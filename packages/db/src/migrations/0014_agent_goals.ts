import { type Kysely, sql } from "kysely";

/**
 * P3-U1: the owner's goal and the agent's offchain state.
 *
 * - `platform.agent_goals`: every goal an owner saved, one current per agent
 *   (D-281), with the goal as sent, the translated configuration, its policy
 *   hash and SOUL.md block, the strategy epoch it was saved under and the
 *   ownership epoch of the owner who saved it.
 * - `platform.agent_states`: one row per agent with its state (FINAL_PLAN
 *   4.12) and its strategy epoch, the platform counter bumped on every saved
 *   goal (and later every accepted plan change, P3-U6). It never touches the
 *   Executor's configuration epoch, so it never ends arming.
 * - `platform.agent_state_changes`: every change of state, with its reason.
 * - `platform.intents.strategy_epoch`: the strategy epoch an intent was
 *   proposed under; the trade flow refuses a stale one (STRATEGY_EPOCH_STALE).
 */
const STATES = sql`('UNCONFIGURED', 'READY', 'RUNNING', 'RESTRICTED', 'INCIDENT')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("platform")
    .createTable("agent_states")
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "integer", (c) => c.notNull())
    .addColumn("state", "text", (c) => c.notNull().check(sql`state in ${STATES}`))
    .addColumn("strategy_epoch", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("agent_states_pk", ["chain_id", "agent_id"])
    .execute();

  await db.schema
    .withSchema("platform")
    .createTable("agent_state_changes")
    .addColumn("change_id", "bigserial", (c) => c.primaryKey())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "integer", (c) => c.notNull())
    .addColumn("from_state", "text", (c) => c.notNull().check(sql`from_state in ${STATES}`))
    .addColumn("to_state", "text", (c) => c.notNull().check(sql`to_state in ${STATES}`))
    .addColumn("reason", "text", (c) => c.notNull())
    .addColumn("strategy_epoch", "bigint", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema
    .withSchema("platform")
    .createIndex("agent_state_changes_by_agent")
    .on("agent_state_changes")
    .columns(["chain_id", "agent_id", "change_id"])
    .execute();

  await db.schema
    .withSchema("platform")
    .createTable("agent_goals")
    .addColumn("goal_id", "text", (c) => c.primaryKey())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "integer", (c) => c.notNull())
    .addColumn("strategy_epoch", "bigint", (c) => c.notNull())
    // The ownership epoch of the owner who saved it: a goal binds only that owner (FINAL_PLAN 6.1).
    .addColumn("owner_epoch", "bigint", (c) => c.notNull())
    .addColumn("saved_by", "text", (c) => c.notNull())
    .addColumn("goal", "jsonb", (c) => c.notNull())
    .addColumn("config", "jsonb", (c) => c.notNull())
    .addColumn("policy_hash", "text", (c) => c.notNull())
    .addColumn("soul_block", "text", (c) => c.notNull())
    .addColumn("current", "boolean", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`create unique index agent_goals_one_current on platform.agent_goals (chain_id, agent_id) where current`.execute(
    db,
  );
  await sql`create unique index agent_goals_one_per_epoch on platform.agent_goals (chain_id, agent_id, strategy_epoch)`.execute(
    db,
  );

  await db.schema
    .withSchema("platform")
    .alterTable("intents")
    .addColumn("strategy_epoch", "bigint")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("platform")
    .alterTable("intents")
    .dropColumn("strategy_epoch")
    .execute();
  await db.schema.withSchema("platform").dropTable("agent_goals").execute();
  await db.schema.withSchema("platform").dropTable("agent_state_changes").execute();
  await db.schema.withSchema("platform").dropTable("agent_states").execute();
}
