// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AccountMode, SwapParams, ICustodyConfig, IValuationOracle, ISwapExecutor} from "../interfaces/ICustody.sol";

/// @title CustodyCore
/// @notice The custody core (FINAL_PLAN 4.1.6): the only code that holds user
/// capital. PersonalAccount is this core in single-owner mode; the
/// StrategyVault (P7-U1) will be the same core in public-vault mode. Written
/// clean-room from the plan; no code is taken from any researched vault.
///
/// Funds can leave in exactly two ways:
/// 1. The owner's withdrawal (`withdraw`, `withdrawAll`, `claim`). It is
///    always on: no mode, pause, oracle, Executor or platform call stands in
///    its way. The only external calls are to the token being moved.
/// 2. `executeSwap`, callable only by the Executor the factory names, which
///    starts unset and changes only through the factory's timelock. Inside it
///    the Executor may pull exactly the intent's `amountIn` of `tokenIn` once
///    (`pullForSwap`), and the core then checks the result itself, with
///    backstops slightly looser than the Executor's own limits, so they hold
///    even if the Executor or its key is compromised.
///
/// The core never approves any spender, has no `receive()` and no payable
/// function, and has no generic call or delegatecall path.
abstract contract CustodyCore is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Constants: the core's backstops (FINAL_PLAN 4.7.8)
    // ---------------------------------------------------------------------

    uint256 public constant BPS = 10_000;
    /// One trade's input may be worth at most 12% of the account (the Executor allows 10%).
    uint256 public constant MAX_TRADE_BPS = 1_200;
    /// After a trade, one non-USDC asset may be at most 45% of the account (the Executor allows 40%).
    uint256 public constant MAX_ASSET_BPS = 4_500;
    /// A trade's output must be worth at least 99% of its input at oracle prices
    /// (the Executor allows 0.5% plus the pool fee).
    uint256 public constant MAX_SLIPPAGE_BPS = 100;

    // ---------------------------------------------------------------------
    // Immutable: the held-asset list (D-056)
    // ---------------------------------------------------------------------

    /// USDC: the reduce-only output and the cap's unit. Held at launch with WMON only.
    address public immutable USDC;
    /// Wrapped MON (D-167): accounts never hold native MON.
    address public immutable WMON;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// The factory: the source of the Executor, oracle, guardian, sentinel and buy list.
    ICustodyConfig public config;
    AccountMode public mode;
    /// Set by `closeDeposits`; separate from any pause, and never touches withdrawals.
    bool public depositsClosed;
    /// Per token: an amount a withdrawal could not pay out because the token's
    /// transfer reverted (a USDC pause or blacklist), kept for the owner to
    /// claim later and excluded from valuation and trading (D-071).
    mapping(address token => uint256) public claimable;

    /// The swap in progress, so `pullForSwap` works only inside `executeSwap`.
    struct SwapContext {
        address executor;
        address token;
        uint256 amount;
        bool open;
        bool pulled;
    }

    SwapContext private _swap;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event ModeChanged(AccountMode previous, AccountMode current, address indexed by);
    event DepositsClosedChanged(bool previous, bool current, address indexed by);
    event Withdrawn(address indexed token, uint256 amount, address indexed to);
    event ClaimableCredited(address indexed token, uint256 amount, uint256 total);
    event CreditClaimed(address indexed token, uint256 amount, address indexed to);
    event SwapExecuted(
        address indexed executor,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 valueIn,
        uint256 valueOut,
        uint256 navBefore,
        uint256 navAfter,
        uint64 ownershipEpoch,
        uint64 configEpoch
    );

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotOwner(address caller);
    error NotTightener(address caller);
    error NotExecutor(address caller);
    error ZeroAmount();
    error BadRecipient(address to);
    error NothingToClaim(address token);
    error NotHeldAsset(address token);
    error SameToken();
    error NotBuyable(address token);
    error ReduceOnly(AccountMode mode);
    error Expired(uint64 deadline);
    error InsufficientFree(address token, uint256 free);
    error OracleUnset();
    error SwapContextInvalid();
    error SpentTooMuch(uint256 spent, uint256 amountIn);
    error OutputTooLow(uint256 received, uint256 minAmountOut);
    error OtherBalanceFell(address token);
    error TradeTooLarge(uint256 valueIn, uint256 nav);
    error SlippageTooHigh(uint256 valueIn, uint256 valueOut);
    error ConcentrationTooHigh(address token, uint256 value, uint256 nav);

    constructor(address usdc, address wmon) {
        USDC = usdc;
        WMON = wmon;
    }

    // ---------------------------------------------------------------------
    // Hooks for the mode the core runs in
    // ---------------------------------------------------------------------

    /// Whether `who` owns this account (PersonalAccount: its fixed owner).
    function _isOwner(address who) internal view virtual returns (bool);

    /// Reverts unless the account may trade now under these epochs.
    function _checkTrading(SwapParams calldata p) internal view virtual;

    /// Called after every amount the owner's withdrawal paid out.
    function _afterWithdraw(address token, uint256 amount) internal virtual;

    modifier onlyOwner() {
        if (!_isOwner(msg.sender)) revert NotOwner(msg.sender);
        _;
    }

    // ---------------------------------------------------------------------
    // Owner withdrawal: always on
    // ---------------------------------------------------------------------

    /// Pays `amount` of any token the account holds to `to`. No mode, pause,
    /// oracle, Executor or platform check: only the owner and the token.
    function withdraw(address token, uint256 amount, address to) external nonReentrant onlyOwner {
        if (amount == 0) revert ZeroAmount();
        _checkRecipient(to);
        IERC20(token).safeTransfer(to, amount);
        _clampCredit(token);
        emit Withdrawn(token, amount, to);
        _afterWithdraw(token, amount);
    }

    /// Pays every held asset's whole balance to `to`. A token whose transfer
    /// reverts is skipped and its balance recorded as a claimable credit, so
    /// the other assets still come out (D-071).
    function withdrawAll(address to) external nonReentrant onlyOwner {
        _checkRecipient(to);
        _withdrawAllOf(USDC, to);
        _withdrawAllOf(WMON, to);
    }

    /// Pays a claimable credit to `to`, which need not be the owner (a
    /// blacklisted owner can name another address). Reverts, keeping the
    /// credit, while the token still refuses the transfer.
    function claim(address token, address to) external nonReentrant onlyOwner {
        uint256 amount = claimable[token];
        if (amount == 0) revert NothingToClaim(token);
        _checkRecipient(to);
        claimable[token] = 0;
        IERC20(token).safeTransfer(to, amount);
        emit CreditClaimed(token, amount, to);
        _afterWithdraw(token, amount);
    }

    function _withdrawAllOf(address token, address to) private {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance == 0) return;
        if (IERC20(token).trySafeTransfer(to, balance)) {
            if (claimable[token] != 0) claimable[token] = 0;
            emit Withdrawn(token, balance, to);
            _afterWithdraw(token, balance);
        } else {
            claimable[token] = balance;
            emit ClaimableCredited(token, balance, balance);
        }
    }

    /// A credit never exceeds what the account still holds.
    function _clampCredit(address token) private {
        uint256 credit = claimable[token];
        if (credit == 0) return;
        uint256 left = IERC20(token).balanceOf(address(this));
        if (credit > left) claimable[token] = left;
    }

    function _checkRecipient(address to) private view {
        if (to == address(0) || to == address(this)) revert BadRecipient(to);
    }

    // ---------------------------------------------------------------------
    // Modes: the sentinel's tighten-only path (A-22, D-138)
    // ---------------------------------------------------------------------

    /// Only swaps whose output is USDC. Owner, guardian or sentinel; tightens only.
    function setReduceOnly() external {
        _checkTightener();
        if (mode == AccountMode.NORMAL) _setMode(AccountMode.REDUCE_ONLY);
    }

    /// No deposits and no new-risk swaps; withdrawals stay open. Owner, guardian or sentinel.
    function pause() external {
        _checkTightener();
        if (mode != AccountMode.PAUSED) _setMode(AccountMode.PAUSED);
    }

    /// No deposits; withdrawals stay open. Owner, guardian or sentinel.
    function closeDeposits() external {
        _checkTightener();
        if (!depositsClosed) {
            depositsClosed = true;
            emit DepositsClosedChanged(false, true, msg.sender);
        }
    }

    /// Back to NORMAL, after review. The owner only: never the guardian or the sentinel.
    function unpause() external onlyOwner {
        if (mode != AccountMode.NORMAL) _setMode(AccountMode.NORMAL);
    }

    /// Reopens deposits. The owner only.
    function openDeposits() external onlyOwner {
        if (depositsClosed) {
            depositsClosed = false;
            emit DepositsClosedChanged(true, false, msg.sender);
        }
    }

    function _checkTightener() private view {
        if (_isOwner(msg.sender) || msg.sender == config.guardian() || msg.sender == config.sentinel()) return;
        revert NotTightener(msg.sender);
    }

    function _setMode(AccountMode next) private {
        emit ModeChanged(mode, next, msg.sender);
        mode = next;
    }

    // ---------------------------------------------------------------------
    // Trading: the Executor's one path, with the core's own checks
    // ---------------------------------------------------------------------

    /// One swap for the registered Executor. The core calls back
    /// `ISwapExecutor.onSwap`, in which the Executor may pull exactly
    /// `amountIn` of `tokenIn` once and must pay `tokenOut` to this account;
    /// then the core checks every post-trade invariant and reverts the whole
    /// trade if one fails.
    function executeSwap(SwapParams calldata p) external nonReentrant {
        address executor = _checkSwap(p);
        IValuationOracle oracle = IValuationOracle(config.oracle());
        if (address(oracle) == address(0)) revert OracleUnset();
        Trade memory t = _before(p, oracle);

        _swap = SwapContext({executor: executor, token: p.tokenIn, amount: p.amountIn, open: true, pulled: false});
        ISwapExecutor(executor).onSwap(p);
        delete _swap;

        _after(p, oracle, t);
        emit SwapExecuted(
            executor,
            p.tokenIn,
            p.tokenOut,
            t.spent,
            t.received,
            t.valueSpent,
            t.valueOut,
            t.navBefore,
            t.navAfter,
            p.ownershipEpoch,
            p.configEpoch
        );
    }

    /// What one trade did, measured by the core.
    struct Trade {
        uint256 inBefore;
        uint256 outBefore;
        uint256 navBefore;
        uint256 spent;
        uint256 received;
        uint256 valueSpent;
        uint256 valueOut;
        uint256 navAfter;
    }

    /// Who may trade what, now: returns the Executor.
    function _checkSwap(SwapParams calldata p) private view returns (address executor) {
        executor = config.executor();
        if (executor == address(0) || msg.sender != executor) revert NotExecutor(msg.sender);
        if (p.tokenIn == p.tokenOut) revert SameToken();
        if (!_isHeld(p.tokenIn)) revert NotHeldAsset(p.tokenIn);
        if (!_isHeld(p.tokenOut)) revert NotHeldAsset(p.tokenOut);
        if (p.tokenOut != USDC && !config.isBuyable(p.tokenOut)) revert NotBuyable(p.tokenOut);
        // Under REDUCE_ONLY and PAUSED only swaps into USDC pass; which caller
        // may make one while PAUSED is the Executor's rule (emergency role only).
        if (mode != AccountMode.NORMAL && p.tokenOut != USDC) revert ReduceOnly(mode);
        if (block.timestamp > p.deadline) revert Expired(p.deadline);
        if (p.amountIn == 0) revert ZeroAmount();
        _checkTrading(p);
    }

    /// Balances and value before the swap, and the 12% trade-size backstop.
    function _before(SwapParams calldata p, IValuationOracle oracle) private view returns (Trade memory t) {
        t.inBefore = IERC20(p.tokenIn).balanceOf(address(this));
        t.outBefore = IERC20(p.tokenOut).balanceOf(address(this));
        uint256 freeIn = _free(p.tokenIn, t.inBefore);
        if (p.amountIn > freeIn) revert InsufficientFree(p.tokenIn, freeIn);
        t.navBefore = _nav(oracle);
        uint256 valueIn = oracle.valueUsdc(p.tokenIn, p.amountIn);
        if (valueIn * BPS > t.navBefore * MAX_TRADE_BPS) revert TradeTooLarge(valueIn, t.navBefore);
    }

    /// The post-trade invariants: only tokenIn down, by at most amountIn; only
    /// tokenOut up, by at least minAmountOut; no worse than 1% against the
    /// oracle; and no non-USDC asset above 45% afterwards. The core never
    /// approves anyone, so no allowance can be left behind.
    function _after(SwapParams calldata p, IValuationOracle oracle, Trade memory t) private view {
        uint256 inAfter = IERC20(p.tokenIn).balanceOf(address(this));
        uint256 outAfter = IERC20(p.tokenOut).balanceOf(address(this));
        t.spent = t.inBefore > inAfter ? t.inBefore - inAfter : 0;
        if (t.spent > p.amountIn) revert SpentTooMuch(t.spent, p.amountIn);
        t.received = outAfter > t.outBefore ? outAfter - t.outBefore : 0;
        if (t.received == 0 || t.received < p.minAmountOut) revert OutputTooLow(t.received, p.minAmountOut);

        t.valueSpent = oracle.valueUsdc(p.tokenIn, t.spent);
        t.valueOut = oracle.valueUsdc(p.tokenOut, t.received);
        if (t.valueOut * BPS < t.valueSpent * (BPS - MAX_SLIPPAGE_BPS)) {
            revert SlippageTooHigh(t.valueSpent, t.valueOut);
        }
        t.navAfter = _nav(oracle);
        if (p.tokenOut != USDC) {
            uint256 held = oracle.valueUsdc(p.tokenOut, _free(p.tokenOut, outAfter));
            if (held * BPS > t.navAfter * MAX_ASSET_BPS) revert ConcentrationTooHigh(p.tokenOut, held, t.navAfter);
        }
    }

    /// Inside `executeSwap` only: the Executor takes exactly the intent's
    /// `amountIn` of `tokenIn`, once. Anything else reverts.
    function pullForSwap(address token, uint256 amount) external {
        SwapContext memory s = _swap;
        if (!s.open || s.pulled || msg.sender != s.executor || token != s.token || amount != s.amount) {
            revert SwapContextInvalid();
        }
        _swap.pulled = true;
        IERC20(token).safeTransfer(s.executor, amount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// The held-asset list (D-056): what withdrawals and valuation cover.
    /// Separate from the factory's buy list, so dropping a token from buying
    /// never stops it being withdrawn.
    function heldAssets() external view returns (address[] memory assets) {
        assets = new address[](2);
        assets[0] = USDC;
        assets[1] = WMON;
    }

    /// A held token's balance minus its claimable credit: what valuation and trading see.
    function freeBalance(address token) external view returns (uint256) {
        return _free(token, IERC20(token).balanceOf(address(this)));
    }

    /// The account's value in USDC (6 decimals) at oracle prices, credits
    /// excluded. Reverts when no oracle is set or a price is unusable.
    function navUsdc() external view returns (uint256) {
        address oracle = config.oracle();
        if (oracle == address(0)) revert OracleUnset();
        return _nav(IValuationOracle(oracle));
    }

    function _isHeld(address token) internal view returns (bool) {
        return token == USDC || token == WMON;
    }

    function _free(address token, uint256 balance) internal view returns (uint256) {
        uint256 credit = claimable[token];
        return balance > credit ? balance - credit : 0;
    }

    function _nav(IValuationOracle oracle) internal view returns (uint256) {
        return oracle.valueUsdc(USDC, _free(USDC, IERC20(USDC).balanceOf(address(this))))
            + oracle.valueUsdc(WMON, _free(WMON, IERC20(WMON).balanceOf(address(this))));
    }
}
