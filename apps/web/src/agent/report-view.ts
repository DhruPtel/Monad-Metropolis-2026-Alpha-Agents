import type { ReportListItemView, ReportView } from "@alpha-agents/ui";
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
  return {
    title: `${agentName}: research report`,
    kindLabel: kindLabel(b.cycle.kind),
    writtenAt: whenUtc(r.createdAt),
    costLine: `Written by ${r.model ?? "the platform's report model"} for ${usdc(r.chargedUsdcE6)} of credits (ceiling ${usdc(r.ceilingUsdcE6)}), from cycle ${b.cycle.cycleId}.`,
    executiveSummary: b.report.executiveSummary,
    recommendation: b.report.recommendation,
    market: b.report.market,
    universeSummary: b.report.universeSummary,
    universe: b.universe.map((u) => ({
      symbol: u.symbol,
      buyable: u.buyable,
      researched: u.researched,
      proposed: u.proposed,
      themeCode: u.themeCode,
      why: u.droppedReason ?? (u.researched ? u.themeReason : (u.whyNot ?? u.themeReason)),
    })),
    tokens: b.report.tokens,
    skeptic: b.report.skeptic,
    portfolio: b.report.portfolio,
    sources: b.sources,
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
