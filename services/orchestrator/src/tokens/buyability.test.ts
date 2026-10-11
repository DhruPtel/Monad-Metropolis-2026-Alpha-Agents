import { describe, expect, it } from "vitest";
import { buyabilityOf } from "./buyability.ts";

/** Buyability (F-U12): the lane, the status, the screen and the opt-in, each with its reason. */
const passed = { verdict: "passed" as const, fresh: true };
const refused = { verdict: "refused" as const, fresh: true };

describe("whether an account may buy a token", () => {
  it("an unregistered token says why: no screen, a refused screen, or not registered yet", () => {
    expect(buyabilityOf({ registryLane: null, registryStatus: null, screen: null }, true)).toEqual({
      lane: null,
      status: null,
      buyable: false,
      whyNot: "not screened yet; a passing safety screen registers it",
    });
    expect(
      buyabilityOf({ registryLane: null, registryStatus: null, screen: refused }, true).whyNot,
    ).toBe("the safety screen refused it");
    expect(
      buyabilityOf({ registryLane: null, registryStatus: null, screen: passed }, true).whyNot,
    ).toBe("passed the screen but is not registered yet");
  });

  it("a core token is buyable while listed, whatever the opt-in; sell-only and frozen say so", () => {
    expect(
      buyabilityOf({ registryLane: "core", registryStatus: "listed", screen: passed }, false),
    ).toEqual({
      lane: "core",
      status: "listed",
      buyable: true,
      whyNot: null,
    });
    expect(
      buyabilityOf({ registryLane: "core", registryStatus: "sell_only", screen: passed }, true)
        .whyNot,
    ).toMatch(/sell-only/);
    expect(
      buyabilityOf({ registryLane: "core", registryStatus: "delisted", screen: passed }, true)
        .whyNot,
    ).toBe("frozen in the registry");
  });

  it("a screened token needs the owner's onchain opt-in, and says when it is unknown", () => {
    const t = {
      registryLane: "screened" as const,
      registryStatus: "listed" as const,
      screen: passed,
    };
    expect(buyabilityOf(t, true).buyable).toBe(true);
    expect(buyabilityOf(t, false).whyNot).toBe(
      "in the screened lane; the owner has not opted in on chain",
    );
    expect(buyabilityOf(t, null).whyNot).toMatch(/opt-in is unknown/);
    expect(buyabilityOf({ ...t, screen: refused }, true).whyNot).toMatch(
      /latest safety screen was refused/,
    );
  });
});
