import { REJECTION_CODES } from "@alpha-agents/domain";
import { describe, expect, it } from "vitest";
import { DEFAULT_FORM, PRESETS, runSandbox } from "./sandbox";

const codes = (form: Parameters<typeof runSandbox>[0]) => {
  const outcome = runSandbox(form);
  if (outcome.kind === "input") throw new Error(outcome.errors.join("; "));
  return outcome.result.ok ? [] : outcome.result.rejections.map((r) => r.code);
};

describe("policy sandbox presets", () => {
  it.each(PRESETS.map((p) => [p.label, p] as const))(
    "%s gives the expected reason codes",
    (_, p) => {
      expect(codes(p.form)).toEqual(p.expected);
    },
  );

  it("covers every reason code the offchain pre-checks can return", () => {
    const covered = new Set(PRESETS.flatMap((p) => p.expected));
    const onchainOnly = [
      "VENUE_NOT_ALLOWED",
      "SIMULATION_FAILED",
      "EXECUTOR_REVERTED",
      "EPOCH_MISMATCH",
      "DEADLINE_EXPIRED",
      "DEADLINE_TOO_FAR",
    ];
    for (const code of REJECTION_CODES.filter((c) => !onchainOnly.includes(c))) {
      expect(covered, code).toContain(code);
    }
  });

  it("reports a passing trade's value and NAV", () => {
    const outcome = runSandbox(DEFAULT_FORM);
    expect(outcome.kind === "policy" && outcome.result.ok && outcome.result.value).toMatchObject({
      navUsdcE6: 100_000_000_000n,
      valueUsdcE6: 1_000_000_000n,
    });
  });

  it.each([
    [{ sellAmount: "abc" }, /Sell amount must be a number/],
    [{ sellAmount: "0" }, /greater than zero/],
    [{ sellAmount: "1.0000001" }, /at most 6 decimals/],
    [{ buy: "USDC" as const }, /different assets/],
    [{ maxSlippageBps: "1.5" }, /Max slippage/],
    [{ tradesLast24h: "0" }, /needs at least one trade/],
  ])("rejects bad input %j", (patch, message) => {
    const outcome = runSandbox({ ...DEFAULT_FORM, ...patch });
    expect(outcome.kind).toBe("input");
    expect(outcome.kind === "input" && outcome.errors.join(" ")).toMatch(message);
  });
});
