import type { StoredReportJson, TerminalEventJson } from "@/api/client";
import { WRAPPED_NATIVE } from "./wrapped-native";

/**
 * UI-FAST: one research run, read from its terminal events (the platform's
 * guarded lines: a line that carried a link, an unchecked number or playbook
 * text arrives withheld and is left out here): how many of each source it
 * used, and its phases in plain words. Nothing is invented or rewritten by a
 * model.
 */

type LaneId = "web" | "onchain" | "market" | "x";

/** Each source tool's lane, by what it reads (packages/domain/src/tools.ts). */
const LANE_OF: Readonly<Record<string, LaneId>> = {
  web_search: "web",
  read_url: "web",
  x_search: "x",
  market_snapshot: "market",
  get_prices: "market",
  get_quote: "market",
  coinmarketcap_prices: "market",
  defillama_yields: "market",
  defillama_tvl: "market",
  dune_query: "market",
  volatility: "market",
  ohlcv: "market",
  unlocks: "market",
  list_tokens: "onchain",
  new_pools: "onchain",
  screen_token: "onchain",
  lookup_token: "onchain",
  find_pools: "onchain",
  get_pool_depth: "onchain",
  read_contract: "onchain",
  get_code: "onchain",
  balance: "onchain",
  get_portfolio: "onchain",
  get_assets: "onchain",
  holders: "onchain",
  hypersync_events: "onchain",
  wallet_portfolio: "onchain",
  wallet_positions: "onchain",
  wallet_pnl: "onchain",
  tradable_now: "onchain",
  get_limits: "onchain",
  simulate_rebalance: "onchain",
};

const toolOf = (text: string) => /^([a-z_]+):/.exec(text)?.[1] ?? null;
const capital = (s: string) => (s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}` : s);

/** "research-medium" as its level: "Medium". */
export function levelOf(alias: string | null | undefined): string {
  const m = /research-(\w+)/.exec(alias ?? "");
  return m?.[1] ? capital(m[1]) : "–";
}

/** UI-FAST: how many of each source the run used, for the bubbles; stages by name. */
export interface SourceCounts {
  readonly webSearches: number;
  readonly pagesRead: number;
  readonly xPosts: number;
  readonly onchainReads: number;
  readonly marketCalls: number;
  /** The stages that finished, in order, by their plain names. */
  readonly stages: readonly string[];
}

const STAGE_NAME: Readonly<Record<string, string>> = {
  SCAN: "Scan",
  DIVE: "Dive",
  CHALLENGE: "Challenge",
  ZOOM_OUT: "Zoom out",
  TEST: "Test",
};

export function sourceCounts(events: readonly TerminalEventJson[]): SourceCounts {
  let webSearches = 0;
  let pagesRead = 0;
  let xPosts = 0;
  let onchainReads = 0;
  let marketCalls = 0;
  const stages: string[] = [];
  for (const e of events) {
    if (e.kind === "tool" && e.tone === "info") {
      const tool = toolOf(e.text);
      const lane = tool ? LANE_OF[tool] : undefined;
      if (tool === "web_search") webSearches += 1;
      else if (tool === "read_url") pagesRead += 1;
      else if (tool === "x_search") xPosts += 1;
      else if (lane === "onchain") onchainReads += 1;
      else if (lane === "market") marketCalls += 1;
    } else if (e.kind === "stage" && /finished\.?$/.test(e.text) && e.stage) {
      stages.push(STAGE_NAME[e.stage] ?? e.stage);
    }
  }
  return { webSearches, pagesRead, xPosts, onchainReads, marketCalls, stages };
}

/** Jargon to plain words: basis points as percent, the band as a range, the stages explained. */
export function plain(text: string): string {
  return text
    .replace(/(\d+(?:\.\d+)?)\s*bps\b/g, (_, n: string) => `${Number(n) / 100}%`)
    .replace(/\btwo-asset band plan\b/gi, "two-token plan")
    .replace(/\bbands?\b/gi, (w) => (w[0] === "B" ? "Range" : "range"))
    .replace(/\bcore-lane\b/gi, "on the core list")
    .replace(/\bDive thesis\b/g, "deep-research case")
    .replace(/\bno Dive\b/g, "no deep research")
    .replace(/\bsurvives Challenge\b/g, "survives the skeptic's review")
    .replace(/\bfallback\b/g, "default");
}

const SYMBOLS = new Set([
  "MON",
  "WMON",
  "USDC",
  "AAVE",
  "ETH",
  "BTC",
  "WETH",
  "WBTC",
  "DEX",
  "TVL",
]);
const themeWords = (code: string) =>
  code
    .split("_")
    .map((w) => (SYMBOLS.has(w) ? w : w.toLowerCase()))
    .join(" ");
/** A clause that reads whole: the part before a colon when the line goes on (and may be cut). */
const clause = (s: string) => {
  const head = s.split(/:\s/)[0] ?? s;
  return head.length < s.length ? `${head.trim().replace(/[.…]$/, "")}.` : firstSentence(s);
};
const firstSentence = (s: string) => (/^(.+?[.!?])(\s|$)/.exec(s)?.[1] ?? s).replace(/…$/, ".");
const rest = (text: string, prefix: string) => text.slice(prefix.length).trim();

export interface PhaseView {
  readonly id: string;
  readonly title: string;
  /** What the phase is, for someone new to it. */
  readonly explainer: string;
  /** One or two plain sentences. */
  readonly summary: readonly string[];
  readonly time: string;
  /** The raw entries, each once, for Details. */
  readonly details: readonly {
    readonly id: string;
    readonly time: string;
    readonly text: string;
    readonly tone: TerminalEventJson["tone"];
  }[];
}

const PHASES: readonly { id: string; title: string; explainer: string }[] = [
  {
    id: "overview",
    title: "Market overview",
    explainer: "A look at the whole market before anything else.",
  },
  { id: "scan", title: "Scan", explainer: "A quick pass over every token the agent could hold." },
  { id: "dive", title: "Dive", explainer: "Deep research into one theme the Scan picked." },
  {
    id: "challenge",
    title: "Challenge",
    explainer: "A skeptic questions what the research found.",
  },
  {
    id: "zoom",
    title: "Zoom out",
    explainer: "The whole-portfolio view, and the plan it leads to.",
  },
  {
    id: "test",
    title: "Test",
    explainer: "The plan checked against every limit, with no model and at no cost.",
  },
  { id: "approval", title: "Approval", explainer: "What you decided about the plan." },
];

/**
 * The run's events grouped into phases, each with one or two plain sentences built from the
 * events' own lines (no model rewrites anything); a line written more than once shows once.
 */
export function phases(
  events: readonly TerminalEventJson[],
  finishedAt: string | null,
): PhaseView[] {
  const end = finishedAt ? Date.parse(finishedAt) : null;
  const by = new Map<string, TerminalEventJson[]>();
  const put = (id: string, e: TerminalEventJson) => by.set(id, [...(by.get(id) ?? []), e]);
  for (const e of events) {
    if (e.kind === "withheld" || e.kind === "tool" || e.kind === "source") continue;
    if (end !== null && Date.parse(e.at) > end + 1000) put("approval", e);
    else if (e.stage === "ZOOM_OUT" && e.text.startsWith("Overview:")) put("overview", e);
    else if (e.stage === "SCAN") put("scan", e);
    else if (e.stage === "DIVE") put("dive", e);
    else if (e.stage === "CHALLENGE") put("challenge", e);
    else if (e.stage === "ZOOM_OUT") put("zoom", e);
    else if (e.stage === "TEST") put("test", e);
  }
  const out: PhaseView[] = [];
  for (const p of PHASES) {
    const list = by.get(p.id) ?? [];
    if (list.length === 0) continue;
    const texts = list.map((e) => e.text);
    const has = (prefix: string) => texts.find((t) => t.startsWith(prefix));
    const summary: string[] = [];
    if (p.id === "overview") {
      const o = has("Overview:");
      if (o) summary.push(plain(`Read the market: ${firstSentence(rest(o, "Overview:"))}`));
    } else if (p.id === "scan") {
      const u = has("Universe:");
      const m = u
        ? /Universe: (\d+) tokens seen, (\d+) buyable for this account \(([^)]*)\)/.exec(u)
        : null;
      const chains = texts.some((t) => t.includes("(Base)")) ? "Monad and Base" : "Monad";
      if (m)
        summary.push(
          `Looked at ${m[1]} tokens across ${chains} and screened them for safety and liquidity; ${m[2]} can be bought by this account (${m[3]}).`,
        );
      const themes = has("Themes:");
      if (themes) {
        const names = rest(themes, "Themes:")
          .replace(/\.$/, "")
          .split(/,\s*/)
          .map((t) => themeWords(t.replace(/\s*\(.*\)$/, "")));
        summary.push(
          `Picked ${names.length} ${names.length === 1 ? "theme" : "themes"} to research: ${names.join(", ")}.`,
        );
      } else if (!m && has("Scan brief:"))
        summary.push("Took a first look at the account and the market.");
    } else if (p.id === "dive") {
      const theses = texts.filter((t) => t.startsWith("Thesis"));
      const evidence = texts.filter((t) => t.startsWith("Evidence:"));
      const dives = texts
        .filter((t) => / started/.test(t) && t.startsWith("Dive on"))
        .map((t) => themeWords(/Dive on (\S+)/.exec(t)?.[1] ?? ""));
      if (dives.length > 0) summary.push(`Researched ${dives.join(" and ")} in depth.`);
      if (evidence[0]) {
        const em = /Evidence: (\d+) for, (\d+) against/.exec(evidence[0]);
        if (em)
          summary.push(
            `Found ${em[1]} points for and ${em[2]} against${theses.length > 0 ? `, and wrote ${theses.length} ${theses.length === 1 ? "case" : "cases"} for a token` : ""}.`,
          );
      }
    } else if (p.id === "challenge") {
      const n = new Set(
        texts.filter((t) => t.startsWith("Objection")).map((t) => t.replace(/\s+/g, " ")),
      ).size;
      summary.push(
        `A skeptic raised ${n} ${n === 1 ? "objection" : "objections"} to the research.`,
      );
    } else if (p.id === "zoom") {
      const decision = has("Decision:");
      const target = texts
        .map((t) => /(?:WMON|WETH) at the (\d+)% target/.exec(t)?.[1])
        .find(Boolean);
      const why = has("Why this much is invested:");
      if (decision?.startsWith("Decision: no change"))
        summary.push(
          `Kept the plan as it is${/limits bind/.test(decision) ? ": its limits allow no change" : ""}.`,
        );
      else if (target)
        summary.push(`Chose ${WRAPPED_NATIVE} at ${target}% of the account, the rest in USDC.`);
      else if (decision) summary.push(plain(decision.replace(/^Decision:\s*/, "Decided to ")));
      if (why) summary.push(plain(`Why: ${clause(rest(why, "Why this much is invested:"))}`));
    } else if (p.id === "test") {
      const check = has("Test checks:");
      summary.push(
        check
          ? `Checked the plan against every limit: ${rest(check, "Test checks:").replace(/^the plan /, "it ")}`
          : "Checked the plan against every limit.",
      );
    } else if (p.id === "approval") {
      const approved = texts.find((t) => /plan was approved/i.test(t));
      const declined = texts.find((t) => /declined|rejected/i.test(t));
      const at = (approved ? list.find((e) => e.text === approved) : list[0])?.at ?? "";
      summary.push(
        approved
          ? `You approved the plan on ${at.slice(0, 10)} at ${at.slice(11, 16)} UTC; it was checked against every limit again first.`
          : declined
            ? "You declined the plan."
            : "Waiting for your decision on the plan.",
      );
    }
    const seen = new Set<string>();
    const details = list
      .filter((e) => {
        const key = e.text.replace(/\s+/g, " ").trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((e) => ({ id: `d-${e.seq}`, time: e.at.slice(11, 19), text: e.text, tone: e.tone }));
    out.push({
      id: p.id,
      title: p.title,
      explainer: p.explainer,
      summary: summary.length > 0 ? summary : ["Nothing more was recorded in this phase."],
      time: list[0]?.at.slice(11, 16) ?? "",
      details,
    });
  }
  return out;
}

/** One line of the branch chart: a stage that ran or a source the run used, with each call on it. */
export interface BranchView {
  readonly id: string;
  readonly label: string;
  readonly kind: "stage" | "source";
  /** Each call or read on this line, in time order; the label is what it read. */
  readonly calls: readonly { readonly id: string; readonly label: string }[];
}

const STAGE_ORDER = ["SCAN", "DIVE", "CHALLENGE", "TEST", "ZOOM_OUT"] as const;
const SOURCE_LINES: readonly { lane: LaneId; label: string }[] = [
  { lane: "web", label: "Web" },
  { lane: "x", label: "X" },
  { lane: "onchain", label: "Onchain" },
  { lane: "market", label: "Market data" },
];

/**
 * 2026-10-13: the branch chart's lines from the run's events: one per stage that ran (Scan,
 * Dive, Challenge, Test, Zoom out) and one per source used (web, X, onchain, market data),
 * each with every call on it in time order, labeled with what it read. A call shows on its
 * stage's line and on its source's line.
 */
export function branches(events: readonly TerminalEventJson[]): BranchView[] {
  const ran = new Set<string>();
  const byStage = new Map<string, { id: string; label: string }[]>();
  const byLane = new Map<LaneId, { id: string; label: string }[]>();
  for (const e of events) {
    if (e.kind === "stage" && e.stage) ran.add(e.stage);
    if (e.kind !== "tool" || e.tone !== "info") continue;
    const tool = toolOf(e.text);
    const call = { id: `c-${e.seq}`, label: plain(capital(rest(e.text, `${tool ?? ""}:`))) };
    if (e.stage) {
      ran.add(e.stage);
      byStage.set(e.stage, [...(byStage.get(e.stage) ?? []), call]);
    }
    const lane = tool ? LANE_OF[tool] : undefined;
    if (lane) byLane.set(lane, [...(byLane.get(lane) ?? []), call]);
  }
  const out: BranchView[] = [];
  for (const s of STAGE_ORDER)
    if (ran.has(s))
      out.push({
        id: `stage-${s}`,
        label: STAGE_NAME[s] ?? s,
        kind: "stage",
        calls: byStage.get(s) ?? [],
      });
  for (const l of SOURCE_LINES) {
    const calls = byLane.get(l.lane);
    if (calls && calls.length > 0)
      out.push({ id: `source-${l.lane}`, label: l.label, kind: "source", calls });
  }
  return out;
}

const NO_FACTS = "No facts were recorded for this phase.";

/** A whole number of US dollars in short words: 1,031,240,420 as "$1.0B". */
function usdShort(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
const num = (s: string | undefined) => {
  const m = /-?[\d,]+(?:\.\d+)?/.exec(s ?? "");
  return m ? Number(m[0].replaceAll(",", "")) : null;
};
const listWords = (xs: readonly string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
const round1 = (n: number) => Number(n.toFixed(1)).toString();

/**
 * 2026-10-13: each phase of a run as a plain description built from the report's structured
 * facts (the market snapshot's figures, the token universe, the researched tokens' evidence,
 * the skeptic's objections, the stages' outcomes and the chosen positions), never from the
 * model's prose or reworded notes. A phase with no facts says so in one line. No model call.
 */
export function factSummaries(
  body: StoredReportJson | null,
): Readonly<Record<string, readonly string[]>> {
  if (!body) return {};
  const r = body.report;
  const snap = (label: RegExp) => r.market.snapshot.find((x) => label.test(x.label))?.value;
  const out: Record<string, string[]> = {};

  // The market, from the snapshot's figures.
  const market: string[] = [];
  const tvl = num(snap(/TVL/i));
  if (tvl !== null) market.push(`Monad's total value locked is about ${usdShort(tvl)}`);
  const change = num(snap(/MON 24h change/i));
  if (change !== null)
    market.push(
      Math.abs(change) < 0.05
        ? "MON was flat today"
        : `MON ${change < 0 ? "fell" : "rose"} ${round1(Math.abs(change))}% today`,
    );
  const dexRaw = snap(/DEX volume/i);
  const dex = num(dexRaw);
  const dexChange = /\(([+-]?[\d.]+)%\)/.exec(dexRaw ?? "")?.[1];
  if (dex !== null)
    market.push(
      `DEX trading was ${usdShort(dex)} over the last day${dexChange ? `, ${Number(dexChange) < 0 ? "down" : "up"} ${round1(Math.abs(Number(dexChange)))}%` : ""}`,
    );
  const vol = num(snap(/volatility/i));
  if (vol !== null) market.push(`MON's price swings about ${Math.round(vol)}% a year`);
  if (market.length > 0) out.overview = [`Read the market: ${listWords(market)}.`];

  // The Scan, from the universe of tokens.
  const u = body.universe;
  if (u.length > 0) {
    const base = u.some((t) => /on Base/.test(t.whyNot ?? ""));
    const buyable = u.filter((t) => t.buyable);
    const scan = [
      `Screened ${u.length} tokens across ${base ? "Monad and Base" : "Monad"}; ${buyable.length} can be bought by this account${buyable.length > 0 && buyable.length <= 5 ? ` (${buyable.map((t) => t.symbol).join(", ")})` : ""}.`,
    ];
    const themes = [...new Set(u.map((t) => t.themeCode).filter((c): c is string => !!c))];
    if (themes.length > 0)
      scan.push(
        `Picked ${themes.length} ${themes.length === 1 ? "theme" : "themes"} to research: ${listWords(themes.map(themeWords))}.`,
      );
    out.scan = scan;
  }

  // The Dive, from each researched token's evidence.
  const dove = body.stages.filter((s) => s.stage === "DIVE" && s.status === "completed").length;
  if (r.tokens.length > 0)
    out.dive = r.tokens.map(
      (t) =>
        `Researched ${t.symbol} in depth: ${t.evidenceFor.length} ${t.evidenceFor.length === 1 ? "point" : "points"} for, ${t.evidenceAgainst.length} against, with ${t.confidence} confidence.`,
    );
  else if (dove > 0)
    out.dive = [
      `Ran ${dove} deep ${dove === 1 ? "dive" : "dives"}; none found a token worth a case.`,
    ];

  // The Challenge, from the skeptic's objections.
  if (r.skeptic.length > 0) {
    const on = [...new Set(r.skeptic.map((s) => themeWords(s.theme)).filter(Boolean))];
    out.challenge = [
      `A skeptic raised ${r.skeptic.length} ${r.skeptic.length === 1 ? "objection" : "objections"}${on.length > 0 ? ` about ${listWords(on)}` : ""}, each answered in the report.`,
    ];
  }

  // The Test, from its stage's outcome.
  const test = body.stages.find((s) => s.stage === "TEST");
  if (test)
    out.test = [
      r.portfolio.stance === "no_change"
        ? "There was no new plan to check."
        : test.status === "completed"
          ? "Checked the plan against every limit; it passed."
          : `The plan did not pass the limit check${test.stopReason ? ` (${plain(test.stopReason)})` : ""}.`,
    ];

  // The Zoom out, from the chosen positions and the facts above.
  const positions = r.portfolio.positions;
  if (r.portfolio.stance === "no_change") out.zoom = ["Kept the plan as it is."];
  else if (positions.length > 0) {
    const cash = positions.find((p) => p.symbol === "USDC");
    const held = positions.filter((p) => p.symbol !== "USDC");
    const chose = held.map((p) => `${p.symbol} for ${p.weight}`);
    const why: string[] = [];
    if (vol !== null && vol >= 50 && held.some((p) => /MON/.test(p.symbol)))
      why.push("MON is volatile");
    const buyableHeld = u.filter((t) => t.buyable && t.symbol !== "USDC");
    const unproposed = buyableHeld.filter((t) => !t.proposed);
    if (u.length > 0 && unproposed.length === 0) why.push("no other token can be bought here yet");
    else if (unproposed.length > 0)
      why.push(
        `no other token had a strong enough case (${unproposed.map((t) => t.symbol).join(", ")} ${unproposed.length === 1 ? "was" : "were"} left out)`,
      );
    out.zoom = [
      `Chose ${listWords(chose)} of the account${cash ? ` and kept ${cash.weight} in USDC` : ""}${why.length > 0 ? `, because ${listWords(why)}` : ""}.`,
    ];
  }
  return out;
}

/**
 * The run's phases with each summary from the report's facts; while a run has no report
 * yet, or a phase has no facts, one plain line says so. The phases and their details are
 * the terminal's own, and a phase the facts cover shows even when the terminal has none.
 */
export function factPhases(
  events: readonly TerminalEventJson[],
  finishedAt: string | null,
  body: StoredReportJson | null,
): PhaseView[] {
  const facts = factSummaries(body);
  const fromEvents = new Map(phases(events, finishedAt).map((p) => [p.id, p]));
  // 2026-10-13: each phase also explains itself live, from its calls as they land.
  const calls = runCalls(events);
  const live = (id: string) =>
    liveSummary(calls.filter((c) => PHASE_OF_STAGE[c.stage ?? ""] === id)).slice(-4);
  const out: PhaseView[] = [];
  for (const p of PHASES) {
    const seen = fromEvents.get(p.id);
    const f = facts[p.id];
    const now = live(p.id);
    if (!seen && !f && now.length === 0) continue;
    out.push({
      id: p.id,
      title: p.id === "overview" ? "Market" : p.title,
      explainer: p.explainer,
      summary:
        p.id === "approval"
          ? (seen?.summary ?? [NO_FACTS])
          : f && f.length > 0
            ? f
            : now.length > 0
              ? now
              : [body ? NO_FACTS : "Nothing recorded in this phase yet."],
      time: seen?.time ?? "",
      details: seen?.details ?? [],
    });
  }
  return out;
}

/** One call of a run (2026-10-13): its request line paired with its result line. */
export interface RunCall {
  readonly id: string;
  readonly at: string;
  readonly stage: string | null;
  /** The Dive's token symbol, when the stage is a Dive on one. */
  readonly token: string | null;
  readonly tool: string;
  readonly lane: LaneId | null;
  /** What it asked for: the query, or the request line in plain words. */
  readonly request: string;
  /** What came back, as the platform recorded it; null while it runs. */
  readonly result: string | null;
  readonly failed: boolean;
  readonly chargeUsdc: number;
  /** The sites a search's results came from. */
  readonly sites: readonly string[];
  readonly count: number | null;
}

const quoted = (s: string) => /"([^"]+)"/.exec(s)?.[1] ?? null;

/** Every data call of the run, request paired with result, in time order (platform calls left out). */
export function runCalls(events: readonly TerminalEventJson[]): RunCall[] {
  const out: RunCall[] = [];
  const open = new Map<string, number>();
  let dive: string | null = null;
  for (const e of events) {
    if (e.kind === "stage" && e.stage === "DIVE") {
      const t = /Dive on TOKEN_([A-Z0-9]+)/.exec(e.text)?.[1];
      if (t) dive = t;
    }
    if (e.kind !== "tool") continue;
    const tool = toolOf(e.text);
    if (!tool || !LANE_OF[tool]) continue;
    const body = rest(e.text, `${tool}:`);
    const key = `${e.stage ?? ""}:${tool}`;
    if (e.tone === "info") {
      out.push({
        id: `c-${e.seq}`,
        at: e.at,
        stage: e.stage,
        token: e.stage === "DIVE" ? dive : null,
        tool,
        lane: LANE_OF[tool] ?? null,
        request: body,
        result: null,
        failed: false,
        chargeUsdc: 0,
        sites: [],
        count: null,
      });
      open.set(key, out.length - 1);
      continue;
    }
    // A result line: the latest open call of the same tool in the stage, or one of its own.
    const i = open.get(key);
    const charge = Number(/charged ([\d.]+) USDC/.exec(body)?.[1] ?? 0);
    const sites =
      /results? from ([^;]+)/
        .exec(body)?.[1]
        ?.split(/,\s*/)
        .map((x) => x.trim()) ?? [];
    const count = Number(/^(\d+) results?/.exec(body)?.[1] ?? Number.NaN);
    const patch = {
      result: body,
      failed: e.tone === "bad" || e.tone === "warn",
      chargeUsdc: charge,
      sites,
      count: Number.isNaN(count) ? null : count,
    };
    if (i !== undefined && out[i] && out[i].result === null) {
      out[i] = { ...out[i], ...patch };
      open.delete(key);
    } else
      out.push({
        id: `c-${e.seq}`,
        at: e.at,
        stage: e.stage,
        token: e.stage === "DIVE" ? dive : null,
        tool,
        lane: LANE_OF[tool] ?? null,
        request: "",
        ...patch,
      });
  }
  return out;
}

const STAGE_WHY: Readonly<Record<string, string>> = {
  SCAN: "for the market read and to choose the tokens to research",
  DIVE: "to research the token in depth",
  CHALLENGE: "to test the research",
  ZOOM_OUT: "for the whole-portfolio view",
};

/** A call in two or three plain sentences: what it looked up and why, and what came back. */
export function describeCall(c: RunCall): { what: string; got: string | null } {
  const why = c.token ? `to research ${c.token}` : (STAGE_WHY[c.stage ?? ""] ?? "for the research");
  const q = quoted(c.request);
  const what =
    c.tool === "web_search"
      ? `Searched the web for "${q ?? c.request}" ${why}.`
      : c.tool === "x_search"
        ? `Searched X for "${q ?? c.request}" for what people are saying now, ${why}.`
        : c.tool === "read_url"
          ? `Read a page ${why}.`
          : c.tool === "market_snapshot"
            ? "Read the overall market: MON's price and 24-hour move, Monad's total value locked, DEX volume and the biggest protocols."
            : c.tool === "list_tokens"
              ? "Listed the tokens the platform tracks, with their CoinMarketCap rank, liquidity and volume, to sort them into degen, growth and conservative."
              : c.tool === "new_pools"
                ? "Read the pools created in the last three days, to spot new tokens."
                : c.tool === "screen_token"
                  ? `Ran the safety screen${c.token ? ` on ${c.token}` : ""}: a simulated buy and sell, the owner's powers and the pool.`
                  : c.tool === "lookup_token"
                    ? `Looked up ${c.token ?? "the token"}: what it is, its pools and liquidity.`
                    : c.tool === "find_pools"
                      ? `Found ${c.token ?? "the token"}'s pools and their liquidity.`
                      : c.tool === "get_portfolio"
                        ? "Read the account's holdings."
                        : `${capital(c.tool.replaceAll("_", " "))} ${why}.`;
  if (c.result === null) return { what, got: null };
  if (c.failed) return { what, got: `It did not answer: ${plain(c.result)}` };
  const got =
    c.sites.length > 0
      ? `${c.count ?? c.sites.length} results came back, from ${c.sites.join(", ")}.`
      : c.tool === "x_search" && c.count !== null
        ? `${c.count} posts came back.`
        : c.count !== null
          ? `${c.count} came back.`
          : /verdict (\w+)/.test(c.result)
            ? `The screen ${/verdict (\w+)/.exec(c.result)?.[1]}.`
            : "It answered.";
  return { what, got };
}

/** A phase's live description: the plain sentence of each of its calls, in order, each once. */
export function liveSummary(calls: readonly RunCall[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of calls) {
    const s = describeCall(c).what;
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

const PHASE_OF_STAGE: Readonly<Record<string, string>> = {
  SCAN: "scan",
  DIVE: "dive",
  CHALLENGE: "challenge",
  ZOOM_OUT: "zoom",
  TEST: "test",
};

/** The research record over the chart: steps, sources read, tokens examined, cost and time. */
export function runRecord(
  events: readonly TerminalEventJson[],
  o: {
    readonly chargedUsdcE6: string | null;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    readonly now: string;
  },
) {
  const calls = runCalls(events);
  const sources = calls
    .filter((c) => c.lane === "web" || c.lane === "x")
    .reduce((n, c) => n + (c.count ?? c.sites.length), 0);
  const tokens = new Set(
    events
      .filter((e) => e.kind === "stage" && e.stage === "DIVE")
      .map((e) => /Dive on TOKEN_([A-Z0-9]+)/.exec(e.text)?.[1])
      .filter(Boolean),
  );
  const end = o.finishedAt ? Date.parse(o.finishedAt) : Date.parse(o.now);
  const ms = o.startedAt ? Math.max(0, end - Date.parse(o.startedAt)) : null;
  return {
    steps: calls.length,
    sourcesRead: sources,
    tokensExamined: tokens.size,
    costUsdc: o.chargedUsdcE6 === null ? null : Number(o.chargedUsdcE6) / 1e6,
    elapsed:
      ms === null ? null : `${Math.floor(ms / 60_000)} min ${Math.floor((ms % 60_000) / 1000)} s`,
  };
}

/** What a live run is doing now (2026-10-13): its stage and its latest call, in a few words. */
export function currentStep(events: readonly TerminalEventJson[]): string | null {
  const calls = runCalls(events);
  const last = calls.at(-1);
  const stage = [...events].reverse().find((e) => e.kind === "stage" && e.stage)?.stage ?? null;
  if (!stage) return null;
  const name = STAGE_NAME[stage] ?? stage;
  if (!last || last.stage !== stage) return `${name}: starting`;
  const what = describeCall(last).what.replace(/\.$/, "");
  return `${name}: ${what.charAt(0).toLowerCase()}${what.slice(1)}`;
}

export { PHASE_OF_STAGE };
