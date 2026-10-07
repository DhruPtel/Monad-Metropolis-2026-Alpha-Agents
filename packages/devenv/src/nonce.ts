import { LOCAL_FORK_RPC_URL } from "@alpha-agents/config";
import { assertLocalFork } from "./guard.ts";
import { hexToNumber, rpc, toHex } from "./rpc.ts";

/**
 * Stuck transactions on the local fork (P2-U1 step 0). After a fork reset a
 * wallet can keep numbering its transactions from the old fork's history, so
 * it sends nonces the fork does not expect yet. Anvil queues those forever:
 * it does not promote them even after `anvil_setNonce` catches the account up
 * (checked on a throwaway anvil). These read the gap and offer the two fixes
 * that work from the fork's side: drop the queued transactions, or move the
 * account's nonce to the one the wallet will send next. Every function checks
 * that the URL is the local fork before touching it.
 */
export interface QueuedTransaction {
  readonly nonce: number;
  readonly hash: string;
  readonly to: string | null;
}

export interface AccountNonceReport {
  readonly address: string;
  /** The fork's next nonce for the account (its mined transaction count). */
  readonly forkNonce: number;
  /** Transactions anvil holds for the account and will not mine yet, lowest nonce first. */
  readonly queued: readonly QueuedTransaction[];
  /** Transactions anvil will mine next. */
  readonly pending: number;
  /**
   * The nonce to align to so the wallet's next transaction mines: one past the
   * highest queued nonce, or null when nothing is queued.
   */
  readonly suggestedNonce: number | null;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function checkAddress(address: string): string {
  if (!ADDRESS.test(address)) throw new Error("That is not an account address.");
  return address;
}

type PoolSection = Record<string, Record<string, { hash?: unknown; to?: unknown }>>;

const forAddress = (section: PoolSection | undefined, address: string) =>
  Object.entries(section ?? {}).find(
    ([from]) => from.toLowerCase() === address.toLowerCase(),
  )?.[1] ?? {};

export async function accountNonceReport(
  address: string,
  url: string = LOCAL_FORK_RPC_URL,
): Promise<AccountNonceReport> {
  checkAddress(address);
  await assertLocalFork(url);
  const [count, pool] = await Promise.all([
    rpc(url, "eth_getTransactionCount", [address, "latest"]),
    rpc(url, "txpool_content") as Promise<{ pending?: PoolSection; queued?: PoolSection }>,
  ]);
  const queued = Object.entries(forAddress(pool.queued, address))
    .map(([nonce, tx]) => ({
      nonce: Number(nonce),
      hash: typeof tx.hash === "string" ? tx.hash : "",
      to: typeof tx.to === "string" ? tx.to : null,
    }))
    .filter((t) => Number.isSafeInteger(t.nonce))
    .sort((a, b) => a.nonce - b.nonce);
  const highest = queued.at(-1)?.nonce;
  return {
    address,
    forkNonce: hexToNumber(count),
    queued,
    pending: Object.keys(forAddress(pool.pending, address)).length,
    suggestedNonce: highest === undefined ? null : highest + 1,
  };
}

/** Drops every transaction anvil holds for the account, queued or pending. */
export async function dropQueuedTransactions(
  address: string,
  url: string = LOCAL_FORK_RPC_URL,
): Promise<AccountNonceReport> {
  checkAddress(address);
  await assertLocalFork(url);
  await rpc(url, "anvil_removePoolTransactions", [address]);
  return accountNonceReport(address, url);
}

/** The largest nonce the console will set: far above any real wallet's history. */
export const MAX_ALIGN_NONCE = 1_000_000;

/**
 * Sets the fork's nonce for the account, so the wallet's next transaction
 * (numbered from its own history) mines. Anvil does not promote transactions
 * already queued, so they are dropped first: the wallet's next send replaces
 * them. Only moves forward: a lower nonce would let old transactions replay.
 */
export async function alignAccountNonce(
  address: string,
  nonce: number,
  url: string = LOCAL_FORK_RPC_URL,
): Promise<AccountNonceReport> {
  checkAddress(address);
  if (!Number.isSafeInteger(nonce) || nonce < 0 || nonce > MAX_ALIGN_NONCE)
    throw new Error(`The nonce must be a whole number from 0 to ${MAX_ALIGN_NONCE}.`);
  const before = await accountNonceReport(address, url);
  if (nonce < before.forkNonce)
    throw new Error(
      `The fork's nonce for this account is already ${before.forkNonce}; it only moves forward.`,
    );
  await rpc(url, "anvil_removePoolTransactions", [address]);
  await rpc(url, "anvil_setNonce", [address, toHex(nonce)]);
  return accountNonceReport(address, url);
}
