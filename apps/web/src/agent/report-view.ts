import type {
  ReportListItemView,
  ReportReferenceView,
  ReportUniverseGroupView,
  ReportUniverseRowView,
  ReportView,
} from "@alpha-agents/ui";
import type { ReportJson, ReportListItemJson, StoredReportJson } from "@/api/client";

/**
 * RP-U1: the stored report as the document shows it. Pure: the words are
 * fixed here, the figures are the record's, nothing is computed beyond
 * formatting.
 */
const KIND_LABEL: Readonly<Record<string, string>> = {
  ACTIVATION: "Activation sweep",
  ROUTINE: "Routine research cycle",
  TRIGGERED: "Triggered research cycle",
  REVIEW: "Plan review",
  REPLAY: "Replay",
};
const STAGE_LABEL: Readonly<Record<string, string>> = {
  SCAN: "Scan",
  DIVE: "Dive",
  CHALLENGE: "Challenge",
  TEST: "Test",
  ZOOM_OUT: "Zoom out",
};

export const kindLabel = (kind: string) => KIND_LABEL[kind] ?? "Research cycle";
export const usdc = (e6: string) =>
  `${(Number(e6) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} USDC`;
export const whenUtc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/**
 * UI-FAST: a figure the model wrote as a bare number ("0.02504364702970262",
 * "1009846222") reads at a sensible precision; any other text is kept as written.
 */
export function figure(value: string): string {
  const v = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(v)) return value;
  const n = Number(v);
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (abs >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (abs === 0) return "0";
  return n.toLocaleString("en-US", { maximumSignificantDigits: 4 });
}

const isUrl = (s: string) => /^https?:\/\//i.test(s);

function urlLabel(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, "");
    const label = `${u.hostname.replace(/^www\./, "")}${path}`;
    return label.length > 72 ? `${label.slice(0, 71)}…` : label;
  } catch {
    return url;
  }
}

const CLASS_WORD: Readonly<Record<string, string>> = {
  onchain: "onchain",
  primary: "primary source",
  market: "market data",
  news: "news",
  social: "social",
  platform: "the platform's own records",
};

/**
 * UI-FAST: every source gets one number, in the order the report first cites
 * it (the market figures, then each token's evidence); sources the cycle used
 * but the text never cites follow, so the list stays the cycle's full record.
 */
function numberSources(b: StoredReportJson): {
  references: ReportReferenceView[];
  cite: (sources: readonly string[]) => number[];
} {
  const known = new Map(b.sources.map((s) => [s.source, s]));
  const order: string[] = [];
  const add = (s: string) => {
    if (!order.includes(s)) order.push(s);
  };
  for (const s of b.report.market.snapshot) if (s.source) add(s.source);
  for (const t of b.report.tokens)
    for (const e of [...t.evidenceFor, ...t.evidenceAgainst]) for (const s of e.sources) add(s);
  const cited = order.length;
  for (const s of b.sources) add(s.source);
  const references = order.map((source, i): ReportReferenceView => {
    const rec = known.get(source);
    const url = rec ? rec.kind === "url" : isUrl(source);
    const classes = (rec?.classes ?? []).map((c) => CLASS_WORD[c] ?? c).join(", ");
    const calls = rec ? `${rec.calls} ${rec.calls === 1 ? "call" : "calls"}` : "";
    return {
      n: i + 1,
      source,
      label: url ? urlLabel(source) : source,
      href: url ? source : null,
      detail: url
        ? `Web page${classes ? `, ${classes}` : ""}, retrieved by the cycle`
        : `Tool record${classes ? `, ${classes}` : ""}${calls ? `, ${calls}` : ""}`,
      cited: i < cited,
    };
  });
  const index = new Map(order.map((s, i) => [s, i + 1]));
  const cite = (sources: readonly string[]) =>
    [...new Set(sources.map((s) => index.get(s) ?? 0).filter((n) => n > 0))].sort((a, b) => a - b);
  return { references, cite };
}

export function reportView(r: ReportJson["report"], agentName: string): ReportView | null {
  const b: StoredReportJson | null = r.body;
  if (!b) return null;
  const removed = r.checks.removedSentences ?? 0;
  const dropped = r.checks.droppedSources ?? 0;
  const checks: string[] = [];
  if (removed > 0)
    checks.push(
      `The checks removed ${removed} ${removed === 1 ? "sentence" : "sentences"} the records could not support.`,
    );
  if (dropped > 0)
    checks.push(
      `${dropped} cited ${dropped === 1 ? "source was" : "sources were"} dropped as not retrieved by the cycle.`,
    );
  const { references, cite } = numberSources(b);
  const sectioned = new Set(b.report.tokens.map((t) => t.symbol));
  const universe = b.universe.map((u): ReportUniverseRowView => ({
    symbol: u.symbol,
    buyable: u.buyable,
    // A buyable token with its own section was researched in depth, whatever the Scan's row
    // says; a research-only token of the same symbol (on another chain) was not.
    researched: u.researched || (u.buyable && sectioned.has(u.symbol)),
    proposed: u.proposed,
    themeCode: u.themeCode,
    why: u.droppedReason ?? (u.researched ? u.themeReason : (u.whyNot ?? u.themeReason)),
  }));
  const symbols = b.report.tokens.map((t) => t.symbol);
  return {
    title: symbols.length > 0 ? `Research report: ${listWords(symbols)}` : "Research report",
    byline: agentName,
    kindLabel: kindLabel(b.cycle.kind),
    writtenAt: whenUtc(r.createdAt),
    costLine: `Written by ${r.model ?? "the platform's report model"} for ${usdc(r.chargedUsdcE6)} of credits (ceiling ${usdc(r.ceilingUsdcE6)}), from cycle ${b.cycle.cycleId}.`,
    executiveSummary: b.report.executiveSummary,
    recommendation: b.report.recommendation,
    market: {
      overview: b.report.market.overview,
      snapshot: b.report.market.snapshot.map((s) => ({
        label: s.label,
        value: figure(s.value),
        cites: cite([s.source]),
      })),
    },
    universeSummary: b.report.universeSummary,
    universe,
    universeGroups: groupUniverse(universe),
    tokens: b.report.tokens.map((t) => ({
      ...t,
      evidenceFor: t.evidenceFor.map((e) => ({ text: e.text, cites: cite(e.sources) })),
      evidenceAgainst: t.evidenceAgainst.map((e) => ({ text: e.text, cites: cite(e.sources) })),
    })),
    skeptic: b.report.skeptic,
    portfolio: b.report.portfolio,
    references,
    stages: b.stages.map((s) => ({
      label: `${STAGE_LABEL[s.stage] ?? s.stage}${s.themeCode ? ` (${s.themeCode})` : ""}`,
      result:
        s.status === "completed"
          ? "finished"
          : `${s.status}${s.stopReason ? `: ${s.stopReason.toLowerCase().replaceAll("_", " ")}` : ""}`,
      charged: usdc(s.chargedUsdcE6),
    })),
    checksNote: checks.length > 0 ? checks.join(" ") : null,
  };
}

const listWords = (xs: readonly string[]) =>
  xs.length <= 2 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

/**
 * UI-FAST: the universe in a few rows: researched and buyable tokens each keep
 * their own row; the rest are grouped by the reason they were passed over.
 */
function groupUniverse(rows: readonly ReportUniverseRowView[]): ReportUniverseGroupView[] {
  const groups = new Map<string, ReportUniverseGroupView & { symbols: string[] }>();
  for (const r of rows) {
    const outcome: ReportUniverseGroupView["outcome"] = r.researched
      ? r.proposed
        ? "proposed"
        : "researched"
      : r.buyable
        ? "buyable"
        : "not buyable";
    const key = `${outcome}|${r.why ?? ""}`;
    const g = groups.get(key) ?? { outcome, why: r.why, symbols: [] };
    g.symbols.push(r.symbol);
    groups.set(key, g);
  }
  const rank = { proposed: 0, researched: 1, buyable: 2, "not buyable": 3 } as const;
  return [...groups.values()].sort(
    (a, b) => rank[a.outcome] - rank[b.outcome] || b.symbols.length - a.symbols.length,
  );
}

export function reportListView(
  agentId: bigint,
  items: readonly ReportListItemJson[],
): ReportListItemView[] {
  return items.map((r) => ({
    cycleId: r.cycleId,
    href: reportHref(agentId, r.cycleId),
    kindLabel: kindLabel(r.kind),
    writtenAt: whenUtc(r.createdAt),
    status: r.status,
    summary: r.summary,
    reason: r.reason,
    tokens: r.tokens,
  }));
}

export const reportHref = (agentId: bigint, cycleId: string) =>
  `/agents/${agentId.toString()}/research/reports/${cycleId}`;

/**
 * RP-U1: Download as PDF: the browser's print dialog, whose "Save as PDF"
 * names the file after the document's title; the print styling makes the
 * PDF read like the page. The title is restored once the dialog closes.
 */
export function printReport(
  target: { document: { title: string }; print(): void },
  agentName: string,
  cycleId: string,
): string {
  const before = target.document.title;
  const title = `Vivarium research report, ${agentName}, ${cycleId.slice(6, 14)}`;
  target.document.title = title;
  try {
    target.print();
  } finally {
    target.document.title = before;
  }
  return title;
}
