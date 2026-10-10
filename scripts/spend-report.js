// @ts-check
// pnpm spend:report (P0-SPEND, D-369): where model spend went, from LiteLLM's own spend
// logs in Postgres (schema litellm), joined with the platform's records when they exist:
// by day, by kind of caller (live checks, local development, scripts on the master key,
// testnet agents), by model, by task type for local work, and the costliest hours and
// calls. Prints USD; key aliases only, never a key. Uses DATABASE_URL for APP_ENV.
import { ConfigError, loadConfig } from "@alpha-agents/config";
import { createDb, sql } from "@alpha-agents/db";
import { loadRootEnv } from "./lib/config.js";

loadRootEnv();
const days = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? 14);
let config;
try {
  config = loadConfig({ name: "spend report", usesChain: false, requires: ["DATABASE_URL"] });
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : String(err));
  process.exit(1);
}
const url = /** @type {import("@alpha-agents/config").Secret} */ (config.values.DATABASE_URL);
const db = createDb(url.reveal(), { max: 2 });
const usd = (v) => Number(v ?? 0).toFixed(3);
/** @param {string} title @param {readonly string[]} head @param {readonly (readonly unknown[])[]} rows */
const table = (title, head, rows) => {
  console.log(`\n== ${title}`);
  console.log(head.join(" | "));
  for (const r of rows) console.log(r.join(" | "));
  if (rows.length === 0) console.log("(none)");
};
const since = new Date(Date.now() - days * 86_400_000);
const q = async (/** @type {import("kysely").RawBuilder<unknown>} */ query) =>
  /** @type {Record<string, unknown>[]} */ ((await query.execute(db)).rows);

const total = await q(
  sql`select count(*)::int calls, coalesce(sum(spend),0) usd, min("startTime") first, max("startTime") last
      from litellm."LiteLLM_SpendLogs" where "startTime" >= ${since}`,
);
console.log(
  `Model spend over the last ${days} days: ${usd(total[0]?.usd)} USD in ${String(total[0]?.calls)} calls (${String(total[0]?.first ?? "-").slice(0, 24)} to ${String(total[0]?.last ?? "-").slice(0, 24)}).`,
);
table(
  "by day (UTC)",
  ["day", "calls", "USD"],
  (
    await q(
      sql`select date_trunc('day', "startTime")::date d, count(*)::int calls, sum(spend) usd
          from litellm."LiteLLM_SpendLogs" where "startTime" >= ${since} group by 1 order by 1`,
    )
  ).map((r) => [String(r.d).slice(0, 10), r.calls, usd(r.usd)]),
);
table(
  "by kind of caller",
  ["kind", "calls", "USD"],
  (
    await q(
      sql`select case when metadata->>'user_api_key_alias' like 'aa-live-%' then 'live checks (aa-live-*)'
                      when metadata->>'user_api_key_alias' like 'aa-local-%' then 'local development (aa-local-*)'
                      when metadata->>'user_api_key_alias' like 'aa-testnet-%' then 'testnet agents'
                      when metadata->>'user_api_key_alias' is null then 'scripts on the master key'
                      else 'other: ' || (metadata->>'user_api_key_alias') end kind,
                 count(*)::int calls, sum(spend) usd
          from litellm."LiteLLM_SpendLogs" where "startTime" >= ${since} group by 1 order by 3 desc`,
    )
  ).map((r) => [r.kind, r.calls, usd(r.usd)]),
);
table(
  "by model alias",
  ["alias", "calls", "USD", "avg prompt tokens"],
  (
    await q(
      sql`select coalesce(model_group, model, '?') m, count(*)::int calls, sum(spend) usd, round(avg(prompt_tokens)) p
          from litellm."LiteLLM_SpendLogs" where "startTime" >= ${since} group by 1 order by 3 desc`,
    )
  ).map((r) => [r.m, r.calls, usd(r.usd), r.p]),
);
table(
  "local tasks by purpose (platform records; live checks keep their own databases)",
  ["purpose", "requested by", "calls", "USD"],
  (
    await q(
      sql`select coalesce(l.purpose, '(no lease)') purpose, coalesce(t.requested_by, '-') by, count(*)::int calls, sum(s.spend) usd
          from litellm."LiteLLM_SpendLogs" s
          join platform.model_calls m on m.request_id = s.request_id
          left join platform.sandbox_leases l on l.lease_id = m.lease_id
          left join platform.agent_tasks t on t.lease_id = l.lease_id
          where s."startTime" >= ${since} group by 1, 2 order by 4 desc`,
    )
  ).map((r) => [r.purpose, r.by, r.calls, usd(r.usd)]),
);
table(
  "costliest hours",
  ["hour (UTC)", "namespace", "alias", "calls", "USD"],
  (
    await q(
      sql`select to_char(date_trunc('hour', "startTime"), 'YYYY-MM-DD HH24:00') h, split_part(coalesce(metadata->>'user_api_key_alias','-'), '-', 3) ns,
                 coalesce(model_group, model, '?') m, count(*)::int calls, sum(spend) usd
          from litellm."LiteLLM_SpendLogs" where "startTime" >= ${since} group by 1, 2, 3 order by 5 desc limit 10`,
    )
  ).map((r) => [r.h, r.ns, r.m, r.calls, usd(r.usd)]),
);
table(
  "costliest single calls",
  ["at (UTC)", "alias", "prompt", "completion", "USD"],
  (
    await q(
      sql`select to_char("startTime", 'YYYY-MM-DD HH24:MI:SS') at, coalesce(model_group, model, '?') m, prompt_tokens p, completion_tokens c, spend
          from litellm."LiteLLM_SpendLogs" where "startTime" >= ${since} order by spend desc limit 6`,
    )
  ).map((r) => [r.at, r.m, r.p, r.c, Number(r.spend).toFixed(4)]),
);
await db.destroy();
