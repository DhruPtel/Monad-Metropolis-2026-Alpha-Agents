import { type Address, addressEntry } from "@alpha-agents/domain";
import { assertLocalFork } from "./guard.ts";
import { hexToBigInt, hexToNumber, rpc, toHex } from "./rpc.ts";

/**
 * Fork controls and test funds for the local anvil fork. Every function that
 * changes state calls assertLocalFork first, so none of them can touch a
 * remote chain. They use anvil's own RPC methods and the real token contracts
 * on the fork.
 */

export interface ForkClock {
  readonly blockNumber: number;
  readonly timestamp: number;
}

export async function forkClock(url: string): Promise<ForkClock> {
  const block = (await rpc(url, "eth_getBlockByNumber", ["latest", false])) as {
    number?: unknown;
    timestamp?: unknown;
  };
  return { blockNumber: hexToNumber(block.number), timestamp: hexToNumber(block.timestamp) };
}

/** Takes a snapshot; revert to its ID later. Snapshot IDs are hex strings. */
export async function takeSnapshot(url: string): Promise<string> {
  await assertLocalFork(url);
  const id = await rpc(url, "evm_snapshot");
  if (typeof id !== "string") throw new Error("evm_snapshot returned no ID");
  return id;
}

/** Reverts to a snapshot. Anvil drops that snapshot and every later one. */
export async function revertToSnapshot(id: string, url: string): Promise<boolean> {
  if (!/^0x[0-9a-fA-F]+$/.test(id)) throw new Error("snapshot ID must be a hex quantity");
  await assertLocalFork(url);
  return (await rpc(url, "evm_revert", [id])) === true;
}

export const MAX_MINE_BLOCKS = 10_000;

export async function mineBlocks(count: number, url: string): Promise<ForkClock> {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_MINE_BLOCKS) {
    throw new Error(`block count must be an integer from 1 to ${MAX_MINE_BLOCKS}`);
  }
  await assertLocalFork(url);
  await rpc(url, "anvil_mine", [toHex(count)]);
  return forkClock(url);
}

export const MAX_ADVANCE_SECONDS = 365 * 86_400;

/** Moves the fork's clock forward and mines one block so the new time takes effect. */
export async function advanceTime(seconds: number, url: string): Promise<ForkClock> {
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_ADVANCE_SECONDS) {
    throw new Error(`seconds must be an integer from 1 to ${MAX_ADVANCE_SECONDS}`);
  }
  await assertLocalFork(url);
  await rpc(url, "evm_increaseTime", [toHex(seconds)]);
  await rpc(url, "evm_mine");
  return forkClock(url);
}

/** How many times a reset is tried: anvil 1.8.3 fails about every other one (L-51). */
export const RESET_ATTEMPTS = 3;

/**
 * Resets the fork to the pinned block. Only the block number is sent: anvil
 * keeps its existing upstream, so the RPC URL (a secret) is never handled here.
 * A failed reset changes nothing, so it is tried again, up to RESET_ATTEMPTS:
 * anvil 1.8.3 often fails one with "failed to invalidate fork cache" and
 * succeeds on the next (L-51).
 */
export async function resetToBlock(blockNumber: number, url: string): Promise<ForkClock> {
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 1)
    throw new Error("block number must be a positive integer");
  await assertLocalFork(url);
  for (let attempt = 1; ; attempt++) {
    try {
      await rpc(url, "anvil_reset", [{ forking: { blockNumber } }], 120_000);
      break;
    } catch (error) {
      if (attempt >= RESET_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  return forkClock(url);
}

/**
 * The fork's whole state as anvil serializes it: accounts, code, storage,
 * balances, and the blocks, transactions and logs mined since the pin. Taken
 * before anything destructive so it can be put back (L-58).
 */
export async function dumpForkState(url: string): Promise<string> {
  await assertLocalFork(url);
  const state = await rpc(url, "anvil_dumpState", [], 120_000);
  if (typeof state !== "string" || !/^0x[0-9a-fA-F]*$/.test(state)) {
    throw new Error("anvil_dumpState did not return hex");
  }
  return state;
}

/**
 * Loads a dumpForkState result back. After a reset to the pinned block this
 * restores the fork as it was: deployed contracts such as AgentNFT, wallet
 * balances, and the blocks and logs the app reads agents from.
 */
export async function loadForkState(state: string, url: string): Promise<void> {
  if (!/^0x[0-9a-fA-F]*$/.test(state)) throw new Error("state must be hex from dumpForkState");
  await assertLocalFork(url);
  await rpc(url, "anvil_loadState", [state], 120_000);
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
function checkAddress(address: string): Address {
  if (!ADDRESS.test(address)) throw new Error("address must be 0x followed by 40 hex characters");
  return address as Address;
}

/** Native MON, in wei. */
export async function setMonBalance(address: string, wei: bigint, url: string): Promise<void> {
  const to = checkAddress(address);
  if (wei < 0n) throw new Error("balance must not be negative");
  await assertLocalFork(url);
  await rpc(url, "anvil_setBalance", [to, toHex(wei)]);
}

// Function selectors, computed with `cast sig` (a test rechecks them when cast is installed).
export const SELECTORS = {
  masterMinter: "0x35d99f35", // masterMinter()
  configureMinter: "0x4e44d956", // configureMinter(address,uint256)
  mint: "0x40c10f19", // mint(address,uint256)
  balanceOf: "0x70a08231", // balanceOf(address)
} as const;

/** An address that exists only on the local fork, configured as a USDC minter for test funds. */
export const TEST_USDC_MINTER = "0x000000000000000000000000000000000000a11c" as Address;
const GAS_FOR_IMPERSONATION = 10n ** 20n; // 100 MON so impersonated accounts can pay gas

const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const encodeAddressUint = (selector: string, address: string, amount: bigint) =>
  `${selector}${word(address)}${word(amount.toString(16))}`;

function localUsdc(): Address {
  const entry = addressEntry("local", "usdc");
  if (entry.status !== "verified")
    throw new Error("USDC is not verified in the local address book");
  return entry.address;
}

/**
 * Waits for a receipt. Anvil returns the hash before the receipt is queryable,
 * so a null receipt means "not yet", never "failed" (Alpha Markets lesson 6).
 */
export async function waitForReceipt(
  url: string,
  hash: unknown,
  timeoutMs = 15_000,
): Promise<{ status?: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const receipt = (await rpc(url, "eth_getTransactionReceipt", [hash])) as {
      status?: string;
    } | null;
    if (receipt) return receipt;
    if (Date.now() > deadline) throw new Error("no receipt from the fork within 15 seconds");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function sendAs(url: string, from: Address, to: Address, data: string): Promise<void> {
  await rpc(url, "anvil_impersonateAccount", [from]);
  try {
    const hash = await rpc(url, "eth_sendTransaction", [{ from, to, data }]);
    const receipt = await waitForReceipt(url, hash);
    if (receipt.status !== "0x1") throw new Error("transaction reverted on the fork");
  } finally {
    await rpc(url, "anvil_stopImpersonatingAccount", [from]);
  }
}

/**
 * Gives test USDC through the real FiatToken contract on the fork: the
 * contract's master minter (impersonated) configures a fork-only test minter,
 * which then mints to the address. Supply, events and checks all stay real.
 */
export async function mintTestUsdc(address: string, amountE6: bigint, url: string): Promise<void> {
  const to = checkAddress(address);
  if (amountE6 <= 0n) throw new Error("amount must be greater than zero");
  await assertLocalFork(url);
  const usdc = localUsdc();
  const masterMinter =
    `0x${String(await rpc(url, "eth_call", [{ to: usdc, data: SELECTORS.masterMinter }, "latest"])).slice(-40)}` as Address;
  await rpc(url, "anvil_setBalance", [masterMinter, toHex(GAS_FOR_IMPERSONATION)]);
  await rpc(url, "anvil_setBalance", [TEST_USDC_MINTER, toHex(GAS_FOR_IMPERSONATION)]);
  await sendAs(
    url,
    masterMinter,
    usdc,
    encodeAddressUint(SELECTORS.configureMinter, TEST_USDC_MINTER, amountE6),
  );
  await sendAs(url, TEST_USDC_MINTER, usdc, encodeAddressUint(SELECTORS.mint, to, amountE6));
}

export interface Balances {
  readonly monWei: bigint;
  readonly usdcE6: bigint;
}

/** Reads balances back from the fork. Read-only. */
export async function balancesOf(address: string, url: string): Promise<Balances> {
  const who = checkAddress(address);
  const monWei = hexToBigInt(await rpc(url, "eth_getBalance", [who, "latest"]));
  const raw = await rpc(url, "eth_call", [
    { to: localUsdc(), data: `${SELECTORS.balanceOf}${word(who)}` },
    "latest",
  ]);
  return { monWei, usdcE6: hexToBigInt(raw) };
}
