import { describe, expect, it } from "vitest";
import {
  CLASS_F_FEEDS,
  REVIEWED_TOKENS,
  SCREEN_CHECK_CODES,
  type ScreenCheck,
  classFFeed,
  foldName,
  lookAlike,
  reviewedToken,
  screenVerdict,
} from "./index.ts";

const check = (code: ScreenCheck["code"], status: ScreenCheck["status"]): ScreenCheck => ({
  code,
  status,
  reason: "r",
  evidence: {},
});

describe("the token screen's rules (F-U1)", () => {
  it("passes only when every required check passed and none failed", () => {
    const all = SCREEN_CHECK_CODES.map((c) => check(c, "pass"));
    expect(screenVerdict(all)).toBe("passed");
    // GoPlus is a second opinion: skipping it never refuses.
    expect(
      screenVerdict(all.map((c) => (c.code === "GOPLUS" ? check("GOPLUS", "skipped") : c))),
    ).toBe("passed");
    // But when it fails, it blocks.
    expect(screenVerdict(all.map((c) => (c.code === "GOPLUS" ? check("GOPLUS", "fail") : c)))).toBe(
      "refused",
    );
    // A required check skipped is not a pass.
    expect(screenVerdict(all.map((c) => (c.code === "SELL" ? check("SELL", "skipped") : c)))).toBe(
      "refused",
    );
    expect(screenVerdict(all.filter((c) => c.code !== "LIQUIDITY"))).toBe("refused");
  });

  it("folds case, punctuation and confusable letters before comparing names", () => {
    expect(foldName("USDC")).toBe("usdc");
    expect(foldName("U.S.D.C")).toBe("usdc");
    expect(foldName("USDС")).toBe("usdc");
    expect(foldName("M0N")).toBe("mon");
  });

  it("calls a token a look-alike only when a listing of that symbol or name sits at another address", () => {
    const listings = [
      {
        symbol: "USDC",
        name: "USDC",
        monadAddress: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
        source: "coingecko" as const,
      },
      { symbol: "SOL", name: "Solana", monadAddress: null, source: "coinmarketcap" as const },
    ];
    const fake = {
      address: "0x00000000000000000000000000000000000000aa",
      symbol: "USDС",
      name: "x",
    };
    expect(lookAlike(fake, listings)?.field).toBe("symbol");
    expect(lookAlike({ ...fake, symbol: "ZZ", name: "Solana" }, listings)?.listed.symbol).toBe(
      "SOL",
    );
    expect(
      lookAlike(
        { address: "0x754704BC059F8C67012FED69BC8A327A5AAFB603", symbol: "USDC", name: "USDC" },
        listings,
      ),
    ).toBeNull();
    expect(lookAlike({ ...fake, symbol: "CHOG", name: "Chog" }, listings)).toBeNull();
  });

  it("keeps the feed map and reviewed list lowercase, unique and consistent", () => {
    const tokens = CLASS_F_FEEDS.map((f) => f.address);
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const f of CLASS_F_FEEDS) {
      expect(f.address).toMatch(/^0x[0-9a-f]{40}$/);
      expect(f.legs.length).toBe(f.kind === "composite" ? 2 : 1);
      for (const l of f.legs) expect(l.proxy).toMatch(/^0x[0-9a-f]{40}$/);
      // A composite's last leg is a USD feed.
      expect(f.legs.at(-1)?.description).toMatch(/ \/ USD$/);
    }
    for (const r of REVIEWED_TOKENS) {
      expect(r.address).toMatch(/^0x[0-9a-f]{40}$/);
      // Every reviewed token is also feed priced.
      expect(classFFeed(r.address)?.symbol).toBe(r.symbol);
    }
    expect(reviewedToken("0x754704BC059F8C67012FED69BC8A327A5AAFB603")?.issuer).toBe("Circle");
    expect(classFFeed("0x0000000000000000000000000000000000000001")).toBeNull();
  });
});
