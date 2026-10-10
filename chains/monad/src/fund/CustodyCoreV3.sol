// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AccountMode} from "../interfaces/ICustody.sol";
import {ICustodyConfigV3, IOracleV3, ISwapExecutorV3, SwapParamsV3} from "../interfaces/ICustodyV3.sol";
import {FeedConfig, ITokenRegistry, Lane, PriceClass, PriceReason, TokenRecord} from "../interfaces/IFund.sol";

/// @title CustodyCoreV3
/// @notice The custody core for the fund agent (FINAL_PLAN 0.4 and 4.1.6,
/// D-341, F-U3): the only code that holds user capital, for a portfolio of up
/// to 16 registered tokens. PersonalAccountV3 is this core in single-owner
/// mode; the StrategyVault (P7-U1) will be the same core in public-vault mode.
/// Written clean-room from the plan; no code is taken from any researched vault.
///
/// Funds can leave in exactly two ways:
/// 1. The owner's withdrawal (`withdraw`, `withdrawAll`, `claim`). It is
///    always on: no mode, pause, oracle, registry, Executor or platform call
///    stands in its way. The only external calls are to the tokens being moved
///    (and balance reads of the held tokens, which cannot revert it). A token
///    whose transfer reverts is skipped and recorded as a claimable credit.
/// 2. `executeSwap`, callable only by the Executor the factory names, which
///    changes only through the factory's timelock and can be set to none at
///    once. Inside it the Executor may pull exactly the intent's `amountIn` of
///    `tokenIn` once (`pullForSwap`), and the core then checks the result
///    itself, with backstops slightly looser than the Executor's own limits,
///    so they hold even if the Executor or its key is compromised.
///
/// The held list (D-056): every token the account holds, USDC first, at most
/// 16, each one registered in the TokenRegistry. A token joins when it is
/// deposited or bought and leaves when its balance reaches zero, so
/// `withdrawAll`, valuation and the empty check stay inside a block's gas. The
/// list is separate from what may be bought: a token the registry has moved to
/// sell-only or frozen is still valued, sold (if allowed) and withdrawn.
///
/// Prices (D-337) come from OracleAdapterV3, read once per transaction: class F
/// tokens from their feeds (any unusable feed fails the priced action closed),
/// class A tokens from the attestation the Executor passed, else from the last
/// attested price while it is under 24 hours old, else zero, which can only
/// tighten. The caps that must hold even against a wrong price do not use one:
/// each class A position's cost basis is at most 15% of the account's basis
/// and all class A positions together at most 50%, where the cost basis is the
/// USDC paid for what is held (moved pro rata on sells and withdrawals).
///
/// The core never approves any spender, has no `receive()` and no payable
/// function, and has no generic call or delegatecall path. The circuit breaker
/// (FINAL_PLAN 4.7.8, D-233) watches the account's value per unit over the
/// whole portfolio, so deposits and withdrawals never move it.
abstract contract CustodyCoreV3 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Constants: the core's backstops (FINAL_PLAN 0.4, 4.7.8)
    // ---------------------------------------------------------------------

    uint256 public constant BPS = 10_000;
    /// One trade's input may be worth at most 12% of the account (the Executor allows 10%).
    uint256 public constant MAX_TRADE_BPS = 1_200;
    /// After a trade, one class F asset other than USDC may be at most 45% of the account by value.
    uint256 public constant MAX_ASSET_BPS = 4_500;
    /// One class A position's cost basis may be at most 15% of the account's basis (D-337).
    uint256 public constant MAX_CLASS_A_POSITION_BPS = 1_500;
    /// All class A positions' cost basis together at most 50% of the account's basis (D-337).
    uint256 public constant MAX_CLASS_A_TOTAL_BPS = 5_000;
    /// A trade's output must be worth at least 99% of its input at the reference prices.
    uint256 public constant MAX_SLIPPAGE_BPS = 100;
    /// Deposits stop while USDC/USD is more than 1% from 1 (A-34); valuation and exits never read it.
    uint256 public constant MAX_DEPEG_BPS = 100;
    /// The held list's bound (A-62).
    uint256 public constant MAX_HELD_TOKENS = 16;
    /// A class A price counts in valuation for this long after its attestation; then it counts as zero.
    uint64 public constant ATTESTED_PRICE_TTL = 24 hours;
    /// A held token's decimals may be at most this, so no valuation can overflow and block a withdrawal.
    uint8 public constant MAX_DECIMALS = 36;
    /// Gas given to each token's transfer inside `withdrawAll`, so one token cannot burn the whole exit.
    uint256 public constant WITHDRAW_ALL_TRANSFER_GAS = 1_000_000;

    // ---------------------------------------------------------------------
    // Constants: the circuit breaker (FINAL_PLAN 4.7.8, D-233)
    // ---------------------------------------------------------------------

    /// A drop of 10% or more from the 7-day peak value per unit sets REDUCE_ONLY.
    uint256 public constant BREAKER_REDUCE_ONLY_BPS = 1_000;
    /// A drop of 20% or more sets PAUSED.
    uint256 public constant BREAKER_PAUSE_BPS = 2_000;
    /// The peak is kept as the highest value per unit seen on each UTC day, for
    /// today and the 7 days before: a peak counts for at least 7 days and at most 8.
    uint256 public constant PEAK_DAYS = 8;
    uint256 internal constant DAY = 1 days;
    uint256 internal constant ONE_E18 = 1e18;
    /// A price is USDC (6 decimals) per whole token scaled by 1e18, so an amount's
    /// value in USDC base units is amount × price / 10^(decimals + 12).
    uint256 internal constant PRICE_TO_USDC_DECIMALS = 12;

    // ---------------------------------------------------------------------
    // Immutables
    // ---------------------------------------------------------------------

    /// USDC: the unit of account, the reduce-only output, always the first held token.
    address public immutable USDC;
    /// The TokenRegistry (F-U2): what may be held and bought, and how each token is priced.
    ITokenRegistry public immutable TOKENS;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// The factory: the source of the Executor, oracle, guardian and sentinel.
    ICustodyConfigV3 public config;
    AccountMode public mode;
    /// Set by `closeDeposits`; separate from any pause, and never touches withdrawals.
    bool public depositsClosed;

    /// One held token's record.
    struct Held {
        bool present;
        uint8 decimals;
        uint8 index;
        /// When the last price was read from a feed or an attestation.
        uint64 lastPricedAt;
        /// USDC (6 decimals) paid for what is held; unused for USDC itself, whose basis is its balance.
        uint256 costBasis;
        /// The last price a priced action used. A withdrawal values what left
        /// at this price, only to keep the breaker's units in step; it never
        /// decides what the owner receives.
        uint256 lastPriceE18;
    }

    address[] private _held;
    mapping(address token => Held) private _records;

    /// Per token and beneficiary: an amount a withdrawal could not pay out
    /// because the token's transfer reverted (a USDC pause or blacklist), kept
    /// for the beneficiary to claim later and excluded from valuation and
    /// trading (D-071). The beneficiary is the owner in single-owner mode.
    mapping(address token => mapping(address who => uint256)) public claimable;
    /// Every beneficiary's credit in a token together: what `freeBalance` leaves out.
    mapping(address token => uint256) public totalClaimable;

    /// The swap in progress, so `pullForSwap` works only inside `executeSwap`.
    struct SwapContext {
        address executor;
        address token;
        uint256 amount;
        bool open;
        bool pulled;
    }

    SwapContext private _swap;

    /// The highest value per unit seen on one UTC day.
    struct PeakBucket {
        uint32 day;
        uint224 value;
    }

    /// One bucket per day, indexed by `day % PEAK_DAYS`.
    PeakBucket[8] private _peaks;

    // ---------------------------------------------------------------------
    // Memory shapes
    // ---------------------------------------------------------------------

    /// The whole portfolio valued once: balances, prices and totals.
    struct Valuation {
        address[] tokens;
        uint8[] decimals;
        uint256[] balances;
        uint256[] free;
        /// Zero for a class A token with no usable price.
        uint256[] prices;
        bool[] classA;
        /// Priced in this call by a feed or an attestation (cached afterwards).
        bool[] fresh;
        /// Market value: class F at the feed, class A at its attested price (zero when none is usable).
        uint256 nav;
        /// The value the caps use: class A at the lower of its cost basis and its value (D-337).
        uint256 capped;
        /// Every token's cost basis, USDC's being its free balance.
        uint256 totalBasis;
        uint256 classABasis;
    }

    /// What one trade did, measured by the core.
    struct Trade {
        uint256 inIndex;
        uint256 outIndex;
        uint256 priceIn;
        uint256 priceOut;
        uint256 navBefore;
        uint256 spent;
        uint256 received;
        uint256 valueSpent;
        uint256 valueOut;
        uint256 navAfter;
    }

    /// One held token as the indexer and the UI read it.
    struct Holding {
        address token;
        uint8 decimals;
        uint256 balance;
        uint256 free;
        uint256 costBasis;
        uint256 lastPriceE18;
        uint64 lastPricedAt;
    }

    /// What a trade event records.
    struct TradeRecord {
        uint256 amountIn;
        uint256 amountOut;
        uint256 valueIn;
        uint256 valueOut;
        uint256 priceInE18;
        uint256 priceOutE18;
        uint256 navBefore;
        uint256 navAfter;
        uint64 ownershipEpoch;
        uint64 configEpoch;
    }

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event ModeChanged(AccountMode previous, AccountMode current, address indexed by);
    event DepositsClosedChanged(bool previous, bool current, address indexed by);
    event Withdrawn(address indexed token, uint256 amount, address indexed to);
    event ClaimableCredited(address indexed token, address indexed who, uint256 amount, uint256 total);
    event CreditClaimed(address indexed token, address indexed who, uint256 amount, address indexed to);
    event HeldTokenAdded(address indexed token, uint8 decimals);
    event HeldTokenRemoved(address indexed token);
    event CostBasisChanged(address indexed token, uint256 previous, uint256 current);
    event AttestedPriceUsed(address indexed token, uint256 priceE18);
    event Poked(address indexed by, uint256 nav, uint256 perUnit, uint256 peak);
    event BreakerTripped(AccountMode mode, uint256 perUnit, uint256 peak, uint256 drawdownBps);
    event PeakReset(address indexed by);
    event SwapExecuted(
        address indexed executor,
        address indexed tokenIn,
        address indexed tokenOut,
        bytes32 routeHash,
        TradeRecord record
    );

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotOwner(address caller);
    error NotTightener(address caller);
    error NotExecutor(address caller);
    error NotClaimant(address caller);
    error ZeroAmount();
    error BadRecipient(address to);
    error NothingToClaim(address token);
    error NotHeldAsset(address token);
    error NotRegistered(address token);
    error BadDecimals(address token);
    error TooManyHeldTokens();
    error SameToken();
    error NotBuyable(address token);
    error NotSellable(address token);
    error UnpricedToken(address token);
    error ReduceOnly(AccountMode mode);
    error Expired(uint64 deadline);
    error InsufficientFree(address token, uint256 free);
    error OracleUnset();
    error UsdcFeedUnset();
    error UsdcFeedUnusable(PriceReason reason);
    error UsdcDepegged(uint256 priceE18);
    error SwapContextInvalid();
    error SpentTooMuch(uint256 spent, uint256 amountIn);
    error OutputTooLow(uint256 received, uint256 minAmountOut);
    error OtherBalanceFell(address token);
    error TradeTooLarge(uint256 valueIn, uint256 nav);
    error SlippageTooHigh(uint256 valueIn, uint256 valueOut);
    error ConcentrationTooHigh(address token, uint256 value, uint256 nav);
    error ClassAPositionTooLarge(address token, uint256 basis, uint256 totalBasis);
    error ClassATooLarge(uint256 classABasis, uint256 totalBasis);
    error LengthMismatch();

    constructor(address usdc, ITokenRegistry tokens) {
        USDC = usdc;
        TOKENS = tokens;
    }

    // ---------------------------------------------------------------------
    // Hooks for the mode the core runs in
    // ---------------------------------------------------------------------

    /// Whether `who` owns this account (PersonalAccountV3: its fixed owner).
    function _isOwner(address who) internal view virtual returns (bool);

    /// Whether `who` may claim credits recorded for them (single-owner mode: the owner).
    function _mayClaim(address who) internal view virtual returns (bool);

    /// Reverts unless the account may trade now under these epochs.
    function _checkTrading(SwapParamsV3 calldata p) internal view virtual;

    /// Called after every amount a withdrawal or claim paid out. `freeOut` is
    /// how much the token's free balance (balance minus credits) fell: zero for
    /// a token the account does not hold, and for a claimed credit. `empty` is
    /// whether every held token's balance is now zero.
    function _afterWithdraw(address token, uint256 amount, uint256 freeOut, bool empty) internal virtual;

    /// The account's value per unit, scaled by 1e18, for a NAV; zero when
    /// nothing is outstanding (the breaker then has nothing to watch).
    function _perUnit(uint256 nav) internal view virtual returns (uint256);

    /// Whether this account is a public vault (IRegistryAccount, D-351): a vault never buys screened tokens.
    function isVault() external view virtual returns (bool);

    /// Whether the owner opted in to screened-lane tokens (IRegistryAccount, D-351).
    function screenedOptIn() external view virtual returns (bool);

    modifier onlyOwner() {
        if (!_isOwner(msg.sender)) revert NotOwner(msg.sender);
        _;
    }

    // ---------------------------------------------------------------------
    // Owner withdrawal: always on
    // ---------------------------------------------------------------------

    /// Pays `amount` of any token the account holds to `to`. No mode, pause,
    /// oracle, registry, Executor or platform check: only the owner and the token.
    function withdraw(address token, uint256 amount, address to) external nonReentrant onlyOwner {
        if (amount == 0) revert ZeroAmount();
        _checkRecipient(to);
        bool held = _records[token].present;
        (, uint256 balanceBefore) = _readBalance(token);
        uint256 freeBefore = held ? _free(token, balanceBefore) : 0;
        IERC20(token).safeTransfer(to, amount);
        _clampCredit(token, msg.sender);
        emit Withdrawn(token, amount, to);
        (bool ok, uint256 balanceAfter) = _readBalance(token);
        uint256 freeAfter = held ? _free(token, balanceAfter) : 0;
        _settleWithdrawal(token, amount, freeBefore, freeAfter, ok && balanceAfter == 0);
    }

    /// Pays every held token's whole balance to `to`. A token whose transfer
    /// reverts, or burns more than WITHDRAW_ALL_TRANSFER_GAS, is skipped and
    /// its free balance recorded as the owner's claimable credit, so the other
    /// tokens still come out (D-071).
    function withdrawAll(address to) external nonReentrant onlyOwner {
        _checkRecipient(to);
        address[] memory tokens = _held;
        for (uint256 i = 0; i < tokens.length; ++i) {
            _withdrawAllOf(tokens[i], to);
        }
    }

    /// Pays the caller's claimable credit in `token` to `to`, which need not be
    /// the owner (a blacklisted owner can name another address). Reverts,
    /// keeping the credit, while the token still refuses the transfer.
    function claim(address token, address to) external nonReentrant {
        if (!_mayClaim(msg.sender)) revert NotClaimant(msg.sender);
        uint256 amount = claimable[token][msg.sender];
        if (amount == 0) revert NothingToClaim(token);
        _checkRecipient(to);
        claimable[token][msg.sender] = 0;
        uint256 total = totalClaimable[token];
        totalClaimable[token] = total > amount ? total - amount : 0;
        IERC20(token).safeTransfer(to, amount);
        emit CreditClaimed(token, msg.sender, amount, to);
        // The credit was never part of the free balance, so nothing free left.
        (bool ok, uint256 balanceAfter) = _readBalance(token);
        _settleWithdrawal(token, amount, 0, 0, ok && balanceAfter == 0);
    }

    function _withdrawAllOf(address token, address to) private {
        (bool ok, uint256 balance) = _readBalance(token);
        if (!ok) return;
        if (balance == 0) {
            if (token != USDC) _removeHeld(token);
            return;
        }
        uint256 freeBefore = _free(token, balance);
        if (_tryTransfer(token, to, balance)) {
            _clearCredit(token, msg.sender);
            emit Withdrawn(token, balance, to);
            (bool okAfter, uint256 balanceAfter) = _readBalance(token);
            _settleWithdrawal(token, balance, freeBefore, 0, okAfter && balanceAfter == 0);
        } else if (freeBefore != 0) {
            _credit(token, msg.sender, freeBefore);
        }
    }

    /// Bookkeeping after an amount left: the mode's hook (units, principal),
    /// then this token's cost basis and its place in the held list. Reads no
    /// oracle and cannot revert on arithmetic: a withdrawal never depends on it.
    function _settleWithdrawal(address token, uint256 amount, uint256 freeBefore, uint256 freeAfter, bool gone)
        private
    {
        uint256 freeOut = freeBefore > freeAfter ? freeBefore - freeAfter : 0;
        _afterWithdraw(token, amount, freeOut, _isEmpty());
        _reduceBasis(token, freeOut, freeBefore);
        if (gone && token != USDC && _records[token].present) _removeHeld(token);
    }

    /// A transfer with bounded gas whose outcome is read, never trusted: a
    /// token that reverts, returns false or burns its gas is reported as
    /// failed, and only one word of its return data is ever copied, so a
    /// token answering with a huge payload cannot exhaust the exit's gas.
    function _tryTransfer(address token, address to, uint256 amount) private returns (bool) {
        bytes memory data = abi.encodeCall(IERC20.transfer, (to, amount));
        uint256 gasLimit = WITHDRAW_ALL_TRANSFER_GAS;
        bool success;
        uint256 size;
        uint256 word;
        assembly ("memory-safe") {
            success := call(gasLimit, token, 0, add(data, 0x20), mload(data), 0, 0)
            size := returndatasize()
            if iszero(lt(size, 32)) {
                returndatacopy(0, 0, 32)
                word := mload(0)
            }
        }
        if (!success) return false;
        if (size == 0) return token.code.length > 0;
        return size >= 32 && word == 1;
    }

    /// A token's balance, read so that a token whose `balanceOf` reverts,
    /// answers short or answers with a huge payload cannot stop another token's
    /// withdrawal: at most one word of the answer is copied.
    function _readBalance(address token) internal view returns (bool ok, uint256 balance) {
        bytes memory data = abi.encodeCall(IERC20.balanceOf, (address(this)));
        bool success;
        uint256 size;
        uint256 word;
        assembly ("memory-safe") {
            success := staticcall(gas(), token, add(data, 0x20), mload(data), 0, 32)
            size := returndatasize()
            word := mload(0)
        }
        if (!success || size < 32) return (false, 0);
        return (true, word);
    }

    /// Whether every held token's balance is zero (a token whose balance cannot be read counts as zero).
    function _isEmpty() private view returns (bool) {
        for (uint256 i = 0; i < _held.length; ++i) {
            (, uint256 balance) = _readBalance(_held[i]);
            if (balance != 0) return false;
        }
        return true;
    }

    function _checkRecipient(address to) private view {
        if (to == address(0) || to == address(this)) revert BadRecipient(to);
    }

    // ---------------------------------------------------------------------
    // Credits (D-071)
    // ---------------------------------------------------------------------

    function _credit(address token, address who, uint256 amount) internal {
        uint256 mine = claimable[token][who] + amount;
        claimable[token][who] = mine;
        totalClaimable[token] += amount;
        emit ClaimableCredited(token, who, amount, mine);
    }

    /// After the whole balance went out, the beneficiary's credit is paid with it.
    function _clearCredit(address token, address who) private {
        uint256 mine = claimable[token][who];
        if (mine == 0) return;
        claimable[token][who] = 0;
        uint256 total = totalClaimable[token];
        totalClaimable[token] = total > mine ? total - mine : 0;
    }

    /// A credit never exceeds what the account still holds: a withdrawal paid
    /// out of a credited balance lowers the withdrawer's own credit.
    function _clampCredit(address token, address who) private {
        uint256 total = totalClaimable[token];
        if (total == 0) return;
        (bool ok, uint256 left) = _readBalance(token);
        if (!ok || total <= left) return;
        uint256 excess = total - left;
        uint256 mine = claimable[token][who];
        uint256 cut = excess < mine ? excess : mine;
        claimable[token][who] = mine - cut;
        totalClaimable[token] = total - cut;
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

    /// Back to NORMAL, after review. The owner only: never the guardian or the
    /// sentinel. The breaker's peak starts again from the next observation, so
    /// a drawdown the owner has reviewed does not trip the breaker again at once.
    function unpause() external onlyOwner {
        if (mode != AccountMode.NORMAL) _setMode(AccountMode.NORMAL);
        _resetPeaks();
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
    /// `ISwapExecutorV3.onSwap`, in which the Executor may pull exactly
    /// `amountIn` of `tokenIn` once and must pay `tokenOut` to this account;
    /// then the core checks every post-trade invariant and reverts the whole
    /// trade if one fails. `tokenOut` joins the held list here, so a 17th
    /// token is refused before anything moves.
    function executeSwap(SwapParamsV3 calldata p) external nonReentrant {
        address executor = _checkSwap(p);
        _addHeld(p.tokenOut);
        (address[] memory attTokens, bytes[] memory atts) = _swapAttestations(p);
        Valuation memory v = _valuation(_oracle(), attTokens, atts);
        _cachePrices(v);
        Trade memory t = _before(p, v);

        _swap = SwapContext({executor: executor, token: p.tokenIn, amount: p.amountIn, open: true, pulled: false});
        ISwapExecutorV3(executor).onSwap(p);
        delete _swap;

        _after(p, v, t);
        _observe(t.navAfter);
        emit SwapExecuted(
            executor,
            p.tokenIn,
            p.tokenOut,
            p.routeHash,
            TradeRecord({
                amountIn: t.spent,
                amountOut: t.received,
                valueIn: t.valueSpent,
                valueOut: t.valueOut,
                priceInE18: t.priceIn,
                priceOutE18: t.priceOut,
                navBefore: t.navBefore,
                navAfter: t.navAfter,
                ownershipEpoch: p.ownershipEpoch,
                configEpoch: p.configEpoch
            })
        );
    }

    /// Who may trade what, now: returns the Executor. Buying needs the
    /// registry's say for this account (a screened token only after the owner
    /// opted in, D-351); selling needs the token not to be frozen.
    function _checkSwap(SwapParamsV3 calldata p) private view returns (address executor) {
        executor = config.executor();
        if (executor == address(0) || msg.sender != executor) revert NotExecutor(msg.sender);
        if (p.tokenIn == p.tokenOut) revert SameToken();
        if (!_records[p.tokenIn].present) revert NotHeldAsset(p.tokenIn);
        if (!TOKENS.sellable(p.tokenIn)) revert NotSellable(p.tokenIn);
        if (p.tokenOut != USDC && !TOKENS.buyableFor(p.tokenOut, address(this))) revert NotBuyable(p.tokenOut);
        // Under REDUCE_ONLY and PAUSED only swaps into USDC pass; which caller
        // may make one while PAUSED is the Executor's rule (emergency role only).
        if (mode != AccountMode.NORMAL && p.tokenOut != USDC) revert ReduceOnly(mode);
        if (block.timestamp > p.deadline) revert Expired(p.deadline);
        if (p.amountIn == 0) revert ZeroAmount();
        _checkTrading(p);
    }

    function _swapAttestations(SwapParamsV3 calldata p)
        private
        pure
        returns (address[] memory tokens, bytes[] memory atts)
    {
        tokens = new address[](2);
        atts = new bytes[](2);
        tokens[0] = p.tokenIn;
        tokens[1] = p.tokenOut;
        atts[0] = p.attestationIn;
        atts[1] = p.attestationOut;
    }

    /// Both sides priced, the balance there, the 12% trade-size backstop on
    /// the capped value, and the breaker: a drawdown that would trip it refuses
    /// new risk even before anyone has poked, while a sale into USDC still goes through.
    function _before(SwapParamsV3 calldata p, Valuation memory v) private view returns (Trade memory t) {
        t.inIndex = _indexOf(v, p.tokenIn);
        t.outIndex = _indexOf(v, p.tokenOut);
        t.priceIn = v.prices[t.inIndex];
        t.priceOut = v.prices[t.outIndex];
        // Both sides need a price read in this call: a feed, or for a class A
        // token the attestation the Executor passed (a cached one is for valuation only).
        if (t.priceIn == 0 || !v.fresh[t.inIndex]) revert UnpricedToken(p.tokenIn);
        if (t.priceOut == 0 || !v.fresh[t.outIndex]) revert UnpricedToken(p.tokenOut);
        uint256 freeIn = v.free[t.inIndex];
        if (p.amountIn > freeIn) revert InsufficientFree(p.tokenIn, freeIn);
        t.navBefore = v.nav;
        if (p.tokenOut != USDC) {
            AccountMode due = _breakerMode(_perUnit(v.nav));
            if (due != AccountMode.NORMAL) revert ReduceOnly(due);
        }
        uint256 valueIn = _valueOf(p.amountIn, t.priceIn, v.decimals[t.inIndex]);
        if (valueIn * BPS > v.capped * MAX_TRADE_BPS) revert TradeTooLarge(valueIn, v.capped);
    }

    /// The post-trade invariants: only tokenIn down, by at most amountIn; only
    /// tokenOut up, by at least minAmountOut; no other held token down; no
    /// worse than 1% against the reference prices; then the cost basis moves
    /// with the trade and the caps hold: 45% by value for a class F token, the
    /// cost-basis caps for a class A token. The core never approves anyone, so
    /// no allowance can be left behind.
    function _after(SwapParamsV3 calldata p, Valuation memory v, Trade memory t) private {
        uint256[] memory after_ = new uint256[](v.tokens.length);
        for (uint256 i = 0; i < after_.length; ++i) {
            uint256 balance = IERC20(v.tokens[i]).balanceOf(address(this));
            after_[i] = balance;
            if (i == t.inIndex) {
                t.spent = v.balances[i] > balance ? v.balances[i] - balance : 0;
                if (t.spent > p.amountIn) revert SpentTooMuch(t.spent, p.amountIn);
            } else if (i == t.outIndex) {
                t.received = balance > v.balances[i] ? balance - v.balances[i] : 0;
                if (t.received == 0 || t.received < p.minAmountOut) revert OutputTooLow(t.received, p.minAmountOut);
            } else if (balance < v.balances[i]) {
                revert OtherBalanceFell(v.tokens[i]);
            }
        }
        t.valueSpent = _valueOf(t.spent, t.priceIn, v.decimals[t.inIndex]);
        t.valueOut = _valueOf(t.received, t.priceOut, v.decimals[t.outIndex]);
        if (t.valueOut * BPS < t.valueSpent * (BPS - MAX_SLIPPAGE_BPS)) {
            revert SlippageTooHigh(t.valueSpent, t.valueOut);
        }
        _moveBasis(p.tokenIn, p.tokenOut, t.spent, v.free[t.inIndex]);
        // The same prices over the post-trade balances: `v` now describes the account after the trade.
        _totals(v, after_);
        t.navAfter = v.nav;
        if (p.tokenOut != USDC) {
            if (v.classA[t.outIndex]) {
                uint256 basis = _records[p.tokenOut].costBasis;
                if (basis * BPS > v.totalBasis * MAX_CLASS_A_POSITION_BPS) {
                    revert ClassAPositionTooLarge(p.tokenOut, basis, v.totalBasis);
                }
                if (v.classABasis * BPS > v.totalBasis * MAX_CLASS_A_TOTAL_BPS) {
                    revert ClassATooLarge(v.classABasis, v.totalBasis);
                }
            } else {
                uint256 held = _valueOf(v.free[t.outIndex], t.priceOut, v.decimals[t.outIndex]);
                if (held * BPS > v.capped * MAX_ASSET_BPS) revert ConcentrationTooHigh(p.tokenOut, held, v.capped);
            }
        }
        if (after_[t.inIndex] == 0 && p.tokenIn != USDC) _removeHeld(p.tokenIn);
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
    // The cost-basis ledger (D-337): USDC paid for what is held, with no price
    // ---------------------------------------------------------------------

    /// A buy with USDC adds what was spent to the bought token's basis; a sale
    /// into USDC realizes the sold share of the token's basis; a swap between
    /// two other tokens moves that share from one to the other.
    function _moveBasis(address tokenIn, address tokenOut, uint256 spent, uint256 freeInBefore) private {
        uint256 moved;
        if (tokenIn == USDC) {
            moved = spent;
        } else {
            Held storage h = _records[tokenIn];
            uint256 basis = h.costBasis;
            moved = freeInBefore == 0 ? 0 : Math.mulDiv(basis, spent, freeInBefore);
            if (moved != 0) {
                h.costBasis = basis - moved;
                emit CostBasisChanged(tokenIn, basis, basis - moved);
            }
        }
        if (tokenOut != USDC && moved != 0) _addBasis(tokenOut, moved);
    }

    function _addBasis(address token, uint256 value) internal {
        if (token == USDC || value == 0) return;
        Held storage h = _records[token];
        uint256 basis = h.costBasis;
        h.costBasis = basis + value;
        emit CostBasisChanged(token, basis, basis + value);
    }

    /// A withdrawal takes its share of the basis with it, in proportion to the
    /// free balance that left. Rounds the basis kept up, which only tightens the caps.
    function _reduceBasis(address token, uint256 freeOut, uint256 freeBefore) private {
        if (token == USDC || freeOut == 0 || freeBefore == 0) return;
        Held storage h = _records[token];
        if (!h.present) return;
        uint256 basis = h.costBasis;
        uint256 cut = Math.mulDiv(basis, freeOut, freeBefore);
        if (cut == 0) return;
        h.costBasis = basis - cut;
        emit CostBasisChanged(token, basis, basis - cut);
    }

    // ---------------------------------------------------------------------
    // The held list
    // ---------------------------------------------------------------------

    /// Adds a registered token to the held list, refusing a 17th or one whose
    /// decimals could overflow valuation. Nothing for a token already held.
    function _addHeld(address token) internal {
        if (_records[token].present) return;
        if (_held.length >= MAX_HELD_TOKENS) revert TooManyHeldTokens();
        TokenRecord memory r = TOKENS.tokenRecord(token);
        if (r.lane == Lane.NONE) revert NotRegistered(token);
        if (r.decimals > MAX_DECIMALS) revert BadDecimals(token);
        _records[token] = Held({
            present: true,
            decimals: r.decimals,
            // forge-lint: disable-next-line(unsafe-typecast)
            index: uint8(_held.length),
            lastPricedAt: 0,
            costBasis: 0,
            lastPriceE18: 0
        });
        _held.push(token);
        emit HeldTokenAdded(token, r.decimals);
    }

    /// Takes a token with no balance off the list (never USDC), freeing its slot.
    function _removeHeld(address token) private {
        Held memory h = _records[token];
        uint256 last = _held.length - 1;
        if (h.index != last) {
            address moved = _held[last];
            _held[h.index] = moved;
            _records[moved].index = h.index;
        }
        _held.pop();
        delete _records[token];
        emit HeldTokenRemoved(token);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// The held list (D-056): what withdrawals and valuation cover, USDC first.
    function heldTokens() external view returns (address[] memory) {
        return _held;
    }

    function heldCount() external view returns (uint256) {
        return _held.length;
    }

    function isHeld(address token) external view returns (bool) {
        return _records[token].present;
    }

    /// Every held token with its balance, free balance, cost basis and last price.
    function holdings() external view returns (Holding[] memory out) {
        out = new Holding[](_held.length);
        for (uint256 i = 0; i < out.length; ++i) {
            address t = _held[i];
            Held memory h = _records[t];
            (, uint256 balance) = _readBalance(t);
            out[i] = Holding({
                token: t,
                decimals: h.decimals,
                balance: balance,
                free: _free(t, balance),
                costBasis: t == USDC ? _free(t, balance) : h.costBasis,
                lastPriceE18: t == USDC ? ONE_E18 : h.lastPriceE18,
                lastPricedAt: h.lastPricedAt
            });
        }
    }

    /// A held token's balance minus every claimable credit in it: what valuation and trading see.
    function freeBalance(address token) external view returns (uint256) {
        (, uint256 balance) = _readBalance(token);
        return _free(token, balance);
    }

    /// The USDC paid for what is held of a token (USDC itself: its free balance).
    function costBasis(address token) external view returns (uint256) {
        if (token == USDC) {
            (, uint256 balance) = _readBalance(token);
            return _free(token, balance);
        }
        return _records[token].costBasis;
    }

    /// The last price a priced action used for a token, and when it was read.
    function lastPrice(address token) external view returns (uint256 priceE18, uint64 pricedAt) {
        if (token == USDC) return (ONE_E18, uint64(block.timestamp));
        Held memory h = _records[token];
        return (h.lastPriceE18, h.lastPricedAt);
    }

    /// The account's value in USDC (6 decimals): class F at the feeds, class A
    /// at its last attested price under 24 hours old (else zero), credits
    /// excluded. Reverts when no oracle is set or a class F price is unusable.
    function navUsdc() external view returns (uint256) {
        return _valuation(_oracle(), new address[](0), new bytes[](0)).nav;
    }

    /// The value the caps use, every cost basis summed, and the class A share of it. Reverts like `navUsdc`.
    function capValues() external view returns (uint256 capped, uint256 totalBasis, uint256 classABasis) {
        Valuation memory v = _valuation(_oracle(), new address[](0), new bytes[](0));
        return (v.capped, v.totalBasis, v.classABasis);
    }

    /// The breaker's view now: NAV, value per unit (1e18 = 1 USDC), the 7-day
    /// peak including now, and the drop from it in basis points (rounded
    /// down). Reverts like `navUsdc`.
    function breakerState() external view returns (uint256 nav, uint256 perUnit, uint256 peak, uint256 drawdownBps) {
        nav = _valuation(_oracle(), new address[](0), new bytes[](0)).nav;
        perUnit = _perUnit(nav);
        peak = _peak();
        if (perUnit > peak) peak = perUnit;
        if (peak != 0) drawdownBps = (peak - perUnit) * BPS / peak;
    }

    /// The highest value per unit recorded in the last 7 to 8 days. Reads no oracle.
    function peakPerUnit7d() external view returns (uint256) {
        return _peak();
    }

    /// The recorded peak buckets, oldest slot first, for the indexer and tests.
    function peakBuckets() external view returns (PeakBucket[8] memory) {
        return _peaks;
    }

    // ---------------------------------------------------------------------
    // The circuit breaker
    // ---------------------------------------------------------------------

    /// Anyone may value the account and record the result: the peak moves up,
    /// and a drop from it of 10% or 20% tightens the mode. Never loosens.
    /// Class A tokens may be brought up to date with attestations, paired by
    /// token; without one a class A price older than 24 hours counts as zero.
    /// Reverts when a class F price is unusable or an attestation is invalid.
    function poke(address[] calldata tokens, bytes[] calldata attestations)
        external
        nonReentrant
        returns (uint256 nav, uint256 perUnit, uint256 peak)
    {
        if (tokens.length != attestations.length) revert LengthMismatch();
        Valuation memory v = _valuation(_oracle(), tokens, attestations);
        _cachePrices(v);
        nav = v.nav;
        (perUnit, peak) = _observe(nav);
        emit Poked(msg.sender, nav, perUnit, peak);
    }

    /// `poke` with no attestations.
    function poke() external nonReentrant returns (uint256 nav, uint256 perUnit, uint256 peak) {
        Valuation memory v = _valuation(_oracle(), new address[](0), new bytes[](0));
        _cachePrices(v);
        nav = v.nav;
        (perUnit, peak) = _observe(nav);
        emit Poked(msg.sender, nav, perUnit, peak);
    }

    /// Records one value per unit and applies the breaker. Returns the value
    /// per unit and the peak after recording it.
    function _observe(uint256 nav) internal returns (uint256 perUnit, uint256 peak) {
        perUnit = _perUnit(nav);
        if (perUnit == 0) return (0, _peak());
        uint256 today = block.timestamp / DAY;
        PeakBucket storage b = _peaks[today % PEAK_DAYS];
        uint224 v = perUnit > type(uint224).max ? type(uint224).max : uint224(perUnit);
        // forge-lint: disable-next-line(unsafe-typecast)
        if (b.day != today) _peaks[today % PEAK_DAYS] = PeakBucket(uint32(today), v);
        else if (v > b.value) b.value = v;
        peak = _peak();
        AccountMode due = _breakerModeFor(perUnit, peak);
        AccountMode now_ = mode;
        bool tighter = (due == AccountMode.PAUSED && (now_ == AccountMode.NORMAL || now_ == AccountMode.REDUCE_ONLY))
            || (due == AccountMode.REDUCE_ONLY && now_ == AccountMode.NORMAL);
        if (tighter) {
            _setMode(due);
            emit BreakerTripped(due, perUnit, peak, (peak - perUnit) * BPS / peak);
        }
    }

    /// The mode the breaker calls for at this value per unit against the
    /// recorded peak (and the value itself, if higher). Reads no state but the peak.
    function _breakerMode(uint256 perUnit) internal view returns (AccountMode) {
        if (perUnit == 0) return AccountMode.NORMAL;
        uint256 peak = _peak();
        return _breakerModeFor(perUnit, perUnit > peak ? perUnit : peak);
    }

    /// The thresholds are inclusive: a drop of exactly 10% sets REDUCE_ONLY
    /// (breakerMode in packages/policy agrees).
    function _breakerModeFor(uint256 perUnit, uint256 peak) internal pure returns (AccountMode) {
        if (peak == 0 || perUnit >= peak) return AccountMode.NORMAL;
        uint256 drop = peak - perUnit;
        if (drop * BPS >= peak * BREAKER_PAUSE_BPS) return AccountMode.PAUSED;
        if (drop * BPS >= peak * BREAKER_REDUCE_ONLY_BPS) return AccountMode.REDUCE_ONLY;
        return AccountMode.NORMAL;
    }

    /// The highest bucket from today and the 7 days before.
    function _peak() internal view returns (uint256 peak) {
        uint256 today = block.timestamp / DAY;
        for (uint256 i = 0; i < PEAK_DAYS; ++i) {
            PeakBucket memory b = _peaks[i];
            if (b.value > peak && b.day <= today && b.day + PEAK_DAYS > today) peak = b.value;
        }
    }

    function _resetPeaks() internal {
        bool any;
        for (uint256 i = 0; i < PEAK_DAYS; ++i) {
            if (_peaks[i].value != 0) {
                delete _peaks[i];
                any = true;
            }
        }
        if (any) emit PeakReset(msg.sender);
    }

    // ---------------------------------------------------------------------
    // Prices and values
    // ---------------------------------------------------------------------

    function _oracle() internal view returns (IOracleV3 oracle) {
        oracle = IOracleV3(config.oracle());
        if (address(oracle) == address(0)) revert OracleUnset();
    }

    /// Reverts unless USDC/USD is fresh, valid and within 1% of 1 (A-34): the
    /// deposit guard. Read through the oracle's own feed check; never by trades or exits.
    function _requireUsdcPeg(IOracleV3 oracle) internal view {
        FeedConfig memory f = TOKENS.feedOf(USDC);
        if (f.usd.feed == address(0)) revert UsdcFeedUnset();
        (uint256 value,, PriceReason reason) = oracle.readLeg(f.usd);
        if (reason != PriceReason.OK) revert UsdcFeedUnusable(reason);
        uint256 diff = value > ONE_E18 ? value - ONE_E18 : ONE_E18 - value;
        if (diff * BPS > ONE_E18 * MAX_DEPEG_BPS) revert UsdcDepegged(value);
    }

    /// The whole held list valued once: every balance, every price (class F
    /// from its feed, class A from an attestation given for it, else its cached
    /// price while under 24 hours old, else zero) and the totals.
    function _valuation(IOracleV3 oracle, address[] memory attTokens, bytes[] memory atts)
        internal
        view
        returns (Valuation memory v)
    {
        uint256 n = _held.length;
        v.tokens = new address[](n);
        v.decimals = new uint8[](n);
        v.balances = new uint256[](n);
        v.prices = new uint256[](n);
        v.classA = new bool[](n);
        v.fresh = new bool[](n);
        for (uint256 i = 0; i < n; ++i) {
            address t = _held[i];
            Held memory h = _records[t];
            v.tokens[i] = t;
            v.decimals[i] = h.decimals;
            v.balances[i] = IERC20(t).balanceOf(address(this));
            if (t == USDC) {
                v.prices[i] = ONE_E18;
                v.fresh[i] = true;
                continue;
            }
            PriceClass cls = TOKENS.tokenRecord(t).priceClass;
            if (cls == PriceClass.F) {
                v.prices[i] = oracle.priceE18(t);
                v.fresh[i] = true;
            } else if (cls == PriceClass.A) {
                v.classA[i] = true;
                bytes memory att = _attestationFor(t, attTokens, atts);
                if (att.length != 0) {
                    v.prices[i] = oracle.attestedPriceE18(t, att);
                    v.fresh[i] = true;
                } else if (h.lastPricedAt + ATTESTED_PRICE_TTL > block.timestamp) {
                    v.prices[i] = h.lastPriceE18;
                }
            }
        }
        _totals(v, v.balances);
    }

    /// Fills a valuation's totals over these balances, at its prices: the free
    /// balances, market NAV, the capped value and the cost-basis sums.
    function _totals(Valuation memory v, uint256[] memory balances) internal view {
        uint256 n = v.tokens.length;
        v.free = new uint256[](n);
        v.nav = 0;
        v.capped = 0;
        v.totalBasis = 0;
        v.classABasis = 0;
        for (uint256 i = 0; i < n; ++i) {
            address t = v.tokens[i];
            uint256 free = _free(t, balances[i]);
            v.free[i] = free;
            uint256 value = _valueOf(free, v.prices[i], v.decimals[i]);
            uint256 basis = t == USDC ? free : _records[t].costBasis;
            v.nav += value;
            v.totalBasis += basis;
            if (v.classA[i]) {
                v.capped += value < basis ? value : basis;
                v.classABasis += basis;
            } else {
                v.capped += value;
            }
        }
    }

    /// Writes the prices this call read from a feed or an attestation.
    function _cachePrices(Valuation memory v) internal {
        for (uint256 i = 0; i < v.tokens.length; ++i) {
            if (!v.fresh[i] || v.tokens[i] == USDC) continue;
            Held storage h = _records[v.tokens[i]];
            h.lastPriceE18 = v.prices[i];
            // forge-lint: disable-next-line(unsafe-typecast)
            h.lastPricedAt = uint64(block.timestamp);
            if (v.classA[i]) emit AttestedPriceUsed(v.tokens[i], v.prices[i]);
        }
    }

    function _attestationFor(address token, address[] memory tokens, bytes[] memory atts)
        private
        pure
        returns (bytes memory)
    {
        for (uint256 i = 0; i < tokens.length; ++i) {
            if (tokens[i] == token && atts[i].length != 0) return atts[i];
        }
        return "";
    }

    function _indexOf(Valuation memory v, address token) private pure returns (uint256) {
        for (uint256 i = 0; i < v.tokens.length; ++i) {
            if (v.tokens[i] == token) return i;
        }
        revert NotHeldAsset(token);
    }

    /// The USDC value (6 decimals) of an amount of a token at a price, rounded down.
    function _valueOf(uint256 amount, uint256 priceE18, uint8 decimals) internal pure returns (uint256) {
        if (amount == 0 || priceE18 == 0) return 0;
        return Math.mulDiv(amount, priceE18, 10 ** (uint256(decimals) + PRICE_TO_USDC_DECIMALS));
    }

    /// NAV at the last prices every priced action used, credits excluded: what
    /// a withdrawal values against, reading no oracle and never reverting.
    function _navAtLastPrices() internal view returns (uint256 nav) {
        for (uint256 i = 0; i < _held.length; ++i) {
            address t = _held[i];
            (, uint256 balance) = _readBalance(t);
            nav += _valueOf(_free(t, balance), _lastPriceOf(t), _records[t].decimals);
        }
    }

    /// A held token's last price (USDC exactly 1), for the units a withdrawal burns.
    function _lastPriceOf(address token) internal view returns (uint256) {
        return token == USDC ? ONE_E18 : _records[token].lastPriceE18;
    }

    function _decimalsOf(address token) internal view returns (uint8) {
        return _records[token].decimals;
    }

    function _free(address token, uint256 balance) internal view returns (uint256) {
        uint256 credit = totalClaimable[token];
        return balance > credit ? balance - credit : 0;
    }
}
