import { describe, expect, it } from "vitest";
import { PAID_DATA_SOURCES, isPaidDataSourceId, keyHint, ownerKeyProblem } from "./owner-keys.ts";

describe("paid data sources an owner may bring a key for (BK-U1)", () => {
  it("lists Dune with what the key gives and where to get one", () => {
    expect(PAID_DATA_SOURCES.map((s) => s.id)).toEqual(["dune"]);
    expect(PAID_DATA_SOURCES[0].tool).toBe("dune_query");
    expect(isPaidDataSourceId("dune")).toBe(true);
    expect(isPaidDataSourceId("x")).toBe(false);
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
