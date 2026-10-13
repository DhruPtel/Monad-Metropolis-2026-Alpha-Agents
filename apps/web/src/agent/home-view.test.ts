import { describe, expect, it } from "vitest";
import type { ActivityJson, ApiAgent, VaultResponseJson } from "@/api/client";
import { type HomeAgentInput, ago, countText, homeView } from "./home-view";

const NOW = Date.parse("2026-10-13T18:00:00.000Z");
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const entry = (kind: string, hoursAgo: number, text = kind): ActivityJson => ({
  entryId: `${kind}-${hoursAgo}`,
  kind,
  text,
  renderedBy: "template",
  at: at(hoursAgo),
});
const agent = (id: number, species = 5): ApiAgent => ({
  id: BigInt(id),
  owner: "0x32838fe90541567BBf77Fa0570661F3c20e2B152",
  tba: "0x0B21FE455A08C11953C8Ebb56A11b94713554935",
  species,
  ownerEpoch: 0n,
});
const input = (over: Partial<HomeAgentInput> & { agent: ApiAgent }): HomeAgentInput => ({
  activity: [],
  vault: null,
  account: "none",
  goal: null,
  ...over,
});
const vault = (navUsdcE6: string, bps: number | null): VaultResponseJson =>
  ({
    vault: {
      vault: "0x5F75589Ca0eC1Ff0800cdb41bAa864805D4fb1cE",
      state: { navUsdcE6, principalUsdcE6: "100000000" },
    },
    performance: {
      scores: {
        returnSinceStart:
          bps === null
            ? { ok: false, reason: "not enough data" }
            : { ok: true, bps, since: at(48), asOf: at(0) },
      },
    },
  }) as unknown as VaultResponseJson;

describe("the home page's figures (UI-FAST)", () => {
  it("sums value onchain across accounts and vaults, and counts vaults and active agents", () => {
    const v = homeView(
      [
        input({
          agent: agent(2),
          account: { navUsdcE6: 6_000_000n, principalUsdcE6: 6_000_000n },
          activity: [entry("proposal", 2), entry("stage", 3)],
          goal: { configured: true, aggressiveness: "BALANCED" },
        }),
        input({
          agent: agent(4, 18),
          account: { navUsdcE6: 5_000_000n, principalUsdcE6: 5_000_000n },
          vault: vault("120000000", 250),
          activity: [entry("trade", 30)],
        }),
        input({ agent: agent(3, 0) }),
      ],
      NOW,
    );
    expect(v.stats).toMatchObject({
      agents: 3,
      activeToday: 1,
      vaults: 1,
      totalValueE6: 131_000_000n,
      valuePartial: false,
    });
    expect(countText(v.stats.researchToday)).toBe("1");
    expect(countText(v.stats.tradesSettled)).toBe("1");
    expect(v.agents[0]).toMatchObject({ goal: "Balanced", speciesName: "Weevil", live: false });
    expect(v.agents[2]).toMatchObject({ image: null, tier: null, goal: "No goal set" });
    expect(v.vaults.map((a) => [a.id, a.vault?.returnText])).toEqual([[4n, "+2.50%"]]);
  });

  it("leaves an unreadable account out of the total and says so", () => {
    const v = homeView([input({ agent: agent(1), account: null })], NOW);
    expect(v.agents[0]?.valueE6).toBeNull();
    expect(v.stats.valuePartial).toBe(true);
  });

  it("marks a count that may run past the activity page as a lower bound", () => {
    const full = Array.from({ length: 20 }, (_, i) => entry("trade", i * 0.1));
    const v = homeView([input({ agent: agent(1), activity: full })], NOW);
    expect(countText(v.stats.tradesSettled)).toBe("20+");
    expect(v.agents[0]?.live).toBe(true);
  });

  it("puts the newest activity across agents first", () => {
    const v = homeView(
      [
        input({ agent: agent(1), activity: [entry("scan", 5, "old")] }),
        input({ agent: agent(2), activity: [entry("trade", 1, "new")] }),
      ],
      NOW,
    );
    expect(v.latest.map((l) => l.text)).toEqual(["new", "old"]);
  });

  it("says how long ago in rough words", () => {
    expect(ago(at(0.5), NOW)).toBe("30 min ago");
    expect(ago(at(5), NOW)).toBe("5 h ago");
    expect(ago(null, NOW)).toBe("never");
  });
});
