import { describe, expect, it } from "vitest";
import { PAID_DATA_SOURCES, isPaidDataSourceId, keyHint, ownerKeyProblem } from "./owner-keys.ts";

describe("paid data sources an owner may bring a key for (BK-U1)", () => {
  it("lists Dune, X and CoinMarketCap with what each key gives, where to get one and the tool it serves (BC-U1)", () => {
    expect(PAID_DATA_SOURCES.map((s) => [s.id, s.tool])).toEqual([
      ["dune", "dune_query"],
      ["x", "x_search"],
      ["coinmarketcap", "coinmarketcap_prices"],
    ]);
    for (const s of PAID_DATA_SOURCES) {
      expect(s.gives.length).toBeGreaterThan(20);
      expect(s.keyHelp).toMatch(/paste/i);
      // The settings route takes the id as a lowercase path segment.
      expect(s.id).toMatch(/^[a-z]+$/);
    }
    expect(isPaidDataSourceId("dune")).toBe(true);
    expect(isPaidDataSourceId("x")).toBe(true);
    expect(isPaidDataSourceId("coinmarketcap")).toBe(true);
    expect(isPaidDataSourceId("tavily")).toBe(false);
  });

  it("shows a stored key by its last four characters only", () => {
    expect(keyHint("abcdefghijklmnop1234")).toBe("••••1234");
    expect(keyHint("abcdefghijklmnop1234")).not.toContain("abcd");
  });

  it("refuses an empty, padded, spaced, short or long key with the reason", () => {
    expect(ownerKeyProblem("")).toMatch(/Paste the key/);
    expect(ownerKeyProblem(" abcdefghijklmnop ")).toMatch(/spaces around/);
    expect(ownerKeyProblem("abcd efgh ijkl mnop")).toMatch(/no spaces/);
    expect(ownerKeyProblem("short")).toMatch(/too short/);
    expect(ownerKeyProblem("k".repeat(300))).toMatch(/too long/);
    expect(ownerKeyProblem("abcdefghijklmnop1234")).toBeNull();
    expect(ownerKeyProblem(42)).toMatch(/Paste the key/);
  });
});
