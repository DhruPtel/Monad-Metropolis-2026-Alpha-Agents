import { describe, expect, it } from "vitest";
import {
  ACCOUNT_MODES,
  ACCOUNT_MODE_WIRE,
  AGENT_STATES,
  AmountRawSchema,
  BpsSchema,
  DISPLAY_FLAGS,
  LEGACY_MAPPINGS,
  REJECTION_CODES,
  REJECTION_MESSAGES,
  TIERS,
  UsdcE6Schema,
  accountModeFromWire,
  accountModeToWire,
  amountRaw,
  atLeastBps,
  bps,
  canonicalFor,
  meetsTier,
  priceE18,
  ratioBps,
  slotsFor,
  usdcE6,
  valueUsdcE6,
  withinBps,
} from "./index.ts";

describe("amounts", () => {
  it("values a token amount in USDC base units, rounding down", () => {
    // 2.5 WMON at 0.0234 USDC each = 0.0585 USDC = 58_500 base units
    const wmon = amountRaw(2_500_000_000_000_000_000n);
    const price = priceE18(23_400_000_000_000_000n);
    expect(valueUsdcE6(wmon, 18, price)).toBe(58_500n);
    // 1 base unit of WMON is worth less than 1 USDC base unit: rounds to 0
    expect(valueUsdcE6(amountRaw(1n), 18, price)).toBe(0n);
    // USDC at price 1
    expect(valueUsdcE6(amountRaw(1_234_567n), 6, priceE18(10n ** 18n))).toBe(1_234_567n);
  });

  it("stays exact far beyond 2^53", () => {
    const huge = amountRaw(10n ** 30n + 7n);
    expect(valueUsdcE6(huge, 6, priceE18(10n ** 18n))).toBe(10n ** 30n + 7n);
    expect(UsdcE6Schema.parse("9007199254740993")).toBe(9007199254740993n);
  });

  it("rejects floating point and non-integer inputs on the wire", () => {
    expect(UsdcE6Schema.safeParse(1.5).success).toBe(false);
    expect(UsdcE6Schema.safeParse(100).success).toBe(false);
    expect(AmountRawSchema.safeParse("1.5").success).toBe(false);
    expect(AmountRawSchema.safeParse("1e18").success).toBe(false);
    expect(AmountRawSchema.safeParse("-1").success).toBe(false);
    expect(AmountRawSchema.safeParse("007").success).toBe(false);
    expect(BpsSchema.safeParse(12.5).success).toBe(false);
    expect(BpsSchema.safeParse(10_001).success).toBe(false);
  });

  it("refuses negative amounts and fractional basis points", () => {
    expect(() => usdcE6(-1n)).toThrow(RangeError);
    expect(() => bps(0.5)).toThrow(RangeError);
  });

  it("compares ratios exactly at the boundary", () => {
    expect(withinBps(1_000n, 10_000n, 1_000)).toBe(true);
    expect(withinBps(1_001n, 10_000n, 1_000)).toBe(false);
    expect(atLeastBps(1_000n, 10_000n, 1_000)).toBe(true);
    expect(atLeastBps(999n, 10_000n, 1_000)).toBe(false);
    expect(ratioBps(1n, 3n)).toBe(3_333n);
    expect(ratioBps(5n, 0n)).toBe(0n);
  });
});

describe("tiers", () => {
  it("gives base, medium and pro 3, 5 and 8 slots", () => {
    expect([slotsFor("base"), slotsFor("medium"), slotsFor("pro")]).toEqual([3, 5, 8]);
    expect(Object.keys(TIERS)).toEqual(["base", "medium", "pro"]);
  });

  it("orders tiers for required_tier checks", () => {
    expect(meetsTier("pro", "base")).toBe(true);
    expect(meetsTier("medium", "medium")).toBe(true);
    expect(meetsTier("base", "medium")).toBe(false);
  });
});

describe("canonical mode model (FINAL_PLAN 4.12)", () => {
  it("has exactly the plan's account modes, agent states and display flags", () => {
    expect(ACCOUNT_MODES).toEqual(["NORMAL", "REDUCE_ONLY", "PAUSED", "HANDOVER", "WIND_DOWN"]);
    expect(AGENT_STATES).toEqual(["UNCONFIGURED", "READY", "RUNNING", "RESTRICTED", "INCIDENT"]);
    expect(DISPLAY_FLAGS).toEqual([
      "awaiting_approval",
      "evaluated",
      "stale_data",
      "partially_settled",
      "exit_pending",
    ]);
  });

  it("round-trips every account mode through the get_limits wire form", () => {
    expect(Object.values(ACCOUNT_MODE_WIRE)).toEqual([
      "normal",
      "reduce_only",
      "paused",
      "handover",
      "wind_down",
    ]);
    for (const mode of ACCOUNT_MODES)
      expect(accountModeFromWire(accountModeToWire(mode))).toBe(mode);
    expect(accountModeFromWire("none")).toBeUndefined();
  });

  it.each([
    ["Custody core mode() in revision 1", "NONE", "account_mode", "NORMAL"],
    ["Risk Sentinel state machine in revision 1", "RESTRICTED", "agent_state", "RESTRICTED"],
    ["Risk Sentinel state machine", "PAUSED", "account_mode", "PAUSED"],
    ["Risk Sentinel state machine", "EXIT_PENDING", "display_flag", "exit_pending"],
    ["Risk Sentinel state machine", "INCIDENT", "agent_state", "INCIDENT"],
    ["P9-U1 lifecycle modes", "REDUCE_ONLY", "account_mode", "REDUCE_ONLY"],
    ["Chain tools get_limits.mode", "none", "account_mode", "NORMAL"],
    ["UI states in revision 1", "handover", "account_mode", "HANDOVER"],
    ["UI states in revision 1", "stale data", "display_flag", "stale_data"],
  ])("maps %s %s to %s %s", (where, name, machine, value) => {
    expect(canonicalFor(where, name)).toEqual({ machine, value });
  });

  it("maps every legacy name to a value that exists in its machine", () => {
    for (const m of LEGACY_MAPPINGS) {
      const set: readonly string[] =
        m.canonical.machine === "account_mode"
          ? ACCOUNT_MODES
          : m.canonical.machine === "agent_state"
            ? AGENT_STATES
            : DISPLAY_FLAGS;
      expect(set, `${m.where} ${m.name}`).toContain(m.canonical.value);
    }
    expect(LEGACY_MAPPINGS).toHaveLength(31);
  });

  it("returns undefined for a name with no mapping", () => {
    expect(canonicalFor("UI states in revision 1", "frozen")).toBeUndefined();
  });
});

describe("rejection codes", () => {
  it("has an owner-facing message for every code", () => {
    for (const code of REJECTION_CODES) {
      expect(REJECTION_MESSAGES[code].length, code).toBeGreaterThan(10);
    }
  });
});
