// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AccountMode, IAgentNFTView, ISwapExecutor, SwapParams} from "../interfaces/ICustody.sol";
import {
    IExecutorAccount,
    IExecutorFactory,
    IVenueAdapter,
    Policy,
    Reason,
    SwapIntent
} from "../interfaces/IExecutor.sol";
import {IOracleAdapter, IOracleViews, OracleReason} from "../interfaces/IOracle.sol";
import {ProtocolRegistry} from "./ProtocolRegistry.sol";
import {RiskTimelock} from "./RiskTimelock.sol";

interface ICustodySwap {
    function executeSwap(SwapParams calldata p) external;
}

/// @title Executor
/// @notice The only contract that can trade an account's funds (FINAL_PLAN
/// 4.1.7), written clean-room from the plan.
///
/// - It accepts typed swap intents only, from the session key the agent's
///   owner registered, and never calldata, targets, selectors, delegatecall or
///   native value. The recipient is always the account.
/// - Every launch hard limit is checked in a fixed order, and a refusal
///   reverts with `Rejected(reason)`, the reason codes the chain tools and
///   "why the agent did not trade" share (packages/domain REJECTION_CODES).
///   packages/policy mirrors the order (`executorVerdict`); a shared fixture
///   holds the two together.
/// - Inside the account's `executeSwap` the Executor pulls exactly `amountIn`
///   once, hands it to the registry's adapter, which pays the account in the
///   same call, and keeps nothing; the account then checks its own balance
///   changes and backstops, and the Executor checks the post-trade limits.
/// - Loosening a limit or unpausing waits the 9-day timelock; tightening and
///   pausing are instant for the admin or the guardian.
contract Executor is ISwapExecutor, RiskTimelock, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant SCHEMA_VERSION = 1;
    uint256 public constant BPS = 10_000;
    /// The ring buffer of past trades per account: 20 slots, never reset by an
    /// epoch or policy change (FINAL_PLAN 4.1.7).
    uint256 public constant RING_SIZE = 20;
    /// The longest a session grant may run (A-35).
    uint256 public constant MAX_SESSION = 30 days;
    /// WMON has 18 decimals: amount × price (1e18 per whole token) / 1e30 is USDC.
    uint256 internal constant WMON_VALUE_SCALE = 1e30;

    /// Timelocked actions.
    uint8 public constant SET_POLICY = 1;
    uint8 public constant UNPAUSE = 2;
    uint8 public constant SET_GUARDIAN = 3;

    IAgentNFTView public immutable AGENT_NFT;
    address public immutable USDC;
    address public immutable WMON;

    /// Bound once after deployment (the factory is deployed after the Executor, D-235).
    IExecutorFactory public factory;
    ProtocolRegistry public registry;

    Policy internal _policy;
    /// keccak256(abi.encode(policy)): an intent names the policy it was checked under.
    bytes32 public policyHash;
    /// Set by the admin or the guardian; only the timelock lifts it.
    bool public paused;

    struct Grant {
        address key;
        uint64 ownerEpoch;
        uint64 configEpoch;
        uint64 validUntil;
    }

    struct PastTrade {
        uint64 at;
        uint192 valueUsdc;
    }

    struct Ring {
        PastTrade[20] trades;
        uint8 next;
    }

    mapping(uint256 agentId => Grant) internal _grants;
    /// The agent's configuration epoch (FINAL_PLAN 4.1.2): the owner bumps it
    /// when the agent's configuration changes, which ends its session grant.
    /// BuildRegistry takes it over in Phase 6 (D-238).
    mapping(uint256 agentId => uint64) public configEpochOf;
    mapping(address account => Ring) internal _rings;
    mapping(address account => mapping(bytes32 actionId => bool)) public actionUsed;

    /// The swap in progress, so `onSwap` works only inside it.
    struct Context {
        address account;
        address adapter;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
    }

    Context internal _ctx;

    event Bound(address indexed factory, address indexed registry);
    event PolicySet(bytes32 indexed previousHash, bytes32 indexed currentHash, Policy policy);
    event PausedSet(bool paused, address indexed by);
    event SessionRegistered(
        uint256 indexed agentId, address indexed key, uint64 ownerEpoch, uint64 configEpoch, uint64 validUntil
    );
    event SessionRevoked(uint256 indexed agentId, address indexed by);
    event ConfigEpochBumped(uint256 indexed agentId, uint64 configEpoch);
    event IntentExecuted(
        bytes32 indexed actionId,
        address indexed account,
        uint256 indexed agentId,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 oraclePriceE18,
        uint256 navBefore,
        uint256 navAfter
    );

    error Rejected(Reason reason);
    error AlreadyBound();
    error NotBound();
    error BadBinding();
    error BadPolicy();
    error NotTighter();
    error NotAgentOwner(address caller);
    error BadSession();
    error NotInSwap(address caller);
    error ExecutorKeptFunds(address token);
    error AllowanceLeft(address token);

    constructor(address admin, address guardian_, IAgentNFTView agentNft, address usdc, address wmon, Policy memory p)
        RiskTimelock(admin, guardian_)
    {
        if (address(agentNft) == address(0) || usdc == address(0) || wmon == address(0)) revert BadBinding();
        AGENT_NFT = agentNft;
        USDC = usdc;
        WMON = wmon;
        _setPolicy(p);
    }

    /// Binds the factory and registry, once, after both are deployed. The
    /// factory must already name this Executor.
    function bind(IExecutorFactory factory_, ProtocolRegistry registry_) external onlyOwner {
        if (address(factory) != address(0)) revert AlreadyBound();
        if (factory_.executor() != address(this) || address(registry_) == address(0)) revert BadBinding();
        factory = factory_;
        registry = registry_;
        emit Bound(address(factory_), address(registry_));
    }

    // ---------------------------------------------------------------------
    // Session grants (FINAL_PLAN 4.1.7, 4.2)
    // ---------------------------------------------------------------------

    /// The agent's owner names the session key that may submit its intents,
    /// until `validUntil`. The grant records the current ownership and
    /// configuration epochs, so a transfer, or a configuration change, ends it,
    /// and a grant never revives if the agent returns to a former owner (the
    /// ownership epoch only increases).
    function registerSession(uint256 agentId, address key, uint64 validUntil) external {
        if (AGENT_NFT.ownerOf(agentId) != msg.sender) revert NotAgentOwner(msg.sender);
        // forge-lint: disable-next-line(block-timestamp)
        if (key == address(0) || validUntil <= block.timestamp || validUntil > block.timestamp + MAX_SESSION) {
            revert BadSession();
        }
        uint64 oe = AGENT_NFT.ownerEpoch(agentId);
        uint64 ce = configEpochOf[agentId];
        _grants[agentId] = Grant(key, oe, ce, validUntil);
        emit SessionRegistered(agentId, key, oe, ce, validUntil);
    }

    /// The agent's owner ends its session grant at once.
    function revokeSession(uint256 agentId) external {
        if (AGENT_NFT.ownerOf(agentId) != msg.sender) revert NotAgentOwner(msg.sender);
        delete _grants[agentId];
        emit SessionRevoked(agentId, msg.sender);
    }

    /// The agent's owner bumps its configuration epoch, which ends the grant
    /// and makes every intent signed under the old epoch fail.
    function bumpConfigEpoch(uint256 agentId) external {
        if (AGENT_NFT.ownerOf(agentId) != msg.sender) revert NotAgentOwner(msg.sender);
        uint64 next = configEpochOf[agentId] + 1;
        configEpochOf[agentId] = next;
        emit ConfigEpochBumped(agentId, next);
    }

    function sessionOf(uint256 agentId) external view returns (Grant memory) {
        return _grants[agentId];
    }

    // ---------------------------------------------------------------------
    // The swap
    // ---------------------------------------------------------------------

    /// What `swap` measured, carried to the post-trade checks.
    struct Measure {
        address adapter;
        uint256 px;
        uint256 navBefore;
        uint256 valueIn;
        uint256 outBefore;
    }

    /// Executes one typed intent from the agent's session key, or reverts with
    /// `Rejected(reason)` for the first limit it breaks.
    function swap(SwapIntent calldata i) external nonReentrant returns (uint256 amountOut) {
        if (address(factory) == address(0)) revert NotBound();
        Policy memory p = _policy;
        _checkIntent(i);
        _checkSession(i);
        _checkDeadline(i, p);
        Measure memory m = _checkMarket(i, p);
        actionUsed[i.account][i.actionId] = true;

        m.outBefore = IERC20(i.tokenOut).balanceOf(i.account);
        _ctx = Context(i.account, m.adapter, i.tokenIn, i.tokenOut, i.amountIn, i.minAmountOut);
        ICustodySwap(i.account)
            .executeSwap(
                SwapParams({
                    tokenIn: i.tokenIn,
                    tokenOut: i.tokenOut,
                    amountIn: i.amountIn,
                    minAmountOut: i.minAmountOut,
                    poolId: i.adapterId,
                    deadline: i.deadline,
                    ownershipEpoch: i.ownerEpoch,
                    configEpoch: i.configEpoch
                })
            );
        delete _ctx;

        uint256 navAfter;
        (amountOut, navAfter) = _checkAfter(i, p, m);
        _record(i.account, m.valueIn);
        emit IntentExecuted(
            i.actionId, i.account, i.agentId, i.tokenIn, i.tokenOut, i.amountIn, amountOut, m.px, m.navBefore, navAfter
        );
    }

    /// Called by the account inside `executeSwap`: pull exactly `amountIn`,
    /// hand it to the adapter, which pays the account, and keep nothing.
    function onSwap(SwapParams calldata) external {
        Context memory c = _ctx;
        if (c.account == address(0) || msg.sender != c.account) revert NotInSwap(msg.sender);
        uint256 inBefore = IERC20(c.tokenIn).balanceOf(address(this));
        uint256 outBefore = IERC20(c.tokenOut).balanceOf(address(this));
        IExecutorAccount(c.account).pullForSwap(c.tokenIn, c.amountIn);
        IERC20(c.tokenIn).safeTransfer(c.adapter, c.amountIn);
        IVenueAdapter(c.adapter).swap(c.tokenIn, c.tokenOut, c.amountIn, c.minAmountOut, c.account);
        // Nothing stays with the Executor or the adapter, and no allowance is left.
        if (IERC20(c.tokenIn).balanceOf(address(this)) != inBefore) revert ExecutorKeptFunds(c.tokenIn);
        if (IERC20(c.tokenOut).balanceOf(address(this)) != outBefore) revert ExecutorKeptFunds(c.tokenOut);
        address venue = IVenueAdapter(c.adapter).venue();
        if (IERC20(c.tokenIn).allowance(c.adapter, venue) != 0) revert AllowanceLeft(c.tokenIn);
    }

    // ---------------------------------------------------------------------
    // The checks, in order (mirrored by executorVerdict in packages/policy)
    // ---------------------------------------------------------------------

    function _reject(Reason r) internal pure {
        revert Rejected(r);
    }

    /// The intent's own shape, the global pause and the asset list.
    function _checkIntent(SwapIntent calldata i) internal view {
        if (paused) _reject(Reason.PAUSED);
        if (i.schemaVersion != SCHEMA_VERSION || i.chainId != block.chainid) _reject(Reason.INTENT_INVALID);
        if (i.amountIn == 0 || i.minAmountOut == 0 || i.tokenIn == i.tokenOut) _reject(Reason.INTENT_INVALID);
        if (!_held(i.tokenIn) || !_held(i.tokenOut)) _reject(Reason.ASSET_NOT_ALLOWED);
        if (i.tokenOut != USDC && !factory.isBuyable(i.tokenOut)) _reject(Reason.ASSET_NOT_ALLOWED);
        if (i.policyHash != policyHash) _reject(Reason.INTENT_INVALID);
    }

    /// The session key, its grant, both epochs, the account and the actionId.
    function _checkSession(SwapIntent calldata i) internal view {
        Grant memory g = _grants[i.agentId];
        if (g.key == address(0) || msg.sender != g.key) _reject(Reason.SESSION_UNKNOWN);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > g.validUntil) _reject(Reason.SESSION_EXPIRED);
        uint64 oe = AGENT_NFT.ownerEpoch(i.agentId);
        uint64 ce = configEpochOf[i.agentId];
        if (i.ownerEpoch != oe || g.ownerEpoch != oe || i.configEpoch != ce || g.configEpoch != ce) {
            _reject(Reason.EPOCH_MISMATCH);
        }
        address owner_ = AGENT_NFT.ownerOf(i.agentId);
        if (i.account == address(0) || factory.personalAccountOf(i.agentId, owner_) != i.account) {
            _reject(Reason.INTENT_INVALID);
        }
        if (actionUsed[i.account][i.actionId]) _reject(Reason.ACTION_REPLAYED);
    }

    function _checkDeadline(SwapIntent calldata i, Policy memory p) internal view {
        // forge-lint: disable-next-line(block-timestamp)
        if (i.deadline < block.timestamp) _reject(Reason.DEADLINE_EXPIRED);
        // forge-lint: disable-next-line(block-timestamp)
        if (i.deadline > block.timestamp + p.deadlineSeconds) _reject(Reason.DEADLINE_TOO_FAR);
    }

    /// Mode, venue, oracle, balance, the breaker, size, rate, turnover and
    /// the oracle floor on `minAmountOut`.
    function _checkMarket(SwapIntent calldata i, Policy memory p) internal view returns (Measure memory m) {
        IExecutorAccount account = IExecutorAccount(i.account);
        bool intoUsdc = i.tokenOut == USDC;
        AccountMode mode = AccountMode(account.mode());
        if (mode == AccountMode.PAUSED) _reject(Reason.PAUSED);
        if (mode == AccountMode.HANDOVER) _reject(Reason.VAULT_IN_HANDOVER);
        if (mode != AccountMode.NORMAL && !intoUsdc) _reject(Reason.REDUCE_ONLY_MODE);

        m.adapter = registry.adapterFor(i.adapterId, i.tokenIn, i.tokenOut);
        if (m.adapter == address(0)) _reject(Reason.VENUE_NOT_ALLOWED);

        IOracleViews oracle = IOracleViews(factory.oracle());
        if (address(oracle) == address(0)) _reject(Reason.ORACLE_STALE);
        (bool ok, OracleReason why) = oracle.tradable(WMON);
        if (!ok) {
            _reject(
                why == OracleReason.POOL_DEVIATION || why == OracleReason.POOL_UNREADABLE
                    ? Reason.ORACLE_POOL_DEVIATION
                    : Reason.ORACLE_STALE
            );
        }
        m.px = IOracleAdapter(address(oracle)).priceE18(WMON);

        if (i.amountIn > account.freeBalance(i.tokenIn)) _reject(Reason.INSUFFICIENT_BALANCE);

        uint256 drawdown;
        (m.navBefore,,, drawdown) = account.breakerState();
        // A drawdown nobody has poked yet counts as the mode it would set (D-233).
        if (drawdown >= 2_000) _reject(Reason.PAUSED);
        if (drawdown >= 1_000 && !intoUsdc) _reject(Reason.REDUCE_ONLY_MODE);

        m.valueIn = _valueOf(i.tokenIn, i.amountIn, m.px);
        if (m.valueIn * BPS > m.navBefore * p.maxTradeBps) _reject(Reason.TRADE_SIZE_EXCEEDED);

        (uint256 count, uint256 turnover) = _window(i.account, p.windowSeconds);
        if (count >= p.maxTradesPerWindow) _reject(Reason.DAILY_TRADE_LIMIT);
        if ((turnover + m.valueIn) * BPS > m.navBefore * p.maxTurnoverBps) _reject(Reason.TURNOVER_CAP);

        if (i.minAmountOut < oracleFloor(i.tokenIn, i.tokenOut, i.amountIn, m.px, p.maxSlippageBps)) {
            _reject(Reason.SLIPPAGE_TOO_HIGH);
        }
    }

    /// The post-trade limits, on the account's balances after the swap, at the
    /// same price: the value lost is at most slippage plus the pool fee, and
    /// unless the output is USDC, at most 40% in WMON and at least 10% in USDC.
    function _checkAfter(SwapIntent calldata i, Policy memory p, Measure memory m)
        internal
        view
        returns (uint256 amountOut, uint256 navAfter)
    {
        IExecutorAccount account = IExecutorAccount(i.account);
        amountOut = IERC20(i.tokenOut).balanceOf(i.account) - m.outBefore;
        uint256 usdcFree = account.freeBalance(USDC);
        uint256 wmonValue = _valueOf(WMON, account.freeBalance(WMON), m.px);
        navAfter = usdcFree + wmonValue;
        uint256 allowed = Math.mulDiv(m.valueIn, p.maxSlippageBps + IVenueAdapter(m.adapter).feeBps(), BPS);
        if (navAfter + allowed < m.navBefore) _reject(Reason.SLIPPAGE_TOO_HIGH);
        if (i.tokenOut != USDC) {
            if (wmonValue * BPS > navAfter * p.maxAssetBps) _reject(Reason.CONCENTRATION_CAP);
            if (usdcFree * BPS < navAfter * p.minUsdcBps) _reject(Reason.USDC_FLOOR);
        }
    }

    // ---------------------------------------------------------------------
    // Values and the ring buffer
    // ---------------------------------------------------------------------

    /// The least output the intent may ask for: the oracle-implied output less
    /// the policy's slippage, rounded down.
    function oracleFloor(address tokenIn, address tokenOut, uint256 amountIn, uint256 px, uint256 slippageBps)
        public
        view
        returns (uint256)
    {
        // USDC into WMON: amount × 1e30 / price; WMON into USDC: its value.
        uint256 implied =
            tokenOut == USDC ? _valueOf(tokenIn, amountIn, px) : Math.mulDiv(amountIn, WMON_VALUE_SCALE, px);
        return Math.mulDiv(implied, BPS - slippageBps, BPS);
    }

    function _valueOf(address token, uint256 amount, uint256 px) internal view returns (uint256) {
        return token == USDC ? amount : Math.mulDiv(amount, px, WMON_VALUE_SCALE);
    }

    function _held(address token) internal view returns (bool) {
        return token == USDC || token == WMON;
    }

    /// Trades and turnover in the rolling window `(now - window, now]`.
    function _window(address account, uint256 window) internal view returns (uint256 count, uint256 turnover) {
        Ring storage r = _rings[account];
        for (uint256 k = 0; k < RING_SIZE; ++k) {
            PastTrade memory t = r.trades[k];
            // forge-lint: disable-next-line(block-timestamp)
            if (t.at != 0 && t.at + window > block.timestamp && t.at <= block.timestamp) {
                ++count;
                turnover += t.valueUsdc;
            }
        }
    }

    function _record(address account, uint256 valueIn) internal {
        Ring storage r = _rings[account];
        // forge-lint: disable-next-line(unsafe-typecast)
        r.trades[r.next] = PastTrade(uint64(block.timestamp), uint192(valueIn));
        r.next = uint8((uint256(r.next) + 1) % RING_SIZE);
    }

    // ---------------------------------------------------------------------
    // Views for the chain tools
    // ---------------------------------------------------------------------

    function policy() external view returns (Policy memory) {
        return _policy;
    }

    /// What the account may still do in the window: trades left, when the
    /// next slot frees, and turnover used, with the policy (FINAL_PLAN 4.1.7 `limits`).
    function limits(address account)
        external
        view
        returns (Policy memory p, uint256 tradesLeft, uint256 nextSlotFreesAt, uint256 turnoverUsed)
    {
        p = _policy;
        uint256 count;
        (count, turnoverUsed) = _window(account, p.windowSeconds);
        tradesLeft = count >= p.maxTradesPerWindow ? 0 : p.maxTradesPerWindow - count;
        if (tradesLeft == 0) {
            uint256 oldest = type(uint256).max;
            Ring storage r = _rings[account];
            for (uint256 k = 0; k < RING_SIZE; ++k) {
                PastTrade memory t = r.trades[k];
                // forge-lint: disable-next-line(block-timestamp)
                if (t.at != 0 && t.at + p.windowSeconds > block.timestamp && t.at < oldest) oldest = t.at;
            }
            nextSlotFreesAt = oldest + p.windowSeconds;
        }
    }

    function pastTrades(address account) external view returns (PastTrade[20] memory) {
        return _rings[account].trades;
    }

    // ---------------------------------------------------------------------
    // Instant tightening: the admin or the guardian
    // ---------------------------------------------------------------------

    /// Stops every swap at once.
    function pauseAll() external {
        _checkAdminOrGuardian();
        if (!paused) {
            paused = true;
            emit PausedSet(true, msg.sender);
        }
    }

    /// A policy at least as strict as the current one in every limit, at once.
    function tightenPolicy(Policy calldata next) external {
        _checkAdminOrGuardian();
        Policy memory c = _policy;
        if (
            next.maxTradeBps > c.maxTradeBps || next.maxAssetBps > c.maxAssetBps || next.minUsdcBps < c.minUsdcBps
                || next.maxSlippageBps > c.maxSlippageBps || next.maxTurnoverBps > c.maxTurnoverBps
                || next.maxTradesPerWindow > c.maxTradesPerWindow || next.windowSeconds < c.windowSeconds
                || next.deadlineSeconds > c.deadlineSeconds
        ) revert NotTighter();
        _setPolicy(next);
    }

    // ---------------------------------------------------------------------
    // Timelocked loosening
    // ---------------------------------------------------------------------

    function _validateChange(uint8 action, bytes calldata data) internal pure override {
        if (action == SET_POLICY) _validatePolicy(abi.decode(data, (Policy)));
        else if (action == UNPAUSE) abi.decode(data, (bool));
        else if (action == SET_GUARDIAN) abi.decode(data, (address));
        else revert BadPolicy();
    }

    function _applyChange(uint8 action, bytes calldata data) internal override {
        if (action == SET_POLICY) {
            _setPolicy(abi.decode(data, (Policy)));
        } else if (action == UNPAUSE) {
            if (paused) {
                paused = false;
                emit PausedSet(false, msg.sender);
            }
        } else {
            _setGuardian(abi.decode(data, (address)));
        }
    }

    function _validatePolicy(Policy memory p) internal pure {
        if (
            p.maxTradeBps == 0 || p.maxTradeBps > BPS || p.maxAssetBps > BPS || p.minUsdcBps > BPS
                || p.maxSlippageBps >= BPS || p.maxTradesPerWindow == 0 || p.maxTradesPerWindow > RING_SIZE
                || p.windowSeconds == 0 || p.deadlineSeconds == 0
        ) revert BadPolicy();
    }

    function _setPolicy(Policy memory p) internal {
        _validatePolicy(p);
        bytes32 next = keccak256(abi.encode(p));
        emit PolicySet(policyHash, next, p);
        _policy = p;
        policyHash = next;
    }
}
