import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_RESTARTS, keepLog, restartDelayMs } from "./stack-restart.js";

describe("the testnet supervisor's restarts and logs (2026-10-13)", () => {
  it("waits 5 s, doubling, at most 60 s, and gives up after a few in a row", () => {
    expect([1, 2, 3, 4, 5, 6].map(restartDelayMs)).toEqual([
      5_000, 10_000, 20_000, 40_000, 60_000, 60_000,
    ]);
    expect(MAX_RESTARTS).toBe(5);
  });

  it("keeps the last run's log under its time and only the newest few", () => {
    const dir = mkdtempSync(join(tmpdir(), "stack-log-"));
    const log = join(dir, "testnet-stack.log");
    for (let i = 0; i < 7; i++) {
      writeFileSync(log, `run ${i}`);
      keepLog(log, 3);
    }
    const kept = readdirSync(dir);
    expect(kept.length).toBeLessThanOrEqual(3);
    expect(kept.every((f) => /^testnet-stack\..+\.log$/.test(f))).toBe(true);
  });
});
