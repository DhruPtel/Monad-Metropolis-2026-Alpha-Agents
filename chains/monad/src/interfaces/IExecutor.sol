// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// Why the Executor refused an intent (FINAL_PLAN 4.4.3). The first nineteen
/// are REJECTION_CODES in packages/domain/src/reasons.ts, in order; the last
/// four are the Executor's own (D-238). A domain test holds the two lists
/// together, since an enum crosses the ABI as its index.
enum Reason {
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
    /// The sender is not the agent's registered session key, or there is none.
    SESSION_UNKNOWN,
    /// The session grant's validity has passed.
    SESSION_EXPIRED,
    /// This account already used the intent's actionId.
    ACTION_REPLAYED,
    /// The intent is not for this chain, schema, account or policy, or is malformed.
    INTENT_INVALID
}

/// One typed swap intent (FINAL_PLAN 4.1.7; ExecutorSwapIntent in packages/domain).
/// It has no recipient, target, selector, operation or value: the recipient is
/// always the account, and the venue is an adapter the registry allows.
struct SwapIntent {
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
}

/// The launch hard limits the Executor enforces (FINAL_PLAN 6.3; LAUNCH_LIMITS
/// in packages/policy). Ratios in basis points, times in seconds.
struct Policy {
    uint16 maxTradeBps;
    uint16 maxAssetBps;
    uint16 minUsdcBps;
    uint16 maxSlippageBps;
    uint16 maxTurnoverBps;
    uint8 maxTradesPerWindow;
    uint32 windowSeconds;
    uint32 deadlineSeconds;
}

/// A venue adapter (FINAL_PLAN 4.1.8, D-238): an immutable contract pinned to
/// one venue and one pool. Only the Executor may call `swap`, which must
/// deliver the output, and refund any unspent input, to `recipient` in the
/// same call, and leave no allowance behind.
interface IVenueAdapter {
    /// The venue contract the adapter calls; the registry pins its code hash.
    function venue() external view returns (address);

    /// The pool's fee in basis points, allowed on top of slippage in the value-loss bound.
    function feeBps() external view returns (uint256);

    /// Whether the adapter trades this pair.
    function tradesPair(address tokenIn, address tokenOut) external view returns (bool);

    /// Swaps exactly `amountIn` of `tokenIn`, which the Executor has already
    /// transferred to the adapter, paying `tokenOut` to `recipient`.
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address recipient)
        external
        returns (uint256 amountOut);
}

/// The parts of the custody account the Executor reads and calls.
interface IExecutorAccount {
    function mode() external view returns (uint8);
    function freeBalance(address token) external view returns (uint256);
    function breakerState() external view returns (uint256 nav, uint256 perUnit, uint256 peak, uint256 drawdownBps);
    function pullForSwap(address token, uint256 amount) external;
}

/// The parts of AccountFactory the Executor reads.
interface IExecutorFactory {
    function executor() external view returns (address);
    function oracle() external view returns (address);
    function isBuyable(address token) external view returns (bool);
    function personalAccountOf(uint256 agentId, address owner) external view returns (address);
}
