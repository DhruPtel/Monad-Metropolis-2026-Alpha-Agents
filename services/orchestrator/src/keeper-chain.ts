import { randomBytes } from "node:crypto";
import { assertLocalFork, rpc } from "@alpha-agents/devenv";
import { SPECIES } from "@alpha-agents/domain";
import {
  type Chain,
  type Hex,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { RevealChain, RevealState } from "./keeper.ts";
import { type RevealSteering, findRandomNumber } from "./reveal-steer.ts";

/**
 * The keeper's chain access through viem. The wallet signs locally from the
 * configured key (REVEAL_KEEPER_PRIVATE_KEY); the key and the RPC URL are
 * registered with the redactor by the caller and never appear in messages
 * from here. Every send waits for its receipt and fails on a revert (L-10).
 */
const ABI = parseAbi([
  "function requestReveal() payable returns (uint64)",
  "function reveal(uint256 maxCount) returns (uint256)",
  "function _entropyCallback(uint64 sequence, address provider, bytes32 randomNumber)",
  "function pendingReveal() view returns (uint64 sequence, uint64 requestedAt, uint16 batchLast, bool seedReady)",
  "function nextToReveal() view returns (uint16)",
  "function totalMinted() view returns (uint16)",
  "function remainingOf(uint8 species) view returns (uint256)",
]);
const ENTROPY_ABI = parseAbi(["function getFeeV2() view returns (uint128)"]);
/** Pyth's default Entropy provider on Monad (address book note, D-187). */
export const ENTROPY_PROVIDER = "0x52DeaA1c84233F7bb8C8A45baeDE41091c616506";

export interface KeeperChainOptions {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly agentNft: Hex;
  readonly entropy: Hex;
  readonly privateKey: Hex;
  /** Local fork only: deliver numbers as Entropy and keep the keeper funded. */
  readonly localFork: boolean;
  /**
   * Local fork only (D-221): steer the delivered number so a chosen agent draws a
   * chosen species. Refused for any chain client not built for the local fork.
   */
  readonly steering?: RevealSteering;
  readonly log?: (line: string) => void;
}

export class ViemRevealChain implements RevealChain {
  readonly address: Hex;
  private readonly o: KeeperChainOptions;
  private readonly chain: Chain;
  private readonly pub;
  private readonly wallet;
  readonly deliver?: (sequence: bigint) => Promise<string>;

  constructor(o: KeeperChainOptions) {
    this.o = o;
    this.chain = defineChain({
      id: o.chainId,
      name: `chain ${o.chainId}`,
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [o.rpcUrl] } },
    });
    const account = privateKeyToAccount(o.privateKey);
    this.address = account.address;
    this.pub = createPublicClient({ chain: this.chain, transport: http(o.rpcUrl) });
    this.wallet = createWalletClient({ chain: this.chain, transport: http(o.rpcUrl), account });
    if (o.steering && !o.localFork)
      throw new Error("steered reveals exist only on the local fork (D-221)");
    if (o.localFork) this.deliver = (sequence) => this.deliverLocal(sequence);
  }

  /**
   * The number to deliver: steered when the local steering asks for it and the
   * species still has a slot, otherwise an ordinary random number (D-221).
   */
  private async numberFor(sequence: bigint): Promise<Hex> {
    const random = `0x${randomBytes(32).toString("hex")}` as Hex;
    const steering = this.o.steering;
    if (!steering || !this.o.localFork) return random;
    const s = await this.state();
    const target = steering.targetFor(s.nextToReveal);
    if (!target) return random;
    const deck = await Promise.all(
      Array.from({ length: SPECIES.length }, (_, i) =>
        this.pub.readContract({
          address: this.o.agentNft,
          abi: ABI,
          functionName: "remainingOf",
          args: [i + 1],
        }),
      ),
    );
    const chosen = findRandomNumber(target, {
      sequence,
      chainId: this.o.chainId,
      contract: this.o.agentNft,
      next: s.nextToReveal,
      last: s.pending.batchLast,
      deck: deck.map(Number),
    });
    steering.consumed(target.source);
    const name = SPECIES[target.species - 1]?.name ?? `species ${target.species}`;
    this.o.log?.(
      chosen
        ? `local fork: steering agent #${target.agentId}'s reveal to ${name} (${target.source === "first" ? "LOCAL_FIRST_REVEAL_SPECIES" : "dev console"})`
        : `local fork: ${name} has no slot left for agent #${target.agentId}; revealing at random`,
    );
    return chosen ?? random;
  }

  private async wait(hash: Hex): Promise<string> {
    const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
    return hash;
  }

  async state(): Promise<RevealState> {
    const read = <T>(functionName: "totalMinted" | "nextToReveal" | "pendingReveal") =>
      this.pub.readContract({ address: this.o.agentNft, abi: ABI, functionName }) as Promise<T>;
    const [minted, next, pending, block] = await Promise.all([
      read<number>("totalMinted"),
      read<number>("nextToReveal"),
      read<readonly [bigint, bigint, number, boolean]>("pendingReveal"),
      this.pub.getBlock(),
    ]);
    return {
      totalMinted: Number(minted),
      nextToReveal: Number(next),
      pending: {
        sequence: pending[0],
        requestedAt: Number(pending[1]),
        batchLast: Number(pending[2]),
        seedReady: pending[3],
      },
      chainTime: Number(block.timestamp),
    };
  }

  /** On the local fork, tops the keeper up so the Entropy fee never stops it. */
  private async ensureFunded(fee: bigint): Promise<void> {
    if (!this.o.localFork) return;
    const balance = await this.pub.getBalance({ address: this.address });
    if (balance >= fee * 3n) return;
    await assertLocalFork(this.o.rpcUrl);
    await rpc(this.o.rpcUrl, "anvil_setBalance", [
      this.address,
      `0x${parseEther("100").toString(16)}`,
    ]);
  }

  async requestReveal(): Promise<string> {
    const fee = await this.pub.readContract({
      address: this.o.entropy,
      abi: ENTROPY_ABI,
      functionName: "getFeeV2",
    });
    await this.ensureFunded(fee);
    const hash = await this.wallet.writeContract({
      address: this.o.agentNft,
      abi: ABI,
      functionName: "requestReveal",
      value: fee,
      chain: this.chain,
    });
    return this.wait(hash);
  }

  async reveal(maxCount: number): Promise<string> {
    const hash = await this.wallet.writeContract({
      address: this.o.agentNft,
      abi: ABI,
      functionName: "reveal",
      args: [BigInt(maxCount)],
      chain: this.chain,
    });
    return this.wait(hash);
  }

  /** Simulated delivery: Entropy, impersonated on the local fork, calls back with a random number. */
  private async deliverLocal(sequence: bigint): Promise<string> {
    await assertLocalFork(this.o.rpcUrl);
    const entropy = this.o.entropy;
    await rpc(this.o.rpcUrl, "anvil_impersonateAccount", [entropy]);
    try {
      // Gas for the callback; Entropy's own balance is left alone unless it cannot pay.
      if ((await this.pub.getBalance({ address: entropy })) < parseEther("1"))
        await rpc(this.o.rpcUrl, "anvil_setBalance", [
          entropy,
          `0x${parseEther("10").toString(16)}`,
        ]);
      const impersonated = createWalletClient({
        chain: this.chain,
        transport: http(this.o.rpcUrl),
        account: entropy,
      });
      const hash = await impersonated.writeContract({
        address: this.o.agentNft,
        abi: ABI,
        functionName: "_entropyCallback",
        args: [sequence, ENTROPY_PROVIDER, await this.numberFor(sequence)],
        chain: this.chain,
      });
      return await this.wait(hash);
    } finally {
      await rpc(this.o.rpcUrl, "anvil_stopImpersonatingAccount", [entropy]);
    }
  }
}
