// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {PersonalAccount} from "./PersonalAccount.sol";
import {IAgentNFTView, ICustodyConfig, IDepositLedger} from "../interfaces/ICustody.sol";

/// @title AccountFactory
/// @notice Deploys PersonalAccounts and holds what every custody account reads
/// (FINAL_PLAN 4.1.13): the Executor, oracle, guardian and sentinel
/// references, the buy list, the beta's depositor allowlist and the
/// per-account and platform-wide deposit caps.
///
/// - The factory can never move account funds: it has no call into an
///   account other than `initialize` at creation.
/// - Tightening is instant (the admin lowers a cap, removes a depositor or a
///   buyable token, turns the allowlist on; the admin or guardian clears the
///   Executor or cancels a pending change). Loosening waits RISK_TIMELOCK in
///   this contract's own code: anyone executes a matured change, nobody can
///   execute it early, and it lapses if left too long.
/// - Admin is two-step (Ownable2Step) and cannot be renounced.
contract AccountFactory is ICustodyConfig, IDepositLedger, Ownable2Step {
    /// 9 days: the maximum lockup (7 days) plus notice (2 days) (FINAL_PLAN 4.7.2).
    uint256 public constant RISK_TIMELOCK = 9 days;
    /// A matured change can be executed for this long, then it lapses.
    uint256 public constant EXECUTION_WINDOW = 7 days;

    /// Changes that loosen something, so wait the timelock.
    enum Action {
        SetExecutor,
        SetOracle,
        SetGuardian,
        SetSentinel,
        RaisePersonalCap,
        RaisePlatformCap,
        AllowDepositor,
        DisableAllowlist,
        AddBuyable
    }

    struct Pending {
        uint64 executableAt;
        uint64 expiresAt;
    }

    IAgentNFTView public immutable AGENT_NFT;
    address public immutable USDC;
    address public immutable WMON;
    /// The PersonalAccount every clone runs.
    address public immutable PERSONAL_ACCOUNT_IMPLEMENTATION;

    address public executor;
    address public oracle;
    address public guardian;
    address public sentinel;

    /// Most principal one PersonalAccount may hold, in USDC (6 decimals).
    uint256 public personalCap;
    /// Most principal across every account, in USDC (6 decimals).
    uint256 public platformCap;
    /// Principal across every account, as accounts report it.
    uint256 public platformTotal;

    bool public allowlistEnabled = true;
    mapping(address depositor => bool) public isAllowlisted;
    mapping(address token => bool) public isBuyable;

    mapping(uint256 agentId => mapping(address owner => address)) public personalAccountOf;
    mapping(address account => bool) public isAccount;

    mapping(bytes32 id => Pending) public pending;

    event PersonalAccountCreated(uint256 indexed agentId, address indexed owner, address account);
    event DepositRecorded(
        address indexed account, address indexed depositor, uint256 value, uint256 principalAfter, uint256 platformTotal
    );
    event WithdrawalRecorded(address indexed account, uint256 principalReduced, uint256 platformTotal);
    event ChangeProposed(bytes32 indexed id, Action action, bytes32 value, uint64 executableAt, uint64 expiresAt);
    event ChangeExecuted(bytes32 indexed id, Action action, bytes32 value);
    event ChangeCancelled(bytes32 indexed id, address indexed by);
    event ExecutorSet(address indexed previous, address indexed current);
    event OracleSet(address indexed previous, address indexed current);
    event GuardianSet(address indexed previous, address indexed current);
    event SentinelSet(address indexed previous, address indexed current);
    event PersonalCapSet(uint256 previous, uint256 current);
    event PlatformCapSet(uint256 previous, uint256 current);
    event DepositorAllowlistSet(address indexed depositor, bool previous, bool current);
    event AllowlistEnabledSet(bool previous, bool current);
    event BuyableSet(address indexed token, bool previous, bool current);

    error ZeroAddress();
    error NotAgentOwner(address caller, address agentOwner);
    error AccountExists(address account);
    error NotAnAccount(address caller);
    error NotAllowlisted(address depositor);
    error PersonalCapExceeded(uint256 principalAfter, uint256 cap);
    error PlatformCapExceeded(uint256 totalAfter, uint256 cap);
    error NotAdminOrGuardian(address caller);
    error UseTimelock();
    error NotHeldAsset(address token);
    error AlreadyPending(bytes32 id);
    error NotPending(bytes32 id);
    error TooEarly(uint64 executableAt);
    error Lapsed(uint64 expiresAt);
    error BadValue(bytes32 value);
    error RenounceDisabled();

    constructor(
        address admin,
        address guardian_,
        address sentinel_,
        IAgentNFTView agentNft,
        address usdc,
        address wmon,
        uint256 personalCap_,
        uint256 platformCap_,
        address[] memory allowlist
    ) Ownable(admin) {
        if (address(agentNft) == address(0) || usdc == address(0) || wmon == address(0)) {
            revert ZeroAddress();
        }
        AGENT_NFT = agentNft;
        USDC = usdc;
        WMON = wmon;
        PERSONAL_ACCOUNT_IMPLEMENTATION = address(new PersonalAccount(agentNft, usdc, wmon));
        guardian = guardian_;
        sentinel = sentinel_;
        personalCap = personalCap_;
        platformCap = platformCap_;
        isBuyable[usdc] = true;
        isBuyable[wmon] = true;
        for (uint256 i = 0; i < allowlist.length; i++) {
            isAllowlisted[allowlist[i]] = true;
            emit DepositorAllowlistSet(allowlist[i], false, true);
        }
        emit GuardianSet(address(0), guardian_);
        emit SentinelSet(address(0), sentinel_);
        emit PersonalCapSet(0, personalCap_);
        emit PlatformCapSet(0, platformCap_);
        emit BuyableSet(usdc, false, true);
        emit BuyableSet(wmon, false, true);
    }

    // ---------------------------------------------------------------------
    // Accounts
    // ---------------------------------------------------------------------

    /// Deploys the caller's PersonalAccount for an agent they own. The address
    /// is fixed by `(agentId, owner)`, so the UI can show it beforehand.
    function createPersonalAccount(uint256 agentId) external returns (address account) {
        address agentOwner = AGENT_NFT.ownerOf(agentId);
        if (agentOwner != msg.sender) revert NotAgentOwner(msg.sender, agentOwner);
        address existing = personalAccountOf[agentId][msg.sender];
        if (existing != address(0)) revert AccountExists(existing);
        account = Clones.cloneDeterministic(PERSONAL_ACCOUNT_IMPLEMENTATION, _salt(agentId, msg.sender));
        personalAccountOf[agentId][msg.sender] = account;
        isAccount[account] = true;
        emit PersonalAccountCreated(agentId, msg.sender, account);
        PersonalAccount(account).initialize(agentId, msg.sender);
    }

    /// Where `(agentId, owner)`'s PersonalAccount is or will be.
    function predictPersonalAccount(uint256 agentId, address owner_) external view returns (address) {
        return Clones.predictDeterministicAddress(PERSONAL_ACCOUNT_IMPLEMENTATION, _salt(agentId, owner_));
    }

    function _salt(uint256 agentId, address owner_) private pure returns (bytes32) {
        return keccak256(abi.encode(agentId, owner_));
    }

    // ---------------------------------------------------------------------
    // Deposit bookkeeping (accounts only)
    // ---------------------------------------------------------------------

    /// @inheritdoc IDepositLedger
    function recordDeposit(address depositor, uint256 principalAfter, uint256 value) external {
        if (!isAccount[msg.sender]) revert NotAnAccount(msg.sender);
        if (allowlistEnabled && !isAllowlisted[depositor]) revert NotAllowlisted(depositor);
        if (principalAfter > personalCap) revert PersonalCapExceeded(principalAfter, personalCap);
        uint256 totalAfter = platformTotal + value;
        if (totalAfter > platformCap) revert PlatformCapExceeded(totalAfter, platformCap);
        platformTotal = totalAfter;
        emit DepositRecorded(msg.sender, depositor, value, principalAfter, totalAfter);
    }

    /// @inheritdoc IDepositLedger
    function recordWithdrawal(uint256 principalReduced) external {
        if (!isAccount[msg.sender]) revert NotAnAccount(msg.sender);
        uint256 total = platformTotal;
        total = principalReduced < total ? total - principalReduced : 0;
        platformTotal = total;
        emit WithdrawalRecorded(msg.sender, principalReduced, total);
    }

    // ---------------------------------------------------------------------
    // Instant tightening
    // ---------------------------------------------------------------------

    /// Sets the Executor to none: no account can trade until a new one passes
    /// the timelock. The admin or the guardian.
    function clearExecutor() external {
        _checkAdminOrGuardian();
        emit ExecutorSet(executor, address(0));
        executor = address(0);
    }

    /// Cancels a pending change. The admin or the guardian.
    function cancel(bytes32 id) external {
        _checkAdminOrGuardian();
        if (pending[id].executableAt == 0) revert NotPending(id);
        delete pending[id];
        emit ChangeCancelled(id, msg.sender);
    }

    /// Lowers the per-account cap at once; raising it waits the timelock.
    function setPersonalCap(uint256 cap) external onlyOwner {
        if (cap > personalCap) revert UseTimelock();
        emit PersonalCapSet(personalCap, cap);
        personalCap = cap;
    }

    /// Lowers the platform cap at once; raising it waits the timelock.
    function setPlatformCap(uint256 cap) external onlyOwner {
        if (cap > platformCap) revert UseTimelock();
        emit PlatformCapSet(platformCap, cap);
        platformCap = cap;
    }

    /// Takes a wallet off the depositor allowlist; its withdrawals are never gated.
    function removeDepositor(address depositor) external onlyOwner {
        emit DepositorAllowlistSet(depositor, isAllowlisted[depositor], false);
        isAllowlisted[depositor] = false;
    }

    /// Turns the depositor allowlist back on.
    function enableAllowlist() external onlyOwner {
        emit AllowlistEnabledSet(allowlistEnabled, true);
        allowlistEnabled = true;
    }

    /// Stops buying a token. Accounts keep holding it and can always withdraw it.
    function removeBuyable(address token) external onlyOwner {
        emit BuyableSet(token, isBuyable[token], false);
        isBuyable[token] = false;
    }

    // ---------------------------------------------------------------------
    // Timelocked loosening
    // ---------------------------------------------------------------------

    /// The ID of a change: one per action and value.
    function changeId(Action action, bytes32 value) public pure returns (bytes32) {
        return keccak256(abi.encode(action, value));
    }

    /// Proposes a change, executable by anyone after RISK_TIMELOCK and for
    /// EXECUTION_WINDOW after that. `value` is an address or an amount as bytes32.
    function propose(Action action, bytes32 value) external onlyOwner returns (bytes32 id) {
        _validate(action, value);
        id = changeId(action, value);
        Pending memory p = pending[id];
        if (p.executableAt != 0 && block.timestamp <= p.expiresAt) revert AlreadyPending(id);
        uint64 executableAt = uint64(block.timestamp + RISK_TIMELOCK);
        uint64 expiresAt = uint64(block.timestamp + RISK_TIMELOCK + EXECUTION_WINDOW);
        pending[id] = Pending(executableAt, expiresAt);
        emit ChangeProposed(id, action, value, executableAt, expiresAt);
    }

    /// Applies a matured change. Anyone may call it.
    function execute(Action action, bytes32 value) external {
        bytes32 id = changeId(action, value);
        Pending memory p = pending[id];
        if (p.executableAt == 0) revert NotPending(id);
        if (block.timestamp < p.executableAt) revert TooEarly(p.executableAt);
        if (block.timestamp > p.expiresAt) revert Lapsed(p.expiresAt);
        delete pending[id];
        _validate(action, value);
        _apply(action, value);
        emit ChangeExecuted(id, action, value);
    }

    function _validate(Action action, bytes32 value) private view {
        bool isAmount = action == Action.RaisePersonalCap || action == Action.RaisePlatformCap;
        // One encoding per change: an address fills the low 160 bits only, and
        // turning the allowlist off carries no value.
        if (!isAmount && uint256(value) >> 160 != 0) revert BadValue(value);
        if (action == Action.DisableAllowlist && value != bytes32(0)) revert BadValue(value);
        if (action == Action.AddBuyable) {
            address token = _address(value);
            if (token != USDC && token != WMON) revert NotHeldAsset(token);
        }
    }

    function _apply(Action action, bytes32 value) private {
        if (action == Action.SetExecutor) {
            emit ExecutorSet(executor, _address(value));
            executor = _address(value);
        } else if (action == Action.SetOracle) {
            emit OracleSet(oracle, _address(value));
            oracle = _address(value);
        } else if (action == Action.SetGuardian) {
            emit GuardianSet(guardian, _address(value));
            guardian = _address(value);
        } else if (action == Action.SetSentinel) {
            emit SentinelSet(sentinel, _address(value));
            sentinel = _address(value);
        } else if (action == Action.RaisePersonalCap) {
            emit PersonalCapSet(personalCap, uint256(value));
            personalCap = uint256(value);
        } else if (action == Action.RaisePlatformCap) {
            emit PlatformCapSet(platformCap, uint256(value));
            platformCap = uint256(value);
        } else if (action == Action.AllowDepositor) {
            address depositor = _address(value);
            emit DepositorAllowlistSet(depositor, isAllowlisted[depositor], true);
            isAllowlisted[depositor] = true;
        } else if (action == Action.DisableAllowlist) {
            emit AllowlistEnabledSet(allowlistEnabled, false);
            allowlistEnabled = false;
        } else {
            address token = _address(value);
            emit BuyableSet(token, isBuyable[token], true);
            isBuyable[token] = true;
        }
    }

    function _address(bytes32 value) private pure returns (address) {
        return address(uint160(uint256(value)));
    }

    function _checkAdminOrGuardian() private view {
        if (msg.sender != owner() && (msg.sender != guardian || guardian == address(0))) {
            revert NotAdminOrGuardian(msg.sender);
        }
    }

    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }
}
