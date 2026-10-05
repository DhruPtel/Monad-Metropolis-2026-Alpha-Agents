import { type Hex, encodeAbiParameters, encodeEventTopics, keccak256, padHex, toHex } from "viem";
import { AGENT_NFT_EVENTS_ABI, USDC_TRANSFER_ABI } from "./events.ts";
import {
  type BlockRef,
  type LogFilter,
  type LogSource,
  RangeTooLargeError,
  type RawLog,
} from "./source.ts";

/**
 * An in-memory chain for the indexer's tests: blocks with hashes and logs that
 * a test mines, replaces (a reorg) or drops (a rewind). Hashes depend on a
 * branch label, so a replaced block always gets a new hash.
 */
interface MemoryBlock {
  readonly number: number;
  readonly hash: Hex;
  readonly logs: RawLog[];
}

export interface PendingLog {
  readonly address: Hex;
  readonly topics: readonly Hex[];
  readonly data: Hex;
}

export class MemoryLogSource implements LogSource {
  readonly blocks: MemoryBlock[] = [];
  /** Requests answered, by method, for tests that count calls. */
  readonly calls = { head: 0, block: 0, logs: 0 };
  /** Ranges wider than this are refused, as a capped RPC does. */
  maxLogRange = Number.POSITIVE_INFINITY;
  private branch = "main";
  private tx = 0;

  private readonly id: number;
  readonly firstBlock: number;

  constructor(id: number, firstBlock: number) {
    this.id = id;
    this.firstBlock = firstBlock;
    // The block before the first, as the chain's history up to the deploy.
    this.blocks.push({ number: firstBlock - 1, hash: this.hashOf(firstBlock - 1), logs: [] });
  }

  private hashOf(n: number): Hex {
    return keccak256(toHex(`${this.branch}:${n}`));
  }

  /** Mines one block holding these logs, each in its own transaction. */
  mine(...logs: PendingLog[]): number {
    const number = (this.blocks.at(-1)?.number ?? this.firstBlock - 1) + 1;
    const hash = this.hashOf(number);
    this.blocks.push({
      number,
      hash,
      logs: logs.map((l, i) => ({
        ...l,
        blockNumber: number,
        blockHash: hash,
        transactionHash: keccak256(toHex(`${this.branch}:tx:${++this.tx}`)),
        logIndex: i,
      })),
    });
    return number;
  }

  /** Drops every block from `number` on and mines on a new branch: the next blocks get new hashes. */
  reorgFrom(number: number, branch: string): void {
    this.rewindTo(number - 1);
    this.branch = branch;
  }

  /** Drops every block above `number`, as an anvil revert does. */
  rewindTo(number: number): void {
    while ((this.blocks.at(-1)?.number ?? 0) > number) this.blocks.pop();
  }

  async chainId(): Promise<number> {
    return this.id;
  }

  async head(): Promise<number> {
    this.calls.head++;
    return this.blocks.at(-1)?.number ?? 0;
  }

  async block(number: number): Promise<BlockRef | null> {
    this.calls.block++;
    const b = this.blocks.find((x) => x.number === number);
    return b ? { number: b.number, hash: b.hash } : null;
  }

  async logs(filter: LogFilter): Promise<RawLog[]> {
    this.calls.logs++;
    if (filter.toBlock - filter.fromBlock + 1 > this.maxLogRange) {
      throw new RangeTooLargeError(filter.fromBlock, filter.toBlock);
    }
    const matches = (topic: Hex | undefined, want: Hex | readonly Hex[] | null | undefined) =>
      want === null ||
      want === undefined ||
      (typeof want === "string"
        ? topic?.toLowerCase() === want.toLowerCase()
        : want.some((w) => w.toLowerCase() === topic?.toLowerCase()));
    return this.blocks
      .filter((b) => b.number >= filter.fromBlock && b.number <= filter.toBlock)
      .flatMap((b) => b.logs)
      .filter(
        (l) =>
          l.address.toLowerCase() === filter.address.toLowerCase() &&
          (filter.topics ?? []).every((want, i) => matches(l.topics[i], want)),
      );
  }
}

// Builders for the logs AgentNFT and USDC emit.
type AgentNftEvent = (typeof AGENT_NFT_EVENTS_ABI)[number];

function nftLog(
  contract: Hex,
  name: AgentNftEvent["name"],
  args: Record<string, unknown>,
): PendingLog {
  const event = AGENT_NFT_EVENTS_ABI.find((e) => e.name === name);
  if (!event) throw new Error(`no event ${name}`);
  const topics = encodeEventTopics({ abi: [event], args } as never) as Hex[];
  const data = event.inputs.filter((i) => !(i as { indexed?: boolean }).indexed);
  return {
    address: contract,
    topics,
    data:
      data.length === 0
        ? "0x"
        : encodeAbiParameters(
            data,
            data.map((i) => args[i.name ?? ""]),
          ),
  };
}

const ZERO = padHex("0x0", { size: 20 });

/**
 * The logs of one mint, as AgentNFT emits them: Transfer from zero, then
 * AgentMinted. A mint does not bump the ownership epoch; it starts at 0.
 */
export function mintLogs(contract: Hex, agentId: bigint, owner: Hex, tba: Hex): PendingLog[] {
  return [
    nftLog(contract, "Transfer", { from: ZERO, to: owner, tokenId: agentId }),
    nftLog(contract, "AgentMinted", { agentId, owner, tba }),
  ];
}

export function revealLog(
  contract: Hex,
  agentId: bigint,
  tier: number,
  species: number,
): PendingLog {
  return nftLog(contract, "AgentRevealed", { agentId, tier, species });
}

export function transferLogs(
  contract: Hex,
  agentId: bigint,
  from: Hex,
  to: Hex,
  epoch: bigint,
): PendingLog[] {
  return [
    nftLog(contract, "Transfer", { from, to, tokenId: agentId }),
    nftLog(contract, "OwnerEpochBumped", { agentId, epoch, from, to }),
  ];
}

export function adminLog(contract: Hex, required: boolean): PendingLog {
  return nftLog(contract, "ClaimRequiredSet", { required });
}

export function usdcLog(usdc: Hex, from: Hex, to: Hex, value: bigint): PendingLog {
  return {
    address: usdc,
    topics: encodeEventTopics({ abi: USDC_TRANSFER_ABI, args: { from, to } }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  };
}
