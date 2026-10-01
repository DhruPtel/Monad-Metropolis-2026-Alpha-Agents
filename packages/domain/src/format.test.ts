import { describe, expect, it } from "vitest";
import { formatAmount, parseAmount, shortenAddress } from "./index.ts";

describe("formatAmount", () => {
  it.each([
    [12_480_000_000n, 6, {}, "12,480"],
    [12_480_000_000n, 6, { minFractionDigits: 2 }, "12,480.00"],
    [1_234_567_890n, 6, {}, "1,234.56"],
    [1_234_567_890n, 6, { maxFractionDigits: 6 }, "1,234.56789"],
    [1n, 18, {}, "0"],
    [1n, 18, { maxFractionDigits: 18 }, "0.000000000000000001"],
    [-312_400_000n, 6, { minFractionDigits: 2 }, "-312.40"],
    [3_100_000n, 6, { signed: true }, "+3.1"],
    [0n, 6, { signed: true, minFractionDigits: 2 }, "0.00"],
    [-1n, 6, {}, "0"],
    [10n ** 30n, 6, {}, "1,000,000,000,000,000,000,000,000"],
    [123n, 0, { minFractionDigits: 0 }, "123"],
  ] as const)("formats %s with %i decimals and %j as %s", (amount, decimals, options, expected) => {
    expect(formatAmount(amount, decimals, options)).toBe(expected);
  });

  it("truncates instead of rounding up", () => {
    expect(formatAmount(1_999_999n, 6)).toBe("1.99");
  });

  it("rejects inconsistent options", () => {
    expect(() => formatAmount(1n, 6, { minFractionDigits: 3, maxFractionDigits: 2 })).toThrow(
      RangeError,
    );
  });
});

describe("shortenAddress", () => {
  it("keeps the prefix and the last four characters", () => {
    expect(shortenAddress("0x754704Bc059F8C67012fEd69BC8A327a5aafb603")).toBe("0x7547…b603");
  });

  it("leaves short or non-hex values alone", () => {
    expect(shortenAddress("0x1234")).toBe("0x1234");
    expect(shortenAddress("not an address")).toBe("not an address");
  });
});

describe("parseAmount", () => {
  it.each([
    ["2,500.5", 6, 2_500_500_000n],
    ["0.000001", 6, 1n],
    [".5", 6, 500_000n],
    ["12", 18, 12n * 10n ** 18n],
    ["  7.  ", 6, 7_000_000n],
    ["1234567890123456789012345", 0, 1234567890123456789012345n],
  ] as const)("parses %j with %i decimals", (text, decimals, expected) => {
    expect(parseAmount(text, decimals)).toBe(expected);
  });

  it.each(["", "-1", "1e6", "1.0000001", "abc", "1..2", "0x10"])("rejects %j", (text) => {
    expect(parseAmount(text, 6)).toBeUndefined();
  });

  it("round-trips with formatAmount", () => {
    expect(formatAmount(parseAmount("12,480.25", 6) ?? 0n, 6, { minFractionDigits: 2 })).toBe(
      "12,480.25",
    );
  });
});
