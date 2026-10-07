import { addressEntry } from "@alpha-agents/domain";
import {
  type Hex,
  createPublicClient,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  toBytes,
  zeroAddress,
} from "viem";
import { ERC20_ABI, EXECUTOR_ABI, type SwapIntentArgs } from "./abi.ts";

/**
 * Test swaps for the local fork (P2-U4 items 10 and 12): an intent built
 * from the chain's current epochs, policy hash and oracle floor, and the
 * variants that break one chosen limit. Reads only; the signer and the
 * Executor decide what happens. The real intent pipeline is P2-U5's.
 */
export const V4_ADAPTER_ID = keccak256(toBytes("uniswap-v4-mon-usdc-500"));

/** Limits a test swap can break on purpose: the Executor's, then the signer's own. */
export const BREAKABLE_LIMITS = [
  "SLIPPAGE_TOO_HIGH",
  "TRADE_SIZE_EXCEEDED",
  "DEADLINE_TOO_FAR",
  "DEADLINE_EXPIRED",
  "TARGET_NOT_ALLOWED",
  "CHAIN_NOT_PINNED",
] as const;
export type BreakableLimit = (typeof BREAKABLE_LIMITS)[number];

export const BREAKABLE_LIMIT_TEXT: Readonly<Record<BreakableLimit, string>> = {
  SLIPPAGE_TOO_HIGH: "minimum out below the oracle floor (Executor)",
  TRADE_SIZE_EXCEEDED: "the account's whole balance in one trade (Executor)",
  DEADLINE_TOO_FAR: "a deadline ten minutes out (Executor)",
  DEADLINE_EXPIRED: "a deadline already past (Executor)",
  TARGET_NOT_ALLOWED: "a USDC transfer instead of a swap (signer)",
  CHAIN_NOT_PINNED: "a transaction for Monad mainnet (signer)",
};

const NFT_ABI = parseAbi([
  "function ownerOf(uint256 agentId) view returns (address)",
  "function ownerEpoch(uint256 agentId) view returns (uint64)",
]);
const FACTORY_ABI = parseAbi([
  "function personalAccountOf(uint256 agentId, address owner) view returns (address)",
]);
const ORACLE_ABI = parseAbi(["function priceE18(address asset) view returns (uint256)"]);

const book = (id: Parameters<typeof addressEntry>[1]) => addressEntry("local", id).address as Hex;

export interface TestSwapRequest {
  readonly agentId: number;
  readonly direction: "buy" | "sell";
  /** Raw units of what is sold: USDC (6 decimals) to buy WMON, WMON (18) to sell it. */
  readonly amountIn: bigint;
  readonly breakLimit?: BreakableLimit;
}

/** What to hand the signer: a swap intent, or (for the signer's own limits) a raw request. */
export type TestSwap =
  | { readonly kind: "swap"; readonly intent: SwapIntentArgs }
  | {
      readonly kind: "request";
      readonly request: { chainId: number; to: Hex; data: Hex; value: bigint };
    };

export async function buildTestSwap(forkUrl: string, r: TestSwapRequest): Promise<TestSwap> {
  const client = createPublicClient({ transport: http(forkUrl) });
  const usdc = book("usdc");
  const wmon = book("wmon");
  const executor = book("executor");
  const nft = book("agent_nft");
  const agentId = BigInt(r.agentId);
  const tokenIn = r.direction === "buy" ? usdc : wmon;
  const tokenOut = r.direction === "buy" ? wmon : usdc;

  if (r.breakLimit === "TARGET_NOT_ALLOWED")
    return {
      kind: "request",
      request: {
        chainId: await client.getChainId(),
        to: usdc,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "transfer",
          args: ["0x000000000000000000000000000000000000dEaD", 1n],
        }),
        value: 0n,
      },
    };

  const owner = await client.readContract({
    address: nft,
    abi: NFT_ABI,
    functionName: "ownerOf",
    args: [agentId],
  });
  const account = await client.readContract({
    address: book("account_factory"),
    abi: FACTORY_ABI,
    functionName: "personalAccountOf",
    args: [agentId, owner],
  });
  if (account === zeroAddress)
    throw new Error(`agent ${r.agentId} has no PersonalAccount for its owner yet`);

  const [block, chainId, px, policyHash, configEpoch, ownerEpoch, held] = await Promise.all([
    client.getBlock(),
    client.getChainId(),
    client.readContract({
      address: book("oracle_adapter"),
      abi: ORACLE_ABI,
      functionName: "priceE18",
      args: [wmon],
    }),
    client.readContract({ address: executor, abi: EXECUTOR_ABI, functionName: "policyHash" }),
    client.readContract({
      address: executor,
      abi: EXECUTOR_ABI,
      functionName: "configEpochOf",
      args: [agentId],
    }),
    client.readContract({
      address: nft,
      abi: NFT_ABI,
      functionName: "ownerEpoch",
      args: [agentId],
    }),
    client.readContract({
      address: tokenIn,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account],
    }),
  ]);
  const amountIn = r.breakLimit === "TRADE_SIZE_EXCEEDED" ? held : r.amountIn;
  if (amountIn === 0n) throw new Error("the account holds none of what this swap sells");
  const floor = await client.readContract({
    address: executor,
    abi: EXECUTOR_ABI,
    functionName: "oracleFloor",
    args: [tokenIn, tokenOut, amountIn, px, 50n],
  });
  const now = block.timestamp;
  const deadline =
    r.breakLimit === "DEADLINE_TOO_FAR"
      ? now + 600n
      : r.breakLimit === "DEADLINE_EXPIRED"
        ? now - 1n
        : now + 120n;
  const intent: SwapIntentArgs = {
    schemaVersion: 1,
    chainId: BigInt(r.breakLimit === "CHAIN_NOT_PINNED" ? 143 : chainId),
    agentId,
    account,
    actionId: keccak256(toBytes(`test-swap:${r.agentId}:${Date.now()}:${Math.random()}`)),
    ownerEpoch,
    configEpoch,
    policyHash,
    adapterId: V4_ADAPTER_ID,
    tokenIn,
    tokenOut,
    amountIn,
    minAmountOut: r.breakLimit === "SLIPPAGE_TOO_HIGH" ? (floor > 1n ? floor - 1n : 0n) : floor,
    deadline,
  };
  if (r.breakLimit === "CHAIN_NOT_PINNED")
    return {
      kind: "request",
      request: {
        chainId: 143,
        to: executor,
        data: encodeFunctionData({ abi: EXECUTOR_ABI, functionName: "swap", args: [intent] }),
        value: 0n,
      },
    };
  return { kind: "swap", intent };
}
