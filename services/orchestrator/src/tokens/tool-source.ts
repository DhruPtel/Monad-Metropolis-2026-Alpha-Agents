import type { PoolItem, ScreenOutput, TokenItem, TokenSource } from "@alpha-agents/data-tools";
import { NATIVE_MON, SCREEN_CHECK_LABELS } from "@alpha-agents/domain";
import { LOOKUP_FRESH_MS, type TokenRegistry } from "./registry.ts";
import type { PoolRow, ScreenRecord, TokenRow } from "./store.ts";

/**
 * The token tools' view of the registry (F-U1): rows become the tools' typed
 * outputs, bounded and with nothing platform-only (no feed answers, no
 * request records). Token names are read from the token contract and capped.
 */
export function tokenItem(t: TokenRow): TokenItem {
  const feed = t.feed as { kind?: string; ok?: boolean; legs?: { description?: string }[] } | null;
  const listings = t.listings as {
    coingecko?: { id: string } | null;
    coinmarketcap?: { rank: number | null } | null;
  };
  return {
    address: t.address,
    symbol: t.symbol.slice(0, 32),
    name: t.name.slice(0, 80),
    decimals: t.decimals,
    priceClass: t.priceClass,
    feed: feed
      ? {
          kind: feed.kind ?? "direct",
          legs: (feed.legs ?? []).map((l) => (l.description ?? "").slice(0, 60)).slice(0, 2),
          fresh: feed.ok === true,
        }
      : null,
    liquidityUsd: Math.round(t.liquidityUsd),
    volume24hUsd: Math.round(t.volume24hUsd),
    oldestPoolAt: t.oldestPoolAt,
    listedOnCoinGecko: Boolean(listings.coingecko),
    coinMarketCapRank: listings.coinmarketcap?.rank ?? null,
    screen: t.screen
      ? {
          verdict: t.screen.verdict,
          screenedAt: t.screen.screenedAt,
          expiresAt: t.screen.expiresAt,
          fresh: t.screen.fresh,
        }
      : null,
  };
}

export function poolItem(
  p: PoolRow & { symbol0?: string | null; symbol1?: string | null },
  nowMs: number,
): PoolItem {
  const sym = (a: string, s: string | null | undefined) =>
    a === NATIVE_MON ? "MON" : (s ?? `${a.slice(0, 6)}...${a.slice(-4)}`);
  return {
    pool: p.poolId,
    dex: p.dex,
    pair: `${sym(p.token0, p.symbol0)} / ${sym(p.token1, p.symbol1)}`.slice(0, 80),
    token0: p.token0,
    token1: p.token1,
    fee: p.fee,
    routable: p.routable,
    routeNote: p.routeNote.slice(0, 200),
    liquidityUsd: Math.round(p.liquidityUsd),
    volume24hUsd: Math.round(p.volume24hUsd),
    createdAt: p.createdAt,
    ageHours: p.createdAt ? Math.floor((nowMs - Date.parse(p.createdAt)) / 3_600_000) : null,
  };
}

/** A screen as the tool returns it: the verdict, a one-line summary, the route and every check. */
export function screenView(
  s: ScreenRecord,
  symbol: string,
): Omit<ScreenOutput, "source" | "cacheHit"> {
  const failed = s.checks.filter((c) => c.status === "fail");
  const route = s.route as {
    pool?: string;
    dex?: string;
    base?: string;
    fee?: number | null;
  } | null;
  const clip = (v: unknown) => (typeof v === "string" ? v.slice(0, 200) : v);
  return {
    address: s.address,
    symbol: symbol.slice(0, 32),
    verdict: s.verdict,
    buyable: s.verdict === "passed" && Date.parse(s.expiresAt) > Date.now(),
    summary: (s.verdict === "passed"
      ? "Passed every check; buyable until the screen expires."
      : `Refused: ${failed.map((c) => `${SCREEN_CHECK_LABELS[c.code]} (${c.reason})`).join("; ") || "a required check did not pass"}`
    ).slice(0, 400),
    screenedAt: s.createdAt,
    expiresAt: s.expiresAt,
    forkBlock: s.forkBlock,
    route:
      route?.pool && route.dex && route.base
        ? { pool: route.pool, dex: route.dex, base: route.base, fee: route.fee ?? null }
        : null,
    checks: s.checks.map((c) => ({
      code: c.code,
      status: c.status,
      reason: c.reason.slice(0, 300),
      evidence: Object.fromEntries(
        Object.entries(c.evidence).map(([k, v]) => [k, clip(v)]),
      ) as Record<string, string | number | boolean | null>,
    })),
  };
}

export function registryToolSource(r: TokenRegistry, now: () => number = Date.now): TokenSource {
  return {
    get configured() {
      return r.configured;
    },
    async list(f) {
      const rows = await r.list({
        ...(f.priceClass ? { priceClass: f.priceClass } : {}),
        minLiquidityUsd: f.minLiquidityUsd,
        ...(f.screen === "any" ? {} : { screen: f.screen }),
        limit: f.limit,
      });
      return rows.map(tokenItem);
    },
    async newPools(hours, limit) {
      return (await r.newPools(hours, limit)).map((p) => poolItem(p, now()));
    },
    async isFresh(address) {
      const t = await r.store.token(r.chainId, address);
      return t !== null && now() - Date.parse(t.lastSeenAt) < LOOKUP_FRESH_MS;
    },
    async findPools(address, requestedBy) {
      const found = await r.lookup(address, requestedBy);
      const symbols = await r.store.symbols(
        r.chainId,
        found.pools.flatMap((p) => [p.token0, p.token1]),
      );
      return {
        token: tokenItem(found.token),
        pools: found.pools.map((p) =>
          poolItem(
            {
              ...p,
              symbol0: symbols.get(p.token0) ?? null,
              symbol1: symbols.get(p.token1) ?? null,
            },
            now(),
          ),
        ),
        foundBy: found.token.foundBy,
        cacheHit: found.cacheHit,
      };
    },
    async search(query) {
      const { registry, candidates } = await r.search(query);
      return [
        ...registry.map((t) => {
          const item = tokenItem(t);
          return {
            address: t.address,
            symbol: item.symbol,
            name: item.name,
            inRegistry: true,
            priceClass: t.priceClass,
            liquidityUsd: item.liquidityUsd,
            screen: item.screen,
            foundBy: t.foundBy,
            sources: ["registry"],
          };
        }),
        ...candidates.map((c) => ({
          address: c.address,
          symbol: c.symbol.slice(0, 32),
          name: c.name.slice(0, 80),
          inRegistry: false,
          priceClass: null,
          liquidityUsd: null,
          screen: null,
          foundBy: null,
          sources: [...c.sources],
        })),
      ];
    },
    async freshScreen(address) {
      const s = await r.freshScreen(address);
      if (!s) return null;
      const t = await r.store.token(r.chainId, address);
      return screenView(s, t?.symbol ?? "");
    },
    async screen(address, requestedBy) {
      const s = await r.screen(address, requestedBy);
      const t = await r.store.token(r.chainId, address);
      return screenView(s, t?.symbol ?? "");
    },
    asOf: () => new Date(now()).toISOString(),
  };
}
