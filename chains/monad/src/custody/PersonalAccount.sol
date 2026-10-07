// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CustodyCore} from "./CustodyCore.sol";
import {AccountMode, SwapParams, IAgentNFTView, ICustodyConfig, IDepositLedger} from "../interfaces/ICustody.sol";
import {IOracleAdapter} from "../interfaces/IOracle.sol";

/// @title PersonalAccount
/// @notice The custody core in single-owner mode (FINAL_PLAN 4.1.6, D-048):
/// one owner's own trading money for one agent. No shares and no lockup.
///
/// - One clone per `(agentId, owner)`, deployed by AccountFactory, with both
///   fixed at creation. A seller keeps their account and their withdrawal
///   after the agent is sold; trading stops by itself, because it requires
///   the agent's current owner to be this account's owner and the intent's
///   ownership epoch to be the current one.
/// - Deposits are the owner's own, checked against the factory's allowlist
///   and caps, valued in USDC (USDC one for one, WMON through the oracle),
///   and must arrive exactly: a fee-on-transfer token is refused.
/// - Withdrawals are the core's: always on, owner only.
/// - Internal units (D-233): non-transferable bookkeeping that makes the
///   breaker flow-adjusted. A deposit mints units at the current value per
///   unit and a withdrawal burns them in proportion to the value that left,
///   so the owner's own flows never move the value per unit, and only price
///   moves and trades do. The first unit is worth 1 USDC.
contract PersonalAccount is CustodyCore {
    using SafeERC20 for IERC20;

    /// Gas for telling the factory about a withdrawal: enough for its bookkeeping,
    /// and the withdrawal never depends on the call.
    uint256 internal constant WITHDRAWAL_NOTE_GAS = 50_000;
    /// Units have 18 decimals; the first deposit mints 1e12 units per USDC base unit (1 unit per USDC).
    uint256 internal constant UNITS_PER_USDC_E6 = 1e12;
    /// NAV (6 decimals) × 1e30 / units (18 decimals) is the value per unit scaled by 1e18.
    uint256 internal constant PER_UNIT_SCALE = 1e30;

    IAgentNFTView public immutable AGENT_NFT;

    uint256 public agentId;
    address public owner;
    /// What the owner has put in, in USDC (6 decimals), net of USDC taken out:
    /// what the per-account cap counts. Withdrawing everything sets it to zero.
    uint256 public principal;
    /// Internal units outstanding (18 decimals). Not a token: nothing can move them.
    uint256 public units;
    bool private _initialized;

    event Initialized(address indexed factory, uint256 indexed agentId, address indexed owner);
    event Deposited(address indexed token, uint256 amount, uint256 valueUsdc, uint256 principalAfter);
    event PrincipalReduced(uint256 amount, uint256 principalAfter);
    event UnitsChanged(uint256 previous, uint256 current);

    error AlreadyInitialized();
    error DepositsPaused();
    error DepositsAreClosed();
    error NotAgentOwner(address currentOwner);
    error StaleEpoch(uint64 intentEpoch, uint64 currentEpoch);
    error TransferNotExact(address token, uint256 received, uint256 amount);
    error AccountValueZero();

    /// The implementation: its own storage is never used, so it is locked.
    constructor(IAgentNFTView agentNft, address usdc, address wmon) CustodyCore(usdc, wmon) {
        AGENT_NFT = agentNft;
        _initialized = true;
    }

    /// Called once by the factory in the transaction that deploys the clone.
    function initialize(uint256 agentId_, address owner_) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        config = ICustodyConfig(msg.sender);
        agentId = agentId_;
        owner = owner_;
        emit Initialized(msg.sender, agentId_, owner_);
    }

    // ---------------------------------------------------------------------
    // Deposits
    // ---------------------------------------------------------------------

    /// Pulls `amount` of USDC or WMON from the owner (who approves this
    /// account first). Refused while PAUSED or with deposits closed, once the
    /// owner no longer owns the agent, above either cap, for a wallet off the
    /// beta allowlist, without an oracle, while USDC/USD is stale or off its
    /// peg (the depeg guard), and, when WMON is involved, while MON/USD is unusable.
    function deposit(address token, uint256 amount) external nonReentrant onlyOwner {
        if (amount == 0) revert ZeroAmount();
        if (!_isHeld(token)) revert NotHeldAsset(token);
        if (mode == AccountMode.PAUSED) revert DepositsPaused();
        if (depositsClosed) revert DepositsAreClosed();
        address agentOwner = AGENT_NFT.ownerOf(agentId);
        if (agentOwner != owner) revert NotAgentOwner(agentOwner);

        // Valued once: the depeg guard, then the WMON price if WMON is held or deposited.
        IOracleAdapter oracle = _oracle();
        oracle.requireUsdcPeg();
        uint256 px = token == WMON ? oracle.priceE18(WMON) : _wmonPriceIfHeld(oracle);
        _cachePrice(px);
        uint256 navBefore = _navAt(px);
        uint256 value = _valueOf(token, amount, px);
        _mintUnits(value, navBefore);

        uint256 principalAfter = principal + value;
        principal = principalAfter;
        IDepositLedger(address(config)).recordDeposit(owner, principalAfter, value);

        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received != amount) revert TransferNotExact(token, received, amount);
        emit Deposited(token, amount, value, principalAfter);
    }

    // ---------------------------------------------------------------------
    // Core hooks
    // ---------------------------------------------------------------------

    function _isOwner(address who) internal view override returns (bool) {
        return who == owner;
    }

    /// Trading needs the agent still to belong to this account's owner and the
    /// intent's epoch to be current: a sale stops it in the same transaction.
    function _checkTrading(SwapParams calldata p) internal view override {
        address agentOwner = AGENT_NFT.ownerOf(agentId);
        if (agentOwner != owner) revert NotAgentOwner(agentOwner);
        uint64 epoch = AGENT_NFT.ownerEpoch(agentId);
        if (p.ownershipEpoch != epoch) revert StaleEpoch(p.ownershipEpoch, epoch);
    }

    /// Keeps units and principal in step with what left. Reads no oracle and
    /// cannot revert on arithmetic: a withdrawal never depends on either.
    function _afterWithdraw(address token, uint256 amount, uint256 freeOut) internal override {
        bool empty = IERC20(USDC).balanceOf(address(this)) == 0 && IERC20(WMON).balanceOf(address(this)) == 0;
        _burnUnits(token, freeOut, empty);
        _reducePrincipal(token, amount, empty);
    }

    /// The value per unit for the breaker: NAV × 1e30 / units, so 1e18 is 1 USDC per unit.
    function _perUnit(uint256 nav) internal view override returns (uint256) {
        uint256 u = units;
        return u == 0 ? 0 : Math.mulDiv(nav, PER_UNIT_SCALE, u);
    }

    /// Mints units for a deposit worth `value` at the value per unit before it,
    /// rounding down, so the units already out never lose value to a deposit.
    function _mintUnits(uint256 value, uint256 navBefore) private {
        uint256 u = units;
        uint256 minted;
        if (u == 0) {
            minted = value * UNITS_PER_USDC_E6;
        } else {
            // Units with no value behind them cannot price new ones; withdrawing everything starts afresh.
            if (navBefore == 0) revert AccountValueZero();
            minted = Math.mulDiv(value, u, navBefore);
        }
        if (minted == 0) return;
        units = u + minted;
        emit UnitsChanged(u, u + minted);
    }

    /// Burns units in proportion to the value that left, at the last price a
    /// priced action used, rounding up, so the units left never gain value
    /// from a withdrawal. An empty account, or one whose units all burn,
    /// starts afresh: no units and no peak.
    function _burnUnits(address token, uint256 freeOut, bool empty) private {
        uint256 u = units;
        if (u == 0) return;
        uint256 left;
        if (!empty) {
            if (freeOut == 0) return;
            uint256 px = lastWmonPriceE18;
            // The value that left is the exact fall in NAV (each side rounded as
            // NAV rounds), never the withdrawn amount valued on its own, which
            // can round to less and let a dust withdrawal lower the value per unit.
            uint256 freeAfter = _free(token, IERC20(token).balanceOf(address(this)));
            uint256 valueOut = _valueOf(token, freeAfter + freeOut, px) - _valueOf(token, freeAfter, px);
            if (valueOut == 0) return;
            // valueOut <= navBefore, so the burn is at most u.
            uint256 burn = Math.mulDiv(u, valueOut, _navAt(px) + valueOut, Math.Rounding.Ceil);
            left = u - burn;
        }
        units = left;
        emit UnitsChanged(u, left);
        if (left == 0) _resetPeaks();
    }

    /// Lowers the principal by USDC taken out (WMON lowers nothing, which only
    /// errs towards the cap), or to zero once the account is empty, then tells
    /// the factory without depending on it.
    function _reducePrincipal(address token, uint256 amount, bool empty) private {
        uint256 p = principal;
        if (p == 0) return;
        uint256 reduce = token == USDC ? (amount < p ? amount : p) : 0;
        if (empty) reduce = p;
        if (reduce == 0) return;
        principal = p - reduce;
        emit PrincipalReduced(reduce, p - reduce);
        _noteWithdrawal(reduce);
    }

    /// A call with bounded gas whose result and return data are ignored: a
    /// factory that reverts, burns gas or returns a huge payload cannot stop
    /// the withdrawal.
    function _noteWithdrawal(uint256 reduced) private {
        bytes memory data = abi.encodeCall(IDepositLedger.recordWithdrawal, (reduced));
        address target = address(config);
        uint256 gasLimit = WITHDRAWAL_NOTE_GAS;
        assembly ("memory-safe") {
            pop(call(gasLimit, target, 0, add(data, 0x20), mload(data), 0, 0))
        }
    }
}
