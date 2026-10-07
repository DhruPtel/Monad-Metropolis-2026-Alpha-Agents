import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  NotLocalForkError,
  accountNonceReport,
  advanceTime,
  alignAccountNonce,
  assertLocalFork,
  balancesOf,
  dropQueuedTransactions,
  dumpForkState,
  forkClock,
  loadForkState,
  mineBlocks,
  mintTestUsdc,
  resetToBlock,
  revertToSnapshot,
  setMonBalance,
  takeSnapshot,
} from "./index.ts";

/**
 * L-100: a devenv call without a URL used to go to the playtest fork on 8545,
 * so a script aimed at a test fork changed the playtest fork. Every fork
 * function now takes its URL as a required argument (P2-U3 step 0).
 */
const SRC = fileURLToPath(new URL(".", import.meta.url));
const sources = readdirSync(SRC)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => ({ file: f, text: readFileSync(`${SRC}${f}`, "utf8") }));

describe("devenv's fork URL is required (L-100)", () => {
  it("no devenv source gives a URL parameter a default", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/\b(url|rpcUrl|forkUrl)\??\s*:\s*string\s*=/);
      expect(text, file).not.toMatch(/(?<![=!])=\s*LOCAL_FORK_RPC_URL/);
    }
  });

  it("names no playtest fork port", () => {
    for (const { file, text } of sources) expect(text, file).not.toMatch(/:8545\b/);
  });

  it("refuses a state change that leaves the URL out, before any request", async () => {
    const a = "0x1111111111111111111111111111111111111111";
    // The casts stand in for a JavaScript caller that the type checker cannot stop.
    const missing = undefined as unknown as string;
    for (const call of [
      () => assertLocalFork(missing),
      () => takeSnapshot(missing),
      () => revertToSnapshot("0x1", missing),
      () => mineBlocks(1, missing),
      () => advanceTime(1, missing),
      () => resetToBlock(109_670_000, missing),
      () => dumpForkState(missing),
      () => loadForkState("0x00", missing),
      () => setMonBalance(a, 1n, missing),
      () => mintTestUsdc(a, 1n, missing),
      () => accountNonceReport(a, missing),
      () => dropQueuedTransactions(a, missing),
      () => alignAccountNonce(a, 1, missing),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(NotLocalForkError);
    }
  });

  it("fails a read that leaves the URL out instead of reading the playtest fork", async () => {
    const missing = undefined as unknown as string;
    await expect(forkClock(missing)).rejects.toThrow(/unreachable/);
    await expect(balancesOf("0x1111111111111111111111111111111111111111", missing)).rejects.toThrow(
      /unreachable/,
    );
  });
});
