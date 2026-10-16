// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CustodyCoreV3} from "./CustodyCoreV3.sol";
import {AccountMode, IAgentNFTView, IDepositLedger} from "../interfaces/ICustody.sol";
import {ICustodyConfigV3, IOracleV3, SwapParamsV3} from "../interfaces/ICustodyV3.sol";
import {IRegistryAccount, ITokenRegistry, PriceClass} from "../interfaces/IFund.sol";

/// The part of AgentNFT a vault reads beside IAgentNFTView: when the current epoch began.
interface IAgentNFTEpochs {
    function epochStartedAt(uint256 agentId) external view returns (uint64);
}

/// @title StrategyVaultV3
/// @notice The custody core v3 in public-vault mode (FINAL_PLAN 4.7, P7-U1):
/// one agent's public fund, holding USDC and core-lane class F tokens only
/// (D-338, D-355), with shares that nobody can transfer at launch. Written
/// clean-room from the plan; no code is taken from any researched vault.
///
/// - Deposits are USDC, priced at the vault's value plus the spread, minted
///   against a virtual offset so a first depositor cannot be diluted or
///   inflate the price; every deposit sits in a lock bucket (one day by
///   default, seven at most) that only the depositor's own later deposit can
///   extend; a lockup increase by the manager waits the new duration plus
///   notice and touches no existing lock (D-072, D-076).
/// - The manager is the agent's current owner, resolved live, never stored,
///   and only while the ownership epoch is the accepted one. The manager's
///   deposits are the leader stake, at least 5% of the supply after every
///   other deposit and every leader exit, in a balance of its own.
/// - Exits never depend on the Executor, the platform, a role or a pause. The
///   USDC path pays from USDC above the 10% floor at the value less the
///   spread; when USDC does not cover it the call names the in-kind path.
///   `redeemInKind` pays each depositor's share of every held token with no
///   oracle at all; a token whose transfer reverts is skipped and its share
///   kept as a claimable credit (D-071).
/// - A sale of the agent moves the ownership epoch and the vault is in
///   handover: deposits close, every lock is waived, the old manager can only
///   exit, the incoming owner stakes and, after the handover period, accepts.
/// - `closeVault` winds the vault down: reduce-only trading, no deposits,
///   locks waived, and after the longest lockup the leader may exit last. The
///   platform reads the event to start the agent's unstake cooldown (D-242).
/// - Fees are zero at launch; the storage for a later performance fee (each
///   depositor's entry price, a timelocked rate capped at 20%) is here.
/// - The vault is marked (`isVault`) so the Executor can give it a session
///   grant without a fixed expiry (D-241, built in P7-U2).
contract StrategyVaultV3 is CustodyCoreV3, IRegistryAccount {
    using SafeERC20 for IERC20;

    uint64 public constant MIN_LOCKUP = 1 days;
    uint64 public constant MAX_LOCKUP = 7 days;
    /// A lockup increase waits the new duration plus this notice (D-076).
    uint64 public constant NOTICE = 2 days;
    /// The fee change timelock: the longest lockup plus the notice (D-081).
    uint64 public constant RISK_TIMELOCK = 9 days;
    uint64 public constant EXECUTION_WINDOW = 7 days;
    uint64 public constant HANDOVER_PERIOD = 3 days;
    /// The leader's stake: 5% of the supply, in basis points.
    uint256 public constant LEADER_STAKE_BPS = 500;
    uint256 public constant MAX_FEE_BPS = 2_000;
    /// The spread kept in the vault on deposits and USDC exits, 0.5%: the
    /// MON/USD feed's deviation threshold, so a feed lag cannot be arbitraged.
    uint256 public constant SPREAD_BPS = 50;
    /// The USDC the USDC path leaves behind: 10% of the value remaining.
    uint256 public constant USDC_FLOOR_BPS = 1_000;
    /// The reference band: deposits and USDC exits refuse a share price more
    /// than 10% from the reference, which moves toward the live price by at
    /// most 10% a day (FINAL_PLAN 4.7.3).
    uint256 public constant REF_BAND_BPS = 1_000;
    uint256 public constant REF_MAX_MOVE_BPS = 1_000;
    uint256 public constant REF_WINDOW = 1 days;
    /// The virtual shares behind the supply: 1e12 per USDC base unit (A-06), so a
    /// first deposit mints 1e18 shares per USDC and a donation cannot pay.
    uint256 public constant VIRTUAL_SHARES = 1e12;
    /// Deposits open only once at least one USDC's worth of shares exist, so the
    /// real supply always dwarfs the virtual offset and a gift to the vault
    /// cannot be bought below its value by a later depositor (P7-U3, A-88).
    uint256 public constant MIN_SUPPLY_TO_OPEN = 1e18;
    /// NAV (6 decimals) × 1e30 / shares (18 decimals) is the price per share scaled by 1e18.
    uint256 internal constant SHARE_PRICE_SCALE = 1e30;
    uint256 internal constant WITHDRAWAL_NOTE_GAS = 50_000;

    IAgentNFTView public immutable AGENT_NFT;

    struct Lock {
        uint256 lockedShares;
        uint64 unlockAt;
    }

    /// A timelocked change of the vault's own: a lockup increase or a fee.
    struct Pending {
        uint64 appliesAt;
        uint64 expiresAt;
        uint64 epoch;
        uint64 value;
    }

    uint256 public agentId;
    /// The ownership epoch the vault's management was accepted at; another is a handover.
    uint64 public acceptedEpoch;
    /// The leader: whose stake `leaderShares` is. The agent's owner at acceptance.
    address public leader;
    uint256 public leaderShares;
    /// During a handover: the incoming owner's stake, until accepted.
    address public incomingLeader;
    uint256 public incomingShares;
    uint256 public totalSupply;
    /// Depositors' shares. The leader's and the incoming leader's stakes are separate.
    mapping(address who => uint256) public balanceOf;
    mapping(address who => Lock) private _locks;
    /// Each holder's weighted average entry price per share (1e18 = 1 USDC), for the dormant fee.
    mapping(address who => uint256) public entryPriceE18;
    uint64 public lockup;
    /// The manager's switch; the core's `depositsClosed` is the tighteners'.
    bool public depositsOpen;
    uint64 public windDownAt;
    uint64 public pausedAt;
    /// USDC put in, net of USDC taken out: what the factory's caps count.
    uint256 public principal;
    uint16 public feeBps;
    Pending public pendingLockup;
    Pending public pendingFee;
    uint256 public refPriceE18;
    uint64 public refTime;
    bool private _initialized;

    event Initialized(address indexed factory, uint256 indexed agentId, address indexed leader);
    event Deposited(address indexed who, uint256 assets, uint256 shares, uint256 priceE18, bool leaderStake);
    event Redeemed(address indexed who, address indexed receiver, uint256 shares, uint256 assets, uint256 feeShares);
    event RedeemedInKind(address indexed who, address indexed receiver, uint256 shares, uint256 supplyBefore);
    event InKindSkipped(address indexed token, address indexed who, uint256 amount);
    event Locked(address indexed who, uint256 lockedShares, uint64 unlockAt);
    event DepositsOpenSet(bool previous, bool current);
    event LockupSet(uint64 previous, uint64 current);
    event LockupProposed(uint64 lockup, uint64 appliesAt, uint64 expiresAt);
    event LockupProposalCancelled(address indexed by);
    event FeeProposed(uint16 feeBps, uint64 appliesAt, uint64 expiresAt);
    event FeeProposalCancelled(address indexed by);
    event FeeSet(uint16 previous, uint16 current);
    event VaultClosed(uint256 indexed agentId, address indexed by, uint64 closedAt);
    event HandoverStaked(address indexed incoming, uint256 assets, uint256 shares);
    event IncomingStakeReleased(address indexed earlier, uint256 shares);
    event ManagementAccepted(address indexed previous, address indexed current, uint64 epoch);
    event ReferenceMoved(uint256 previous, uint256 current, uint256 live);

    error AlreadyInitialized();
    error NotManager(address caller);
    error NotManagerOrGuardian(address caller);
    error NotAgentOwner(address currentOwner);
    error InHandover();
    error NotInHandover();
    error WindingDown();
    error DepositsPaused();
    error DepositsAreClosed();
    error DepositsNotOpen();
    error StaleEpoch(uint64 intentEpoch, uint64 currentEpoch);
    error ClassAInVault(address token);
    error TransferNotExact(uint256 received, uint256 amount);
    error SharesTooFew(uint256 shares, uint256 minSharesOut);
    error AssetsTooFew(uint256 assets, uint256 minAssetsOut);
    error SharesLocked(uint256 free, uint64 unlockAt);
    error InsufficientShares(uint256 held, uint256 wanted);
    error LeaderStakeTooLow(uint256 leaderShares, uint256 supply);
    error UseInKind(uint256 owed, uint256 usdcAboveTheFloor);
    error OutsideBand(uint256 live, uint256 ref);
    error BadLockup(uint64 lockup);
    error BadFee(uint16 feeBps);
    error NothingPending();
    error TooEarly(uint64 appliesAt);
    error Lapsed(uint64 expiresAt);
    error StaleProposal(uint64 proposedAt, uint64 current);
    error HandoverTooRecent(uint64 acceptableAt);
    error PauseTooRecent(uint64 unpausableAt);
    error SharesNotTransferable();
    error SeedTooSmall(uint256 supply, uint256 minimum);

    /// The implementation: its own storage is never used, so it is locked.
    constructor(IAgentNFTView agentNft, address usdc, ITokenRegistry tokens, uint256 maxAssetBps)
        CustodyCoreV3(usdc, tokens, maxAssetBps)
    {
        AGENT_NFT = agentNft;
        _initialized = true;
    }

    /// Called once by the factory in the transaction that deploys the clone,
    /// for the agent's current owner, who is its first leader.
    function initialize(uint256 agentId_, address leader_) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        config = ICustodyConfigV3(msg.sender);
        agentId = agentId_;
        address agentOwner = AGENT_NFT.ownerOf(agentId_);
        if (agentOwner != leader_) revert NotAgentOwner(agentOwner);
        leader = leader_;
        acceptedEpoch = AGENT_NFT.ownerEpoch(agentId_);
        lockup = MIN_LOCKUP;
        _addHeld(USDC);
        emit Initialized(msg.sender, agentId_, leader_);
        emit LockupSet(0, MIN_LOCKUP);
    }

    // ---------------------------------------------------------------------
    // Roles
    // ---------------------------------------------------------------------

    /// The agent's current owner, while its ownership epoch is the accepted
    /// one; nobody during a handover (FINAL_PLAN 4.7.1).
    function manager() public view returns (address) {
        if (inHandover()) return address(0);
        return AGENT_NFT.ownerOf(agentId);
    }

    /// Whether the agent changed hands since management was accepted.
    function inHandover() public view returns (bool) {
        return AGENT_NFT.ownerEpoch(agentId) != acceptedEpoch;
    }

    /// The canonical mode (FINAL_PLAN 4.12): the core's stored mode, with
    /// HANDOVER while the agent has changed hands and the vault is not paused.
    function effectiveMode() external view returns (AccountMode) {
        AccountMode m = mode;
        if (m == AccountMode.PAUSED) return m;
        if (inHandover()) return AccountMode.HANDOVER;
        return m;
    }

    modifier onlyManager() {
        if (msg.sender != manager()) revert NotManager(msg.sender);
        _;
    }

    // ---------------------------------------------------------------------
    // Deposits
    // ---------------------------------------------------------------------

    /// Pulls `assets` USDC from the caller and mints shares at the value plus
    /// the spread. The manager's deposits are the leader stake; anyone else
    /// needs deposits open and leaves the leader at 5% or more. Refused in
    /// handover, in wind-down, while paused (or when this value would trip the
    /// breaker's pause), while a tightener closed deposits, outside the
    /// reference band, and by the factory's allowlist and caps. Third parties
    /// cannot deposit for a receiver: nobody can extend another's lock.
    function deposit(uint256 assets, uint256 minSharesOut) external nonReentrant returns (uint256 shares) {
        if (inHandover()) revert InHandover();
        bool asLeader = msg.sender == AGENT_NFT.ownerOf(agentId);
        if (!asLeader && !depositsOpen) revert DepositsNotOpen();
        shares = _deposit(assets, minSharesOut, asLeader, false);
        if (!asLeader) _checkLeaderStake();
    }

    function _deposit(uint256 assets, uint256 minSharesOut, bool asLeader, bool asIncoming)
        private
        returns (uint256 shares)
    {
        if (assets == 0) revert ZeroAmount();
        if (windDownAt != 0) revert WindingDown();
        // The incoming owner's stake is exempt from closed deposits and from a
        // pause's deposit block: without it a handover could never end.
        if (!asIncoming) {
            if (mode == AccountMode.PAUSED) revert DepositsPaused();
            if (depositsClosed) revert DepositsAreClosed();
        }
        IOracleV3 oracle = _oracle();
        _requireUsdcPeg(oracle);
        Valuation memory v = _valuation(oracle, new address[](0), new bytes[](0));
        _cachePrices(v);
        // The breaker sees this value first: a drop that pauses the vault refuses the deposit.
        _observe(v.nav);
        if (!asIncoming && mode == AccountMode.PAUSED) revert DepositsPaused();
        _band(v.nav);
        uint256 supply = totalSupply;
        shares = _sharesFor(assets, v.nav, supply);
        if (shares < minSharesOut) revert SharesTooFew(shares, minSharesOut);
        if (shares == 0) revert ZeroAmount();
        uint256 priceE18 = Math.mulDiv(assets, SHARE_PRICE_SCALE, shares);
        _mint(msg.sender, shares, priceE18, asLeader, asIncoming);
        uint256 principalAfter = principal + assets;
        principal = principalAfter;
        IDepositLedger(address(config)).recordDeposit(msg.sender, principalAfter, assets);
        uint256 before = IERC20(USDC).balanceOf(address(this));
        IERC20(USDC).safeTransferFrom(msg.sender, address(this), assets);
        uint256 received = IERC20(USDC).balanceOf(address(this)) - before;
        if (received != assets) revert TransferNotExact(received, assets);
        emit Deposited(msg.sender, assets, shares, priceE18, asLeader || asIncoming);
    }

    /// The shares `assets` mint at `nav` and `supply`: at the value plus the
    /// spread against the virtual offset, rounded down so the shares out never
    /// price above the value put in; into an empty vault at the virtual rate
    /// alone, so anything the vault holds then (a gift, dust) goes to that
    /// first depositor, the leader, and the real supply dwarfs the offset.
    function _sharesFor(uint256 assets, uint256 nav, uint256 supply) private pure returns (uint256) {
        if (supply == 0) return assets * VIRTUAL_SHARES;
        uint256 navBuy = nav + Math.mulDiv(nav, SPREAD_BPS, BPS, Math.Rounding.Ceil);
        return Math.mulDiv(assets, supply + VIRTUAL_SHARES, navBuy + 1);
    }

    /// The most `who` may deposit now, in USDC: zero while any guard would
    /// refuse, the leader-stake headroom for a depositor, and no bound of the
    /// vault's own for the manager (the factory's caps still apply). Never reverts.
    function maxDeposit(address who) external view returns (uint256) {
        if (windDownAt != 0 || mode == AccountMode.PAUSED || depositsClosed) return 0;
        (bool ok, uint64 epoch) = _epoch();
        if (!ok || epoch != acceptedEpoch) return 0;
        (bool okOwner, address agentOwner) = _agentOwner();
        if (!okOwner) return 0;
        bool asLeader = who == agentOwner;
        if (!asLeader && !depositsOpen) return 0;
        if (asLeader) return type(uint256).max;
        // Shares out such that leaderShares >= 5% of the supply after: at most 20 × stake − supply.
        uint256 room = leaderShares * BPS / LEADER_STAKE_BPS;
        uint256 supply = totalSupply;
        if (room <= supply) return 0;
        uint256 nav = _navAtLastPrices();
        uint256 navBuy = nav + Math.mulDiv(nav, SPREAD_BPS, BPS, Math.Rounding.Ceil);
        return Math.mulDiv(room - supply, navBuy + 1, supply + VIRTUAL_SHARES);
    }

    // ---------------------------------------------------------------------
    // Exits: never pausable, never gated by any role
    // ---------------------------------------------------------------------

    /// The USDC path: burns `shares` and pays their value less the spread in
    /// USDC to `receiver`, when USDC above the 10% floor covers it; otherwise
    /// reverts with `UseInKind`. Free shares only, unless the lock is waived
    /// (handover, wind-down, pause). The leader's exit keeps the stake at 5%
    /// unless the vault is in handover or past its wind-down lockup. Only the
    /// share owner burns their shares: there is no third-party path (MV-S14).
    function redeem(uint256 shares, address receiver, uint256 minAssetsOut, uint64 deadline)
        external
        nonReentrant
        returns (uint256 assets)
    {
        if (block.timestamp > deadline) revert Expired(deadline);
        if (shares == 0) revert ZeroAmount();
        _checkRecipient(receiver);
        _checkFree(msg.sender, shares);
        Valuation memory v = _valuation(_oracle(), new address[](0), new bytes[](0));
        _cachePrices(v);
        _observe(v.nav);
        _band(v.nav);
        uint256 supply = totalSupply;
        uint256 navSell = v.nav - Math.mulDiv(v.nav, SPREAD_BPS, BPS, Math.Rounding.Ceil);
        uint256 feeShares = _feeShares(msg.sender, shares, navSell, supply);
        assets = Math.mulDiv(shares - feeShares, navSell, supply);
        if (assets < minAssetsOut) revert AssetsTooFew(assets, minAssetsOut);
        if (assets == 0) revert ZeroAmount();
        uint256 usdcFree = v.free[0];
        uint256 floor = Math.mulDiv(v.nav - assets, USDC_FLOOR_BPS, BPS, Math.Rounding.Ceil);
        if (usdcFree < assets + floor) revert UseInKind(assets, usdcFree > floor ? usdcFree - floor : 0);
        _burn(msg.sender, shares);
        if (feeShares != 0) _mintFee(feeShares);
        if (msg.sender == leader) _checkLeaderStake();
        _reducePrincipal(assets);
        IERC20(USDC).safeTransfer(receiver, assets);
        emit Redeemed(msg.sender, receiver, shares, assets, feeShares);
    }

    /// The in-kind path: burns `shares` and pays `receiver` the caller's
    /// share of every held token, rounded down. No oracle, Executor, platform
    /// or role is read; the only external calls are the tokens' transfers and
    /// balance reads, each bounded, a read of the agent's epoch when a lock is
    /// active (which counts as a handover when it fails), and a bounded note
    /// to the factory whose result is ignored. A token that refuses the
    /// transfer is skipped and the amount kept as the caller's claimable
    /// credit, out of everyone else's math (D-071).
    function redeemInKind(uint256 shares, address receiver) external nonReentrant {
        if (shares == 0) revert ZeroAmount();
        _checkRecipient(receiver);
        _checkFreeFailOpen(msg.sender, shares);
        uint256 supply = totalSupply;
        _burn(msg.sender, shares);
        if (msg.sender == leader && !_leaderMayLeaveFailOpen() && leaderShares * BPS < LEADER_STAKE_BPS * totalSupply) {
            revert LeaderStakeTooLow(leaderShares, totalSupply);
        }
        address[] memory held = _heldList();
        for (uint256 i = 0; i < held.length; ++i) {
            address token = held[i];
            (bool ok, uint256 balance) = _readBalance(token);
            if (!ok) continue;
            uint256 freeBefore = _free(token, balance);
            uint256 amount = Math.mulDiv(freeBefore, shares, supply);
            if (amount == 0) continue;
            if (_tryTransfer(token, receiver, amount)) {
                _reduceBasis(token, amount, freeBefore);
                (bool okAfter, uint256 left) = _readBalance(token);
                if (okAfter && left == 0 && token != USDC) _removeHeld(token);
            } else {
                // The share stays here for its owner; it leaves the free balance now.
                _credit(token, msg.sender, amount);
                _reduceBasis(token, amount, freeBefore);
                emit InKindSkipped(token, msg.sender, amount);
            }
        }
        _reducePrincipal(Math.mulDiv(principal, shares, supply));
        emit RedeemedInKind(msg.sender, receiver, shares, supply);
    }

    /// What `redeemInKind(shares, ...)` would pay now, per held token. Reads no oracle; never reverts.
    function inKindAmounts(uint256 shares) external view returns (address[] memory tokens, uint256[] memory amounts) {
        tokens = _heldList();
        amounts = new uint256[](tokens.length);
        uint256 supply = totalSupply;
        if (supply == 0 || shares == 0) return (tokens, amounts);
        for (uint256 i = 0; i < tokens.length; ++i) {
            (bool ok, uint256 balance) = _readBalance(tokens[i]);
            if (!ok) continue;
            amounts[i] = Math.mulDiv(_free(tokens[i], balance), shares > supply ? supply : shares, supply);
        }
    }

    /// Share transfers are disabled at launch (FINAL_PLAN 4.7.4).
    function transfer(address, uint256) external pure returns (bool) {
        revert SharesNotTransferable();
    }

    // ---------------------------------------------------------------------
    // The manager: deposits open, the lockup, the fee, wind-down
    // ---------------------------------------------------------------------

    /// Opens deposits once the leader stake is there and at least one USDC's
    /// worth of shares exist, or closes them.
    function setDepositsOpen(bool open) external onlyManager {
        if (open) {
            if (windDownAt != 0) revert WindingDown();
            if (leaderShares == 0 || leaderShares * BPS < LEADER_STAKE_BPS * totalSupply) {
                revert LeaderStakeTooLow(leaderShares, totalSupply);
            }
            if (totalSupply < MIN_SUPPLY_TO_OPEN) revert SeedTooSmall(totalSupply, MIN_SUPPLY_TO_OPEN);
        }
        emit DepositsOpenSet(depositsOpen, open);
        depositsOpen = open;
    }

    /// Lowers the lockup at once, or proposes an increase that applies after
    /// the new duration plus the notice, to later deposits only (D-072, D-076).
    function setLockup(uint64 duration) external onlyManager {
        if (duration < MIN_LOCKUP || duration > MAX_LOCKUP) revert BadLockup(duration);
        uint64 current = lockup;
        if (duration <= current) {
            emit LockupSet(current, duration);
            lockup = duration;
            delete pendingLockup;
            return;
        }
        uint64 appliesAt = uint64(block.timestamp) + duration + NOTICE;
        pendingLockup = Pending(appliesAt, appliesAt + EXECUTION_WINDOW, acceptedEpoch, duration);
        emit LockupProposed(duration, appliesAt, appliesAt + EXECUTION_WINDOW);
    }

    /// Applies a matured lockup increase. Anyone; fails after a sale.
    function applyLockup() external {
        Pending memory p = _matured(pendingLockup);
        delete pendingLockup;
        emit LockupSet(lockup, p.value);
        lockup = p.value;
    }

    /// Drops a pending lockup increase. The manager or the guardian.
    function cancelLockupProposal() external {
        _checkManagerOrGuardian();
        if (pendingLockup.appliesAt == 0) revert NothingPending();
        delete pendingLockup;
        emit LockupProposalCancelled(msg.sender);
    }

    /// Proposes a performance fee rate (at most 20%) behind the risk timelock;
    /// zero at launch, and it never resets any entry price. The timelock is
    /// longer than the longest lockup, so every depositor can leave before a
    /// rate applies.
    function proposeFee(uint16 bps) external onlyManager {
        if (bps > MAX_FEE_BPS) revert BadFee(bps);
        uint64 appliesAt = uint64(block.timestamp) + RISK_TIMELOCK;
        pendingFee = Pending(appliesAt, appliesAt + EXECUTION_WINDOW, acceptedEpoch, bps);
        emit FeeProposed(bps, appliesAt, appliesAt + EXECUTION_WINDOW);
    }

    function applyFee() external {
        Pending memory p = _matured(pendingFee);
        delete pendingFee;
        emit FeeSet(feeBps, uint16(p.value));
        feeBps = uint16(p.value);
    }

    /// Drops a pending fee change. The manager or the guardian.
    function cancelFeeProposal() external {
        _checkManagerOrGuardian();
        if (pendingFee.appliesAt == 0) revert NothingPending();
        delete pendingFee;
        emit FeeProposalCancelled(msg.sender);
    }

    /// Winds the vault down: no deposits, reduce-only trading, locks waived,
    /// and after the longest lockup the leader may exit last. The platform
    /// starts the agent's unstake cooldown on this event (D-242).
    function closeVault() external onlyManager {
        if (windDownAt != 0) revert WindingDown();
        windDownAt = uint64(block.timestamp);
        depositsOpen = false;
        if (mode != AccountMode.PAUSED) _setMode(AccountMode.WIND_DOWN);
        emit VaultClosed(agentId, msg.sender, uint64(block.timestamp));
    }

    function _checkManagerOrGuardian() private view {
        if (msg.sender == manager()) return;
        address guardian = config.guardian();
        if (guardian != address(0) && msg.sender == guardian) return;
        revert NotManagerOrGuardian(msg.sender);
    }

    // ---------------------------------------------------------------------
    // Handover on an agent sale (FINAL_PLAN 4.7.7)
    // ---------------------------------------------------------------------

    /// The incoming owner's stake, during a handover: a deposit exempt from
    /// closed deposits, locked like any other, counted on acceptance.
    function stakeAsIncomingLeader(uint256 assets, uint256 minSharesOut)
        external
        nonReentrant
        returns (uint256 shares)
    {
        if (!inHandover()) revert NotInHandover();
        address agentOwner = AGENT_NFT.ownerOf(agentId);
        if (msg.sender != agentOwner) revert NotAgentOwner(agentOwner);
        if (incomingLeader != address(0) && incomingLeader != msg.sender) {
            // The agent changed hands again: the earlier incoming stake becomes ordinary shares.
            _releaseIncoming();
        }
        incomingLeader = msg.sender;
        shares = _deposit(assets, minSharesOut, false, true);
        emit HandoverStaked(msg.sender, assets, shares);
    }

    /// After the handover period, the incoming owner with at least 5% takes
    /// over: the old leader's stake becomes ordinary, unlocked shares.
    function acceptManagement() external nonReentrant {
        if (!inHandover()) revert NotInHandover();
        address agentOwner = AGENT_NFT.ownerOf(agentId);
        if (msg.sender != agentOwner) revert NotAgentOwner(agentOwner);
        uint64 since = IAgentNFTEpochs(address(AGENT_NFT)).epochStartedAt(agentId);
        if (block.timestamp < since + HANDOVER_PERIOD) revert HandoverTooRecent(since + HANDOVER_PERIOD);
        uint256 stake = incomingLeader == msg.sender ? incomingShares : 0;
        if (stake == 0 || stake * BPS < LEADER_STAKE_BPS * totalSupply) revert LeaderStakeTooLow(stake, totalSupply);
        address previous = leader;
        balanceOf[previous] += leaderShares;
        delete _locks[previous];
        leader = msg.sender;
        leaderShares = stake;
        incomingLeader = address(0);
        incomingShares = 0;
        acceptedEpoch = AGENT_NFT.ownerEpoch(agentId);
        depositsOpen = false;
        emit ManagementAccepted(previous, msg.sender, acceptedEpoch);
    }

    /// Moves the reference price toward the live share price and records the
    /// value for the breaker, by anyone.
    function pokeReference() external nonReentrant {
        Valuation memory v = _valuation(_oracle(), new address[](0), new bytes[](0));
        _cachePrices(v);
        _observe(v.nav);
        _moveReference(_priceOf(v.nav));
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function sharePriceE18() external view returns (uint256) {
        return _priceOf(_navAtLastPrices());
    }

    /// Shares for `assets` at the last prices, as a deposit would mint them now.
    function convertToShares(uint256 assets) external view returns (uint256) {
        return _sharesFor(assets, _navAtLastPrices(), totalSupply);
    }

    /// USDC for `shares` at the last prices, as the USDC path would pay them now (before any fee).
    function convertToAssets(uint256 shares) external view returns (uint256) {
        uint256 supply = totalSupply;
        if (supply == 0) return 0;
        uint256 nav = _navAtLastPrices();
        uint256 navSell = nav - Math.mulDiv(nav, SPREAD_BPS, BPS, Math.Rounding.Ceil);
        return Math.mulDiv(shares, navSell, supply);
    }

    /// Every share `who` holds: ordinary, leader stake and incoming stake.
    function sharesOf(address who) public view returns (uint256) {
        uint256 total = balanceOf[who];
        if (who == leader) total += leaderShares;
        if (who == incomingLeader) total += incomingShares;
        return total;
    }

    /// The shares `who` may exit with now: everything once the lock passed or is waived.
    function freeShares(address who) public view returns (uint256) {
        uint256 total = sharesOf(who);
        Lock memory l = _locks[who];
        if (l.unlockAt <= block.timestamp || _locksWaived()) return total;
        return l.lockedShares >= total ? 0 : total - l.lockedShares;
    }

    function lockOf(address who) external view returns (uint256 lockedShares, uint64 unlockAt) {
        Lock memory l = _locks[who];
        return (l.lockedShares, l.unlockAt);
    }

    function leaderStakeBps() external view returns (uint256) {
        uint256 supply = totalSupply;
        return supply == 0 ? 0 : leaderShares * BPS / supply;
    }

    function isVault() external pure override(CustodyCoreV3, IRegistryAccount) returns (bool) {
        return true;
    }

    /// A vault never buys screened-lane tokens (D-351).
    function screenedOptIn() external pure override(CustodyCoreV3, IRegistryAccount) returns (bool) {
        return false;
    }

    // ---------------------------------------------------------------------
    // Core hooks
    // ---------------------------------------------------------------------

    /// The manager owns the account's switches (unpause, open deposits, tighten).
    function _isOwner(address who) internal view override returns (bool) {
        return who != address(0) && who == manager();
    }

    /// Credits are claimed by whoever they were recorded for.
    function _mayClaim(address) internal pure override returns (bool) {
        return true;
    }

    /// Nobody takes the vault's tokens out directly: depositors leave through the exits.
    function _mayWithdraw(address) internal pure override returns (bool) {
        return false;
    }

    /// Trading needs the intent's epoch to be current, only USDC out during a
    /// handover, and never a class A token in: a vault's value mints and burns
    /// shares, so only feeds may price it (D-338).
    function _checkTrading(SwapParamsV3 calldata p) internal view override {
        uint64 epoch = AGENT_NFT.ownerEpoch(agentId);
        if (p.ownershipEpoch != epoch) revert StaleEpoch(p.ownershipEpoch, epoch);
        if (epoch != acceptedEpoch && p.tokenOut != USDC) revert ReduceOnly(AccountMode.HANDOVER);
        if (p.tokenOut != USDC && TOKENS.tokenRecord(p.tokenOut).priceClass != PriceClass.F) {
            revert ClassAInVault(p.tokenOut);
        }
    }

    /// Only credits leave through the core's own paths; they were never part of the shares' value.
    function _afterWithdraw(address, uint256, uint256, bool) internal override {}

    /// The value per share for the breaker: NAV × 1e30 / shares, so 1e18 is 1 USDC per share.
    function _perUnit(uint256 nav) internal view override returns (uint256) {
        return _priceOf(nav);
    }

    /// A public vault unpauses only after one lockup, so depositors can leave first (D-080).
    function _checkUnpause() internal view override {
        if (mode != AccountMode.PAUSED) return;
        uint64 unpausableAt = pausedAt + lockup;
        if (block.timestamp < unpausableAt) revert PauseTooRecent(unpausableAt);
    }

    /// A wound-down vault never returns to NORMAL; a pause records when it began.
    function _setMode(AccountMode next) internal override {
        if (next == AccountMode.NORMAL && windDownAt != 0) next = AccountMode.WIND_DOWN;
        if (next == AccountMode.PAUSED && mode != AccountMode.PAUSED) pausedAt = uint64(block.timestamp);
        super._setMode(next);
    }

    // ---------------------------------------------------------------------
    // Shares
    // ---------------------------------------------------------------------

    function _mint(address who, uint256 shares, uint256 priceE18, bool asLeader, bool asIncoming) private {
        uint256 before = sharesOf(who);
        uint256 prior = entryPriceE18[who];
        entryPriceE18[who] = before == 0 ? priceE18 : (prior * before + priceE18 * shares) / (before + shares);
        if (asLeader) {
            // The accepted owner is the leader; the epoch check before this call keeps it so.
            if (leader != who) revert NotManager(who);
            leaderShares += shares;
        } else if (asIncoming) {
            incomingShares += shares;
        } else {
            balanceOf[who] += shares;
        }
        totalSupply += shares;
        _lock(who, shares);
    }

    /// The lock bucket (D-072): a fresh bucket after the last one expired,
    /// otherwise the new shares join it and the unlock moves to the later time.
    function _lock(address who, uint256 shares) private {
        Lock storage l = _locks[who];
        uint64 until = uint64(block.timestamp) + lockup;
        if (l.unlockAt <= block.timestamp) {
            l.lockedShares = shares;
            l.unlockAt = until;
        } else {
            l.lockedShares += shares;
            if (until > l.unlockAt) l.unlockAt = until;
        }
        emit Locked(who, l.lockedShares, l.unlockAt);
    }

    /// Burns `shares` of `who`: the leader's stake first, then an incoming
    /// leader's stake, then ordinary shares, so every balance a holder has can
    /// leave (an incoming owner who never accepts leaves like anyone else).
    function _burn(address who, uint256 shares) private {
        uint256 total = sharesOf(who);
        if (total < shares) revert InsufficientShares(total, shares);
        uint256 rest = shares;
        if (who == leader) {
            uint256 stake = leaderShares;
            uint256 take = rest < stake ? rest : stake;
            leaderShares = stake - take;
            rest -= take;
        }
        if (rest != 0 && who == incomingLeader) {
            uint256 stake = incomingShares;
            uint256 take = rest < stake ? rest : stake;
            incomingShares = stake - take;
            rest -= take;
        }
        if (rest != 0) balanceOf[who] -= rest;
        totalSupply -= shares;
    }

    /// The exit fee's shares go to the leader's stake.
    function _mintFee(uint256 shares) private {
        leaderShares += shares;
        totalSupply += shares;
    }

    /// The dormant performance fee on a USDC exit: shares × (P − P_entry) / P × fee,
    /// in the user's favor, none for the leader (FINAL_PLAN 4.7.6).
    function _feeShares(address who, uint256 shares, uint256 navSell, uint256 supply) private view returns (uint256) {
        uint16 bps = feeBps;
        if (bps == 0 || who == leader) return 0;
        uint256 price = supply == 0 ? 0 : Math.mulDiv(navSell, SHARE_PRICE_SCALE, supply);
        uint256 entry = entryPriceE18[who];
        if (price <= entry) return 0;
        return Math.mulDiv(shares, (price - entry) * bps, price * BPS);
    }

    function _checkLeaderStake() private view {
        if (_leaderMayLeave()) return;
        if (leaderShares * BPS < LEADER_STAKE_BPS * totalSupply) revert LeaderStakeTooLow(leaderShares, totalSupply);
    }

    /// Whether the 5% rule is lifted: in handover, or past the wind-down's lockup.
    function _leaderMayLeave() private view returns (bool) {
        if (windDownAt != 0 && block.timestamp >= windDownAt + MAX_LOCKUP) return true;
        return inHandover();
    }

    function _leaderMayLeaveFailOpen() private view returns (bool) {
        if (windDownAt != 0 && block.timestamp >= windDownAt + MAX_LOCKUP) return true;
        return _handoverFailOpen();
    }

    /// Releases an earlier incoming leader's stake as ordinary shares.
    function _releaseIncoming() private {
        address earlier = incomingLeader;
        if (earlier == address(0)) return;
        uint256 shares = incomingShares;
        balanceOf[earlier] += shares;
        incomingShares = 0;
        incomingLeader = address(0);
        emit IncomingStakeReleased(earlier, shares);
    }

    // ---------------------------------------------------------------------
    // Locks
    // ---------------------------------------------------------------------

    function _checkFree(address who, uint256 shares) private view {
        uint256 total = sharesOf(who);
        if (total < shares) revert InsufficientShares(total, shares);
        Lock memory l = _locks[who];
        if (l.unlockAt <= block.timestamp || _locksWaived()) return;
        uint256 free = l.lockedShares >= total ? 0 : total - l.lockedShares;
        if (shares > free) revert SharesLocked(free, l.unlockAt);
    }

    /// The in-kind path's lock check: a handover read that fails counts as a
    /// handover, since it can only unlock (FINAL_PLAN 4.7.5).
    function _checkFreeFailOpen(address who, uint256 shares) private view {
        uint256 total = sharesOf(who);
        if (total < shares) revert InsufficientShares(total, shares);
        Lock memory l = _locks[who];
        if (l.unlockAt <= block.timestamp) return;
        if (windDownAt != 0 || mode == AccountMode.PAUSED) return;
        uint256 free = l.lockedShares >= total ? 0 : total - l.lockedShares;
        if (shares <= free) return;
        if (_handoverFailOpen()) return;
        revert SharesLocked(free, l.unlockAt);
    }

    /// Locks are waived in handover, wind-down and a pause (D-075).
    function _locksWaived() private view returns (bool) {
        return windDownAt != 0 || mode == AccountMode.PAUSED || inHandover();
    }

    function _handoverFailOpen() private view returns (bool) {
        (bool ok, uint64 epoch) = _epoch();
        return !ok || epoch != acceptedEpoch;
    }

    function _epoch() private view returns (bool ok, uint64 epoch) {
        try AGENT_NFT.ownerEpoch(agentId) returns (uint64 e) {
            return (true, e);
        } catch {
            return (false, 0);
        }
    }

    function _agentOwner() private view returns (bool ok, address who) {
        try AGENT_NFT.ownerOf(agentId) returns (address o) {
            return (true, o);
        } catch {
            return (false, address(0));
        }
    }

    // ---------------------------------------------------------------------
    // Timelocks, the reference band, the price, the principal
    // ---------------------------------------------------------------------

    function _matured(Pending memory p) private view returns (Pending memory) {
        if (p.appliesAt == 0) revert NothingPending();
        if (block.timestamp < p.appliesAt) revert TooEarly(p.appliesAt);
        if (block.timestamp > p.expiresAt) revert Lapsed(p.expiresAt);
        uint64 current = AGENT_NFT.ownerEpoch(agentId);
        if (p.epoch != current) revert StaleProposal(p.epoch, current);
        return p;
    }

    /// Deposits and USDC exits price inside the reference band: the reference
    /// first moves toward the live price by at most 10% a day, then the live
    /// price must be within 10% of it. The first priced action sets it.
    function _band(uint256 nav) private {
        uint256 live = _priceOf(nav);
        if (live == 0) return;
        uint256 ref = _moveReference(live);
        uint256 diff = live > ref ? live - ref : ref - live;
        if (diff * BPS > ref * REF_BAND_BPS) revert OutsideBand(live, ref);
    }

    function _moveReference(uint256 live) private returns (uint256 ref) {
        ref = refPriceE18;
        uint256 previous = ref;
        if (ref == 0 || refTime == 0) {
            ref = live;
        } else {
            uint256 elapsed = block.timestamp - refTime;
            if (elapsed > REF_WINDOW) elapsed = REF_WINDOW;
            uint256 maxMove = Math.mulDiv(ref, REF_MAX_MOVE_BPS * elapsed, BPS * REF_WINDOW);
            if (live > ref) ref = live - ref > maxMove ? ref + maxMove : live;
            else ref = ref - live > maxMove ? ref - maxMove : live;
        }
        refPriceE18 = ref;
        refTime = uint64(block.timestamp);
        if (ref != previous) emit ReferenceMoved(previous, ref, live);
    }

    function _priceOf(uint256 nav) private view returns (uint256) {
        uint256 supply = totalSupply;
        return supply == 0 ? 0 : Math.mulDiv(nav, SHARE_PRICE_SCALE, supply);
    }

    /// Lowers the principal by USDC that left (never below zero), then tells
    /// the factory with bounded gas, ignoring the result: an exit never depends on it.
    function _reducePrincipal(uint256 amount) private {
        uint256 p = principal;
        uint256 reduce = amount < p ? amount : p;
        if (reduce == 0) return;
        principal = p - reduce;
        bytes memory data = abi.encodeCall(IDepositLedger.recordWithdrawal, (reduce));
        address target = address(config);
        uint256 gasLimit = WITHDRAWAL_NOTE_GAS;
        assembly ("memory-safe") {
            pop(call(gasLimit, target, 0, add(data, 0x20), mload(data), 0, 0))
        }
    }
}
