import { describe, expect, it } from "vitest";
import { cadence } from "./cadence.ts";

describe("cadence", () => {
  it("runs at once, then once a minute while idle, every wake while busy, and once after", async () => {
    let t = 0;
    let busy = false;
    const runs: number[] = [];
    const step = cadence({ idleMs: 60_000, busy: async () => busy, now: () => t }, async () => {
      runs.push(t);
    });
    for (; t <= 120_000; t += 10_000) await step();
    expect(runs).toEqual([0, 60_000, 120_000]);
    busy = true;
    for (t = 130_000; t <= 150_000; t += 10_000) await step();
    busy = false;
    for (t = 160_000; t <= 230_000; t += 10_000) await step();
    // Busy at 130 to 150, the run after it clears at 160, then idle until 220.
    expect(runs.slice(3)).toEqual([130_000, 140_000, 150_000, 160_000, 220_000]);
  });
});
