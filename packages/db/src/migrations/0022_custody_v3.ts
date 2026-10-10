import { type Kysely, sql } from "kysely";

/**
 * F-U5 (D-367): intents, armings and snapshots say which custody set they
 * belong to. The v2 set trades USDC and WMON; the fund agent's v3 set trades
 * any pair of registered tokens through a route of registered pools, so an
 * intent's `sell` and `buy` become the tokens' symbols with their addresses
 * beside them, and its route is kept for the signer and the console. An
 * arming records the Executor the grant is on, and a snapshot of a v3
 * account keeps every held token with its value.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const pf = db.schema.withSchema("platform");
  await sql`alter table platform.intents drop constraint intents_sell_check`.execute(db);
  await sql`alter table platform.intents drop constraint intents_buy_check`.execute(db);
  await pf
    .alterTable("intents")
    .addColumn("custody", "text", (c) =>
      c
        .notNull()
        .defaultTo("v2")
        .check(sql`custody in ('v2', 'v3')`),
    )
    .addColumn("sell_token", "text")
    .addColumn("buy_token", "text")
    /** The route the proposal chose: registered pool IDs, in order (v3). */
    .addColumn("route", "jsonb")
    .execute();
  await pf
    .alterTable("arming")
    .addColumn("custody", "text", (c) =>
      c
        .notNull()
        .defaultTo("v2")
        .check(sql`custody in ('v2', 'v3')`),
    )
    .addColumn("executor", "text")
    .execute();
  await pf
    .alterTable("account_snapshots")
    .addColumn("custody", "text", (c) =>
      c
        .notNull()
        .defaultTo("v2")
        .check(sql`custody in ('v2', 'v3')`),
    )
    /** Every held token of a v3 account: symbol, amount, price and value, as the account values it. */
    .addColumn("holdings", "jsonb")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table platform.account_snapshots drop column holdings, drop column custody`.execute(
    db,
  );
  await sql`alter table platform.arming drop column executor, drop column custody`.execute(db);
  await sql`alter table platform.intents drop column route, drop column buy_token, drop column sell_token, drop column custody`.execute(
    db,
  );
  await sql`alter table platform.intents add constraint intents_sell_check check (sell in ('USDC', 'WMON'))`.execute(
    db,
  );
  await sql`alter table platform.intents add constraint intents_buy_check check (buy in ('USDC', 'WMON'))`.execute(
    db,
  );
}
