import { describe, expect, it } from "vitest";
import { age, evidenceText, feePct, isAddress, screenState, screenTone, usd } from "./tokens";

describe("the console's token registry (F-U1)", () => {
  it("shows dollars whole, and millions short", () => {
    expect(usd(49_999.6)).toBe("$50,000");
    expect(usd(3_501_329)).toBe("$3.50M");
  });

  it("shows a pool's age in hours under three days, then in days", () => {
    const now = Date.parse("2026-10-09T20:40:00Z");
    expect(age("2026-10-07T21:31:10Z", now)).toBe("47 hours");
    expect(age("2025-11-24T08:11:07Z", now)).toBe("319 days");
    expect(age(null, now)).toBe("Unknown");
  });

  it("reads a screen as passed, refused, expired or not screened", () => {
    const s = { screenId: "s", screenedAt: "", expiresAt: "" };
    expect(screenState(null)).toBe("unscreened");
    expect(screenState({ ...s, verdict: "passed", fresh: true })).toBe("passed");
    expect(screenState({ ...s, verdict: "passed", fresh: false })).toBe("expired");
    expect(screenTone("refused")).toBe("negative");
    expect(screenTone("skipped")).toBe("neutral");
  });

  it("formats fees and evidence, and checks addresses", () => {
    expect(feePct(500)).toBe("0.05%");
    expect(feePct(3000)).toBe("0.3%");
    expect(feePct(50)).toBe("0.005%");
    expect(feePct(0x800000)).toBe("Dynamic");
    expect(evidenceText(true)).toBe("Yes");
    expect(evidenceText(null)).toBe("None");
    expect(evidenceText(1289430)).toBe("1,289,430");
    expect(isAddress("0x754704bc059f8c67012fed69bc8a327a5aafb603")).toBe(true);
    expect(isAddress("USDC")).toBe(false);
  });
});
