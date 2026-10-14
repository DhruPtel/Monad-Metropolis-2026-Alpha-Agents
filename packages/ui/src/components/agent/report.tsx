import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Tag } from "../ui/tag";

/**
 * RP-U1, reshaped in UI-FAST: a research cycle's report laid out like a deep
 * research report: a title and byline, an executive summary with the bottom
 * line, contents, numbered sections (the market, the universe considered, a
 * section per researched token, the challenges, the portfolio, the method)
 * and numbered references that every citation links to. Readable on screen
 * and in print: the `report-document` class carries the print styling
 * (styles.css), so the PDF reads like the page. The component formats what
 * it is given; the platform wrote and checked every sentence.
 */

export interface ReportCitedTextView {
  readonly text: string;
  /** Reference numbers, ascending; each links to its entry under References. */
  readonly cites: readonly number[];
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
  readonly evidenceFor: readonly ReportCitedTextView[];
  readonly evidenceAgainst: readonly ReportCitedTextView[];
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

/** Universe rows that share an outcome and a reason, as one line of the summary table. */
export interface ReportUniverseGroupView {
  readonly outcome: "proposed" | "researched" | "buyable" | "not buyable";
  readonly why: string | null;
  readonly symbols: readonly string[];
}

export interface ReportReferenceView {
  readonly n: number;
  readonly source: string;
  readonly label: string;
  /** The page's address for a web source; null for a tool record. */
  readonly href: string | null;
  readonly detail: string;
  /** False for a source the cycle used that the text never cites. */
  readonly cited: boolean;
}

export interface ReportView {
  readonly title: string;
  /** Who the report is for: the agent's name. */
  readonly byline: string;
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
      readonly cites: readonly number[];
    }[];
  };
  readonly universeSummary: string;
  readonly universe: readonly ReportUniverseRowView[];
  readonly universeGroups: readonly ReportUniverseGroupView[];
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
  /**
   * 2026-10-13: what the agent would buy across the real tokens it researched, as if all were
   * tradable; the report leads with it. Null on a report written before it existed.
   */
  readonly mainDecision?: {
    readonly summary: string;
    readonly positions: readonly {
      readonly symbol: string;
      readonly weight: string;
      readonly why: string;
    }[];
  } | null;
  /** On a test network: how the plan actually executes there, beside the main decision. */
  readonly testnet?: { readonly executesAs: string } | null;
  readonly references: readonly ReportReferenceView[];
  readonly stages: readonly {
    readonly label: string;
    readonly result: string;
    readonly charged: string;
  }[];
  /** What the checks removed, in words; null when nothing was. */
  readonly checksNote: string | null;
}

function Section({
  id,
  number,
  title,
  children,
}: {
  id: string;
  number?: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      id={`report-${id}`}
      aria-labelledby={`report-${id}-title`}
      className="report-section flex scroll-mt-24 flex-col gap-4"
      data-testid={`report-${id}`}
    >
      <h2
        id={`report-${id}-title`}
        className="flex items-baseline gap-3 border-b border-border pb-2 text-2xl font-semibold tracking-tight"
      >
        {number !== undefined ? (
          <span className="numeric text-foreground-muted">{number}.</span>
        ) : null}
        {title}
      </h2>
      {children}
    </section>
  );
}

const PROSE = "max-w-[72ch] text-base leading-7";

const Para = ({ text, empty }: { text: string; empty?: string }) =>
  text ? (
    <p className={PROSE}>{text}</p>
  ) : empty ? (
    <p className="text-sm text-foreground-muted">{empty}</p>
  ) : null;

const Muted = ({ children }: { children: ReactNode }) => (
  <p className="text-sm text-foreground-muted">{children}</p>
);

const STATUS_TONE = { supports: "positive", concern: "warning", unknown: "neutral" } as const;
const STATUS_WORD = { supports: "Supports", concern: "Concern", unknown: "Unknown" } as const;
const CONFIDENCE_TONE = { low: "neutral", medium: "warning", high: "positive" } as const;

/** Numbered citations, each a link to its reference: [1][3]. */
function Cites({ cites }: { cites: readonly number[] }) {
  if (cites.length === 0) return null;
  return (
    <sup className="numeric ml-0.5 whitespace-nowrap" data-testid="report-cite">
      {cites.map((n) => (
        <a
          key={n}
          href={`#report-ref-${n}`}
          className="text-primary no-underline hover:underline"
          aria-label={`Reference ${n}`}
        >
          [{n}]
        </a>
      ))}
    </sup>
  );
}

function EvidenceList({ title, items }: { title: string; items: readonly ReportCitedTextView[] }) {
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-base font-semibold">{title}</h4>
      {items.length === 0 ? (
        <Muted>None recorded.</Muted>
      ) : (
        <ul className={cn(PROSE, "flex list-disc flex-col gap-2 pl-5")}>
          {items.map((e, i) => (
            <li key={i}>
              {e.text}
              <Cites cites={e.cites} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TokenReport({ t, number }: { t: ReportTokenView; number: string }) {
  return (
    <article
      id={`report-token-${t.symbol}`}
      aria-labelledby={`report-token-${t.symbol}-title`}
      className="report-token flex scroll-mt-24 flex-col gap-4"
      data-testid="report-token"
      data-symbol={t.symbol}
    >
      <header className="flex flex-wrap items-center gap-2">
        <h3 id={`report-token-${t.symbol}-title`} className="text-xl font-semibold">
          <span className="numeric mr-2 text-foreground-muted">{number}</span>
          {t.symbol}
        </h3>
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
      <EvidenceList title="The case for" items={t.evidenceFor} />
      <EvidenceList title="The case against" items={t.evidenceAgainst} />
      {t.risks.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h4 className="text-base font-semibold">Risks</h4>
          <ul className={cn(PROSE, "flex list-disc flex-col gap-1 pl-5")}>
            {t.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <dl className="grid gap-x-6 gap-y-2 rounded-lg border border-border bg-surface-raised p-4 text-base leading-7 md:grid-cols-[auto_1fr]">
        <dt className="font-semibold">Thesis</dt>
        <dd>{t.thesis || "–"}</dd>
        <dt className="font-semibold">Kill condition</dt>
        <dd>{t.killCondition || "–"}</dd>
      </dl>
    </article>
  );
}

function References({ refs }: { refs: readonly ReportReferenceView[] }) {
  if (refs.length === 0) return <Muted>No sources recorded.</Muted>;
  const item = (r: ReportReferenceView) => (
    <li
      key={r.n}
      id={`report-ref-${r.n}`}
      className="grid scroll-mt-24 grid-cols-[auto_1fr] gap-1 text-sm"
      data-testid="report-reference"
    >
      <span className="numeric w-10 text-foreground-muted">[{r.n}]</span>
      <span className="flex min-w-0 flex-col">
        {r.href ? (
          <a
            href={r.href}
            className="break-all text-primary underline-offset-4 hover:underline"
            rel="noreferrer noopener"
            target="_blank"
          >
            {r.label}
          </a>
        ) : (
          <span className="font-mono text-sm">{r.label}</span>
        )}
        <span className="text-foreground-muted">{r.detail}</span>
      </span>
    </li>
  );
  const cited = refs.filter((r) => r.cited);
  const consulted = refs.filter((r) => !r.cited);
  return (
    <div className="flex flex-col gap-4">
      {cited.length > 0 ? <ol className="flex flex-col gap-2">{cited.map(item)}</ol> : null}
      {consulted.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-base font-semibold">Also consulted</h3>
          <ol className="flex flex-col gap-2">{consulted.map(item)}</ol>
        </div>
      ) : null}
    </div>
  );
}

const OUTCOME_TONE = {
  proposed: "positive",
  researched: "positive",
  buyable: "neutral",
  "not buyable": "neutral",
} as const;
const OUTCOME_WORD = {
  proposed: "Researched, proposed",
  researched: "Researched",
  buyable: "Buyable, not researched",
  "not buyable": "Not buyable here",
} as const;

function symbolList(symbols: readonly string[]) {
  const shown = symbols.slice(0, 8);
  const more = symbols.length - shown.length;
  return `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

function UniverseTable({ view }: { view: ReportView }) {
  if (view.universe.length === 0) return <Muted>The cycle recorded no universe.</Muted>;
  return (
    <>
      <Table label="Universe considered" stack data-testid="report-universe-groups">
        <TableHeader>
          <TableRow>
            <TableHead>Outcome</TableHead>
            <TableHead>Tokens</TableHead>
            <TableHead className="text-right">Count</TableHead>
            <TableHead>Reason</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {view.universeGroups.map((g, i) => (
            <TableRow key={i} data-testid="report-universe-group">
              <TableCell>
                <Badge tone={OUTCOME_TONE[g.outcome]}>{OUTCOME_WORD[g.outcome]}</Badge>
              </TableCell>
              <TableCell className="font-medium">{symbolList(g.symbols)}</TableCell>
              <TableCell className="numeric text-right">{g.symbols.length}</TableCell>
              <TableCell className="text-foreground-muted">{g.why ?? "–"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <details className="report-universe-all text-sm" data-print="hide">
        <summary className="cursor-pointer text-foreground-muted">
          Every token, one per row (<span className="numeric">{view.universe.length}</span>)
        </summary>
        <div className="mt-3">
          <Table label="Every token considered" stack data-testid="report-universe-table">
            <TableHeader>
              <TableRow>
                <TableHead>Token</TableHead>
                <TableHead>Buyable</TableHead>
                <TableHead>Researched</TableHead>
                <TableHead>Why</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.universe.map((r, i) => (
                <TableRow key={`${r.symbol}-${i}`} data-testid="report-universe-row">
                  <TableCell className="font-medium">{r.symbol}</TableCell>
                  <TableCell>{r.buyable ? "Yes" : "No"}</TableCell>
                  <TableCell>
                    {r.researched ? (r.proposed ? "Researched, proposed" : "Researched") : "No"}
                  </TableCell>
                  <TableCell className="text-foreground-muted">{r.why ?? "–"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </details>
    </>
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
  const n = { market: 1, universe: 2, tokens: 3, skeptic: 4, portfolio: 5, method: 6 };
  const contents: { id: string; label: string; children?: { id: string; label: string }[] }[] = [
    { id: "summary", label: "Executive summary" },
    { id: "market", label: `${n.market}. Market overview` },
    { id: "universe", label: `${n.universe}. Universe considered` },
    {
      id: "tokens",
      label: `${n.tokens}. Token analysis`,
      children: view.tokens.map((t, i) => ({
        id: `token-${t.symbol}`,
        label: `${n.tokens}.${i + 1} ${t.symbol}`,
      })),
    },
    { id: "skeptic", label: `${n.skeptic}. Challenges and answers` },
    { id: "portfolio", label: `${n.portfolio}. Recommended portfolio` },
    { id: "method", label: `${n.method}. How this report was made` },
    { id: "sources", label: "References" },
  ];
  return (
    <article
      className={cn("report-document mx-auto flex w-full max-w-3xl flex-col gap-10", className)}
      data-testid="research-report"
    >
      <header className="flex flex-col gap-4 border-b border-border pb-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <span className="text-xs font-medium tracking-wide text-foreground-muted uppercase">
            {view.kindLabel}
          </span>
          {actions ? (
            <div className="report-actions flex flex-wrap gap-2" data-print="hide">
              {actions}
            </div>
          ) : null}
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">{view.title}</h1>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <div className="flex gap-2">
            <dt className="text-foreground-muted">Prepared for</dt>
            <dd className="font-medium">{view.byline}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-foreground-muted">Written</dt>
            <dd className="numeric font-medium">{view.writtenAt}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-foreground-muted">Recommendation</dt>
            <dd>
              <Badge tone={view.portfolio.stance === "propose" ? "positive" : "neutral"}>
                {view.portfolio.stance === "propose" ? "New plan proposed" : "No change"}
              </Badge>
            </dd>
          </div>
        </dl>
        <p className="text-xs text-foreground-muted">{view.costLine}</p>
      </header>

      {view.mainDecision &&
      (view.mainDecision.summary || view.mainDecision.positions.length > 0) ? (
        <Section id="decision" title="Decision">
          <Para text={view.mainDecision.summary} />
          {view.mainDecision.positions.length > 0 ? (
            <Table label="What the agent would buy" stack>
              <TableHeader>
                <TableRow>
                  <TableHead>Token</TableHead>
                  <TableHead className="text-right">Weight</TableHead>
                  <TableHead>Why</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.mainDecision.positions.map((p) => (
                  <TableRow key={p.symbol}>
                    <TableCell className="font-medium">{p.symbol}</TableCell>
                    <TableCell className="numeric text-right">{p.weight}</TableCell>
                    <TableCell>{p.why}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
          {view.testnet ? (
            <div
              className="flex flex-col gap-1 rounded-lg border border-warning p-4"
              data-testid="report-testnet"
            >
              <span className="text-xs font-semibold tracking-wide uppercase">Monad testnet</span>
              <p className="text-sm">
                On Monad testnet these tokens don&apos;t exist, so this plan executes as:{" "}
                {view.testnet.executesAs}
              </p>
              <p className="text-sm text-foreground-muted">
                On mainnet it would buy the main decision above.
              </p>
            </div>
          ) : null}
        </Section>
      ) : null}

      <Section id="summary" title="Executive summary">
        <Para text={view.executiveSummary} empty="The report has no summary." />
        {view.recommendation ? (
          <div
            className="flex flex-col gap-1 rounded-lg border-l-4 border-primary bg-surface-raised p-4"
            data-testid="report-recommendation"
          >
            <span className="text-xs font-semibold tracking-wide text-foreground-muted uppercase">
              Bottom line
            </span>
            <p className="text-base leading-7 font-medium">{view.recommendation}</p>
          </div>
        ) : null}
      </Section>

      <nav aria-label="Contents" className="report-contents flex flex-col gap-2 text-sm">
        <h2 className="text-xs font-semibold tracking-wide text-foreground-muted uppercase">
          Contents
        </h2>
        <ol className="flex flex-col gap-1">
          {contents.map((c) => (
            <li key={c.id}>
              <a
                href={`#report-${c.id}`}
                className="text-foreground underline-offset-4 hover:underline"
              >
                {c.label}
              </a>
              {c.children && c.children.length > 0 ? (
                <ol className="mt-1 flex flex-col gap-1 pl-5">
                  {c.children.map((k) => (
                    <li key={k.id}>
                      <a
                        href={`#report-${k.id}`}
                        className="text-foreground-muted underline-offset-4 hover:underline"
                      >
                        {k.label}
                      </a>
                    </li>
                  ))}
                </ol>
              ) : null}
            </li>
          ))}
        </ol>
      </nav>

      <Section id="market" number={n.market} title="Market overview">
        <Para text={view.market.overview} empty="No market overview was written." />
        {view.market.snapshot.length > 0 ? (
          <Table label="Market snapshot" stack>
            <TableHeader>
              <TableRow>
                <TableHead>Figure</TableHead>
                <TableHead className="text-right">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.market.snapshot.map((s) => (
                <TableRow key={s.label}>
                  <TableCell>{s.label}</TableCell>
                  <TableCell className="numeric text-right">
                    {s.value}
                    <Cites cites={s.cites} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </Section>

      <Section id="universe" number={n.universe} title="Universe considered">
        <p className={PROSE}>
          <span className="numeric">{view.universe.length}</span> tokens seen,{" "}
          <span className="numeric">{buyable}</span> buyable by this account,{" "}
          <span className="numeric">{researched}</span> researched in depth.
        </p>
        <Para text={view.universeSummary} />
        <UniverseTable view={view} />
      </Section>

      <Section id="tokens" number={n.tokens} title="Token analysis">
        {view.tokens.length === 0 ? (
          <Muted>This cycle researched no single token in depth.</Muted>
        ) : (
          <div className="flex flex-col gap-10">
            {view.tokens.map((t, i) => (
              <TokenReport key={`${t.symbol}-${t.chain}`} t={t} number={`${n.tokens}.${i + 1}`} />
            ))}
          </div>
        )}
      </Section>

      <Section id="skeptic" number={n.skeptic} title="Challenges and answers">
        {view.skeptic.length === 0 ? (
          <Muted>No objections were recorded.</Muted>
        ) : (
          <>
            <p className={PROSE}>
              A skeptic step challenged the findings; each objection and how the agent answered it.
            </p>
            <Table label="Challenges and answers" stack>
              <TableHeader>
                <TableRow>
                  <TableHead>Theme</TableHead>
                  <TableHead>Objection</TableHead>
                  <TableHead>Answer</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.skeptic.map((s, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-medium">{s.theme || "–"}</TableCell>
                    <TableCell>{s.objection}</TableCell>
                    <TableCell>{s.answer || "Not answered."}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </Section>

      <Section id="portfolio" number={n.portfolio} title="Recommended portfolio">
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
        ) : (
          <Muted>No positions are recommended.</Muted>
        )}
      </Section>

      <Section id="method" number={n.method} title="How this report was made">
        <p className={PROSE}>
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

      <Section id="sources" title="References">
        <References refs={view.references} />
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
