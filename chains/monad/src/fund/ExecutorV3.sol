// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AccountMode, IAgentNFTView} from "../interfaces/ICustody.sol";
import {ISwapExecutorV3, SwapParamsV3} from "../interfaces/ICustodyV3.sol";
import {
    IAdapterRegistry,
    IExecutorAccountV3,
    IExecutorFactoryV3,
    IRouteAdapter,
    PolicyV3,
    ReasonV3,
    SwapIntentV3
} from "../interfaces/IExecutorV3.sol";
import {
    IPoolRegistry,
    ITokenRegistry,
    Lane,
    PoolRecord,
    PriceClass,
    PriceReason,
    TokenRecord,
    TokenStatus
} from "../interfaces/IFund.sol";
import {RiskTimelock} from "../executor/RiskTimelock.sol";
import {OracleAdapterV3} from "./OracleAdapterV3.sol";

/// @title ExecutorV3
/// @notice The only contract that can trade a fund agent's portfolio
/// (FINAL_PLAN 0.4, 4.1.7, D-341, F-U4), written clean-room from the plan.
///
/// - It accepts typed swap intents only, from the session key the agent's
///   owner registered, for any pair of tokens the TokenRegistry lists, routed
///   through up to three registered pools by the RouteAdapter. It never takes
///   calldata, targets, selectors, delegatecall or native value. The recipient
///   is always the account.
/// - Every hard limit is checked across the whole portfolio in a fixed order,
///   and a refusal reverts with `Rejected(reason)`, the codes the chain tools
///   and "why the agent did not trade" share (packages/domain REJECTION_CODES).
///   packages/policy mirrors the order (`executorV3Verdict`); a shared fixture
///   holds the two together.
/// - Each side of a trade is priced on its own: a class F token by its feed,
///   a class A token by the attestation the intent carries, checked through
///   the registry's verifier (F-U12); until an attestor is set, class A trades
///   are refused by name. Slippage is 0.5% against the feeds and 1% against an
///   attested price (D-352); the value the trade may lose is that plus the
///   route's pool fees.
/// - Inside the account's `executeSwap` the Executor pulls exactly `amountIn`
///   once, hands it to the adapter, which pays the account in the same call,
///   checks what arrived against the intent's minimum, and keeps nothing; the
///   account then checks its own backstops and the cost-basis caps, and the
///   Executor checks the post-trade limits.
/// - Loosening a limit or unpausing waits the 9-day timelock; tightening and
///   pausing are instant for the admin or the guardian.
contract ExecutorV3 is ISwapExecutorV3, RiskTimelock, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant SCHEMA_VERSION = 2;
    uint256 public constant BPS = 10_000;
    /// The ring buffer of past trades per account: 20 slots, never reset by an
    /// epoch or policy change (FINAL_PLAN 4.1.7).
    uint256 public constant RING_SIZE = 20;
    /// The longest a session grant may run (A-35).
    uint256 public constant MAX_SESSION = 30 days;
    /// A route's bound (A-62), the RouteAdapter's too.
    uint256 public constant MAX_HOPS = 3;
    /// The account's own class A caps: a policy may be tighter, never looser (D-337).
    uint16 public constant ACCOUNT_CLASS_A_POSITION_BPS = 1_500;
    uint16 public constant ACCOUNT_CLASS_A_TOTAL_BPS = 5_000;
    uint256 internal constant ONE_E18 = 1e18;
    /// A pool's fee is in hundredths of a basis point.
    uint256 internal constant FEE_PER_BPS = 100;

    /// Timelocked actions.
    uint8 public constant SET_POLICY = 1;
    uint8 public constant UNPAUSE = 2;
    uint8 public constant SET_GUARDIAN = 3;

    IAgentNFTView public immutable AGENT_NFT;
    ITokenRegistry public immutable TOKENS;
    address public immutable USDC;
    address public immutable WMON;

    /// Bound once after deployment, since both are deployed after the Executor
    /// (D-235, D-361): the factory names this Executor, and the ProtocolRegistryV3
    /// lists the adapters and the pools a route may use, the Executor's own
    /// RouteAdapter among them from its construction.
    IExecutorFactoryV3 public factory;
    IPoolRegistry public pools;

    PolicyV3 internal _policy;
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
        uint64 tradedAt;
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
        uint256 outBefore;
        bool allowScreened;
    }

    Context internal _ctx;
    bytes32[] internal _ctxRoute;

    /// What `swap` measured, carried to the post-trade checks.
    struct Measure {
        address adapter;
        uint256 pxIn;
        uint256 pxOut;
        uint8 decIn;
        uint8 decOut;
        bool classAIn;
        bool classAOut;
        bool allowScreened;
        /// Market NAV before, and the value the caps use (class A at the lower of basis and value).
        uint256 navBefore;
        uint256 capped;
        uint256 totalBasis;
        uint256 classABasis;
        uint256 valueIn;
        uint256 outBefore;
        /// The route's pool fees, in basis points, rounded up per hop.
        uint256 feeBps;
        /// The caps for the token bought: the policy's and the registry's, whichever is lower.
        uint256 capOutBps;
        uint256 slippageBps;
    }

    /// What a trade event records.
    struct ExecutedRecord {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 amountOut;
        uint256 priceInE18;
        uint256 priceOutE18;
        uint256 navBefore;
        uint256 navAfter;
        bytes32 routeHash;
    }

    event Bound(address indexed factory, address indexed pools);
    event PolicySet(bytes32 indexed previousHash, bytes32 indexed currentHash, PolicyV3 policy);
    event PausedSet(bool paused, address indexed by);
    event SessionRegistered(
        uint256 indexed agentId, address indexed key, uint64 ownerEpoch, uint64 configEpoch, uint64 validUntil
    );
    event SessionRevoked(uint256 indexed agentId, address indexed by);
    event ConfigEpochBumped(uint256 indexed agentId, uint64 configEpoch);
    event IntentExecuted(
        bytes32 indexed actionId, address indexed account, uint256 indexed agentId, ExecutedRecord record
    );

    error Rejected(ReasonV3 reason);
    error AlreadyBound();
    error NotBound();
    error BadBinding();
    error BadPolicy();
    error NotTighter();
    error NotAgentOwner(address caller);
    error BadSession();
    error NotInSwap(address caller);
    error ExecutorKeptFunds(address token);

    constructor(
        address admin,
        address guardian_,
        IAgentNFTView agentNft,
        ITokenRegistry tokens,
        address usdc,
        address wmon,
        PolicyV3 memory p
    ) RiskTimelock(admin, guardian_) {
        if (
            address(agentNft) == address(0) || address(tokens) == address(0) || usdc == address(0) || wmon == address(0)
        ) {
            revert BadBinding();
        }
        AGENT_NFT = agentNft;
        TOKENS = tokens;
        USDC = usdc;
        WMON = wmon;
        _setPolicy(p);
    }

    /// Binds the factory and the pool registry, once, after both are deployed:
    /// the factory with this Executor given (D-361), the registry with the
    /// Executor's RouteAdapter active from its construction (D-239).
    function bind(IExecutorFactoryV3 factory_, IPoolRegistry pools_) external onlyOwner {
        if (address(factory) != address(0)) revert AlreadyBound();
        if (address(factory_) == address(0) || address(pools_) == address(0)) revert BadBinding();
        if (factory_.executor() != address(this)) revert BadBinding();
        factory = factory_;
        pools = pools_;
        emit Bound(address(factory_), address(pools_));
    }

    // ---------------------------------------------------------------------
    // Session grants (FINAL_PLAN 4.1.7, 4.2), as in v2
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

    /// Executes one typed intent from the agent's session key, or reverts with
    /// `Rejected(reason)` for the first limit it breaks.
    function swap(SwapIntentV3 calldata i) external nonReentrant returns (uint256 amountOut) {
        if (address(factory) == address(0) || address(pools) == address(0)) revert NotBound();
        PolicyV3 memory p = _policy;
        _checkIntent(i);
        _checkSession(i);
        _checkDeadline(i, p);
        Measure memory m = _checkMarket(i, p);
        actionUsed[i.account][i.actionId] = true;

        m.outBefore = IERC20(i.tokenOut).balanceOf(i.account);
        _ctx = Context({
            account: i.account,
            adapter: m.adapter,
            tokenIn: i.tokenIn,
            tokenOut: i.tokenOut,
            amountIn: i.amountIn,
            minAmountOut: i.minAmountOut,
            outBefore: m.outBefore,
            allowScreened: m.allowScreened
        });
        for (uint256 k = 0; k < i.route.length; ++k) {
            _ctxRoute.push(i.route[k]);
        }
        bytes32 routeHash = keccak256(abi.encodePacked(i.route));
        SwapParamsV3 memory sp = SwapParamsV3({
            tokenIn: i.tokenIn,
            tokenOut: i.tokenOut,
            amountIn: i.amountIn,
            minAmountOut: i.minAmountOut,
            routeHash: routeHash,
            deadline: i.deadline,
            ownershipEpoch: i.ownerEpoch,
            configEpoch: i.configEpoch,
            attestationIn: i.attestationIn,
            attestationOut: i.attestationOut
        });
        // The context is cleared after the call on purpose: `swap` is nonReentrant.
        // forge-lint: disable-next-line(reentrancy-no-eth)
        IExecutorAccountV3(i.account).executeSwap(sp);
        delete _ctx;
        delete _ctxRoute;

        uint256 navAfter;
        (amountOut, navAfter) = _checkAfter(i, p, m);
        _record(i.account, m.valueIn);
        emit IntentExecuted(
            i.actionId,
            i.account,
            i.agentId,
            ExecutedRecord({
                tokenIn: i.tokenIn,
                tokenOut: i.tokenOut,
                amountIn: i.amountIn,
                amountOut: amountOut,
                priceInE18: m.pxIn,
                priceOutE18: m.pxOut,
                navBefore: m.navBefore,
                navAfter: navAfter,
                routeHash: routeHash
            })
        );
    }

    /// Called by the account inside `executeSwap`: pull exactly `amountIn`,
    /// hand it to the adapter, which routes it and pays the account, check
    /// what actually arrived against the intent's minimum, and keep nothing.
    function onSwap(SwapParamsV3 calldata) external {
        Context memory c = _ctx;
        if (c.account == address(0) || msg.sender != c.account) revert NotInSwap(msg.sender);
        uint256 inBefore = IERC20(c.tokenIn).balanceOf(address(this));
        uint256 outBefore = IERC20(c.tokenOut).balanceOf(address(this));
        IExecutorAccountV3(c.account).pullForSwap(c.tokenIn, c.amountIn);
        IERC20(c.tokenIn).safeTransfer(c.adapter, c.amountIn);
        // The adapter pays whatever the route gave; the arrival is judged here,
        // by name, on the account's balance, not on what the adapter reports.
        // forge-lint: disable-next-line(unused-return)
        IRouteAdapter(c.adapter).swapRoute(c.tokenIn, c.tokenOut, c.amountIn, 1, c.account, _ctxRoute, c.allowScreened);
        uint256 arrived = IERC20(c.tokenOut).balanceOf(c.account) - c.outBefore;
        if (arrived < c.minAmountOut) _reject(ReasonV3.SLIPPAGE_TOO_HIGH);
        // Nothing stays with the Executor (the adapter checks itself that it keeps nothing).
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (IERC20(c.tokenIn).balanceOf(address(this)) != inBefore) revert ExecutorKeptFunds(c.tokenIn);
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (IERC20(c.tokenOut).balanceOf(address(this)) != outBefore) revert ExecutorKeptFunds(c.tokenOut);
    }

    // ---------------------------------------------------------------------
    // The checks, in order (mirrored by executorV3Verdict in packages/policy)
    // ---------------------------------------------------------------------

    function _reject(ReasonV3 r) internal pure {
        // forge-lint: disable-next-line(require-revert-in-loop)
        revert Rejected(r);
    }

    /// The intent's own shape, the global pause, the route's shape, and the
    /// tokens' registry status: listed, not frozen, buyable for this account.
    function _checkIntent(SwapIntentV3 calldata i) internal view {
        if (paused) _reject(ReasonV3.PAUSED);
        if (i.schemaVersion != SCHEMA_VERSION || i.chainId != block.chainid) _reject(ReasonV3.INTENT_INVALID);
        if (i.amountIn == 0 || i.minAmountOut == 0 || i.tokenIn == i.tokenOut) _reject(ReasonV3.INTENT_INVALID);
        if (i.policyHash != policyHash) _reject(ReasonV3.INTENT_INVALID);
        if (i.route.length == 0 || i.route.length > MAX_HOPS) _reject(ReasonV3.ROUTE_INVALID);
        TokenRecord memory rin = TOKENS.tokenRecord(i.tokenIn);
        if (rin.lane == Lane.NONE) _reject(ReasonV3.ASSET_NOT_ALLOWED);
        if (rin.status == TokenStatus.FROZEN) _reject(ReasonV3.TOKEN_FROZEN);
        TokenRecord memory rout = TOKENS.tokenRecord(i.tokenOut);
        if (rout.lane == Lane.NONE) _reject(ReasonV3.ASSET_NOT_ALLOWED);
        if (i.tokenOut != USDC) {
            if (rout.status == TokenStatus.FROZEN) _reject(ReasonV3.TOKEN_FROZEN);
            if (rout.status == TokenStatus.SELL_ONLY) _reject(ReasonV3.TOKEN_SELL_ONLY);
            if (rout.lane == Lane.SCREENED && !TOKENS.buyableFor(i.tokenOut, i.account)) {
                _reject(ReasonV3.NOT_OPTED_IN);
            }
        }
    }

    /// The session key, its grant, both epochs, the account and the actionId.
    function _checkSession(SwapIntentV3 calldata i) internal view {
        Grant memory g = _grants[i.agentId];
        if (g.key == address(0) || msg.sender != g.key) _reject(ReasonV3.SESSION_UNKNOWN);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > g.validUntil) _reject(ReasonV3.SESSION_EXPIRED);
        uint64 oe = AGENT_NFT.ownerEpoch(i.agentId);
        uint64 ce = configEpochOf[i.agentId];
        if (i.ownerEpoch != oe || g.ownerEpoch != oe || i.configEpoch != ce || g.configEpoch != ce) {
            _reject(ReasonV3.EPOCH_MISMATCH);
        }
        address owner_ = AGENT_NFT.ownerOf(i.agentId);
        if (i.account == address(0) || factory.personalAccountOf(i.agentId, owner_) != i.account) {
            _reject(ReasonV3.INTENT_INVALID);
        }
        if (actionUsed[i.account][i.actionId]) _reject(ReasonV3.ACTION_REPLAYED);
    }

    function _checkDeadline(SwapIntentV3 calldata i, PolicyV3 memory p) internal view {
        // forge-lint: disable-next-line(block-timestamp)
        if (i.deadline < block.timestamp) _reject(ReasonV3.DEADLINE_EXPIRED);
        // forge-lint: disable-next-line(block-timestamp)
        if (i.deadline > block.timestamp + p.deadlineSeconds) _reject(ReasonV3.DEADLINE_TOO_FAR);
    }

    /// Mode, the adapter, both sides' prices, the route and its pools against
    /// the oracle, balance, the breaker, size, rate, turnover, the floor on
    /// `minAmountOut`, and the caps and the USDC floor projected at the prices.
    function _checkMarket(SwapIntentV3 calldata i, PolicyV3 memory p) internal view returns (Measure memory m) {
        IExecutorAccountV3 account = IExecutorAccountV3(i.account);
        bool intoUsdc = i.tokenOut == USDC;
        AccountMode mode = AccountMode(account.mode());
        if (mode == AccountMode.PAUSED) _reject(ReasonV3.PAUSED);
        if (mode == AccountMode.HANDOVER) _reject(ReasonV3.VAULT_IN_HANDOVER);
        if (mode != AccountMode.NORMAL && !intoUsdc) _reject(ReasonV3.REDUCE_ONLY_MODE);

        m.adapter = IAdapterRegistry(address(pools)).adapterFor(i.adapterId);
        if (m.adapter == address(0)) _reject(ReasonV3.VENUE_NOT_ALLOWED);
        m.allowScreened = account.screenedOptIn();

        OracleAdapterV3 oracle = OracleAdapterV3(factory.oracle());
        if (address(oracle) == address(0)) _reject(ReasonV3.ORACLE_STALE);
        (m.pxIn, m.decIn, m.classAIn) = _sidePrice(oracle, i.tokenIn, i.attestationIn);
        (m.pxOut, m.decOut, m.classAOut) = _sidePrice(oracle, i.tokenOut, i.attestationOut);
        m.feeBps = _checkRoute(i, m, oracle, intoUsdc);

        if (i.amountIn > account.freeBalance(i.tokenIn)) _reject(ReasonV3.INSUFFICIENT_BALANCE);

        uint256 drawdown;
        (m.navBefore, drawdown, m.capped, m.totalBasis, m.classABasis) = _accountValues(account);
        // A drawdown nobody has poked yet counts as the mode it would set (D-233).
        if (drawdown >= 2_000) _reject(ReasonV3.PAUSED);
        if (drawdown >= 1_000 && !intoUsdc) _reject(ReasonV3.REDUCE_ONLY_MODE);

        m.valueIn = _valueOf(i.amountIn, m.pxIn, m.decIn);
        if (m.valueIn * BPS > m.capped * p.maxTradeBps) _reject(ReasonV3.TRADE_SIZE_EXCEEDED);

        (uint256 count, uint256 turnover) = _window(i.account, p.windowSeconds);
        if (count >= p.maxTradesPerWindow) _reject(ReasonV3.DAILY_TRADE_LIMIT);
        if ((turnover + m.valueIn) * BPS > m.capped * p.maxTurnoverBps) _reject(ReasonV3.TURNOVER_CAP);

        m.slippageBps = m.classAIn || m.classAOut ? p.maxSlippageClassABps : p.maxSlippageBps;
        if (i.minAmountOut < floorFor(i.amountIn, m.pxIn, m.decIn, m.pxOut, m.decOut, m.slippageBps)) {
            _reject(ReasonV3.SLIPPAGE_TOO_HIGH);
        }

        // The trade at the prices, before it is made: a buy that would break a
        // cap or the floor is named here, before the account's own looser
        // backstop could refuse it with its own error (L-108).
        if (!intoUsdc) _projectCaps(i, p, m, account);
    }

    /// A side's price and class: USDC exactly 1, class F from its feed, class A
    /// from the attestation the intent carries, through the registry's verifier.
    function _sidePrice(OracleAdapterV3 oracle, address token, bytes calldata attestation)
        internal
        view
        returns (uint256 px, uint8 decimals, bool classA)
    {
        TokenRecord memory r = TOKENS.tokenRecord(token);
        decimals = r.decimals;
        if (token == USDC) return (ONE_E18, decimals, classA);
        if (r.priceClass == PriceClass.F) {
            PriceReason reason;
            // forge-lint: disable-next-line(unused-return)
            (px,, reason) = oracle.price(token);
            if (reason != PriceReason.OK) _reject(ReasonV3.ORACLE_STALE);
            return (px, decimals, classA);
        }
        classA = true;
        if (TOKENS.verifier() == address(0)) _reject(ReasonV3.ATTESTOR_UNAVAILABLE);
        if (attestation.length == 0) _reject(ReasonV3.ATTESTATION_REQUIRED);
        try oracle.attestedPriceE18(token, attestation) returns (uint256 attested) {
            px = attested;
        } catch {
            _reject(ReasonV3.ATTESTATION_INVALID);
        }
    }

    /// Every hop's pool must be usable now, the hops must connect the tokens
    /// without revisiting one, every token between the ends must be class F
    /// (the oracle alone prices it), and each pool must price its token within
    /// the oracle's bound. Returns the route's pool fees in basis points.
    function _checkRoute(SwapIntentV3 calldata i, Measure memory m, OracleAdapterV3 oracle, bool intoUsdc)
        internal
        view
        returns (uint256 feeBps)
    {
        address[] memory path = new address[](i.route.length + 1);
        path[0] = i.tokenIn;
        for (uint256 k = 0; k < i.route.length; ++k) {
            PoolRecord memory pool;
            // forge-lint: disable-next-line(calls-loop)
            try pools.usablePool(i.route[k], m.allowScreened, intoUsdc) returns (PoolRecord memory r) {
                pool = r;
            } catch {
                _reject(ReasonV3.VENUE_NOT_ALLOWED);
            }
            address a = _held(pool.token0);
            address b = _held(pool.token1);
            if (path[k] != a && path[k] != b) _reject(ReasonV3.ROUTE_INVALID);
            address next = path[k] == a ? b : a;
            for (uint256 j = 0; j <= k; ++j) {
                if (path[j] == next) _reject(ReasonV3.ROUTE_INVALID);
            }
            path[k + 1] = next;
            if (k + 1 < i.route.length) {
                // A token between the ends is priced by the oracle alone: it must be class F.
                // forge-lint: disable-next-line(calls-loop)
                if (next != USDC && next != WMON && TOKENS.tokenRecord(next).priceClass != PriceClass.F) {
                    _reject(ReasonV3.ROUTE_INVALID);
                }
            } else if (next != i.tokenOut) {
                _reject(ReasonV3.ROUTE_INVALID);
            }
            feeBps += (uint256(pool.fee) + FEE_PER_BPS - 1) / FEE_PER_BPS;
            _checkHopPrice(i, m, oracle, i.route[k], a, b);
        }
    }

    /// The hop's pool against the price of the token it prices: the pair's
    /// token that is not a base asset, else WMON. A class A end is checked
    /// against its attested price; anything else through the oracle's own rule.
    function _checkHopPrice(
        SwapIntentV3 calldata i,
        Measure memory m,
        OracleAdapterV3 oracle,
        bytes32 poolId,
        address a,
        address b
    ) internal view {
        address priced = a == USDC || a == WMON ? (b == USDC || b == WMON ? WMON : b) : a;
        uint256 attested = 0;
        if (priced == i.tokenIn && m.classAIn) attested = m.pxIn;
        else if (priced == i.tokenOut && m.classAOut) attested = m.pxOut;
        if (attested == 0) {
            // forge-lint: disable-next-line(calls-loop,unused-return)
            (, PriceReason reason) = oracle.poolDeviationBps(priced, poolId);
            if (reason == PriceReason.OK) return;
            _reject(
                reason == PriceReason.POOL_DEVIATION || reason == PriceReason.POOL_UNREADABLE
                    || reason == PriceReason.POOL_UNSUPPORTED
                    ? ReasonV3.ORACLE_POOL_DEVIATION
                    : ReasonV3.ORACLE_STALE
            );
        }
        // forge-lint: disable-next-line(calls-loop)
        (uint256 poolPx, PriceReason why) = oracle.poolPrice(priced, poolId);
        if (why != PriceReason.OK) _reject(ReasonV3.ORACLE_POOL_DEVIATION);
        uint256 diff = poolPx > attested ? poolPx - attested : attested - poolPx;
        // forge-lint: disable-next-line(calls-loop)
        if (diff * BPS > attested * oracle.MAX_DEVIATION_BPS()) _reject(ReasonV3.ORACLE_POOL_DEVIATION);
    }

    /// The account's values, or ORACLE_STALE when a held class F price is unusable.
    function _accountValues(IExecutorAccountV3 account)
        internal
        view
        returns (uint256 nav, uint256 drawdown, uint256 capped, uint256 totalBasis, uint256 classABasis)
    {
        try account.breakerState() returns (uint256 n, uint256, uint256, uint256 d) {
            nav = n;
            drawdown = d;
        } catch {
            _reject(ReasonV3.ORACLE_STALE);
        }
        try account.capValues() returns (uint256 c, uint256 t, uint256 a) {
            capped = c;
            totalBasis = t;
            classABasis = a;
        } catch {
            _reject(ReasonV3.ORACLE_STALE);
        }
    }

    /// The caps after the trade at the prices: a class A token by cost basis
    /// (its position and the class A total), a class F token by value, and the
    /// USDC floor against the account's value.
    function _projectCaps(SwapIntentV3 calldata i, PolicyV3 memory p, Measure memory m, IExecutorAccountV3 account)
        internal
        view
    {
        TokenRecord memory rout = TOKENS.tokenRecord(i.tokenOut);
        if (m.classAOut) {
            uint256 moved = i.tokenIn == USDC
                ? i.amountIn
                : Math.mulDiv(account.costBasis(i.tokenIn), i.amountIn, account.freeBalance(i.tokenIn));
            uint256 positionAfter = account.costBasis(i.tokenOut) + moved;
            uint256 classAAfter = m.classABasis + (m.classAIn ? 0 : moved);
            m.capOutBps = _min(p.maxClassAPositionBps, rout.maxPositionBps);
            if (positionAfter * BPS > m.totalBasis * m.capOutBps) _reject(ReasonV3.CLASS_A_POSITION_CAP);
            if (classAAfter * BPS > m.totalBasis * p.maxClassATotalBps) _reject(ReasonV3.CLASS_A_TOTAL_CAP);
        } else {
            uint256 heldAfter = _valueOf(account.freeBalance(i.tokenOut), m.pxOut, m.decOut) + m.valueIn;
            m.capOutBps = _min(p.maxAssetBps, rout.maxPositionBps);
            if (heldAfter * BPS > m.capped * m.capOutBps) _reject(ReasonV3.CONCENTRATION_CAP);
        }
        uint256 usdcFree = account.freeBalance(USDC);
        uint256 usdcAfter = i.tokenIn == USDC ? (usdcFree > i.amountIn ? usdcFree - i.amountIn : 0) : usdcFree;
        if (usdcAfter * BPS < m.navBefore * p.minUsdcBps) _reject(ReasonV3.USDC_FLOOR);
    }

    /// The post-trade limits on the account's balances after the swap, at the
    /// same prices: the value that arrived is at most the slippage plus the
    /// route's fees short of the value sent, and unless the output is USDC,
    /// the caps and the floor hold.
    function _checkAfter(SwapIntentV3 calldata i, PolicyV3 memory p, Measure memory m)
        internal
        view
        returns (uint256 amountOut, uint256 navAfter)
    {
        IExecutorAccountV3 account = IExecutorAccountV3(i.account);
        amountOut = IERC20(i.tokenOut).balanceOf(i.account) - m.outBefore;
        navAfter = account.navUsdc();
        uint256 valueOut = _valueOf(amountOut, m.pxOut, m.decOut);
        uint256 allowed = Math.mulDiv(m.valueIn, m.slippageBps + m.feeBps, BPS);
        if (valueOut + allowed < m.valueIn) _reject(ReasonV3.SLIPPAGE_TOO_HIGH);
        if (i.tokenOut != USDC) {
            (uint256 capped, uint256 totalBasis, uint256 classABasis) = account.capValues();
            if (m.classAOut) {
                if (account.costBasis(i.tokenOut) * BPS > totalBasis * m.capOutBps) {
                    _reject(ReasonV3.CLASS_A_POSITION_CAP);
                }
                if (classABasis * BPS > totalBasis * p.maxClassATotalBps) _reject(ReasonV3.CLASS_A_TOTAL_CAP);
            } else {
                uint256 held = _valueOf(account.freeBalance(i.tokenOut), m.pxOut, m.decOut);
                if (held * BPS > capped * m.capOutBps) _reject(ReasonV3.CONCENTRATION_CAP);
            }
            if (account.freeBalance(USDC) * BPS < navAfter * p.minUsdcBps) _reject(ReasonV3.USDC_FLOOR);
        }
    }

    // ---------------------------------------------------------------------
    // Values and the ring buffer
    // ---------------------------------------------------------------------

    /// The least output an intent may ask for: the output the two prices imply
    /// for `amountIn`, less the slippage, rounded down.
    function floorFor(uint256 amountIn, uint256 pxIn, uint8 decIn, uint256 pxOut, uint8 decOut, uint256 slippageBps)
        public
        pure
        returns (uint256)
    {
        return Math.mulDiv(impliedOut(amountIn, pxIn, decIn, pxOut, decOut), BPS - slippageBps, BPS);
    }

    /// The output the two prices imply for `amountIn`, rounded down at each step.
    function impliedOut(uint256 amountIn, uint256 pxIn, uint8 decIn, uint256 pxOut, uint8 decOut)
        public
        pure
        returns (uint256)
    {
        uint256 valueE18 = Math.mulDiv(amountIn, pxIn, 10 ** uint256(decIn));
        return Math.mulDiv(valueE18, 10 ** uint256(decOut), pxOut);
    }

    /// The USDC value (6 decimals) of an amount at a price, rounded down, as the account values it.
    function _valueOf(uint256 amount, uint256 priceE18, uint8 decimals) internal pure returns (uint256) {
        if (amount == 0 || priceE18 == 0) return 0;
        return Math.mulDiv(amount, priceE18, 10 ** (uint256(decimals) + 12));
    }

    /// A pool's native MON side is held as WMON.
    function _held(address currency) internal view returns (address) {
        return currency == address(0) ? WMON : currency;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    /// Trades and turnover in the rolling window `(now - window, now]`.
    function _window(address account, uint256 window) internal view returns (uint256 count, uint256 turnover) {
        Ring storage r = _rings[account];
        for (uint256 k = 0; k < RING_SIZE; ++k) {
            PastTrade memory t = r.trades[k];
            // forge-lint: disable-next-line(block-timestamp)
            if (t.tradedAt != 0 && t.tradedAt + window > block.timestamp && t.tradedAt <= block.timestamp) {
                ++count;
                turnover += t.valueUsdc;
            }
        }
    }

    function _record(address account, uint256 valueIn) internal {
        Ring storage r = _rings[account];
        // forge-lint: disable-next-line(unsafe-typecast)
        r.trades[r.next] = PastTrade(uint64(block.timestamp), uint192(valueIn));
        // forge-lint: disable-next-line(unsafe-typecast)
        r.next = uint8((uint256(r.next) + 1) % RING_SIZE);
    }

    // ---------------------------------------------------------------------
    // Views for the chain tools
    // ---------------------------------------------------------------------

    function policy() external view returns (PolicyV3 memory) {
        return _policy;
    }

    /// What the account may still do in the window: trades left, when the
    /// next slot frees, and turnover used, with the policy (FINAL_PLAN 4.1.7 `limits`).
    function limits(address account)
        external
        view
        returns (PolicyV3 memory p, uint256 tradesLeft, uint256 nextSlotFreesAt, uint256 turnoverUsed)
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
                if (t.tradedAt != 0 && t.tradedAt + p.windowSeconds > block.timestamp && t.tradedAt < oldest) {
                    oldest = t.tradedAt;
                }
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
    function tightenPolicy(PolicyV3 calldata next) external {
        _checkAdminOrGuardian();
        PolicyV3 memory c = _policy;
        if (
            next.maxTradeBps > c.maxTradeBps || next.maxAssetBps > c.maxAssetBps || next.minUsdcBps < c.minUsdcBps
                || next.maxSlippageBps > c.maxSlippageBps || next.maxSlippageClassABps > c.maxSlippageClassABps
                || next.maxClassAPositionBps > c.maxClassAPositionBps || next.maxClassATotalBps > c.maxClassATotalBps
                || next.maxTurnoverBps > c.maxTurnoverBps || next.maxTradesPerWindow > c.maxTradesPerWindow
                || next.windowSeconds < c.windowSeconds || next.deadlineSeconds > c.deadlineSeconds
        ) revert NotTighter();
        _setPolicy(next);
    }

    // ---------------------------------------------------------------------
    // Timelocked loosening
    // ---------------------------------------------------------------------

    function _validateChange(uint8 action, bytes calldata data) internal pure override {
        if (action == SET_POLICY) _validatePolicy(abi.decode(data, (PolicyV3)));
        else if (action == UNPAUSE) abi.decode(data, (bool));
        else if (action == SET_GUARDIAN) abi.decode(data, (address));
        else revert BadPolicy();
    }

    function _applyChange(uint8 action, bytes calldata data) internal override {
        if (action == SET_POLICY) {
            _setPolicy(abi.decode(data, (PolicyV3)));
        } else if (action == UNPAUSE) {
            if (paused) {
                paused = false;
                emit PausedSet(false, msg.sender);
            }
        } else {
            _setGuardian(abi.decode(data, (address)));
        }
    }

    function _validatePolicy(PolicyV3 memory p) internal pure {
        if (
            p.maxTradeBps == 0 || p.maxTradeBps > BPS || p.maxAssetBps > BPS || p.minUsdcBps > BPS
                || p.maxSlippageBps >= BPS || p.maxSlippageClassABps >= BPS
                || p.maxClassAPositionBps > ACCOUNT_CLASS_A_POSITION_BPS
                || p.maxClassATotalBps > ACCOUNT_CLASS_A_TOTAL_BPS || p.maxTradesPerWindow == 0
                || p.maxTradesPerWindow > RING_SIZE || p.windowSeconds == 0 || p.deadlineSeconds == 0
        ) revert BadPolicy();
    }

    function _setPolicy(PolicyV3 memory p) internal {
        _validatePolicy(p);
        bytes32 next = keccak256(abi.encode(p));
        emit PolicySet(policyHash, next, p);
        _policy = p;
        policyHash = next;
    }
}
