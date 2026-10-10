import { parseAbi } from "viem";

/**
 * The Executor's surface the signer touches (FINAL_PLAN 4.1.7). `swap` is the
 * one function the signer will sign a call to; the rest are reads and the
 * event reconciliation checks against.
 */
export const SWAP_INTENT_TUPLE =
  "(uint16 schemaVersion,uint256 chainId,uint256 agentId,address account,bytes32 actionId,uint64 ownerEpoch,uint64 configEpoch,bytes32 policyHash,bytes32 adapterId,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint64 deadline)";

export const EXECUTOR_ABI = parseAbi([
  `function swap(${SWAP_INTENT_TUPLE} i) returns (uint256)`,
  "function registerSession(uint256 agentId, address key, uint64 validUntil)",
  "function sessionOf(uint256 agentId) view returns ((address key, uint64 ownerEpoch, uint64 configEpoch, uint64 validUntil))",
  "function policyHash() view returns (bytes32)",
  "function configEpochOf(uint256 agentId) view returns (uint64)",
  "function oracleFloor(address tokenIn, address tokenOut, uint256 amountIn, uint256 px, uint256 slippageBps) view returns (uint256)",
  "event IntentExecuted(bytes32 indexed actionId, address indexed account, uint256 indexed agentId, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, uint256 oraclePriceE18, uint256 navBefore, uint256 navAfter)",
  "error Rejected(uint8 reason)",
]);

export const ERC20_ABI = parseAbi([
  "function balanceOf(address who) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

/**
 * Executor v3's surface (F-U4, F-U5): `swap` takes `SwapIntentV3`, which adds
 * the route of registered pool IDs and one attestation per side, and its
 * event carries the trade as one record. The v2 types above stay for the v2
 * set beside it.
 */
export const SWAP_INTENT_V3_TUPLE =
  "(uint16 schemaVersion,uint256 chainId,uint256 agentId,address account,bytes32 actionId,uint64 ownerEpoch,uint64 configEpoch,bytes32 policyHash,bytes32 adapterId,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint64 deadline,bytes32[] route,bytes attestationIn,bytes attestationOut)";

export const EXECUTOR_V3_ABI = parseAbi([
  `function swap(${SWAP_INTENT_V3_TUPLE} i) returns (uint256)`,
  "function registerSession(uint256 agentId, address key, uint64 validUntil)",
  "function revokeSession(uint256 agentId)",
  "function sessionOf(uint256 agentId) view returns ((address key, uint64 ownerEpoch, uint64 configEpoch, uint64 validUntil))",
  "function policyHash() view returns (bytes32)",
  "function configEpochOf(uint256 agentId) view returns (uint64)",
  "event IntentExecuted(bytes32 indexed actionId, address indexed account, uint256 indexed agentId, (address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, uint256 priceInE18, uint256 priceOutE18, uint256 navBefore, uint256 navAfter, bytes32 routeHash) record)",
  "error Rejected(uint8 reason)",
]);

/** The swap intent as the Executor takes it: every number a bigint, every address checksummed or lower case. */
export interface SwapIntentArgs {
  readonly schemaVersion: number;
  readonly chainId: bigint;
  readonly agentId: bigint;
  readonly account: `0x${string}`;
  readonly actionId: `0x${string}`;
  readonly ownerEpoch: bigint;
  readonly configEpoch: bigint;
  readonly policyHash: `0x${string}`;
  readonly adapterId: `0x${string}`;
  readonly tokenIn: `0x${string}`;
  readonly tokenOut: `0x${string}`;
  readonly amountIn: bigint;
  readonly minAmountOut: bigint;
  readonly deadline: bigint;
}

/** Executor v3's intent: the v2 fields, the route of registered pool IDs, and one attestation per side (empty for class F). */
export interface SwapIntentV3Args extends SwapIntentArgs {
  readonly route: readonly `0x${string}`[];
  readonly attestationIn: `0x${string}`;
  readonly attestationOut: `0x${string}`;
}
