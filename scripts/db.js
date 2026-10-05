// @ts-check
// The database (P1-U4, D-199).
//
//   pnpm db:migrate   applies pending migrations (any environment's DATABASE_URL)
//   pnpm db:reset     local only: drops the indexer and platform schemas and
//                     migrates from scratch. The indexer then re-indexes the fork
//                     from AgentNFT's deploy block; the allowlist is emptied.
import { ConfigError, loadConfig } from "@alpha-agents/config";
import { createDb, migrateToLatest, resetDatabase } from "@alpha-agents/db";
import { loadRootEnv } from "./lib/config.js";

loadRootEnv();
const command = process.argv[2];
if (command !== "migrate" && command !== "reset") {
  console.error("usage: node scripts/db.js migrate|reset");
  process.exit(2);
}

let config;
try {
  config = loadConfig({ name: "db scripts", usesChain: false, requires: ["DATABASE_URL"] });
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`error: ${err.message}`);
  process.exit(1);
}
const url = /** @type {import("@alpha-agents/config").Secret} */ (config.values.DATABASE_URL);
if (command === "reset") {
  const host = new URL(url.reveal()).hostname;
  if (config.environment.id !== "local" || !["127.0.0.1", "localhost"].includes(host)) {
    console.error("error: db:reset runs only with APP_ENV=local against a loopback database");
    process.exit(1);
  }
}

const db = createDb(url.reveal(), { max: 1 });
try {
  const applied = command === "reset" ? await resetDatabase(db) : await migrateToLatest(db);
  console.log(
    applied.length > 0
      ? `${command === "reset" ? "reset; applied" : "applied"} ${applied.join(", ")}`
      : "the database is up to date",
  );
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
