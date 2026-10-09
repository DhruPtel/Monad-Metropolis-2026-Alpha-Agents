import { type Kysely, sql } from "kysely";

/**
 * F-U1: the platform's offchain token registry, which F-U2's onchain
 * TokenRegistry mirrors.
 *
 * - `platform.tokens`: one row per token discovered on a chain: its symbol,
 *   name and decimals as the contract answers them, its price class (F with
 *   its verified feed, or A), its deepest pool and liquidity, its listings,
 *   and its latest screen. `registry_lane` and `registry_status` are what
 *   F-U2 will write onchain (core or screened lane; listed, sell-only or
 *   delisted); they start empty, so nothing here can be bought yet.
 * - `platform.token_pools`: each pool seen on Uniswap v3, Uniswap v4 or
 *   PancakeSwap v3, with its key (fee, tick spacing, hooks), whether the
 *   platform can route through it, its liquidity, volume and creation time.
 * - `platform.token_screens`: every screen ever run, kept as history: the
 *   verdict, each check with its reason and evidence, the route, the fork
 *   block, who asked, and when it expires.
 * - `platform.token_discovery_runs`: each discovery pass and what it found.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const pf = db.schema.withSchema("platform");

  await pf
    .createTable("tokens")
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("address", "text", (c) => c.notNull())
    .addColumn("symbol", "text", (c) => c.notNull())
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("decimals", "integer", (c) => c.notNull())
    .addColumn("price_class", "text", (c) => c.notNull().check(sql`price_class in ('F', 'A')`))
    .addColumn("feed", "jsonb")
    .addColumn("listings", "jsonb", (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("liquidity_usd", "double precision", (c) => c.notNull().defaultTo(0))
    .addColumn("volume_24h_usd", "double precision", (c) => c.notNull().defaultTo(0))
    .addColumn("deepest_pool", "text")
    .addColumn("oldest_pool_at", "timestamptz")
    .addColumn("latest_screen_id", "text")
    .addColumn("screen_verdict", "text", (c) =>
      c.check(sql`screen_verdict in ('passed', 'refused')`),
    )
    .addColumn("screened_at", "timestamptz")
    .addColumn("screen_expires_at", "timestamptz")
    .addColumn("registry_lane", "text", (c) => c.check(sql`registry_lane in ('core', 'screened')`))
    .addColumn("registry_status", "text", (c) =>
      c.check(sql`registry_status in ('listed', 'sell_only', 'delisted')`),
    )
    .addColumn("first_seen_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("last_seen_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("tokens_pk", ["chain_id", "address"])
    .execute();
  await pf
    .createIndex("tokens_liquidity")
    .on("tokens")
    .columns(["chain_id", "liquidity_usd"])
    .execute();

  await pf
    .createTable("token_pools")
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("pool_id", "text", (c) => c.notNull())
    .addColumn("dex", "text", (c) =>
      c.notNull().check(sql`dex in ('uniswap_v3', 'uniswap_v4', 'pancakeswap_v3')`),
    )
    .addColumn("token0", "text", (c) => c.notNull())
    .addColumn("token1", "text", (c) => c.notNull())
    .addColumn("fee", "integer")
    .addColumn("tick_spacing", "integer")
    .addColumn("hooks", "text")
    .addColumn("routable", "boolean", (c) => c.notNull())
    .addColumn("route_note", "text", (c) => c.notNull())
    .addColumn("liquidity_usd", "double precision", (c) => c.notNull())
    .addColumn("volume_24h_usd", "double precision", (c) => c.notNull())
    .addColumn("pool_created_at", "timestamptz")
    .addColumn("first_seen_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("last_seen_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("token_pools_pk", ["chain_id", "pool_id"])
    .execute();
  await pf
    .createIndex("token_pools_token0")
    .on("token_pools")
    .columns(["chain_id", "token0"])
    .execute();
  await pf
    .createIndex("token_pools_token1")
    .on("token_pools")
    .columns(["chain_id", "token1"])
    .execute();
  await pf
    .createIndex("token_pools_created")
    .on("token_pools")
    .columns(["chain_id", "pool_created_at"])
    .execute();

  await pf
    .createTable("token_screens")
    .addColumn("screen_id", "text", (c) => c.primaryKey())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("address", "text", (c) => c.notNull())
    .addColumn("verdict", "text", (c) => c.notNull().check(sql`verdict in ('passed', 'refused')`))
    .addColumn("checks", "jsonb", (c) => c.notNull())
    .addColumn("route", "jsonb")
    .addColumn("fork_block", "bigint")
    .addColumn("requested_by", "text", (c) => c.notNull())
    .addColumn("duration_ms", "integer", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("expires_at", "timestamptz", (c) => c.notNull())
    .execute();
  await pf
    .createIndex("token_screens_token")
    .on("token_screens")
    .columns(["chain_id", "address", "created_at"])
    .execute();

  await pf
    .createTable("token_discovery_runs")
    .addColumn("run_id", "text", (c) => c.primaryKey())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("status", "text", (c) =>
      c.notNull().check(sql`status in ('running', 'completed', 'failed')`),
    )
    .addColumn("pools_seen", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("tokens_seen", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("new_pools", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("sources", "jsonb", (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("error", "text")
    .addColumn("started_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("finished_at", "timestamptz")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const pf = db.schema.withSchema("platform");
  await pf.dropTable("token_discovery_runs").execute();
  await pf.dropTable("token_screens").execute();
  await pf.dropTable("token_pools").execute();
  await pf.dropTable("tokens").execute();
}
