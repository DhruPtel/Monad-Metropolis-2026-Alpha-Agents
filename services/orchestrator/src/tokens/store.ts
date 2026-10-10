import { type Db, sql } from "@alpha-agents/db";
import type { PriceClass, ScreenCheck, ScreenVerdict } from "@alpha-agents/domain";
import type { Discovery, KnownState, SourceStatus } from "@alpha-agents/market";

/**
 * The token registry's records (F-U1, migration 0019): tokens, pools, every
 * screen as history, and discovery runs. Addresses are lowercase. A token's
 * latest screen is copied onto its row so lists can filter by it; the
 * screens table keeps every result.
 */
export interface TokenRow {
  readonly chainId: number;
  readonly address: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly priceClass: PriceClass;
  readonly feed: Record<string, unknown> | null;
  readonly listings: Record<string, unknown>;
  readonly liquidityUsd: number;
  readonly volume24hUsd: number;
  readonly deepestPool: string | null;
  readonly oldestPoolAt: string | null;
  readonly screen: {
    readonly screenId: string;
    readonly verdict: ScreenVerdict;
    readonly screenedAt: string;
    readonly expiresAt: string;
    /** Whether it is still inside its six hours. */
    readonly fresh: boolean;
  } | null;
  readonly registryLane: "core" | "screened" | null;
  readonly registryStatus: "listed" | "sell_only" | "delisted" | null;
  /** Who first found the token: `discovery`, `console` or `agent:<id>` (D-360). */
  readonly foundBy: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

export interface PoolRow {
  readonly poolId: string;
  readonly dex: "uniswap_v3" | "uniswap_v4" | "pancakeswap_v3";
  readonly token0: string;
  readonly token1: string;
  readonly fee: number | null;
  readonly tickSpacing: number | null;
  readonly hooks: string | null;
  readonly routable: boolean;
  readonly routeNote: string;
  readonly liquidityUsd: number;
  readonly volume24hUsd: number;
  readonly createdAt: string | null;
  readonly firstSeenAt: string;
}

export interface ScreenRecord {
  readonly screenId: string;
  readonly chainId: number;
  readonly address: string;
  readonly verdict: ScreenVerdict;
  readonly checks: readonly ScreenCheck[];
  readonly route: Record<string, unknown> | null;
  readonly forkBlock: number | null;
  readonly requestedBy: string;
  readonly durationMs: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface DiscoveryRun {
  readonly runId: string;
  readonly status: "running" | "completed" | "failed";
  readonly poolsSeen: number;
  readonly tokensSeen: number;
  readonly newPools: number;
  readonly sources: Record<string, SourceStatus>;
  readonly error: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export type ScreenFilter = "passed" | "refused" | "unscreened" | "expired";

export interface TokenFilter {
  readonly priceClass?: PriceClass;
  readonly minLiquidityUsd?: number;
  readonly screen?: ScreenFilter;
  readonly limit?: number;
}

const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

interface TokenDb {
  chain_id: number;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  price_class: PriceClass;
  feed: Record<string, unknown> | null;
  listings: Record<string, unknown>;
  liquidity_usd: number;
  volume_24h_usd: number;
  deepest_pool: string | null;
  oldest_pool_at: Date | null;
  latest_screen_id: string | null;
  screen_verdict: ScreenVerdict | null;
  screened_at: Date | null;
  screen_expires_at: Date | null;
  registry_lane: "core" | "screened" | null;
  registry_status: "listed" | "sell_only" | "delisted" | null;
  found_by: string;
  first_seen_at: Date;
  last_seen_at: Date;
}

function tokenRow(r: TokenDb, nowMs: number): TokenRow {
  return {
    chainId: r.chain_id,
    address: r.address,
    symbol: r.symbol,
    name: r.name,
    decimals: r.decimals,
    priceClass: r.price_class,
    feed: r.feed,
    listings: r.listings,
    liquidityUsd: r.liquidity_usd,
    volume24hUsd: r.volume_24h_usd,
    deepestPool: r.deepest_pool,
    oldestPoolAt: iso(r.oldest_pool_at),
    screen:
      r.latest_screen_id && r.screen_verdict && r.screened_at && r.screen_expires_at
        ? {
            screenId: r.latest_screen_id,
            verdict: r.screen_verdict,
            screenedAt: new Date(r.screened_at).toISOString(),
            expiresAt: new Date(r.screen_expires_at).toISOString(),
            fresh: new Date(r.screen_expires_at).getTime() > nowMs,
          }
        : null,
    registryLane: r.registry_lane,
    registryStatus: r.registry_status,
    foundBy: r.found_by,
    firstSeenAt: new Date(r.first_seen_at).toISOString(),
    lastSeenAt: new Date(r.last_seen_at).toISOString(),
  };
}

interface PoolDb {
  pool_id: string;
  dex: PoolRow["dex"];
  token0: string;
  token1: string;
  fee: number | null;
  tick_spacing: number | null;
  hooks: string | null;
  routable: boolean;
  route_note: string;
  liquidity_usd: number;
  volume_24h_usd: number;
  pool_created_at: Date | null;
  first_seen_at: Date;
}

const poolRow = (r: PoolDb): PoolRow => ({
  poolId: r.pool_id,
  dex: r.dex,
  token0: r.token0,
  token1: r.token1,
  fee: r.fee,
  tickSpacing: r.tick_spacing,
  hooks: r.hooks,
  routable: r.routable,
  routeNote: r.route_note,
  liquidityUsd: r.liquidity_usd,
  volume24hUsd: r.volume_24h_usd,
  createdAt: iso(r.pool_created_at),
  firstSeenAt: new Date(r.first_seen_at).toISOString(),
});

interface ScreenDb {
  screen_id: string;
  chain_id: number;
  address: string;
  verdict: ScreenVerdict;
  checks: unknown[];
  route: Record<string, unknown> | null;
  fork_block: number | null;
  requested_by: string;
  duration_ms: number;
  created_at: Date;
  expires_at: Date;
}

const screenRecord = (r: ScreenDb): ScreenRecord => ({
  screenId: r.screen_id,
  chainId: r.chain_id,
  address: r.address,
  verdict: r.verdict,
  checks: r.checks as ScreenCheck[],
  route: r.route,
  forkBlock: r.fork_block,
  requestedBy: r.requested_by,
  durationMs: r.duration_ms,
  createdAt: new Date(r.created_at).toISOString(),
  expiresAt: new Date(r.expires_at).toISOString(),
});

export class TokenStore {
  private readonly db: Db;
  private readonly now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  async startRun(chainId: number, runId: string): Promise<void> {
    await this.db
      .insertInto("platform.token_discovery_runs")
      .values({ run_id: runId, chain_id: chainId, status: "running", error: null })
      .execute();
  }

  async finishRun(
    runId: string,
    r:
      | {
          status: "completed";
          poolsSeen: number;
          tokensSeen: number;
          newPools: number;
          sources: Record<string, SourceStatus>;
        }
      | { status: "failed"; error: string; sources?: Record<string, SourceStatus> },
  ): Promise<void> {
    await this.db
      .updateTable("platform.token_discovery_runs")
      .set(
        r.status === "completed"
          ? {
              status: "completed",
              pools_seen: r.poolsSeen,
              tokens_seen: r.tokensSeen,
              new_pools: r.newPools,
              sources: JSON.stringify(r.sources),
              finished_at: new Date(this.now()),
            }
          : {
              status: "failed",
              error: r.error.slice(0, 500),
              sources: JSON.stringify(r.sources ?? {}),
              finished_at: new Date(this.now()),
            },
      )
      .where("run_id", "=", runId)
      .execute();
  }

  async runs(chainId: number, limit = 10): Promise<DiscoveryRun[]> {
    const rows = await this.db
      .selectFrom("platform.token_discovery_runs")
      .selectAll()
      .where("chain_id", "=", chainId)
      .orderBy("started_at", "desc")
      .limit(limit)
      .execute();
    return rows.map((r) => ({
      runId: r.run_id,
      status: r.status,
      poolsSeen: r.pools_seen,
      tokensSeen: r.tokens_seen,
      newPools: r.new_pools,
      sources: r.sources as Record<string, SourceStatus>,
      error: r.error,
      startedAt: new Date(r.started_at).toISOString(),
      finishedAt: iso(r.finished_at),
    }));
  }

  /** What the registry already confirmed, so discovery reads the chain only for what is new. */
  async knownState(chainId: number): Promise<KnownState> {
    const [pools, tokens] = await Promise.all([
      this.db
        .selectFrom("platform.token_pools")
        .selectAll()
        .where("chain_id", "=", chainId)
        .execute(),
      this.db
        .selectFrom("platform.tokens")
        .select(["address", "symbol", "name", "decimals"])
        .where("chain_id", "=", chainId)
        .execute(),
    ]);
    return {
      pools: new Map(
        pools.map((p) => [
          p.pool_id,
          {
            dex: p.dex,
            poolId: p.pool_id,
            token0: p.token0,
            token1: p.token1,
            fee: p.fee,
            tickSpacing: p.tick_spacing,
            hooks: p.hooks,
            routable: p.routable,
            note: p.route_note,
          },
        ]),
      ),
      tokens: new Map(
        tokens.map((t) => [t.address, { symbol: t.symbol, name: t.name, decimals: t.decimals }]),
      ),
    };
  }

  /** Writes a discovery: pools and tokens upserted, with their latest figures. Returns how many pools are new. */
  async saveDiscovery(
    chainId: number,
    d: Pick<Discovery, "pools" | "tokens">,
    foundBy = "discovery",
  ): Promise<number> {
    const at = new Date(this.now());
    return this.db.transaction().execute(async (tx) => {
      const before = new Set(
        (
          await tx
            .selectFrom("platform.token_pools")
            .select("pool_id")
            .where("chain_id", "=", chainId)
            .execute()
        ).map((r) => r.pool_id),
      );
      for (const p of d.pools) {
        await tx
          .insertInto("platform.token_pools")
          .values({
            chain_id: chainId,
            pool_id: p.poolId,
            dex: p.dex,
            token0: p.token0,
            token1: p.token1,
            fee: p.fee,
            tick_spacing: p.tickSpacing,
            hooks: p.hooks,
            routable: p.routable,
            route_note: p.note,
            liquidity_usd: p.liquidityUsd,
            volume_24h_usd: p.volume24hUsd,
            pool_created_at: p.createdAt,
            first_seen_at: at,
            last_seen_at: at,
          })
          .onConflict((oc) =>
            oc.columns(["chain_id", "pool_id"]).doUpdateSet({
              liquidity_usd: p.liquidityUsd,
              volume_24h_usd: p.volume24hUsd,
              routable: p.routable,
              route_note: p.note,
              last_seen_at: at,
            }),
          )
          .execute();
      }
      for (const t of d.tokens) {
        const values = {
          symbol: t.symbol,
          name: t.name,
          decimals: t.decimals,
          price_class: t.priceClass,
          feed: t.feed ? JSON.stringify(t.feed) : null,
          listings: JSON.stringify(t.listings),
          liquidity_usd: t.liquidityUsd,
          volume_24h_usd: t.volume24hUsd,
          deepest_pool: t.deepestPool,
          oldest_pool_at: t.oldestPoolAt,
          last_seen_at: at,
        };
        await tx
          .insertInto("platform.tokens")
          .values({
            chain_id: chainId,
            address: t.address,
            ...values,
            found_by: foundBy,
            first_seen_at: at,
          })
          .onConflict((oc) => oc.columns(["chain_id", "address"]).doUpdateSet(values))
          .execute();
      }
      return d.pools.filter((p) => !before.has(p.poolId)).length;
    });
  }

  async listTokens(chainId: number, f: TokenFilter = {}): Promise<TokenRow[]> {
    const now = new Date(this.now());
    let q = this.db.selectFrom("platform.tokens").selectAll().where("chain_id", "=", chainId);
    if (f.priceClass) q = q.where("price_class", "=", f.priceClass);
    if (f.minLiquidityUsd !== undefined) q = q.where("liquidity_usd", ">=", f.minLiquidityUsd);
    if (f.screen === "unscreened") q = q.where("latest_screen_id", "is", null);
    if (f.screen === "expired") q = q.where("screen_expires_at", "<=", now);
    if (f.screen === "passed" || f.screen === "refused")
      q = q.where("screen_verdict", "=", f.screen).where("screen_expires_at", ">", now);
    const rows = await q
      .orderBy("liquidity_usd", "desc")
      .orderBy("address")
      .limit(f.limit ?? 100)
      .execute();
    return rows.map((r) => tokenRow(r as unknown as TokenDb, this.now()));
  }

  async token(chainId: number, address: string): Promise<TokenRow | null> {
    const r = await this.db
      .selectFrom("platform.tokens")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where("address", "=", address.toLowerCase())
      .executeTakeFirst();
    return r ? tokenRow(r as unknown as TokenDb, this.now()) : null;
  }

  /** Registry tokens whose symbol or name is the query, case-insensitively, deepest first. */
  async findBySymbol(chainId: number, query: string, limit = 10): Promise<TokenRow[]> {
    const q = query.trim().toLowerCase();
    const rows = await this.db
      .selectFrom("platform.tokens")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where((eb) => eb.or([eb(sql`lower(symbol)`, "=", q), eb(sql`lower(name)`, "=", q)]))
      .orderBy("liquidity_usd", "desc")
      .limit(limit)
      .execute();
    return rows.map((r) => tokenRow(r as unknown as TokenDb, this.now()));
  }

  /** Every pool holding the token; native MON pools count for WMON. */
  async poolsOf(chainId: number, address: string, alsoNative = false): Promise<PoolRow[]> {
    const a = address.toLowerCase();
    const ids = alsoNative ? [a, "0x0000000000000000000000000000000000000000"] : [a];
    const rows = await this.db
      .selectFrom("platform.token_pools")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where((eb) => eb.or([eb("token0", "in", ids), eb("token1", "in", ids)]))
      .orderBy("liquidity_usd", "desc")
      .execute();
    return rows.map((r) => poolRow(r as unknown as PoolDb));
  }

  /** Symbols of the given tokens, for naming pool pairs; native MON is "MON". */
  async symbols(chainId: number, addresses: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>([["0x0000000000000000000000000000000000000000", "MON"]]);
    const want = [...new Set(addresses)].filter((a) => !out.has(a));
    if (want.length === 0) return out;
    const rows = await this.db
      .selectFrom("platform.tokens")
      .select(["address", "symbol"])
      .where("chain_id", "=", chainId)
      .where("address", "in", want)
      .execute();
    for (const r of rows) out.set(r.address, r.symbol);
    return out;
  }

  /** Pools created since `sinceMs` by their creation time, newest first, with each side's symbol. */
  async newPools(chainId: number, sinceMs: number, limit = 50) {
    const rows = await this.db
      .selectFrom("platform.token_pools as p")
      .leftJoin("platform.tokens as t0", (j) =>
        j.onRef("t0.address", "=", "p.token0").onRef("t0.chain_id", "=", "p.chain_id"),
      )
      .leftJoin("platform.tokens as t1", (j) =>
        j.onRef("t1.address", "=", "p.token1").onRef("t1.chain_id", "=", "p.chain_id"),
      )
      .selectAll("p")
      .select(["t0.symbol as symbol0", "t1.symbol as symbol1"])
      .where("p.chain_id", "=", chainId)
      .where("p.pool_created_at", ">=", new Date(sinceMs))
      .orderBy("p.pool_created_at", "desc")
      .limit(limit)
      .execute();
    return rows.map((r) => ({
      ...poolRow(r as unknown as PoolDb),
      symbol0: r.token0 === "0x0000000000000000000000000000000000000000" ? "MON" : r.symbol0,
      symbol1: r.token1 === "0x0000000000000000000000000000000000000000" ? "MON" : r.symbol1,
    }));
  }

  async saveScreen(s: ScreenRecord): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await tx
        .insertInto("platform.token_screens")
        .values({
          screen_id: s.screenId,
          chain_id: s.chainId,
          address: s.address,
          verdict: s.verdict,
          checks: JSON.stringify(s.checks),
          route: s.route ? JSON.stringify(s.route) : null,
          fork_block: s.forkBlock,
          requested_by: s.requestedBy,
          duration_ms: s.durationMs,
          created_at: s.createdAt,
          expires_at: s.expiresAt,
        })
        .execute();
      await tx
        .updateTable("platform.tokens")
        .set({
          latest_screen_id: s.screenId,
          screen_verdict: s.verdict,
          screened_at: s.createdAt,
          screen_expires_at: s.expiresAt,
        })
        .where("chain_id", "=", s.chainId)
        .where("address", "=", s.address)
        .execute();
    });
  }

  async screens(chainId: number, address: string, limit = 10): Promise<ScreenRecord[]> {
    const rows = await this.db
      .selectFrom("platform.token_screens")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where("address", "=", address.toLowerCase())
      .orderBy("created_at", "desc")
      .limit(limit)
      .execute();
    return rows.map((r) => screenRecord(r as unknown as ScreenDb));
  }

  async screen(screenId: string): Promise<ScreenRecord | null> {
    const r = await this.db
      .selectFrom("platform.token_screens")
      .selectAll()
      .where("screen_id", "=", screenId)
      .executeTakeFirst();
    return r ? screenRecord(r as unknown as ScreenDb) : null;
  }

  /** Tokens whose screen is missing or expired, deepest first, above a liquidity floor. */
  async dueForScreen(chainId: number, minLiquidityUsd: number, limit: number): Promise<string[]> {
    const rows = await this.db
      .selectFrom("platform.tokens")
      .select("address")
      .where("chain_id", "=", chainId)
      .where("liquidity_usd", ">=", minLiquidityUsd)
      .where((eb) =>
        eb.or([
          eb("screen_expires_at", "is", null),
          eb("screen_expires_at", "<=", new Date(this.now())),
        ]),
      )
      .orderBy("liquidity_usd", "desc")
      .limit(limit)
      .execute();
    return rows.map((r) => r.address);
  }

  async counts(chainId: number) {
    const now = new Date(this.now());
    const r = await this.db
      .selectFrom("platform.tokens")
      .select([
        sql<number>`count(*)::int`.as("tokens"),
        sql<number>`count(*) filter (where price_class = 'F')::int`.as("classF"),
        sql<number>`count(*) filter (where price_class = 'A')::int`.as("classA"),
        sql<number>`count(*) filter (where screen_verdict = 'passed' and screen_expires_at > ${now})::int`.as(
          "passing",
        ),
        sql<number>`count(*) filter (where screen_verdict = 'refused' and screen_expires_at > ${now})::int`.as(
          "refused",
        ),
      ])
      .where("chain_id", "=", chainId)
      .executeTakeFirstOrThrow();
    const pools = await this.db
      .selectFrom("platform.token_pools")
      .select([
        sql<number>`count(*)::int`.as("pools"),
        sql<number>`count(*) filter (where routable)::int`.as("routable"),
      ])
      .where("chain_id", "=", chainId)
      .executeTakeFirstOrThrow();
    return { ...r, ...pools };
  }
}
