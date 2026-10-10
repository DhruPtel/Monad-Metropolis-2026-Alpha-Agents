// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CustodyCoreV3} from "./CustodyCoreV3.sol";
import {AccountMode, IAgentNFTView, IDepositLedger} from "../interfaces/ICustody.sol";
import {ICustodyConfigV3, IOracleV3, SwapParamsV3} from "../interfaces/ICustodyV3.sol";
import {IRegistryAccount, ITokenRegistry, Lane, PriceClass, TokenRecord, TokenStatus} from "../interfaces/IFund.sol";

/// @title PersonalAccountV3
/// @notice The custody core v3 in single-owner mode (FINAL_PLAN 0.4, 4.1.6,
/// D-048, F-U3): one owner's own trading money for one agent, across up to 16
/// tokens. No shares and no lockup.
///
/// - One clone per `(agentId, owner)`, deployed by AccountFactoryV3, with both
///   fixed at creation. A seller keeps their account and their withdrawal
///   after the agent is sold; trading stops by itself, because it requires
///   the agent's current owner to be this account's owner and the intent's
///   ownership epoch to be the current one.
/// - Deposits are the owner's own: USDC, or a core-lane class F token that is
///   buyable (never a screened token, FINAL_PLAN 0.4), checked against the
///   factory's allowlist and caps, valued in USDC through the oracle, and must
///   arrive exactly: a fee-on-transfer token is refused.
/// - The screened-lane opt-in (D-351): the owner's own transaction turns it on,
///   and only then does the TokenRegistry answer that a screened token is
///   buyable for this account. Turning it off is instant and the owner's too.
/// - Withdrawals are the core's: always on, owner only.
/// - Internal units (D-233): non-transferable bookkeeping that makes the
///   breaker flow-adjusted across the whole portfolio. A deposit mints units
///   at the current value per unit and a withdrawal burns them in proportion to
///   the value that left (at the last prices, reading no oracle), so the owner's
///   own flows never move the value per unit, and only price moves and trades do.
contract PersonalAccountV3 is CustodyCoreV3, IRegistryAccount {
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
    /// Whether the owner opted in to screened-lane tokens (D-351).
    bool private _screenedOptIn;
    bool private _initialized;

    event Initialized(address indexed factory, uint256 indexed agentId, address indexed owner);
    event Deposited(address indexed token, uint256 amount, uint256 valueUsdc, uint256 principalAfter);
    event PrincipalReduced(uint256 amount, uint256 principalAfter);
    event UnitsChanged(uint256 previous, uint256 current);
    event ScreenedOptInSet(bool previous, bool current);

    error AlreadyInitialized();
    error DepositsPaused();
    error DepositsAreClosed();
    error NotDepositable(address token);
    error NotAgentOwner(address currentOwner);
    error StaleEpoch(uint64 intentEpoch, uint64 currentEpoch);
    error TransferNotExact(address token, uint256 received, uint256 amount);
    error AccountValueZero();

    /// The implementation: its own storage is never used, so it is locked.
    constructor(IAgentNFTView agentNft, address usdc, ITokenRegistry tokens) CustodyCoreV3(usdc, tokens) {
        AGENT_NFT = agentNft;
        _initialized = true;
    }

    /// Called once by the factory in the transaction that deploys the clone.
    /// USDC takes the first slot of the held list for good.
    function initialize(uint256 agentId_, address owner_) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        config = ICustodyConfigV3(msg.sender);
        agentId = agentId_;
        owner = owner_;
        _addHeld(USDC);
        emit Initialized(msg.sender, agentId_, owner_);
    }

    // ---------------------------------------------------------------------
    // Deposits
    // ---------------------------------------------------------------------

    /// Pulls `amount` of USDC or a buyable core-lane class F token from the
    /// owner (who approves this account first). Refused while PAUSED or with
    /// deposits closed, once the owner no longer owns the agent, above either
    /// cap, for a wallet off the beta allowlist, without an oracle, while
    /// USDC/USD is stale or off its peg (the depeg guard), while any held class
    /// F token's feed is unusable, and for a 17th token.
    function deposit(address token, uint256 amount) external nonReentrant onlyOwner {
        if (amount == 0) revert ZeroAmount();
        if (mode == AccountMode.PAUSED) revert DepositsPaused();
        if (depositsClosed) revert DepositsAreClosed();
        address agentOwner = AGENT_NFT.ownerOf(agentId);
        if (agentOwner != owner) revert NotAgentOwner(agentOwner);
        if (token != USDC) {
            TokenRecord memory r = TOKENS.tokenRecord(token);
            if (r.lane != Lane.CORE || r.priceClass != PriceClass.F || r.status != TokenStatus.BUYABLE) {
                revert NotDepositable(token);
            }
        }

        // Valued once: the depeg guard, then every held token at its price.
        IOracleV3 oracle = _oracle();
        _requireUsdcPeg(oracle);
        _addHeld(token);
        Valuation memory v = _valuation(oracle, new address[](0), new bytes[](0));
        _cachePrices(v);
        uint256 value;
        for (uint256 i = 0; i < v.tokens.length; ++i) {
            if (v.tokens[i] == token) value = _valueOf(amount, v.prices[i], v.decimals[i]);
        }
        _mintUnits(value, v.nav);

        uint256 principalAfter = principal + value;
        principal = principalAfter;
        IDepositLedger(address(config)).recordDeposit(owner, principalAfter, value);

        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received != amount) revert TransferNotExact(token, received, amount);
        _addBasis(token, value);
        emit Deposited(token, amount, value, principalAfter);
    }

    // ---------------------------------------------------------------------
    // The screened-lane opt-in (D-351)
    // ---------------------------------------------------------------------

    /// The owner's own choice to let the agent buy screened-lane tokens for this
    /// account. Opting out is the same call with false, at once.
    function setScreenedOptIn(bool optIn) external onlyOwner {
        emit ScreenedOptInSet(_screenedOptIn, optIn);
        _screenedOptIn = optIn;
    }

    function screenedOptIn() external view override(CustodyCoreV3, IRegistryAccount) returns (bool) {
        return _screenedOptIn;
    }

    function isVault() external pure override(CustodyCoreV3, IRegistryAccount) returns (bool) {
        return false;
    }

    // ---------------------------------------------------------------------
    // Core hooks
    // ---------------------------------------------------------------------

    function _isOwner(address who) internal view override returns (bool) {
        return who == owner;
    }

    function _mayClaim(address who) internal view override returns (bool) {
        return who == owner;
    }

    /// Trading needs the agent still to belong to this account's owner and the
    /// intent's epoch to be current: a sale stops it in the same transaction.
    function _checkTrading(SwapParamsV3 calldata p) internal view override {
        address agentOwner = AGENT_NFT.ownerOf(agentId);
        if (agentOwner != owner) revert NotAgentOwner(agentOwner);
        uint64 epoch = AGENT_NFT.ownerEpoch(agentId);
        if (p.ownershipEpoch != epoch) revert StaleEpoch(p.ownershipEpoch, epoch);
    }

    /// Keeps units and principal in step with what left. Reads no oracle and
    /// cannot revert on arithmetic: a withdrawal never depends on either.
    function _afterWithdraw(address token, uint256 amount, uint256 freeOut, bool empty) internal override {
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

    /// Burns units in proportion to the value that left, at the last prices
    /// the priced actions used, rounding up, so the units left never gain value
    /// from a withdrawal. An empty account, or one whose units all burn,
    /// starts afresh: no units and no peak.
    function _burnUnits(address token, uint256 freeOut, bool empty) private {
        uint256 u = units;
        if (u == 0) return;
        uint256 left;
        if (!empty) {
            if (freeOut == 0) return;
            uint256 px = _lastPriceOf(token);
            uint8 dec = _decimalsOf(token);
            // The value that left is the exact fall in NAV (each side rounded as
            // NAV rounds), never the withdrawn amount valued on its own, which
            // can round to less and let a dust withdrawal lower the value per unit (L-104).
            (, uint256 balance) = _readBalance(token);
            uint256 freeAfter = _free(token, balance);
            uint256 valueOut = _valueOf(freeAfter + freeOut, px, dec) - _valueOf(freeAfter, px, dec);
            if (valueOut == 0) return;
            // valueOut <= NAV before, so the burn is at most u.
            uint256 burn = Math.mulDiv(u, valueOut, _navAtLastPrices() + valueOut, Math.Rounding.Ceil);
            left = u - burn;
        }
        units = left;
        emit UnitsChanged(u, left);
        if (left == 0) _resetPeaks();
    }

    /// Lowers the principal by USDC taken out (another token lowers nothing,
    /// which only errs towards the cap), or to zero once the account is empty,
    /// then tells the factory without depending on it.
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
