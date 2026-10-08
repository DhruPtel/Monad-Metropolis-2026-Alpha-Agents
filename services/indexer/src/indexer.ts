import type { Db } from "@alpha-agents/db";
import { type Hex, decodeEventLog, encodeEventTopics, toEventSelector } from "viem";
import { AGENT_NFT_EVENTS_ABI, USDC_TRANSFER_ABI } from "./events.ts";
import { type AgentDraft, type DecodedEvent, applyEvents, fromRow, toRow } from "./projection.ts";
import { type LogSource, RangeTooLargeError, type RawLog } from "./source.ts";

/**
 * The log poller (P1-U4, D-197). Each step either indexes the next range of
 * blocks after the watermark, in one database transaction with the watermark
 * itself, or finds that the chain changed under it and rolls back:
 *
 * - The watermark keeps the hash of the last processed block. Before every
 *   range the indexer checks that block's hash on the chain. A different hash
 *   is a reorg; a chain whose head is now below the watermark was rewound (an
 *   anvil reset or revert). Either way it walks back through the stored block
 *   hashes to the newest block the chain still has, deletes every record
 *   above it, rebuilds the agents projection from the remaining raw events,
 *   records an incident, and continues from there.
 * - Records are keyed by transaction hash and log index, so a range indexed
 *   twice (a crash between fetch and commit) never duplicates anything.
 * - The watermark only moves in the transaction that stored the whole range, so
 *   the index never has a gap. A source that answers a range inconsistently
 *   (a log outside it, or two hashes for one block) is recorded as a gap
 *   incident and the range is fetched again.
 */
export const WATERMARK_SOURCE = "agent_nft";

export interface IndexerTarget {
  readonly chainId: number;
  readonly agentNft: Hex;
  /** USDC, for transfers into and out of agents' token-bound accounts and funding addresses; null to skip. */
  readonly usdc: Hex | null;
  /** The first block to index: the block after AgentNFT's deployment block or pin. */
  readonly startBlock: number;
}

export interface IndexerOptions {
  readonly db: Db;
  readonly source: LogSource;
  readonly target: IndexerTarget;
  /** The most blocks per range; halved on a range the source refuses. */
  readonly maxRange?: number;
  /**
   * The least time between two steps that indexed something (P2-EC). On a real
   * chain a block comes every 0.4 s, so a back-to-back poller never idles and
   * its eth_getLogs calls alone exceeded a free provider's rate limit.
   */
  readonly minStepMs?: number;
  /** Blocks behind the head to stay, on a chain with reorgs worth waiting out. */
  readonly confirmations?: number;
  readonly log?: (line: string) => void;
}

export type StepResult =
  | { readonly kind: "idle"; readonly head: number; readonly watermark: number }
  | {
      readonly kind: "indexed";
      readonly from: number;
      readonly to: number;
      readonly events: number;
      readonly transfers: number;
    }
  | { readonly kind: "reorg" | "rewind"; readonly at: number; readonly rolledBackTo: number }
  | { readonly kind: "gap"; readonly from: number; readonly to: number; readonly detail: string };

interface Watermark {
  readonly number: number;
  readonly hash: string | null;
}

const TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)");
/** Token-bound accounts per USDC log query, so a filter never grows past what an RPC takes. */
const ADDRESS_CHUNK = 50;

const jsonArgs = (args: Record<string, unknown>) =>
  JSON.stringify(args, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class Indexer {
  private readonly db: Db;
  private readonly source: LogSource;
  readonly target: IndexerTarget;
  private range: number;
  /** The configured maximum, lowered to just under any range the source refuses. */
  private maxRange: number;
  private readonly minStepMs: number;
  private readonly confirmations: number;
  private readonly log: (line: string) => void;

  constructor(options: IndexerOptions) {
    this.db = options.db;
    this.source = options.source;
    this.target = options.target;
    this.maxRange = options.maxRange ?? 2_000;
    this.minStepMs = options.minStepMs ?? 0;
    this.range = this.maxRange;
    this.confirmations = options.confirmations ?? 0;
    this.log = options.log ?? (() => undefined);
  }

  private get chainId(): number {
    return this.target.chainId;
  }

  async watermark(): Promise<Watermark> {
    const row = await this.db
      .selectFrom("indexer.watermarks")
      .select(["block_number", "block_hash"])
      .where("chain_id", "=", this.chainId)
      .where("source", "=", WATERMARK_SOURCE)
      .executeTakeFirst();
    return row
      ? { number: row.block_number, hash: row.block_hash }
      : { number: this.target.startBlock - 1, hash: null };
  }

  /** Indexes one range, or rolls back a reorg; never both. */
  async step(): Promise<StepResult> {
    const wm = await this.watermark();
    const head = (await this.source.head()) - this.confirmations;

    if (wm.hash !== null) {
      if (head < wm.number) return this.rollBack("rewind", wm, head);
      const onChain = await this.source.block(wm.number);
      if (!onChain) return this.rollBack("rewind", wm, head);
      if (onChain.hash.toLowerCase() !== wm.hash)
        return this.rollBack("reorg", wm, head, onChain.hash);
    }
    if (head <= wm.number) return { kind: "idle", head, watermark: wm.number };

    const from = wm.number + 1;
    for (;;) {
      const to = Math.min(head, from + this.range - 1);
      try {
        const result = await this.indexRange(from, to);
        // A range that worked lets the next one grow back towards the maximum.
        this.range = Math.min(this.maxRange, this.range * 2);
        return result;
      } catch (err) {
        if (err instanceof RangeTooLargeError && this.range > 1) {
          // Learn the source's cap (P2-EC: a free-tier testnet provider allows 10 blocks), so
          // the range never grows back into a size the source has refused.
          this.maxRange = Math.max(1, Math.min(this.maxRange, this.range - 1));
          this.range = Math.max(1, Math.floor(this.range / 2));
          continue;
        }
        throw err;
      }
    }
  }

  /** Steps until the indexer is at the head; returns how many steps it took. */
  async catchUp(maxSteps = 10_000): Promise<number> {
    for (let steps = 1; steps <= maxSteps; steps++) {
      const result = await this.step();
      if (result.kind === "idle") return steps;
    }
    throw new Error(`the indexer did not reach the head in ${maxSteps} steps`);
  }

  /** Polls until the signal aborts. A failed step is logged and retried after the interval. */
  async run(signal: AbortSignal, pollMs = 1_000): Promise<void> {
    while (!signal.aborted) {
      let idle = true;
      const stepStarted = Date.now();
      try {
        const result = await this.step();
        idle = result.kind === "idle";
        if (result.kind === "indexed") {
          this.log(
            `indexed blocks ${result.from} to ${result.to}: ${result.events} AgentNFT events, ${result.transfers} USDC transfers`,
          );
        }
      } catch (err) {
        this.log(`step failed, retrying: ${err instanceof Error ? err.message : String(err)}`);
      }
      const waitMs = idle ? pollMs : this.minStepMs - (Date.now() - stepStarted);
      if (waitMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, waitMs);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    }
  }

  private decodeAgentNft(log: RawLog): DecodedEvent {
    const decoded = decodeEventLog({
      abi: AGENT_NFT_EVENTS_ABI,
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
    });
    return {
      name: decoded.eventName,
      args: (decoded.args ?? {}) as Record<string, unknown>,
      blockNumber: log.blockNumber,
      blockHash: log.blockHash.toLowerCase(),
      txHash: log.transactionHash.toLowerCase(),
      logIndex: log.logIndex,
    };
  }

  private async recordGap(from: number, to: number, detail: string): Promise<StepResult> {
    await this.db
      .insertInto("indexer.incidents")
      .values({
        chain_id: this.chainId,
        kind: "gap",
        block_number: from,
        stored_hash: null,
        chain_hash: null,
        rolled_back_to: from - 1,
        detail,
      })
      .execute();
    this.log(`gap: ${detail}; blocks ${from} to ${to} will be fetched again`);
    return { kind: "gap", from, to, detail };
  }

  private async usdcLogs(
    from: number,
    to: number,
    addresses: readonly string[],
  ): Promise<RawLog[]> {
    const usdc = this.target.usdc;
    if (!usdc || addresses.length === 0) return [];
    const out: RawLog[] = [];
    for (const group of chunks(addresses, ADDRESS_CHUNK)) {
      const padded = group.map(
        (a) => encodeEventTopics({ abi: USDC_TRANSFER_ABI, args: { from: a as Hex } })[1] as Hex,
      );
      out.push(
        ...(await this.source.logs({
          address: usdc,
          topics: [TRANSFER_TOPIC, null, padded],
          fromBlock: from,
          toBlock: to,
        })),
        ...(await this.source.logs({
          address: usdc,
          topics: [TRANSFER_TOPIC, padded],
          fromBlock: from,
          toBlock: to,
        })),
      );
    }
    return out;
  }

  private async indexRange(from: number, to: number): Promise<StepResult> {
    const nftLogs = await this.source.logs({
      address: this.target.agentNft,
      fromBlock: from,
      toBlock: to,
    });
    const events = nftLogs
      .map((l) => this.decodeAgentNft(l))
      .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

    // Agents touched in this range, with their rows so far.
    const ids = [
      ...new Set(
        events.flatMap((e) => {
          const id = e.args.agentId ?? (e.name === "Transfer" ? e.args.tokenId : undefined);
          return id === undefined ? [] : [Number(id as bigint)];
        }),
      ),
    ];
    const existing =
      ids.length === 0
        ? []
        : await this.db
            .selectFrom("indexer.agents")
            .selectAll()
            .where("chain_id", "=", this.chainId)
            .where("agent_id", "in", ids)
            .execute();
    const drafts = new Map<number, AgentDraft>(existing.map((r) => [r.agent_id, fromRow(r)]));
    const changed = applyEvents(drafts, events);

    // Every agent's account, including those minted in this range.
    const known = await this.db
      .selectFrom("indexer.agents")
      .select(["agent_id", "tba"])
      .where("chain_id", "=", this.chainId)
      .execute();
    // Each watched address's agent and kind: token-bound accounts, and the funding addresses
    // the orchestrator derives and records (P1-U6, D-207), whose incoming USDC is credits.
    const watched = new Map<string, { agentId: number; account: "tba" | "funding" }>(
      known.map((r) => [r.tba, { agentId: r.agent_id, account: "tba" }]),
    );
    for (const d of drafts.values())
      if (d.tba) watched.set(d.tba, { agentId: d.agentId, account: "tba" });
    const funding = await this.db
      .selectFrom("platform.funding_addresses")
      .select(["agent_id", "address"])
      .where("chain_id", "=", this.chainId)
      .execute();
    for (const f of funding) watched.set(f.address, { agentId: f.agent_id, account: "funding" });
    const usdcLogs = await this.usdcLogs(from, to, [...watched.keys()]);

    // The range end's hash, read after the logs: the next step checks it is still canonical.
    const end = await this.source.block(to);
    if (!end) return this.recordGap(from, to, `the source has no block ${to}`);
    const blockHashes = new Map<number, string>([[to, end.hash.toLowerCase()]]);
    for (const l of [...nftLogs, ...usdcLogs]) {
      if (l.blockNumber < from || l.blockNumber > to) {
        return this.recordGap(
          from,
          to,
          `a log from block ${l.blockNumber} came back for blocks ${from} to ${to}`,
        );
      }
      const hash = l.blockHash.toLowerCase();
      const seen = blockHashes.get(l.blockNumber);
      if (seen !== undefined && seen !== hash) {
        return this.recordGap(from, to, `block ${l.blockNumber} came back with two hashes`);
      }
      blockHashes.set(l.blockNumber, hash);
    }

    const transfers = new Map<
      string,
      {
        chain_id: number;
        block_number: number;
        block_hash: string;
        tx_hash: string;
        log_index: number;
        from_address: string;
        to_address: string;
        value: string;
        agent_id: number;
        direction: "in" | "out";
        account: "tba" | "funding";
      }
    >();
    for (const l of usdcLogs) {
      const decoded = decodeEventLog({
        abi: USDC_TRANSFER_ABI,
        data: l.data,
        topics: l.topics as [Hex, ...Hex[]],
      });
      const fromAddr = decoded.args.from.toLowerCase();
      const toAddr = decoded.args.to.toLowerCase();
      for (const [direction, account] of [
        ["in", toAddr],
        ["out", fromAddr],
      ] as const) {
        const hit = watched.get(account);
        if (hit === undefined) continue;
        const key = `${l.transactionHash}:${l.logIndex}:${direction}`;
        transfers.set(key, {
          chain_id: this.chainId,
          block_number: l.blockNumber,
          block_hash: l.blockHash.toLowerCase(),
          tx_hash: l.transactionHash.toLowerCase(),
          log_index: l.logIndex,
          from_address: fromAddr,
          to_address: toAddr,
          value: decoded.args.value.toString(),
          agent_id: hit.agentId,
          direction,
          account: hit.account,
        });
      }
    }

    await this.db.transaction().execute(async (trx) => {
      if (events.length > 0) {
        await trx
          .insertInto("indexer.agent_nft_events")
          .values(
            events.map((e) => ({
              chain_id: this.chainId,
              contract: this.target.agentNft.toLowerCase(),
              block_number: e.blockNumber,
              block_hash: e.blockHash,
              tx_hash: e.txHash,
              log_index: e.logIndex,
              event_name: e.name,
              args: jsonArgs(e.args as Record<string, unknown>),
            })),
          )
          .onConflict((oc) => oc.columns(["chain_id", "tx_hash", "log_index"]).doNothing())
          .execute();
      }
      for (const id of changed) {
        const row = toRow(this.chainId, drafts.get(id) as AgentDraft);
        await trx
          .insertInto("indexer.agents")
          .values(row)
          .onConflict((oc) => oc.columns(["chain_id", "agent_id"]).doUpdateSet(row))
          .execute();
      }
      if (transfers.size > 0) {
        await trx
          .insertInto("indexer.usdc_transfers")
          .values([...transfers.values()])
          .onConflict((oc) =>
            oc.columns(["chain_id", "tx_hash", "log_index", "direction"]).doNothing(),
          )
          .execute();
      }
      await trx
        .insertInto("indexer.indexed_blocks")
        .values(
          [...blockHashes].map(([block_number, block_hash]) => ({
            chain_id: this.chainId,
            block_number,
            block_hash,
          })),
        )
        .onConflict((oc) =>
          oc
            .columns(["chain_id", "block_number"])
            .doUpdateSet((eb) => ({ block_hash: eb.ref("excluded.block_hash") })),
        )
        .execute();
      const watermark = {
        block_number: to,
        block_hash: end.hash.toLowerCase(),
        updated_at: new Date(),
      };
      await trx
        .insertInto("indexer.watermarks")
        .values({ chain_id: this.chainId, source: WATERMARK_SOURCE, ...watermark })
        .onConflict((oc) => oc.columns(["chain_id", "source"]).doUpdateSet(watermark))
        .execute();
    });
    return { kind: "indexed", from, to, events: events.length, transfers: transfers.size };
  }

  /**
   * Finds the newest stored block the chain still has, deletes every record
   * above it, rebuilds the agents projection and moves the watermark there.
   */
  private async rollBack(
    kind: "reorg" | "rewind",
    wm: Watermark,
    head: number,
    chainHash: string | null = null,
  ): Promise<StepResult> {
    const stored = await this.db
      .selectFrom("indexer.indexed_blocks")
      .select(["block_number", "block_hash"])
      .where("chain_id", "=", this.chainId)
      .where("block_number", "<=", Math.min(wm.number, head))
      .orderBy("block_number", "desc")
      .execute();
    let ancestor: { number: number; hash: string } | null = null;
    for (const b of stored) {
      const onChain = await this.source.block(b.block_number);
      if (onChain && onChain.hash.toLowerCase() === b.block_hash) {
        ancestor = { number: b.block_number, hash: b.block_hash };
        break;
      }
    }
    const to = ancestor?.number ?? this.target.startBlock - 1;

    await this.db.transaction().execute(async (trx) => {
      for (const table of [
        "indexer.agent_nft_events",
        "indexer.usdc_transfers",
        "indexer.indexed_blocks",
      ] as const) {
        await trx
          .deleteFrom(table)
          .where("chain_id", "=", this.chainId)
          .where("block_number", ">", to)
          .execute();
      }
      const remaining = await trx
        .selectFrom("indexer.agent_nft_events")
        .selectAll()
        .where("chain_id", "=", this.chainId)
        .orderBy("block_number")
        .orderBy("log_index")
        .execute();
      const drafts = new Map<number, AgentDraft>();
      applyEvents(
        drafts,
        remaining.map((r) => ({
          name: r.event_name,
          args: r.args,
          blockNumber: r.block_number,
          blockHash: r.block_hash,
          txHash: r.tx_hash,
          logIndex: r.log_index,
        })),
      );
      await trx.deleteFrom("indexer.agents").where("chain_id", "=", this.chainId).execute();
      const rows = [...drafts.values()].map((d) => toRow(this.chainId, d));
      if (rows.length > 0) await trx.insertInto("indexer.agents").values(rows).execute();

      if (ancestor) {
        const watermark = {
          block_number: ancestor.number,
          block_hash: ancestor.hash,
          updated_at: new Date(),
        };
        await trx
          .insertInto("indexer.watermarks")
          .values({ chain_id: this.chainId, source: WATERMARK_SOURCE, ...watermark })
          .onConflict((oc) => oc.columns(["chain_id", "source"]).doUpdateSet(watermark))
          .execute();
      } else {
        await trx
          .deleteFrom("indexer.watermarks")
          .where("chain_id", "=", this.chainId)
          .where("source", "=", WATERMARK_SOURCE)
          .execute();
      }
      await trx
        .insertInto("indexer.incidents")
        .values({
          chain_id: this.chainId,
          kind,
          block_number: wm.number,
          stored_hash: wm.hash,
          chain_hash: chainHash?.toLowerCase() ?? null,
          rolled_back_to: to,
          detail:
            kind === "reorg"
              ? `block ${wm.number} has another hash on the chain; rolled back to block ${to}`
              : `the chain's head (${head}) is below the watermark (${wm.number}); rolled back to block ${to}`,
        })
        .execute();
    });
    this.log(`${kind} at block ${wm.number}: rolled back to block ${to}`);
    return { kind, at: wm.number, rolledBackTo: to };
  }
}
