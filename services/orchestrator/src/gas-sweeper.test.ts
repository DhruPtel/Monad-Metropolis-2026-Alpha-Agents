import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { SWAP_GAS_LIMIT } from "@alpha-agents/signer";
import { SWEEP_MIN_WEI, sweepPass } from "./gas-sweeper.ts";

describe("sweepPass", () => {
  it("keeps one leg at the key's largest recent limit, skips a key with a trade on its way, and logs each sweep", async () => {
    const asked: { agentId: number; keepWei: bigint; minWei: bigint }[] = [];
    const logs: string[] = [];
    const out = await sweepPass({
      keys: async () => [
        { agentId: 6, busy: false, largestGas: 2_685_911n },
        { agentId: 7, busy: true, largestGas: 2_000_000n },
        { agentId: 8, busy: false, largestGas: null },
      ],
      swapCost: async (gas) => gas * 102_000_000_000n,
      sweep: async (agentId, o) => {
        asked.push({ agentId, ...o });
        return agentId === 6
          ? { swept: true, hash: "0xabc" as Hex, wei: 10n ** 18n, kept: o.keepWei }
          : { swept: false, reason: "the key holds 1 wei, within what it keeps" };
      },
      log: (l) => logs.push(l),
    });
    expect(asked).toEqual([
      { agentId: 6, keepWei: 2_685_911n * 102_000_000_000n, minWei: SWEEP_MIN_WEI },
      { agentId: 8, keepWei: SWAP_GAS_LIMIT * 102_000_000_000n, minWei: SWEEP_MIN_WEI },
    ]);
    expect(out.map((o) => o.agentId)).toEqual([6, 8]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("agent 6 returned 1000000000000000000 wei");
  });

  it("goes on to the next key when one sweep throws", async () => {
    const logs: string[] = [];
    const out = await sweepPass({
      keys: async () => [
        { agentId: 1, busy: false, largestGas: null },
        { agentId: 2, busy: false, largestGas: null },
      ],
      swapCost: async () => 1n,
      sweep: async (agentId) => {
        if (agentId === 1) throw new Error("no receipt");
        return { swept: false, reason: "within" };
      },
      log: (l) => logs.push(l),
    });
    expect(out.map((o) => o.agentId)).toEqual([2]);
    expect(logs[0]).toContain("agent 1 failed: no receipt");
  });
});
