import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Tag } from "../ui/tag";

/**
 * RP-U1: a research cycle's report as a document: the executive summary,
 * the market, the universe considered, a section per researched token, the
 * skeptic's objections, the recommended portfolio and every source by class.
 * Readable on screen and in print: the `report-document` class carries the
 * print styling (styles.css), so the PDF reads like the page. The component
 * formats what it is given; the platform wrote and checked every sentence.
 */

export interface ReportEvidenceView {
  readonly text: string;
  readonly sources: readonly string[];
}

export interface ReportTokenView {
  readonly symbol: string;
  readonly chain: string;
  readonly whatItIs: string;
  readonly fundamentals: readonly {
    readonly item: string;
    readonly finding: string;
    readonly status: "supports" | "concern" | "unknown";
  }[];
  readonly evidenceFor: readonly ReportEvidenceView[];
  readonly evidenceAgainst: readonly ReportEvidenceView[];
  readonly risks: readonly string[];
  readonly thesis: string;
  readonly killCondition: string;
  readonly confidence: "low" | "medium" | "high";
}

export interface ReportUniverseRowView {
  readonly symbol: string;
  readonly buyable: boolean;
  readonly researched: boolean;
  readonly proposed: boolean;
  readonly themeCode: string | null;
  readonly why: string | null;
}

export interface ReportSourceView {
  readonly source: string;
  readonly kind: "tool" | "url";
  readonly classes: readonly string[];
  readonly calls: number;
}

export interface ReportView {
  readonly title: string;
  /** "Activation sweep", "Routine cycle"; and when it was written. */
  readonly kindLabel: string;
  readonly writtenAt: string;
  readonly costLine: string;
  readonly executiveSummary: string;
  readonly recommendation: string;
  readonly market: {
    readonly overview: string;
    readonly snapshot: readonly {
      readonly label: string;
      readonly value: string;
      readonly source: string;
    }[];
  };
  readonly universeSummary: string;
  readonly universe: readonly ReportUniverseRowView[];
  readonly tokens: readonly ReportTokenView[];
  readonly skeptic: readonly {
    readonly theme: string;
    readonly objection: string;
    readonly answer: string;
  }[];
  readonly portfolio: {
    readonly stance: "propose" | "no_change";
    readonly summary: string;
    readonly positions: readonly {
      readonly symbol: string;
      readonly weight: string;
      readonly why: string;
    }[];
  };
  readonly sources: readonly ReportSourceView[];
  readonly stages: readonly {
    readonly label: string;
    readonly result: string;
    readonly charged: string;
  }[];
  /** What the checks removed, in words; null when nothing was. */
  readonly checksNote: string | null;
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section
      aria-labelledby={`report-${id}`}
      className="report-section flex flex-col gap-3 border-t border-border pt-6"
      data-testid={`report-${id}`}
    >
      <h2 id={`report-${id}`} className="text-xl font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

const Para = ({ text, empty }: { text: string; empty?: string }) =>
  text ? (
    <p className="max-w-[72ch] text-sm leading-relaxed">{text}</p>
  ) : empty ? (
    <p className="text-sm text-foreground-muted">{empty}</p>
  ) : null;

const STATUS_TONE = { supports: "positive", concern: "warning", unknown: "neutral" } as const;
const STATUS_WORD = { supports: "Supports", concern: "Concern", unknown: "Unknown" } as const;
const CONFIDENCE_TONE = { low: "neutral", medium: "warning", high: "positive" } as const;

function SourceTags({ sources }: { sources: readonly string[] }) {
  if (sources.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {sources.map((s) => (
        <Tag key={s} tone="neutral" className="max-w-full truncate">
          {s.replace(/^https?:\/\//, "").slice(0, 60)}
        </Tag>
      ))}
    </span>
  );
}

function EvidenceList({ title, items }: { title: string; items: readonly ReportEvidenceView[] }) {
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-semibold">{title}</h4>
      {items.length === 0 ? (
        <p className="text-sm text-foreground-muted">None recorded.</p>
      ) : (
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed">
          {items.map((e, i) => (
            <li key={i} className="flex flex-col gap-1">
              <span>{e.text}</span>
              <SourceTags sources={e.sources} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TokenReport({ t }: { t: ReportTokenView }) {
  return (
    <article
      className="report-token flex flex-col gap-4 rounded-lg border border-border bg-surface p-4"
      data-testid="report-token"
      data-symbol={t.symbol}
    >
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold">{t.symbol}</h3>
        {t.chain ? <Tag tone="neutral">{t.chain}</Tag> : null}
        <Badge tone={CONFIDENCE_TONE[t.confidence]}>{t.confidence} confidence</Badge>
      </header>
      <Para text={t.whatItIs} />
      {t.fundamentals.length > 0 ? (
        <Table label={`${t.symbol} fundamentals`} stack>
          <TableHeader>
            <TableRow>
              <TableHead>Checklist item</TableHead>
              <TableHead>Finding</TableHead>
              <TableHead className="text-right">Reads as</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {t.fundamentals.map((f) => (
              <TableRow key={f.item}>
                <TableCell className="font-medium">{f.item}</TableCell>
                <TableCell>{f.finding}</TableCell>
                <TableCell className="text-right">
                  <Badge tone={STATUS_TONE[f.status]}>{STATUS_WORD[f.status]}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        <EvidenceList title="Evidence for" items={t.evidenceFor} />
        <EvidenceList title="Evidence against" items={t.evidenceAgainst} />
      </div>
      {t.risks.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold">Risks</h4>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            {t.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <dl className="grid gap-2 text-sm md:grid-cols-[auto_1fr]">
        <dt className="font-semibold">Thesis</dt>
        <dd>{t.thesis || "–"}</dd>
        <dt className="font-semibold">Kill condition</dt>
        <dd>{t.killCondition || "–"}</dd>
      </dl>
    </article>
  );
}

const CLASS_ORDER = ["onchain", "primary", "market", "news", "social", "platform"];
const CLASS_WORD: Record<string, string> = {
  onchain: "Onchain",
  primary: "Primary sources",
  market: "Market data",
  news: "News",
  social: "Social",
  platform: "The platform's own records",
};

function SourcesByClass({ sources }: { sources: readonly ReportSourceView[] }) {
  const groups = new Map<string, ReportSourceView[]>();
  for (const s of sources) {
    const cls =
      s.kind === "url"
        ? s.classes.includes("social")
          ? "social"
          : "primary"
        : (s.classes[0] ?? "platform");
    groups.set(cls, [...(groups.get(cls) ?? []), s]);
  }
  const order = [...groups.keys()].sort((a, b) => CLASS_ORDER.indexOf(a) - CLASS_ORDER.indexOf(b));
  if (order.length === 0)
    return <p className="text-sm text-foreground-muted">No sources recorded.</p>;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {order.map((cls) => (
        <div
          key={cls}
          className="flex flex-col gap-2"
          data-testid="report-source-class"
          data-class={cls}
        >
          <h3 className="text-sm font-semibold">{CLASS_WORD[cls] ?? cls}</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {(groups.get(cls) ?? []).map((s) => (
              <li key={s.source} className="break-all">
                {s.kind === "url" ? (
                  <a
                    href={s.source}
                    className="text-primary underline-offset-4 hover:underline"
                    rel="noreferrer noopener"
                    target="_blank"
                  >
                    {s.source}
                  </a>
                ) : (
                  <span>
                    <span className="font-medium">{s.source}</span>{" "}
                    <span className="text-foreground-muted">
                      ({s.calls} {s.calls === 1 ? "call" : "calls"})
                    </span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function UniverseTable({ rows }: { rows: readonly ReportUniverseRowView[] }) {
  if (rows.length === 0)
    return <p className="text-sm text-foreground-muted">The cycle recorded no universe.</p>;
  return (
    <Table label="Universe considered" stack data-testid="report-universe-table">
      <TableHeader>
        <TableRow>
          <TableHead>Token</TableHead>
          <TableHead>Buyable</TableHead>
          <TableHead>Researched</TableHead>
          <TableHead>Why</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r, i) => (
          <TableRow key={`${r.symbol}-${i}`} data-testid="report-universe-row">
            <TableCell className="font-medium">{r.symbol}</TableCell>
            <TableCell>{r.buyable ? "Yes" : "No"}</TableCell>
            <TableCell>
              {r.researched ? (
                <Badge tone="positive">{r.proposed ? "Researched, proposed" : "Researched"}</Badge>
              ) : (
                "No"
              )}
            </TableCell>
            <TableCell className="text-foreground-muted">{r.why ?? "–"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ResearchReportDocument({
  view,
  actions,
  className,
}: {
  view: ReportView;
  /** The page's actions (Download as PDF, back links); hidden in print. */
  actions?: ReactNode;
  className?: string;
}) {
  const researched = view.universe.filter((u) => u.researched).length;
  const buyable = view.universe.filter((u) => u.buyable).length;
  return (
    <article
      className={cn("report-document mx-auto flex w-full max-w-4xl flex-col gap-6", className)}
      data-testid="research-report"
    >
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs tracking-wide text-foreground-muted uppercase">
              {view.kindLabel} · {view.writtenAt}
            </span>
            <h1 className="text-3xl font-semibold">{view.title}</h1>
          </div>
          {actions ? (
            <div className="report-actions flex flex-wrap gap-2" data-print="hide">
              {actions}
            </div>
          ) : null}
        </div>
        <p className="text-xs text-foreground-muted">{view.costLine}</p>
      </header>

      <Section id="summary" title="Executive summary">
        <Para text={view.executiveSummary} empty="The report has no summary." />
        {view.recommendation ? (
          <p
            className="rounded-lg border border-primary-muted bg-surface-raised p-4 text-sm font-medium"
            data-testid="report-recommendation"
          >
            {view.recommendation}
          </p>
        ) : null}
      </Section>

      <Section id="market" title="Market overview">
        <Para text={view.market.overview} empty="No market overview was written." />
        {view.market.snapshot.length > 0 ? (
          <Table label="Market snapshot" stack>
            <TableHeader>
              <TableRow>
                <TableHead>Figure</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead>Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.market.snapshot.map((s) => (
                <TableRow key={s.label}>
                  <TableCell>{s.label}</TableCell>
                  <TableCell className="numeric text-right">{s.value}</TableCell>
                  <TableCell className="text-foreground-muted">{s.source}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </Section>

      <Section id="universe" title="Universe considered">
        <p className="text-sm text-foreground-muted">
          <span className="numeric">{view.universe.length}</span> tokens seen,{" "}
          <span className="numeric">{buyable}</span> buyable by this account,{" "}
          <span className="numeric">{researched}</span> researched in depth.
        </p>
        <Para text={view.universeSummary} />
        <UniverseTable rows={view.universe} />
      </Section>

      <Section id="tokens" title="Researched tokens">
        {view.tokens.length === 0 ? (
          <p className="text-sm text-foreground-muted">
            This cycle researched no single token in depth.
          </p>
        ) : (
          view.tokens.map((t) => <TokenReport key={`${t.symbol}-${t.chain}`} t={t} />)
        )}
      </Section>

      <Section id="skeptic" title="The skeptic's objections">
        {view.skeptic.length === 0 ? (
          <p className="text-sm text-foreground-muted">No objections were recorded.</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {view.skeptic.map((s, i) => (
              <li
                key={i}
                className="flex flex-col gap-1 rounded-lg border border-border p-3 text-sm"
              >
                {s.theme ? <Tag tone="neutral">{s.theme}</Tag> : null}
                <p>
                  <span className="font-semibold">Objection. </span>
                  {s.objection}
                </p>
                <p>
                  <span className="font-semibold">Answer. </span>
                  {s.answer || "Not answered."}
                </p>
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section id="portfolio" title="Recommended portfolio">
        <Badge tone={view.portfolio.stance === "propose" ? "positive" : "neutral"}>
          {view.portfolio.stance === "propose"
            ? "A new plan is proposed"
            : "The plan should not change"}
        </Badge>
        <Para text={view.portfolio.summary} />
        {view.portfolio.positions.length > 0 ? (
          <Table label="Recommended positions" stack>
            <TableHeader>
              <TableRow>
                <TableHead>Token</TableHead>
                <TableHead className="text-right">Weight</TableHead>
                <TableHead>Why</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.portfolio.positions.map((p) => (
                <TableRow key={p.symbol}>
                  <TableCell className="font-medium">{p.symbol}</TableCell>
                  <TableCell className="numeric text-right">{p.weight}</TableCell>
                  <TableCell>{p.why}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </Section>

      <Section id="sources" title="Sources">
        <SourcesByClass sources={view.sources} />
      </Section>

      <Section id="method" title="How this report was made">
        <p className="text-sm text-foreground-muted">
          The agent's research cycle ran these steps; the report was written from their records, and
          every figure in it traces to a tool result the cycle stored.
          {view.checksNote ? ` ${view.checksNote}` : ""}
        </p>
        <Table label="Research steps" stack>
          <TableHeader>
            <TableRow>
              <TableHead>Step</TableHead>
              <TableHead>Result</TableHead>
              <TableHead className="text-right">Charged</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.stages.map((s, i) => (
              <TableRow key={i}>
                <TableCell className="font-medium">{s.label}</TableCell>
                <TableCell>{s.result}</TableCell>
                <TableCell className="numeric text-right">{s.charged}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>
    </article>
  );
}

export interface ReportListItemView {
  readonly cycleId: string;
  readonly href: string;
  readonly kindLabel: string;
  readonly writtenAt: string;
  readonly status: "written" | "skipped" | "failed";
  readonly summary: string | null;
  readonly reason: string | null;
  readonly tokens: number;
}

/** The Research page's list of reports: each opens its document; a skipped one says why. */
function ReportList({
  items,
  className,
}: {
  items: readonly ReportListItemView[];
  className?: string;
}) {
  if (items.length === 0)
    return (
      <p className={cn("text-sm text-foreground-muted", className)} data-testid="report-list-empty">
        No reports yet: the first is written when a research cycle ends.
      </p>
    );
  return (
    <ul className={cn("flex flex-col gap-3", className)} data-testid="report-list">
      {items.map((r) => (
        <li
          key={r.cycleId}
          className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-3"
        >
          <div className="flex flex-wrap items-center gap-2 text-xs text-foreground-muted">
            <span>{r.kindLabel}</span>
            <span>·</span>
            <span className="numeric">{r.writtenAt}</span>
            {r.status !== "written" ? (
              <Badge tone={r.status === "failed" ? "negative" : "neutral"}>{r.status}</Badge>
            ) : null}
          </div>
          {r.status === "written" ? (
            <a
              href={r.href}
              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
              data-testid="report-link"
            >
              {r.summary ?? "Open the report"}
            </a>
          ) : (
            <p className="text-sm text-foreground-muted">{r.reason ?? "No report was written."}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

export { ReportList, ResearchReportDocument };
