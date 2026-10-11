import type { Cycle, StageRun } from "./cycle/store.ts";
import { CANARY_PREFIX, SKILL_RUN_WORDS } from "./cycle/validator.ts";
import { MAX_ENTRY_CHARS, formatUsdc, numbersIn } from "./narrator.ts";

/**
 * The agent terminal (P3-U10): a cycle's records turned into plain one-line
 * events the owner may read, live while the cycle runs and as history after.
 * Pure: the records come in, the events go out in time order with stable
 * sequence numbers, so a client that reconnects asks for what came after the
 * last one it saw.
 *
 * What never reaches the owner, by construction: skill and playbook text
 * (every line is checked against the mounted skills' eight-word runs and the
 * cycle's canary, and withheld on a match), system prompts and raw model
 * reasoning (never read: the builder sees stage runs, tool calls, briefs and
 * records only), and web or X content (a page's text and a post's text are
 * never in these records; sources show as titles, domains and tool names).
 * Every number in a line comes from the record the line was built from, as
 * the narrator's validator checks, or the line is withheld.
 */
export type TerminalEventKind =
  | "cycle"
  | "stage"
  | "tool"
  | "source"
  | "brief"
  | "thesis"
  | "objection"
  | "check"
  | "plan"
  | "decision"
  | "cost"
  | "sentinel"
  | "universe"
  | "withheld";

export interface TerminalEvent {
  readonly seq: number;
  readonly at: string;
  readonly kind: TerminalEventKind;
  readonly stage: string | null;
  readonly text: string;
  readonly tone: "info" | "ok" | "warn" | "bad";
}

export interface TerminalCall {
  readonly callId: string;
  readonly stageRunId: string | null;
  readonly server: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly status: "running" | "succeeded" | "failed" | "refused";
  readonly errorCode: string | null;
  readonly chargeUsdcE6: string;
  readonly cacheHit: boolean;
  readonly summary: Record<string, unknown> | null;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
}

export interface TerminalBrief {
  readonly stageRunId: string;
  readonly kind: string;
  readonly status: "accepted" | "refused";
  readonly body: Record<string, unknown>;
  readonly reasons: readonly string[];
  readonly createdAt: Date;
}

export interface TerminalRecord {
  readonly stageRunId: string | null;
  readonly outcome: string;
  readonly decision: Record<string, unknown> | null;
  readonly createdAt: Date;
}

export interface TerminalProposal {
  readonly status: string;
  readonly evaluation: {
    readonly checkedAt: string;
    readonly passed: boolean;
    readonly findings: readonly { readonly code: string; readonly message: string }[];
  } | null;
  readonly createdAt: Date;
}

/** P4-U2: one action of the Risk Sentinel, as stored. */
export interface TerminalSentinelAction {
  readonly code: string;
  readonly action: string;
  readonly state: string | null;
  readonly reason: string;
  readonly txHash: string | null;
  readonly status: "done" | "failed" | "skipped";
  readonly createdAt: Date;
}

/** F-U12: one token of the cycle's universe, as stored. */
export interface TerminalUniverseRow {
  readonly symbol: string;
  readonly priceClass: string;
  readonly lane: string | null;
  readonly buyable: boolean;
  readonly whyNot: string | null;
  readonly themeCode: string | null;
  readonly themeReason: string | null;
  readonly researched: boolean;
  readonly proposed: boolean;
  readonly droppedReason: string | null;
}

export interface TerminalInput {
  readonly cycle: Cycle;
  readonly stages: readonly StageRun[];
  readonly calls: readonly TerminalCall[];
  readonly briefs: readonly TerminalBrief[];
  readonly records: readonly TerminalRecord[];
  readonly proposals: readonly TerminalProposal[];
  /** P4-U2: the sentinel's actions in the cycle's window, if any. */
  readonly sentinel?: readonly TerminalSentinelAction[];
  /** F-U12: the universe the cycle considered, if recorded. */
  readonly universe?: readonly TerminalUniverseRow[];
  /** Today's research budget and what the day's other cycles used before this one; both optional. */
  readonly budget?: { readonly dailyUsdcE6: bigint; readonly usedBeforeUsdcE6: bigint } | null;
  /** Eight-word runs of the mounted skills' text; a line containing one is withheld. */
  readonly skillRuns: ReadonlySet<string>;
}

const CYCLE_NAMES: Readonly<Record<string, string>> = {
  ROUTINE: "Routine research",
  TRIGGERED: "Triggered research",
  ACTIVATION: "Activation research",
  REVIEW: "Review",
};
const STAGE_NAMES: Readonly<Record<string, string>> = {
  SCAN: "Scan",
  DIVE: "Dive",
  CHALLENGE: "Challenge",
  TEST: "Test",
  ZOOM_OUT: "Zoom out",
};
const BRIEF_NAMES: Readonly<Record<string, string>> = {
  SCAN: "Scan brief",
  THEME: "Dive brief",
  CHALLENGE: "Challenge brief",
  OVERVIEW: "Overview",
  RATIONALE: "Rationale",
};

/** Plain words for each tool's call, from its input's known fields only. */
const TOOL_LINES: Readonly<Record<string, (input: Record<string, unknown>) => string>> = {
  web_search: (i) => `searching the web for ${quoted(i.query)}`,
  read_url: (i) => `reading a page on ${hostOf(i.url)}`,
  x_search: (i) => `searching X for ${quoted(i.topic ?? i.query)}`,
  market_snapshot: () => "reading the market snapshot",
  get_prices: () => "reading prices",
  volatility: () => "reading volatility",
  defillama_tvl: () => "reading TVL",
  defillama_yields: () => "reading yields",
  coinmarketcap_prices: () => "reading market prices",
  dune_query: (i) => `running the ${plain(i.query ?? i.name) ?? "Dune"} query`,
  lookup_token: (i) => `looking up ${tokenOf(i)}`,
  screen_token: (i) => `screening ${tokenOf(i)}`,
  list_tokens: () => "listing the registry's tokens",
  find_pools: (i) => `finding pools for ${tokenOf(i)}`,
  new_pools: () => "reading new pools",
  tradable_now: () => "reading what is tradable now",
  get_portfolio: () => "reading the account",
  get_goals_and_limits: () => "reading the goal and limits",
  get_limits: () => "reading the limits",
  get_quote: () => "reading a quote",
  get_pool_depth: () => "reading a pool's depth",
  get_research_context: () => "reading the research context",
  write_thesis: () => "writing private notes",
  write_research_brief: (i) => `writing the ${BRIEF_NAMES[String(i.kind)] ?? "brief"}`,
  complete_stage: () => "ending the stage",
  propose_swap: () => "proposing a swap",
};

const SHORT = 120;

function plain(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  if (t.length === 0) return null;
  return t.length > SHORT ? `${t.slice(0, SHORT - 1).trimEnd()}…` : t;
}

const quoted = (v: unknown) => {
  const t = plain(v);
  return t ? `"${t}"` : "a query";
};

export function hostOf(v: unknown): string {
  if (typeof v !== "string") return "a page";
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    return u.hostname.replace(/^www\./, "") || "a page";
  } catch {
    return "a page";
  }
}

function tokenOf(i: Record<string, unknown>): string {
  const s = plain(i.symbol);
  if (s) return s;
  const a =
    typeof i.address === "string" ? i.address : typeof i.token === "string" ? i.token : null;
  return a && /^0x[0-9a-fA-F]{40}$/.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : "a token";
}

/** A source as the owner may see it: a URL's domain, a tool's name, or nothing recognisable. */
export function sourceLabel(s: string): string {
  if (/^https?:\/\//i.test(s)) return hostOf(s);
  if (/^[a-z][a-z0-9_]{1,40}$/.test(s)) return s;
  return "a source";
}

const words = (text: string) => text.toLowerCase().match(/[a-z0-9']+/g) ?? [];

/** Whether the text carries any eight-word run of the skills' text, or the canary. */
export function carriesSkillText(text: string, runs: ReadonlySet<string>): boolean {
  if (text.includes(CANARY_PREFIX)) return true;
  if (runs.size === 0) return false;
  const w = words(text);
  for (let i = 0; i + SKILL_RUN_WORDS <= w.length; i += 1)
    if (runs.has(w.slice(i, i + SKILL_RUN_WORDS).join(" "))) return true;
  return false;
}

/** Cuts a line to the entry length at a word boundary. */
function fit(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= MAX_ENTRY_CHARS) return t;
  const cut = t.slice(0, MAX_ENTRY_CHARS - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > MAX_ENTRY_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

interface Draft {
  readonly at: Date;
  /** Ties at the same time keep this order. */
  readonly order: number;
  readonly kind: TerminalEventKind;
  readonly stage: string | null;
  readonly text: string;
  readonly tone: TerminalEvent["tone"];
  /** The record the line was built from: every number in the line must be in it. */
  readonly facts: unknown;
}

const usdc = (e6: bigint | string) => formatUsdc(typeof e6 === "bigint" ? e6 : BigInt(e6));

/** The guarded line: skill text withheld, links withheld, numbers checked against the facts. */
export function guard(d: Draft, runs: ReadonlySet<string>): Pick<Draft, "kind" | "text" | "tone"> {
  const text = fit(d.text);
  if (carriesSkillText(text, runs))
    return {
      kind: "withheld",
      text: "[a line was withheld: it carried playbook text]",
      tone: "warn",
    };
  if (/https?:|www\./i.test(text))
    return { kind: "withheld", text: "[a line was withheld: it carried a link]", tone: "warn" };
  const allowed = new Set(numbersIn(JSON.stringify(d.facts)));
  const invented = numbersIn(text).filter((n) => !allowed.has(n));
  if (invented.length > 0)
    return {
      kind: "withheld",
      text: "[a line was withheld: its numbers were not in the record]",
      tone: "warn",
    };
  return { kind: d.kind, text, tone: d.tone };
}

/** Every event of the cycle, in time order, numbered from 1. */
export function terminalEvents(i: TerminalInput): TerminalEvent[] {
  const drafts: Draft[] = [];
  const push = (d: Draft) => drafts.push(d);
  const c = i.cycle;
  const stageOf = new Map(i.stages.map((s) => [s.stageRunId, s]));
  const nameOf = (s: StageRun | undefined) =>
    s
      ? `${STAGE_NAMES[s.stage] ?? s.stage}${s.themeCode ? ` on ${s.themeCode}` : ""}`
      : "the cycle";
  const stageName = (id: string | null) => (id ? (stageOf.get(id)?.stage ?? null) : null);

  const startedAt = c.startedAt ?? c.createdAt;
  push({
    at: startedAt,
    order: 0,
    kind: "cycle",
    stage: null,
    text: `${CYCLE_NAMES[c.kind] ?? c.kind} started, reasoning on ${c.reasoningAlias}.`,
    tone: "info",
    facts: { kind: c.kind, alias: c.reasoningAlias },
  });

  for (const s of i.stages) {
    const name = nameOf(s);
    const ceiling = usdc(s.ceilingUsdcE6);
    const cost = usdc(s.chargedUsdcE6);
    if (s.startedAt)
      push({
        at: s.startedAt,
        order: 1,
        kind: "stage",
        stage: s.stage,
        text:
          s.modelAlias === null
            ? `${name} started: deterministic, no model, free.`
            : `${name} started on ${s.modelAlias}; it may cost up to ${ceiling} USDC.`,
        tone: "info",
        facts: { name, model: s.modelAlias, ceiling },
      });
    if (s.finishedAt) {
      const how =
        s.status === "completed"
          ? "finished"
          : s.status === "skipped"
            ? `did not run (${(s.stopReason ?? "").toLowerCase()})`
            : `ended ${s.status} (${(s.stopReason ?? "").toLowerCase()})`;
      const outcome = s.outcome as { error?: unknown } | null;
      push({
        at: s.finishedAt,
        order: 9,
        kind: "stage",
        stage: s.stage,
        text:
          s.stage === "TEST" && outcome && typeof outcome.error === "string"
            ? `${name} failed: the plan's limits could not be worked out.`
            : `${name} ${how}.`,
        tone: s.status === "completed" ? "ok" : s.status === "skipped" ? "info" : "bad",
        facts: { name, status: s.status },
      });
      if (s.modelAlias !== null && s.status !== "skipped")
        push({
          at: s.finishedAt,
          order: 10,
          kind: "cost",
          stage: s.stage,
          text: `${name} cost ${cost} of at most ${ceiling} USDC, over ${s.modelCalls} model calls.`,
          tone: "info",
          facts: { cost, ceiling, modelCalls: s.modelCalls },
        });
    }
  }

  for (const call of i.calls) {
    const stage = stageName(call.stageRunId);
    const line = TOOL_LINES[call.tool]?.(call.input) ?? "called";
    push({
      at: call.startedAt,
      order: 3,
      kind: "tool",
      stage,
      text: `${call.tool}: ${line}`,
      tone: "info",
      facts: { tool: call.tool, input: call.input },
    });
    if (call.finishedAt && call.status !== "running") {
      const charged = BigInt(call.chargeUsdcE6 || "0");
      const cost = charged > 0n ? `; charged ${usdc(charged)} USDC` : "";
      const cached = call.cacheHit ? " (cached)" : "";
      const sum = call.summary ?? {};
      const hosts = Array.isArray(sum.hosts)
        ? sum.hosts.filter((h) => typeof h === "string").map((h) => hostOf(h))
        : [];
      const parts: string[] = [];
      if (typeof sum.results === "number") parts.push(`${sum.results} results`);
      if (typeof sum.chars === "number") parts.push(`${sum.chars} characters read`);
      if (hosts.length > 0) parts.push(`from ${hosts.join(", ")}`);
      if (typeof sum.verdict === "string") parts.push(`verdict ${sum.verdict}`);
      const result =
        call.status === "succeeded"
          ? `${call.tool}: ${parts.length > 0 ? parts.join(" ") : "answered"}${cached}${cost}.`
          : `${call.tool}: ${call.status}${call.errorCode ? ` (${call.errorCode.toLowerCase()})` : ""}.`;
      push({
        at: call.finishedAt,
        order: 4,
        kind: "tool",
        stage,
        text: result,
        tone: call.status === "succeeded" ? "ok" : call.status === "refused" ? "warn" : "bad",
        facts: { tool: call.tool, summary: sum, cost: usdc(charged), hosts },
      });
    }
  }

  for (const b of i.briefs) {
    const stage = stageName(b.stageRunId);
    const name = BRIEF_NAMES[b.kind] ?? `${b.kind} brief`;
    const at = b.createdAt;
    if (b.status === "refused") {
      push({
        at,
        order: 5,
        kind: "brief",
        stage,
        text: `${name} refused: ${b.reasons.join("; ") || "it did not pass the checks"}. The agent writes it again.`,
        tone: "warn",
        facts: { reasons: b.reasons },
      });
      continue;
    }
    const body = b.body;
    const claims = (v: unknown) =>
      Array.isArray(v) ? (v as { text?: unknown; class?: unknown; sources?: unknown }[]) : [];
    const sourcesOf = (list: { class?: unknown; sources?: unknown }[]) => {
      const by = new Map<string, Set<string>>();
      for (const cl of list) {
        const cls = typeof cl.class === "string" ? cl.class : "source";
        const set = by.get(cls) ?? new Set<string>();
        for (const s of Array.isArray(cl.sources) ? cl.sources : [])
          if (typeof s === "string") set.add(sourceLabel(s));
        by.set(cls, set);
      }
      return [...by.entries()]
        .filter(([, set]) => set.size > 0)
        .map(([cls, set]) => `${cls}: ${[...set].join(", ")}`);
    };
    const sourceLine = (list: { class?: unknown; sources?: unknown }[], order: number) => {
      const groups = sourcesOf(list);
      if (groups.length > 0)
        push({
          at,
          order,
          kind: "source",
          stage,
          text: `Sources, ${groups.join("; ")}.`,
          tone: "info",
          facts: { groups },
        });
    };
    switch (b.kind) {
      case "SCAN": {
        const themes = Array.isArray(body.themes)
          ? (body.themes as { code?: unknown; materiality?: unknown }[])
          : [];
        push({
          at,
          order: 5,
          kind: "brief",
          stage,
          text: `${name}: ${plain(body.summary) ?? "written"}${body.quiet === true ? " (a quiet market)" : ""}`,
          tone: "ok",
          facts: body,
        });
        if (themes.length > 0)
          push({
            at,
            order: 6,
            kind: "brief",
            stage,
            text: `Themes: ${themes.map((t) => `${String(t.code)} (${String(t.materiality)})`).join(", ")}.`,
            tone: "info",
            facts: { themes },
          });
        sourceLine([...claims(body.changes), ...(themes as { sources?: unknown }[])], 7);
        break;
      }
      case "THEME": {
        const thesis = body.thesis as {
          statement?: unknown;
          confidence?: unknown;
          killCriterion?: unknown;
        } | null;
        push({
          at,
          order: 5,
          kind: "brief",
          stage,
          text: `${name} on ${String(body.themeCode)}: ${plain(body.question) ?? "written"}`,
          tone: "ok",
          facts: body,
        });
        push({
          at,
          order: 6,
          kind: "thesis",
          stage,
          text: thesis
            ? `Thesis (${String(thesis.confidence)} confidence): ${plain(thesis.statement)}. It fails if ${plain(thesis.killCriterion)}.`
            : `No thesis: ${plain(body.noThesisReason) ?? "the evidence did not carry one"}.`,
          tone: thesis ? "ok" : "info",
          facts: body,
        });
        const forC = claims(body.evidenceFor);
        const against = claims(body.evidenceAgainst);
        push({
          at,
          order: 7,
          kind: "brief",
          stage,
          text: `Evidence: ${forC.length} for, ${against.length} against; weakest link: ${plain(body.weakestLink) ?? "none named"}.`,
          tone: "info",
          facts: { for: forC.length, against: against.length, weakestLink: body.weakestLink },
        });
        sourceLine([...forC, ...against], 8);
        break;
      }
      case "CHALLENGE": {
        push({
          at,
          order: 5,
          kind: "brief",
          stage,
          text: `${name} on ${String(body.themeCode)}: the thesis ${String(body.verdict)}. ${plain(body.summary) ?? ""}`,
          tone: body.verdict === "REJECTED" ? "warn" : "ok",
          facts: body,
        });
        const objections = Array.isArray(body.objections)
          ? (body.objections as {
              rank?: unknown;
              severity?: unknown;
              text?: unknown;
              sources?: unknown;
            }[])
          : [];
        for (const ob of objections)
          push({
            at,
            order: 6,
            kind: "objection",
            stage,
            text: `Objection ${String(ob.rank)} (${String(ob.severity)}): ${plain(ob.text) ?? ""}`,
            tone: ob.severity === "high" ? "warn" : "info",
            facts: ob,
          });
        sourceLine(
          objections.map((ob) => ({ class: "objection", sources: ob.sources })),
          7,
        );
        break;
      }
      case "OVERVIEW": {
        push({
          at,
          order: 5,
          kind: "brief",
          stage,
          text: `${name}: ${plain(body.summary) ?? "written"}`,
          tone: "ok",
          facts: body,
        });
        sourceLine(claims(body.points), 6);
        break;
      }
      case "RATIONALE": {
        const positions = Array.isArray(body.positions)
          ? (body.positions as { symbol?: unknown; action?: unknown; reason?: unknown }[])
          : [];
        push({
          at,
          order: 5,
          kind: "brief",
          stage,
          text: `${name}: ${String(body.decision) === "PROPOSE" ? "propose a plan" : `no change (${String(body.reasonCode).toLowerCase().replace(/_/g, " ")})`}; the evidence is ${String(body.evidenceStrength)}. ${plain(body.portfolioView) ?? ""}`,
          tone: "ok",
          facts: body,
        });
        for (const p of positions)
          push({
            at,
            order: 6,
            kind: "plan",
            stage,
            text: `${String(p.action)} ${String(p.symbol)}: ${plain(p.reason) ?? ""}`,
            tone: p.action === "EXIT" || p.action === "TRIM" ? "warn" : "info",
            facts: p,
          });
        if (typeof body.allocationNote === "string")
          push({
            at,
            order: 7,
            kind: "plan",
            stage,
            text: `Why this much is invested: ${plain(body.allocationNote)}`,
            tone: "info",
            facts: { allocationNote: body.allocationNote },
          });
        push({
          at,
          order: 8,
          kind: "brief",
          stage,
          text: `What would change it: ${plain(body.whatWouldChangeIt) ?? ""}`,
          tone: "info",
          facts: body,
        });
        sourceLine(claims(body.points), 8);
        break;
      }
      default:
        push({
          at,
          order: 5,
          kind: "brief",
          stage,
          text: `${name} written.`,
          tone: "ok",
          facts: {},
        });
    }
  }

  for (const r of i.records) {
    const stage = stageName(r.stageRunId);
    const d = r.decision as {
      kind?: unknown;
      reasonCode?: unknown;
      template?: unknown;
      params?: { positions?: unknown[]; cashTargetBps?: unknown };
    } | null;
    if (!d) continue;
    if (d.kind === "PROPOSE") {
      const n = Array.isArray(d.params?.positions) ? d.params.positions.length : 0;
      const cash =
        typeof d.params?.cashTargetBps === "number"
          ? `${(d.params.cashTargetBps / 100).toFixed(0)}%`
          : null;
      push({
        at: r.createdAt,
        order: 8,
        kind: "decision",
        stage,
        text: `Decision: propose a plan with ${n} ${n === 1 ? "position" : "positions"}${cash ? ` and ${cash} in USDC` : ""}; it goes to the Test and then to the owner.`,
        tone: "ok",
        facts: { n, cash },
      });
    } else
      push({
        at: r.createdAt,
        order: 8,
        kind: "decision",
        stage,
        text: `Decision: no change${typeof d.reasonCode === "string" ? ` (${d.reasonCode.toLowerCase().replace(/_/g, " ")})` : ""}.`,
        tone: "info",
        facts: { reasonCode: d.reasonCode },
      });
  }

  for (const p of i.proposals) {
    if (!p.evaluation) continue;
    const at = new Date(p.evaluation.checkedAt);
    const when = Number.isNaN(at.getTime()) ? p.createdAt : at;
    push({
      at: when,
      order: 8,
      kind: "check",
      stage: "TEST",
      text: p.evaluation.passed
        ? "Test checks: the plan passed every limit."
        : `Test checks: the plan failed ${p.evaluation.findings.length} ${p.evaluation.findings.length === 1 ? "check" : "checks"}: ${p.evaluation.findings.map((f) => f.code.toLowerCase().replace(/_/g, " ")).join(", ")}.`,
      tone: p.evaluation.passed ? "ok" : "warn",
      facts: { ...p.evaluation, count: p.evaluation.findings.length },
    });
    for (const f of p.evaluation.findings)
      push({
        at: when,
        order: 9,
        kind: "check",
        stage: "TEST",
        text: `Check ${f.code.toLowerCase().replace(/_/g, " ")}: ${f.message}`,
        tone: "warn",
        facts: f,
      });
    push({
      at: when,
      order: 10,
      kind: "plan",
      stage: "ZOOM_OUT",
      text:
        p.status === "pending_owner"
          ? "The plan waits for the owner's approval."
          : p.status === "approved" || p.status === "applied"
            ? "The plan was approved."
            : p.status === "rejected" || p.status === "declined"
              ? "The plan was declined."
              : `The plan is ${p.status.replace(/_/g, " ")}.`,
      tone: "info",
      facts: { status: p.status },
    });
  }

  // F-U12: the universe at the Scan's start, the themes' decisions after it, the Zoom out's drops at its end.
  const universe = i.universe ?? [];
  if (universe.length > 0) {
    const scanRun = i.stages.find((s) => s.stage === "SCAN");
    const seenAt = scanRun?.startedAt ?? startedAt;
    const buyable = universe.filter((u) => u.buyable);
    const notBuyable = universe.filter((u) => !u.buyable && u.priceClass !== "USDC");
    push({
      at: seenAt,
      order: 2,
      kind: "universe",
      stage: "SCAN",
      text: `Universe: ${universe.length} tokens seen, ${buyable.length} buyable for this account${buyable.length > 0 ? ` (${buyable.map((u) => u.symbol).join(", ")})` : ""}.`,
      tone: "info",
      facts: {
        seen: universe.length,
        buyable: buyable.length,
        symbols: buyable.map((u) => u.symbol),
      },
    });
    for (const u of notBuyable.slice(0, 16))
      push({
        at: seenAt,
        order: 2,
        kind: "universe",
        stage: "SCAN",
        text: `Not buyable: ${u.symbol}${u.lane ? ` (${u.lane} lane)` : ""}: ${u.whyNot ?? "no reason recorded"}.`,
        tone: "info",
        facts: u,
      });
    const decided = universe.filter((u) => u.themeCode !== null);
    const scanEnd = scanRun?.finishedAt ?? null;
    if (scanEnd)
      for (const u of decided)
        push({
          at: scanEnd,
          order: 11,
          kind: "universe",
          stage: "SCAN",
          text: `${u.researched ? "Dive" : "No Dive"} on ${u.symbol} (${u.themeCode}): ${u.themeReason ?? ""}.`,
          tone: u.researched ? "ok" : "info",
          facts: u,
        });
    const zoom = i.stages.find((s) => s.stage === "ZOOM_OUT");
    const zoomEnd = zoom?.finishedAt ?? null;
    if (zoomEnd)
      for (const u of universe.filter((x) => x.droppedReason !== null))
        push({
          at: zoomEnd,
          order: 7,
          kind: "universe",
          stage: "ZOOM_OUT",
          text: `Not proposed: ${u.symbol}: ${u.droppedReason ?? ""}.`,
          tone: "info",
          facts: u,
        });
  }

  for (const a of i.sentinel ?? []) {
    const did =
      a.action === "REDUCE_ONLY"
        ? "set the account to reduce-only (sales only)"
        : a.action === "PAUSE"
          ? "paused new risk (withdrawals stay open)"
          : a.action === "CLOSE_DEPOSITS"
            ? "closed deposits"
            : a.action === "INCIDENT"
              ? "marked the agent an incident"
              : a.action === "RESTRICT"
                ? "restricted the agent's research"
                : a.action === "RESUME"
                  ? "let the agent research again"
                  : "noted";
    const how =
      a.status === "failed"
        ? " (the transaction failed)"
        : a.status === "skipped"
          ? " (nothing to tighten)"
          : "";
    push({
      at: a.createdAt,
      order: 2,
      kind: "sentinel",
      stage: null,
      text: `Sentinel ${did}${how}: ${a.reason}.`,
      tone:
        a.status === "failed"
          ? "bad"
          : a.action === "NOTE" || a.action === "RESUME"
            ? "info"
            : "warn",
      facts: a,
    });
  }

  if (c.finishedAt) {
    const charged = usdc(c.chargedUsdcE6);
    const budget = i.budget
      ? ` Today's research used ${usdc(i.budget.usedBeforeUsdcE6 + c.chargedUsdcE6)} of its ${usdc(i.budget.dailyUsdcE6)} USDC budget.`
      : "";
    push({
      at: c.finishedAt,
      order: 20,
      kind: "cycle",
      stage: null,
      text: `${CYCLE_NAMES[c.kind] ?? c.kind} ${c.status}${c.stopReason ? ` (${c.stopReason.toLowerCase().replace(/_/g, " ")})` : ""}: ${charged} USDC in total.${budget}`,
      tone: c.status === "completed" ? "ok" : "bad",
      facts: {
        charged,
        used: i.budget ? usdc(i.budget.usedBeforeUsdcE6 + c.chargedUsdcE6) : null,
        daily: i.budget ? usdc(i.budget.dailyUsdcE6) : null,
      },
    });
  }

  drafts.sort((a, b) => a.at.getTime() - b.at.getTime() || a.order - b.order);
  return drafts.map((d, n) => ({
    seq: n + 1,
    at: d.at.toISOString(),
    stage: d.stage,
    ...guard(d, i.skillRuns),
  }));
}
