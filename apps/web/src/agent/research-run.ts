import type { TerminalEventJson } from "@/api/client";

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

const SYMBOLS = new Set(["MON", "WMON", "USDC", "AAVE", "ETH", "BTC"]);
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
      const target = texts.map((t) => /WMON at the (\d+)% target/.exec(t)?.[1]).find(Boolean);
      const why = has("Why this much is invested:");
      if (decision?.startsWith("Decision: no change"))
        summary.push(
          `Kept the plan as it is${/limits bind/.test(decision) ? ": its limits allow no change" : ""}.`,
        );
      else if (target) summary.push(`Chose WMON at ${target}% of the account, the rest in USDC.`);
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
