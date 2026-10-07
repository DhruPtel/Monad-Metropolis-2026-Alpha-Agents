import { type Address, addressEntry } from "@alpha-agents/domain";
import { assertLocalFork } from "./guard.ts";
import { LOCAL_FEED_RUNTIME_CODE } from "./local-feed-code.ts";
import { hexToBigInt, hexToNumber, rpc } from "./rpc.ts";

/**
 * Fresh Chainlink feeds on the local fork (P2-U2 step 0, D-237).
 *
 * A fork copies the feeds as they were at the pinned block and nothing
 * updates them there, so MON/USD is stale 5 minutes into a fork and every
 * priced action refuses, as it should on a real chain. On the local fork only,
 * this puts `LocalFeed` (chains/monad/script/LocalFeed.sol) at each feed's
 * address and writes its round straight into storage: the feed's last answer
 * (the pinned one, which matches the fork's frozen v4 pool) dated at the
 * fork's latest block. No transaction is sent and no block is mined.
 *
 * It cannot reach a real network: every function runs assertLocalFork first
 * (host 127.0.0.1, an anvil node, chain 143143) and sends nothing before it
 * passes, and the methods it uses, anvil_setCode and anvil_setStorageAt, exist
 * only on anvil.
 */

/** Storage slots of LocalFeed; keep in step with the contract's layout. */
export const LOCAL_FEED_SLOTS = Object.freeze({ packed: 0, answer: 1, updatedAt: 2 });

const DECIMALS = "0x313ce567"; // decimals()
const LATEST_ROUND = "0xfeaf968c"; // latestRoundData()
const WORD = 2n ** 256n;

export interface LocalFeedRound {
  readonly feed: Address;
  readonly decimals: number;
  readonly roundId: bigint;
  readonly answer: bigint;
  readonly updatedAt: bigint;
  readonly down: boolean;
}

/** The two feeds the oracle adapter reads, from the local address book. */
export function localFeedAddresses(): readonly Address[] {
  return (["chainlink_mon_usd", "chainlink_usdc_usd"] as const).map((id) => {
    const e = addressEntry("local", id);
    if (e.address === null) throw new Error(`the address book has no ${id} for the local fork`);
    return e.address;
  });
}

const word = (hex: string, i: number) => `0x${hex.slice(2 + i * 64, 2 + (i + 1) * 64)}`;
/** A two's-complement 256-bit storage word. */
const toWord = (v: bigint) => `0x${(((v % WORD) + WORD) % WORD).toString(16).padStart(64, "0")}`;
const signed = (v: bigint) => (v >= 2n ** 255n ? v - WORD : v);

async function latestTime(url: string): Promise<bigint> {
  const block = (await rpc(url, "eth_getBlockByNumber", ["latest", false])) as {
    timestamp?: unknown;
  };
  return hexToBigInt(block.timestamp);
}

/** Reads a feed: the real one through its own calls, or LocalFeed from storage. */
async function readRound(url: string, feed: Address): Promise<LocalFeedRound & { local: boolean }> {
  const code = (await rpc(url, "eth_getCode", [feed, "latest"])) as string;
  if (code.toLowerCase() === LOCAL_FEED_RUNTIME_CODE.toLowerCase()) {
    const slot = async (n: number) =>
      hexToBigInt(await rpc(url, "eth_getStorageAt", [feed, `0x${n.toString(16)}`, "latest"]));
    const packed = await slot(LOCAL_FEED_SLOTS.packed);
    return {
      feed,
      local: true,
      roundId: packed & ((1n << 80n) - 1n),
      decimals: Number((packed >> 80n) & 0xffn),
      down: ((packed >> 88n) & 0xffn) !== 0n,
      answer: signed(await slot(LOCAL_FEED_SLOTS.answer)),
      updatedAt: await slot(LOCAL_FEED_SLOTS.updatedAt),
    };
  }
  const call = (data: string) =>
    rpc(url, "eth_call", [{ to: feed, data }, "latest"]) as Promise<string>;
  const decimals = hexToNumber(word(await call(DECIMALS), 0));
  const round = await call(LATEST_ROUND);
  return {
    feed,
    local: false,
    roundId: hexToBigInt(word(round, 0)),
    answer: signed(hexToBigInt(word(round, 1))),
    updatedAt: hexToBigInt(word(round, 3)),
    decimals,
    down: false,
  };
}

async function writeRound(url: string, r: LocalFeedRound): Promise<void> {
  const packed =
    (r.roundId & ((1n << 80n) - 1n)) | (BigInt(r.decimals) << 80n) | ((r.down ? 1n : 0n) << 88n);
  const set = (slot: number, value: bigint) =>
    rpc(url, "anvil_setStorageAt", [r.feed, `0x${slot.toString(16)}`, toWord(value)]);
  await set(LOCAL_FEED_SLOTS.packed, packed);
  await set(LOCAL_FEED_SLOTS.answer, r.answer);
  await set(LOCAL_FEED_SLOTS.updatedAt, r.updatedAt);
}

export interface LocalFeedChange {
  /** A new answer in the feed's own decimals; the last answer is kept when absent. */
  readonly answer?: bigint;
  /** Make the feed revert, as an outage would; false brings it back. */
  readonly down?: boolean;
}

/**
 * Re-dates each feed's answer (or sets a new one) to the fork's latest block,
 * putting LocalFeed at its address first if it is still the copied Chainlink
 * feed. Returns the rounds written.
 */
export async function refreshLocalFeeds(
  url: string,
  feeds: readonly Address[] = localFeedAddresses(),
  change: Readonly<Record<string, LocalFeedChange>> = {},
): Promise<LocalFeedRound[]> {
  await assertLocalFork(url);
  const now = await latestTime(url);
  const out: LocalFeedRound[] = [];
  for (const feed of feeds) {
    const current = await readRound(url, feed);
    if (!current.local) {
      await rpc(url, "anvil_setCode", [feed, LOCAL_FEED_RUNTIME_CODE]);
      // The proxy's own storage means nothing to LocalFeed beyond the slots it writes.
    }
    const c = change[feed.toLowerCase()] ?? {};
    const round: LocalFeedRound = {
      feed,
      decimals: current.decimals,
      roundId: current.roundId + 1n,
      answer: c.answer ?? current.answer,
      updatedAt: now,
      down: c.down ?? current.down,
    };
    await writeRound(url, round);
    out.push(round);
  }
  return out;
}

/** Whether the feeds at these addresses are already LocalFeed (read-only). */
export async function localFeedsInstalled(
  url: string,
  feeds: readonly Address[] = localFeedAddresses(),
): Promise<boolean> {
  for (const feed of feeds) {
    const code = (await rpc(url, "eth_getCode", [feed, "latest"])) as string;
    if (code.toLowerCase() !== LOCAL_FEED_RUNTIME_CODE.toLowerCase()) return false;
  }
  return true;
}
