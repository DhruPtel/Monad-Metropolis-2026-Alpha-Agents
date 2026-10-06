import { type Kysely, sql } from "kysely";

/**
 * P1-U5: the orchestrator's records (D-202). Postgres is the source of truth;
 * the Redis queue only carries work. Every table is in the `platform` schema.
 *
 * - `agent_runtimes`: one row per provisioned agent: its rendered Hermes
 *   configuration, its LiteLLM key alias and the key itself, encrypted (D-203).
 * - `sandbox_leases`: at most one active lease per agent, enforced by a
 *   partial unique index, with an expiry and the hash of its gate token.
 * - `agent_tasks`: tasks run in a lease (the dev console's no-op task), with
 *   their structured result.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const pf = db.schema.withSchema("platform");

  await pf
    .createTable("agent_runtimes")
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "bigint", (c) => c.notNull())
    // Bumped by a reset, so a reprovisioned agent gets a new key alias.
    .addColumn("generation", "integer", (c) => c.notNull())
    .addColumn("status", "text", (c) =>
      c
        .notNull()
        .check(
          sql`status in ('provisioning', 'ready', 'deprovisioning', 'deprovisioned', 'failed')`,
        ),
    )
    .addColumn("tier", "smallint", (c) => c.notNull())
    .addColumn("species", "smallint", (c) => c.notNull())
    .addColumn("config", "jsonb", (c) => c.notNull())
    .addColumn("config_hash", "text", (c) => c.notNull())
    .addColumn("key_alias", "text", (c) => c.notNull())
    // AES-256-GCM, cleared when the key is deleted.
    .addColumn("key_ciphertext", "text")
    .addColumn("budget_usd", "numeric(12, 6)", (c) => c.notNull())
    .addColumn("last_error", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("provisioned_at", "timestamptz")
    .addColumn("deprovisioned_at", "timestamptz")
    .addPrimaryKeyConstraint("agent_runtimes_pk", ["chain_id", "agent_id"])
    .execute();
  await pf.createIndex("agent_runtimes_alias").on("agent_runtimes").column("key_alias").execute();

  await pf
    .createTable("sandbox_leases")
    .addColumn("lease_id", "text", (c) => c.primaryKey())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "bigint", (c) => c.notNull())
    // The orchestrator run that holds it, and the sweep namespace it is tagged with.
    .addColumn("run_tag", "text", (c) => c.notNull())
    .addColumn("namespace", "text", (c) => c.notNull())
    .addColumn("purpose", "text", (c) => c.notNull())
    .addColumn("sandbox_id", "text")
    // sha256 of the gate token; the token itself is never stored.
    .addColumn("gate_token_hash", "text", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull().check(sql`status in ('active', 'ended')`))
    .addColumn("started_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("expires_at", "timestamptz", (c) => c.notNull())
    .addColumn("ended_at", "timestamptz")
    .addColumn("end_reason", "text")
    .execute();
  await sql`create unique index sandbox_leases_one_active on platform.sandbox_leases (chain_id, agent_id) where status = 'active'`.execute(
    db,
  );
  await pf
    .createIndex("sandbox_leases_gate_token")
    .on("sandbox_leases")
    .column("gate_token_hash")
    .execute();

  await pf
    .createTable("agent_tasks")
    .addColumn("task_id", "text", (c) => c.primaryKey())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "bigint", (c) => c.notNull())
    .addColumn("kind", "text", (c) => c.notNull().check(sql`kind in ('noop')`))
    .addColumn("status", "text", (c) =>
      c.notNull().check(sql`status in ('queued', 'running', 'succeeded', 'failed')`),
    )
    .addColumn("lease_id", "text")
    .addColumn("result", "jsonb")
    .addColumn("error", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("started_at", "timestamptz")
    .addColumn("finished_at", "timestamptz")
    .execute();
  await pf
    .createIndex("agent_tasks_agent")
    .on("agent_tasks")
    .columns(["chain_id", "agent_id", "created_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const pf = db.schema.withSchema("platform");
  await pf.dropTable("agent_tasks").ifExists().execute();
  await pf.dropTable("sandbox_leases").ifExists().execute();
  await pf.dropTable("agent_runtimes").ifExists().execute();
}
