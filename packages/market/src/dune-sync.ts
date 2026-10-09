import { readFileSync, writeFileSync } from "node:fs";
import { DUNE_API, DUNE_QUERIES, DUNE_QUERY_NAMES, duneQueryIds, duneSql } from "./dune.ts";

/**
 * `pnpm dune:sync` (P3-U9): saves the platform's queries on Dune from the SQL
 * in packages/market/dune, creating any that has no ID yet and updating the
 * SQL of the rest, then records the IDs in dune/queries.json (commit it).
 * Reads DUNE_API_KEY from .env; prints names and IDs only, never the key.
 * Saving a query costs no credits; running one does.
 */
const ENV = new URL("../../../.env", import.meta.url);
try {
  process.loadEnvFile(ENV);
} catch {
  // No .env: the key may be in the environment.
}
const key = process.env.DUNE_API_KEY?.trim();
if (!key) {
  console.error("DUNE_API_KEY is not set (in .env or the environment).");
  process.exit(1);
}

const call = async (method: "POST" | "PATCH", path: string, body: unknown) => {
  const res = await fetch(`${DUNE_API}${path}`, {
    method,
    headers: { "X-Dune-Api-Key": key, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`Dune answered ${res.status} to ${method} ${path}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as { query_id?: number };
};

const ids = duneQueryIds();
for (const name of DUNE_QUERY_NAMES) {
  const spec = DUNE_QUERIES[name];
  const body = {
    name: `Alpha Agents: ${spec.title}`,
    description: `${spec.description} Saved by Alpha Agents (P3-U9); the agent runs it by name.`,
    query_sql: duneSql(name),
    parameters: [{ key: "days", type: "number", value: String(spec.runDays) }],
    is_private: false,
  };
  const id = ids[name];
  if (id === null) {
    const r = await call("POST", "/query", body);
    if (typeof r.query_id !== "number") throw new Error(`Dune did not return an ID for ${name}`);
    ids[name] = r.query_id;
    console.log(`created ${name}: ${r.query_id}`);
  } else {
    await call("PATCH", `/query/${id}`, body);
    console.log(`updated ${name}: ${id}`);
  }
}
const file = new URL("../dune/queries.json", import.meta.url);
const current = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
writeFileSync(file, `${JSON.stringify({ ...current, ids }, null, 2)}\n`);
console.log("Recorded the IDs in packages/market/dune/queries.json.");
