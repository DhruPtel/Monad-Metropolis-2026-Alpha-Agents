import { readFileSync } from "node:fs";
import { type Cached, type MarketCache, cacheKey } from "./cache.ts";
import { type FigureWarning } from "./figures.ts";
import { cleanText } from "./text.ts";
import { MarketError, type Sleep, type TokenBucket, getJson, realSleep } from "./upstream.ts";
import type { DailyBudget } from "./usage.ts";

/**
 * Dune for research (P3-U9): a small platform list of saved, parameterized
 * queries for Monad onchain analytics. The agent runs one by name; the SQL
 * lives in packages/market/dune, is saved on Dune by `pnpm dune:sync`, and
 * never comes from the model. A run first reads the query's latest result
 * (no execution); only when that result is older than the query's freshness
 * rule, and the day's execution budget allows, does the platform execute it.
 * Results are cached across agents, typed column by column, and capped.
 */
export const DUNE_API = "https://api.dune.com/api/v1";

export type DuneColumnType = "date" | "number" | "name";

export interface DuneQuerySpec {
  readonly title: string;
  /** For the model: what the rows mean. */
  readonly description: string;
  readonly sqlFile: string;
  /** The columns returned, in order, with their types; any other column is dropped. */
  readonly columns: Readonly<Record<string, DuneColumnType>>;
  /** The value of the saved query's `days` parameter when the platform executes it. */
  readonly runDays: number;
  /** Daily series are sliced to the agent's `days`; a ranking is returned whole. */
  readonly series: boolean;
  /** Older than this, the latest result is refreshed (if the budget allows) or flagged STALE. */
  readonly maxAgeHours: number;
  readonly maxRows: number;
}

export const DUNE_QUERIES = {
  monad_dex_volume_daily: {
    title: "Monad DEX volume per day",
    description:
      "Daily DEX volume on Monad in USD, with the number of trades and distinct traders (Dune's dex.trades).",
    sqlFile: "monad_dex_volume_daily.sql",
    columns: { day: "date", volume_usd: "number", trades: "number", traders: "number" },
    runDays: 30,
    series: true,
    maxAgeHours: 24,
    maxRows: 30,
  },
  monad_dex_volume_by_project: {
    title: "Monad DEX volume by project, last 7 days",
    description:
      "The top 15 DEX projects on Monad by USD volume over the last 7 days, with trades and share of the total.",
    sqlFile: "monad_dex_volume_by_project.sql",
    columns: { project: "name", volume_usd: "number", trades: "number", share_pct: "number" },
    runDays: 7,
    series: false,
    maxAgeHours: 24,
    maxRows: 15,
  },
  monad_active_addresses_daily: {
    title: "Monad active addresses per day",
    description:
      "Distinct addresses sending transactions on Monad per day, and the day's transaction count.",
    sqlFile: "monad_active_addresses_daily.sql",
    columns: { day: "date", active_addresses: "number", transactions: "number" },
    runDays: 30,
    series: true,
    maxAgeHours: 24,
    maxRows: 30,
  },
  mon_exchange_netflows_daily: {
    title: "MON net flows to exchanges per day",
    description:
      "Native MON sent to and from addresses Dune labels as centralized exchanges, per day; positive netflow_mon means more MON went to exchanges (often read as selling pressure).",
    sqlFile: "mon_exchange_netflows_daily.sql",
    columns: { day: "date", inflow_mon: "number", outflow_mon: "number", netflow_mon: "number" },
    runDays: 30,
    series: true,
    maxAgeHours: 24,
    maxRows: 30,
  },
} as const satisfies Record<string, DuneQuerySpec>;
export type DuneQueryName = keyof typeof DUNE_QUERIES;
export const DUNE_QUERY_NAMES = Object.keys(DUNE_QUERIES) as DuneQueryName[];
export const DUNE_DAYS = [7, 14, 30] as const;
export type DuneDays = (typeof DUNE_DAYS)[number];

/** A-57: latest-result reads and executions per UTC day across the platform. */
export const DUNE_DAILY_READ_BUDGET = 60;
export const DUNE_DAILY_EXECUTION_BUDGET = 6;
/** A-57: results are cached an hour across agents. */
export const DUNE_TTL_MS = 60 * 60_000;
/** How long one execution is waited for before the latest result is returned as STALE. */
export const DUNE_EXECUTION_WAIT_MS = 90_000;

const IDS_FILE = new URL("../dune/queries.json", import.meta.url);

/** The saved queries' Dune IDs, as `pnpm dune:sync` recorded them; null for one not created yet. */
export function duneQueryIds(): Record<DuneQueryName, number | null> {
  const raw = JSON.parse(readFileSync(IDS_FILE, "utf8")) as { ids?: Record<string, unknown> };
  return Object.fromEntries(
    DUNE_QUERY_NAMES.map((n) => {
      const v = raw.ids?.[n];
      return [n, typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null];
    }),
  ) as Record<DuneQueryName, number | null>;
}

export function duneSql(name: DuneQueryName): string {
  return readFileSync(new URL(`../dune/${DUNE_QUERIES[name].sqlFile}`, import.meta.url), "utf8");
}

export type DuneCell = number | string | null;

export interface DuneResult {
  readonly name: DuneQueryName;
  readonly title: string;
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, DuneCell>>[];
  /** When Dune finished the execution these rows came from. */
  readonly executedAt: string;
  readonly ageHours: number;
  /** True when this request ran the query; false when it read Dune's latest result. */
  readonly executed: boolean;
  readonly warnings: readonly FigureWarning[];
  readonly duneQueryId: number;
}

/** One cell as its declared type; anything else becomes null. */
function cell(type: DuneColumnType, v: unknown): DuneCell {
  if (v === null || v === undefined) return null;
  if (type === "number") {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
    return Number.isFinite(n) ? n : null;
  }
  if (type === "date") {
    const t =
      typeof v === "string" ? Date.parse(v.replace(" UTC", "Z").replace(" ", "T")) : Number.NaN;
    return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
  }
  return cleanText(v, 32);
}

/** Dune's result rows typed by the query's declared columns, capped. */
export function duneRows(spec: DuneQuerySpec, rows: unknown): Readonly<Record<string, DuneCell>>[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .slice(0, spec.maxRows)
    .map((r) =>
      Object.fromEntries(
        Object.entries(spec.columns).map(([col, type]) => [
          col,
          cell(type, (r as Record<string, unknown> | null)?.[col]),
        ]),
      ),
    );
}

interface DuneAnswer {
  readonly state: string;
  readonly endedAt: number | null;
  readonly rows: unknown;
}

const answer = (body: unknown): DuneAnswer => {
  const b = (body ?? {}) as {
    state?: unknown;
    execution_ended_at?: unknown;
    result?: { rows?: unknown };
  };
  const ended =
    typeof b.execution_ended_at === "string" ? Date.parse(b.execution_ended_at) : Number.NaN;
  return {
    state: typeof b.state === "string" ? b.state : "",
    endedAt: Number.isNaN(ended) ? null : ended,
    rows: b.result?.rows,
  };
};

export interface DuneDeps {
  readonly apiKey: string;
  readonly reads: DailyBudget;
  readonly executions: DailyBudget;
  readonly cache: MarketCache;
  readonly now: () => number;
  readonly ids?: Record<DuneQueryName, number | null>;
  readonly fetch?: typeof fetch;
  readonly sleep?: Sleep;
  readonly bucket?: TokenBucket;
  readonly executionWaitMs?: number;
}

export const duneCacheKey = (name: DuneQueryName) => cacheKey("dune", "query", { name });

/**
 * A saved query's rows by name, through the shared cache. Reads Dune's latest
 * result; when that is missing or older than the query's freshness rule, runs
 * the query once within the day's execution budget and waits for it; when it
 * cannot, returns the older result flagged STALE.
 */
export async function duneQuery(name: DuneQueryName, deps: DuneDeps): Promise<Cached<DuneResult>> {
  const spec: DuneQuerySpec = DUNE_QUERIES[name];
  const id = (deps.ids ?? duneQueryIds())[name];
  if (id === null)
    throw new MarketError(
      "UPSTREAM_UNAVAILABLE",
      "dune",
      `The saved query ${name} is not set up on Dune yet.`,
      { retryable: false },
    );
  const headers = { "X-Dune-Api-Key": deps.apiKey };
  const up = {
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.bucket ? { bucket: deps.bucket } : {}),
  };
  const sleep = deps.sleep ?? realSleep;
  const read = async (url: string) => {
    await deps.reads.reserve(1);
    return answer(await getJson({ provider: "dune", url, headers, timeoutMs: 30_000 }, up));
  };

  return deps.cache.get(duneCacheKey(name), DUNE_TTL_MS, async () => {
    const maxAgeMs = spec.maxAgeHours * 3_600_000;
    let latest: DuneAnswer | null = null;
    try {
      latest = await read(`${DUNE_API}/query/${id}/results?limit=${spec.maxRows}`);
    } catch (err) {
      // A query never run has no latest result (404); anything else is an outage.
      if (!(err instanceof MarketError && err.status === 404)) throw err;
    }
    const fresh = (a: DuneAnswer | null) =>
      a !== null &&
      a.state === "QUERY_STATE_COMPLETED" &&
      a.endedAt !== null &&
      deps.now() - a.endedAt <= maxAgeMs;

    let used = latest;
    let executed = false;
    if (!fresh(latest)) {
      try {
        await deps.executions.reserve(1);
        const started = (await getJson(
          {
            provider: "dune",
            url: `${DUNE_API}/query/${id}/execute`,
            headers,
            body: { query_parameters: { days: spec.runDays }, performance: "medium" },
            // Executing twice would charge twice: never retried.
            attempts: 1,
            timeoutMs: 30_000,
          },
          up,
        )) as { execution_id?: unknown };
        const eid = typeof started.execution_id === "string" ? started.execution_id : null;
        if (!eid)
          throw new MarketError("UPSTREAM_UNAVAILABLE", "dune", "Dune did not start the query.", {
            retryable: true,
          });
        const deadline = deps.now() + (deps.executionWaitMs ?? DUNE_EXECUTION_WAIT_MS);
        for (;;) {
          const status = answer(
            await getJson(
              { provider: "dune", url: `${DUNE_API}/execution/${eid}/status`, headers },
              up,
            ),
          );
          if (status.state === "QUERY_STATE_COMPLETED") {
            used = await read(`${DUNE_API}/execution/${eid}/results?limit=${spec.maxRows}`);
            executed = true;
            break;
          }
          if (/FAILED|CANCELLED|EXPIRED/.test(status.state) || deps.now() >= deadline) break;
          await sleep(3_000);
        }
      } catch (err) {
        // Out of budget or the run failed: fall back to the latest result if there is one.
        if (!latest || latest.state !== "QUERY_STATE_COMPLETED") throw err;
      }
    }
    if (!used || used.state !== "QUERY_STATE_COMPLETED" || used.endedAt === null)
      throw new MarketError(
        "UPSTREAM_UNAVAILABLE",
        "dune",
        `Dune has no finished result for ${name} yet; try again later.`,
        { retryable: true },
      );
    const ageHours = Math.max(0, (deps.now() - used.endedAt) / 3_600_000);
    const warnings: FigureWarning[] =
      ageHours * 3_600_000 > maxAgeMs
        ? [
            {
              code: "STALE",
              message: `Dune's latest result is ${Math.round(ageHours)} hours old, past this query's ${spec.maxAgeHours}-hour freshness rule; the platform could not refresh it now.`,
            },
          ]
        : [];
    return {
      name,
      title: spec.title,
      columns: Object.keys(spec.columns),
      rows: duneRows(spec, used.rows),
      executedAt: new Date(used.endedAt).toISOString(),
      ageHours: Math.round(ageHours * 10) / 10,
      executed,
      warnings,
      duneQueryId: id,
    };
  });
}

/** The rows an agent asked for: a daily series cut to its window, a ranking whole. */
export function duneWindow(result: DuneResult, days: DuneDays): DuneResult {
  const spec: DuneQuerySpec = DUNE_QUERIES[result.name];
  if (!spec.series) return result;
  return { ...result, rows: result.rows.slice(0, days) };
}
