import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FUND_FIXTURE_PATH,
  LANES,
  POOL_STATUSES,
  PRICE_REASONS,
  TOKEN_STATUSES,
  buyableFor,
  canRestore,
  canTighten,
  checkRoute,
  compositePriceV3,
  fundParityJson,
  readLegV3,
} from "./fund.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFileSync(`${ROOT}${path}`, "utf8");
const enumOf = (name: string) =>
  (
    new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(
      read("chains/monad/src/interfaces/IFund.sol"),
    )?.[1] ?? ""
  )
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("///"))
    .map((l) => l.replace(",", ""));

describe("the fund agent's rules match the v3 contracts (F-U2)", () => {
  it("the committed fixture is what the policy package answers now (pnpm policy:parity rewrites it)", () => {
    expect(read(FUND_FIXTURE_PATH)).toBe(fundParityJson());
  });

  it("lists every enum in the Solidity order", () => {
    expect(enumOf("PriceReason")).toEqual([...PRICE_REASONS]);
    expect(enumOf("Lane")).toEqual([...LANES]);
    expect(enumOf("TokenStatus")).toEqual([...TOKEN_STATUSES]);
    expect(enumOf("PoolStatus")).toEqual([...POOL_STATUSES]);
  });

  it("checks each feed leg against its own bound", () => {
    const answer = (age: bigint) => ({
      decimals: 8,
      roundId: 2n,
      answer: 100n,
      updatedAt: 1_000n - age,
      answeredInRound: 2n,
    });
    expect(readLegV3(answer(299n), { decimals: 8, maxAge: 300n }, 1_000n).reason).toBe("OK");
    expect(readLegV3(answer(300n), { decimals: 8, maxAge: 300n }, 1_000n).reason).toBe("STALE");
    expect(readLegV3(answer(300n), { decimals: 8, maxAge: 3_900n }, 1_000n).reason).toBe("OK");
  });

  it("multiplies a composite's legs and takes the older time", () => {
    const usd = { valueE18: 2n * 10n ** 18n, updatedAt: 90n, reason: "OK" as const };
    const rate = { valueE18: 3n * 10n ** 17n, updatedAt: 50n, reason: "OK" as const };
    expect(compositePriceV3(usd, rate)).toEqual({
      valueE18: 6n * 10n ** 17n,
      updatedAt: 50n,
      reason: "OK",
    });
    expect(compositePriceV3(usd, { ...rate, reason: "STALE" }).reason).toBe("STALE");
  });

  it("lets screened tokens only to opted-in personal accounts, and never loosens at once", () => {
    expect(buyableFor("SCREENED", "BUYABLE", { optIn: true, vault: false })).toBe(true);
    expect(buyableFor("SCREENED", "BUYABLE", { optIn: true, vault: true })).toBe(false);
    expect(buyableFor("SCREENED", "BUYABLE", "eoa")).toBe(false);
    expect(buyableFor("CORE", "SELL_ONLY", { optIn: true, vault: false })).toBe(false);
    expect(canTighten("BUYABLE", "SELL_ONLY")).toBe(true);
    expect(canTighten("FROZEN", "SELL_ONLY")).toBe(false);
    expect(canRestore("FROZEN", "BUYABLE")).toBe(true);
    expect(canRestore("BUYABLE", "FROZEN")).toBe(false);
  });

  it("checks routes in the adapter's order", () => {
    const pool = (name: string, a: string, b: string, status = "ACTIVE" as const) => ({
      name,
      token0: a,
      token1: b,
      lane: "CORE" as const,
      status,
    });
    const p1 = pool("p1", "A", "W");
    const p2 = pool("p2", "U", "W");
    expect(checkRoute("A", "U", [p1, p2], false, "W", "U")).toEqual({ ok: true });
    expect(checkRoute("A", "U", [p2], false, "W", "U")).toEqual({
      ok: false,
      error: "BrokenRoute",
      hop: 0,
    });
    expect(checkRoute("A", "U", [p1, p2, p2, p2], false, "W", "U")).toMatchObject({
      error: "BadRoute",
    });
    // An unusable pool is named before continuity is checked.
    expect(checkRoute("A", "U", [{ ...p2, status: "PAUSED" }], false, "W", "U")).toEqual({
      ok: false,
      error: "PoolUnusable",
      hop: 0,
    });
    // Native MON counts as WMON.
    expect(checkRoute("C", "U", [pool("m", "0x0", "C"), p2], false, "W", "U")).toEqual({
      ok: true,
    });
  });
});
