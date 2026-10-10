// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {SwapParamsV3} from "./ICustodyV3.sol";

/// Shared types of Executor v3 (FINAL_PLAN 0.4, F-U4). The v2 types in
/// IExecutor.sol stay as the v2 set uses them. Written clean-room from the plan.

/// Why Executor v3 refused an intent. The first twenty-three are the v2 `Reason`
/// enum (IExecutor.sol) in its order; the rest are the fund agent's own.
/// REJECTION_CODES in packages/domain/src/reasons.ts holds the whole list in
/// this order, and a domain test keeps the two together, since an enum crosses
/// the ABI as its index.
enum ReasonV3 {
    ASSET_NOT_ALLOWED,
    VENUE_NOT_ALLOWED,
    TRADE_SIZE_EXCEEDED,
    CONCENTRATION_CAP,
    USDC_FLOOR,
    SLIPPAGE_TOO_HIGH,
    DAILY_TRADE_LIMIT,
    TURNOVER_CAP,
    ORACLE_STALE,
    ORACLE_POOL_DEVIATION,
    INSUFFICIENT_BALANCE,
    REDUCE_ONLY_MODE,
    PAUSED,
    EPOCH_MISMATCH,
    VAULT_IN_HANDOVER,
    SIMULATION_FAILED,
    DEADLINE_EXPIRED,
    DEADLINE_TOO_FAR,
    EXECUTOR_REVERTED,
    SESSION_UNKNOWN,
    SESSION_EXPIRED,
    ACTION_REPLAYED,
    INTENT_INVALID,
    /// The route is empty, longer than three hops, does not connect the tokens
    /// through the pools named, revisits a token, or passes through a class A token.
    ROUTE_INVALID,
    /// The token bought is in the screened lane and the account's owner has not opted in (D-351).
    NOT_OPTED_IN,
    /// The token bought is sell-only now.
    TOKEN_SELL_ONLY,
    /// A token of the trade is frozen: it can neither be bought nor sold.
    TOKEN_FROZEN,
    /// A class A side of the trade carries no price attestation.
    ATTESTATION_REQUIRED,
    /// The attestation is expired, for another token, or not from the platform's attestor.
    ATTESTATION_INVALID,
    /// No price attestor is set yet (F-U12), so no class A token can trade.
    ATTESTOR_UNAVAILABLE,
    /// One class A position's cost basis would pass its cap (D-337).
    CLASS_A_POSITION_CAP,
    /// All class A positions' cost basis together would pass the cap (D-337).
    CLASS_A_TOTAL_CAP
}

/// One typed swap intent for Executor v3 (FINAL_PLAN 0.4). It has no recipient,
/// target, selector, operation, value or calldata: the recipient is always the
/// account, the route is a list of registered pool IDs, and a class A side's
/// attestation is a typed field the verifier checks (F-U12).
struct SwapIntentV3 {
    uint16 schemaVersion;
    uint256 chainId;
    uint256 agentId;
    address account;
    bytes32 actionId;
    uint64 ownerEpoch;
    uint64 configEpoch;
    bytes32 policyHash;
    bytes32 adapterId;
    address tokenIn;
    address tokenOut;
    uint256 amountIn;
    uint256 minAmountOut;
    uint64 deadline;
    bytes32[] route;
    bytes attestationIn;
    bytes attestationOut;
}

/// The hard limits Executor v3 enforces (FINAL_PLAN 0.4, 6.3; A-62, D-352).
/// Ratios in basis points, times in seconds. The class A caps are at most the
/// account's own (15% and 50%); the per-token cap from the TokenRegistry is
/// applied beside `maxAssetBps` and `maxClassAPositionBps` when it is lower.
struct PolicyV3 {
    uint16 maxTradeBps;
    uint16 maxAssetBps;
    uint16 minUsdcBps;
    uint16 maxSlippageBps;
    uint16 maxSlippageClassABps;
    uint16 maxClassAPositionBps;
    uint16 maxClassATotalBps;
    uint16 maxTurnoverBps;
    uint8 maxTradesPerWindow;
    uint32 windowSeconds;
    uint32 deadlineSeconds;
}

/// The parts of a custody account v3 Executor v3 reads and calls.
interface IExecutorAccountV3 {
    function mode() external view returns (uint8);
    function freeBalance(address token) external view returns (uint256);
    function costBasis(address token) external view returns (uint256);
    function navUsdc() external view returns (uint256);
    function breakerState() external view returns (uint256 nav, uint256 perUnit, uint256 peak, uint256 drawdownBps);
    function capValues() external view returns (uint256 capped, uint256 totalBasis, uint256 classABasis);
    function screenedOptIn() external view returns (bool);
    function pullForSwap(address token, uint256 amount) external;
    function executeSwap(SwapParamsV3 calldata p) external;
}

/// The parts of AccountFactoryV3 Executor v3 reads.
interface IExecutorFactoryV3 {
    function executor() external view returns (address);
    function oracle() external view returns (address);
    function personalAccountOf(uint256 agentId, address owner) external view returns (address);
}

/// The ProtocolRegistryV3's adapter list, as Executor v3 reads it.
interface IAdapterRegistry {
    function adapterFor(bytes32 adapterId) external view returns (address);
}

/// The RouteAdapter (F-U2) as Executor v3 calls it.
interface IRouteAdapter {
    function swapRoute(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        bytes32[] calldata route,
        bool allowScreened
    ) external returns (uint256 amountOut);
}
