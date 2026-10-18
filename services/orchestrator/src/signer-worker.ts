import { type EnvironmentId, isForkEnvironment } from "@alpha-agents/config";
import type { Db } from "@alpha-agents/db";
import { setMonBalance } from "@alpha-agents/devenv";
import { AGENT_NFT_ABI, ASSET_DECIMALS, addressEntry, parseAmount } from "@alpha-agents/domain";
import {
  type BreakableLimit,
  BREAKABLE_LIMITS,
  CHAIN_PINS,
  type ChainClient,
  LocalKeyProvider,
  Signer,
  ViemChainClient,
  buildTestSwap,
} from "@alpha-agents/signer";
import { type Hex, createPublicClient, http } from "viem";
import type { Log } from "./secrets.ts";

/**
 * The signer as an orchestrator worker (P2-U4, D-243): Executor swaps, and
 * the USDC refunds and settlements credits need (D-261). One pass of the outbox
 * every second, started and stopped with the orchestrator. Local keys come
 * from FUNDING_ADDRESS_SEED, so an agent's session key is its funding address;
 * KMS keys replace them before the beta (D-244), so the signer stays off there
 * until PB-U1 binds KMS. On the local fork the key gets MON for gas here (A-19
 * builds the real top-up), and the second provider is not used: it serves
 * mainnet, and the signer refuses a provider on another chain.
 */
export interface SignerWorkerOptions {
  readonly db: Db;
  readonly environment: EnvironmentId;
  readonly rpcUrl: string;
  readonly secondaryRpcUrl?: string;
  readonly seed: Hex;
  /** The platform treasury, the only settlement recipient; settlements are refused without it. */
  readonly treasury?: Hex;
  readonly log: Log;
  /** For tests: a chain other than the RPC's. */
  readonly chain?: ChainClient;
  readonly everyMs?: number;
  /** The signer's base fee multiple in a max fee (1 on Monad testnet, 2026-10-18); 2 when absent. */
  readonly maxFeeBaseMultiple?: bigint;
  /** Testnet only: where gas sweeps return a key's spare MON (the deployer). */
  readonly gasSweepTo?: Hex;
}

export class SignerWorker {
  readonly signer: Signer;
  private readonly o: SignerWorkerOptions;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  /** When the last pass ended (P4-U2: the sentinel's signer-health check). */
  lastTickAt: number | null = null;

  constructor(o: SignerWorkerOptions) {
    if (o.environment === "beta")
      throw new Error("the beta signs with KMS keys (D-244), not the seed");
    this.o = o;
    const book = (id: Parameters<typeof addressEntry>[1]) => {
      const e = addressEntry(o.environment, id);
      if (e.status !== "verified")
        throw new Error(`the address book has no verified ${id} on ${o.environment}`);
      return e.address as Hex;
    };
    const local = isForkEnvironment(o.environment);
    const agentNft = book("agent_nft");
    const reader = createPublicClient({ transport: http(o.rpcUrl) });
    // The only refund recipient: the agent's owner as the chain says now.
    const ownerOf = async (agentId: number): Promise<Hex | null> => {
      try {
        return (await reader.readContract({
          address: agentNft,
          abi: AGENT_NFT_ABI,
          functionName: "ownerOf",
          args: [BigInt(agentId)],
        } as never)) as Hex;
      } catch (err) {
        if (err instanceof Error && /revert/i.test(err.message)) return null;
        throw err;
      }
    };
    this.signer = new Signer({
      db: o.db,
      environment: o.environment,
      chain:
        o.chain ??
        new ViemChainClient({
          chainId: CHAIN_PINS[o.environment],
          primaryUrl: o.rpcUrl,
          ...(local || !o.secondaryRpcUrl ? {} : { secondaryUrl: o.secondaryRpcUrl }),
        }),
      keys: new LocalKeyProvider(o.seed),
      // M-FAST (A-98): the Base fork has no v2 Executor; every agent there is on v3, so the v3
      // Executor stands in for the v2 paths, which nothing on that fork takes.
      executor:
        addressEntry(o.environment, "executor").status === "verified"
          ? book("executor")
          : book("executor_v3"),
      // F-U5: Executor v3's swaps, where the fund agent's set is deployed.
      executorV3:
        addressEntry(o.environment, "executor_v3").status === "verified"
          ? (addressEntry(o.environment, "executor_v3").address as Hex)
          : null,
      usdc: book("usdc"),
      ownerOf,
      ...(o.treasury ? { treasury: o.treasury } : {}),
      assets: { [book("usdc").toLowerCase()]: "USDC", [book("wmon").toLowerCase()]: "WMON" },
      secrets: [o.rpcUrl, o.secondaryRpcUrl],
      log: o.log,
      ...(o.maxFeeBaseMultiple ? { maxFeeBaseMultiple: o.maxFeeBaseMultiple } : {}),
      ...(o.gasSweepTo ? { gasSweepTo: o.gasSweepTo } : {}),
      ...(local
        ? { topUpGas: (address: Hex, wei: bigint) => setMonBalance(address, wei, o.rpcUrl) }
        : {}),
    });
  }

  async start(): Promise<void> {
    await this.signer.start();
    const loop = () => {
      this.timer = setTimeout(() => {
        this.running = this.signer
          .tick()
          .catch((err: unknown) =>
            this.o.log(`signer pass failed: ${err instanceof Error ? err.message : String(err)}`),
          )
          .finally(() => {
            this.running = null;
            this.lastTickAt = Date.now();
            if (this.timer) loop();
          });
      }, this.o.everyMs ?? 1_000);
    };
    loop();
  }

  /** Whether a pass ended within the window: the sentinel reads this every pass. */
  alive(withinMs = 30_000): boolean {
    return (
      this.timer !== null && this.lastTickAt !== null && Date.now() - this.lastTickAt < withinMs
    );
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }

  /** Local only: builds a test swap from the chain's state and puts it in the outbox. */
  async testSwap(
    agentId: number,
    direction: "buy" | "sell",
    amountText: string,
    breakLimit: string | undefined,
  ) {
    if (!isForkEnvironment(this.o.environment))
      throw new Error("test swaps are for a local fork only");
    if (breakLimit !== undefined && !(BREAKABLE_LIMITS as readonly string[]).includes(breakLimit))
      throw new RangeError(`unknown limit ${breakLimit}`);
    const decimals = direction === "buy" ? ASSET_DECIMALS.USDC : ASSET_DECIMALS.WMON;
    const amountIn = parseAmount(amountText, decimals);
    if (amountIn === undefined || amountIn === 0n)
      throw new RangeError(
        `the amount must be a positive number with at most ${decimals} decimals`,
      );
    const swap = await buildTestSwap(this.o.rpcUrl, {
      agentId,
      direction,
      amountIn,
      ...(breakLimit ? { breakLimit: breakLimit as BreakableLimit } : {}),
    });
    return swap.kind === "swap"
      ? this.signer.submitSwap(agentId, swap.intent)
      : this.signer.accept(agentId, swap.request);
  }
}
