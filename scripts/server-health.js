// @ts-check
// The cloud server's container health checks (infra/server/compose.yaml, docs/HOSTING.md).
// Exits 0 when healthy, 1 with one plain line when not; prints no URL from the environment.
//
//   node scripts/server-health.js http <url>  the URL answers below 500
//   node scripts/server-health.js indexer     the indexer's watermark moved in the last 15 minutes
//   node scripts/server-health.js db          the database answers
import { existsSync } from "node:fs";
import { createDb, sql } from "@alpha-agents/db";
import { ENV_PATH } from "./lib/paths.js";

const INDEXER_STALE_MS = 15 * 60_000;
const [mode, target] = process.argv.slice(2);

/** @param {string} line @returns {never} */
const unhealthy = (line) => {
  console.error(`unhealthy: ${line}`);
  process.exit(1);
};

if (mode === "http") {
  if (!target || !/^http:\/\/127\.0\.0\.1:\d{2,5}\//.test(target))
    unhealthy("give a loopback URL, such as http://127.0.0.1:4100/health");
  const res = await fetch(target, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res) unhealthy(`${target} did not answer`);
  if (res.status >= 500) unhealthy(`${target} answered ${res.status}`);
  console.log(`healthy: ${target} answered ${res.status}`);
} else if (mode === "indexer" || mode === "db") {
  if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);
  const url = process.env.DATABASE_URL;
  if (!url) unhealthy("DATABASE_URL is not set");
  const db = createDb(url, { max: 1 });
  try {
    if (mode === "db") {
      await sql`select 1`.execute(db);
      console.log("healthy: the database answers");
    } else {
      const { rows } = await sql`select max(updated_at) as at from indexer.watermarks`.execute(db);
      const at = /** @type {{ at: Date | null } | undefined} */ (rows[0])?.at ?? null;
      if (!at) unhealthy("the indexer has no watermark yet");
      const age = Date.now() - new Date(at).getTime();
      if (age > INDEXER_STALE_MS)
        unhealthy(`the indexer's watermark is ${Math.round(age / 60_000)} minutes old`);
      console.log(`healthy: the indexer's watermark is ${Math.round(age / 1000)} s old`);
    }
  } catch (err) {
    unhealthy(`the database did not answer (${err instanceof Error ? err.name : "error"})`);
  } finally {
    await db.destroy().catch(() => undefined);
  }
} else {
  console.error("usage: node scripts/server-health.js http <url> | indexer | db");
  process.exit(2);
}
