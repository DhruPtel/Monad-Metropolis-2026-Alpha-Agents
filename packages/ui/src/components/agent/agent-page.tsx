"use client";

import { ChevronDown, ChevronLeft, ChevronRight, FileText } from "lucide-react";
import { type ComponentType, type ReactNode, useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tag } from "../ui/tag";
import { type ArtTier, SpeciesArt } from "./species-art";

/**
 * UI-FAST: the agent pages' shared parts. One clear tab bar across every
 * agent page, the header with the agent and its goal, the agent's card on
 * My Agents, and the Trading tab's plan stepper, trade list and one-line
 * explanations. Presentational: the app gives every word and figure.
 */

type LinkComponent = ComponentType<{
  href: string;
  className?: string;
  children?: ReactNode;
  "aria-current"?: "page" | undefined;
}>;

const TIER_NAME: Readonly<Record<ArtTier, string>> = { base: "Base", medium: "Medium", pro: "Pro" };
const TIER_TONE = { base: "neutral", medium: "rare", pro: "legendary" } as const;

export interface PageTab {
  readonly id: string;
  readonly label: string;
  readonly href: string;
}

/** A row of tabs that reads as tabs: an underline under the one you are on. */
function PageTabs({
  tabs,
  active,
  label,
  end,
  linkAs,
  className,
}: {
  tabs: readonly PageTab[];
  /** What sits at the row's right end, such as the agent's goal. */
  end?: ReactNode;
  /** The id of the tab you are on; null when the page is none of them. */
  active: string | null;
  label: string;
  linkAs?: LinkComponent;
  className?: string;
}) {
  const LinkAs = linkAs ?? "a";
  return (
    <div
      className={cn(
        "flex flex-wrap items-end justify-between gap-x-4 border-b border-border",
        className,
      )}
      data-testid="page-tabs"
    >
      <nav aria-label={label} className="min-w-0">
        <ul className="-mb-px flex gap-1 overflow-x-auto">
          {tabs.map((t) => {
            const on = t.id === active;
            return (
              <li key={t.id}>
                <LinkAs
                  href={t.href}
                  aria-current={on ? "page" : undefined}
                  className={cn(
                    "block border-b-2 px-3 py-2 text-sm whitespace-nowrap outline-none transition-colors is-focus:focus-ring",
                    on
                      ? "border-primary font-medium text-foreground"
                      : "border-transparent text-foreground-muted hover:border-border-strong hover:text-foreground",
                  )}
                >
                  {t.label}
                </LinkAs>
              </li>
            );
          })}
        </ul>
      </nav>
      {end ? <div className="flex items-center gap-2 pb-1.5 text-sm">{end}</div> : null}
    </div>
  );
}

/** The tier's border on the agent's art: gold for Pro, the rare colour for Medium, plain for Base. */
const TIER_BORDER: Readonly<Record<ArtTier, string>> = {
  base: "border-border-strong",
  medium: "border-rare",
  pro: "border-detail",
};

/**
 * The agent at the top of its pages, compact: its art large in its tier's
 * border, and beside it, from the top, its name, tier and species on one line
 * with its status under them.
 */
function AgentPageHeader({
  name,
  image,
  tier,
  speciesName,
  status,
  className,
}: {
  name: string;
  image: string | null;
  tier: ArtTier | null;
  speciesName: string | null;
  /** The agent's status pill (Ready, Running), when known. */
  status?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex items-start gap-4", className)} data-testid="agent-header">
      <div
        className={cn(
          "w-24 shrink-0 overflow-hidden rounded-lg border-2 sm:w-32",
          tier ? TIER_BORDER[tier] : "border-dashed border-primary-muted",
        )}
        data-testid="agent-art"
        data-tier={tier ?? "unrevealed"}
      >
        <SpeciesArt
          compact
          image={image}
          speciesName={speciesName}
          tier={tier}
          className="w-full"
        />
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">{name}</h1>
          {tier ? (
            <Tag tone={TIER_TONE[tier]} size="md">
              {TIER_NAME[tier]}
            </Tag>
          ) : (
            <Tag size="md">Unrevealed</Tag>
          )}
          {speciesName ? (
            <span className="text-sm text-foreground-muted">{speciesName}</span>
          ) : null}
        </div>
        {status ? <div data-testid="agent-status">{status}</div> : null}
      </div>
    </header>
  );
}

export interface AgentListCardView {
  readonly id: string;
  readonly name: string;
  readonly image: string | null;
  readonly tier: ArtTier | null;
  readonly speciesName: string | null;
  /** "3 skills", or "–" while unread. */
  readonly skills: string;
  /** "6.00 USDC", or "–" while unread. */
  readonly value: string;
  /** The goal's word, or null for none. */
  readonly goal: string | null;
  readonly href: string;
}

/**
 * One agent on My Agents: the whole card opens the agent's page; Set goal,
 * when the agent has none, sits above that link as its own button.
 */
function AgentListCard({
  agent,
  setGoal,
  linkAs,
  className,
}: {
  agent: AgentListCardView;
  /** The Set goal button, shown when the agent has no goal. */
  setGoal?: ReactNode;
  linkAs?: LinkComponent;
  className?: string;
}) {
  const LinkAs = linkAs ?? "a";
  return (
    <article
      className={cn(
        "relative flex items-center gap-3 rounded-md border border-border p-3 transition-colors hover:border-primary-muted has-[a:focus-visible]:focus-ring",
        className,
      )}
      data-testid="agent-list-card"
      data-agent={agent.id}
    >
      <SpeciesArt
        compact
        image={agent.image}
        speciesName={agent.speciesName}
        tier={agent.tier}
        className="w-12 shrink-0"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <LinkAs
            href={agent.href}
            className="truncate text-sm font-semibold outline-none after:absolute after:inset-0 after:rounded-md"
          >
            {agent.name}
          </LinkAs>
          {agent.tier ? (
            <Tag tone={TIER_TONE[agent.tier]} size="sm">
              {TIER_NAME[agent.tier]}
            </Tag>
          ) : (
            <Tag size="sm">Unrevealed</Tag>
          )}
        </div>
        <span className="text-xs text-foreground-muted">
          {agent.skills} · {agent.goal ?? "No goal"}
        </span>
      </div>
      <span className="numeric text-sm font-semibold">{agent.value}</span>
      {agent.goal === null && setGoal ? <span className="relative z-10">{setGoal}</span> : null}
    </article>
  );
}

/** A token's mark until real logos exist: its symbol's first letters in a circle. */
function TokenMark({ symbol, className }: { symbol: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface-raised text-2xs font-semibold",
        className,
      )}
      data-testid="token-mark"
    >
      {symbol.replace(/^W(?=[A-Z]{2,})/, "").slice(0, 3)}
    </span>
  );
}

export interface PlanMoveView {
  readonly side: "Buy" | "Sell" | "Hold";
  readonly symbol: string;
  /** "Target 20% (now 0%)". */
  readonly amount: string;
  /** One line from the research. */
  readonly reason: string;
}

/**
 * The agent's plan, one move per card: Back and Next step through them, and
 * the last card asks to approve or decline the whole plan. A decided or
 * informational plan steps the same way without the decision.
 */
function PlanStepper({
  moves,
  heading,
  reportHref,
  decision,
  status,
  linkAs,
  className,
}: {
  moves: readonly PlanMoveView[];
  /** "The plan waits for your approval", "Applied 2026-10-12". */
  heading: string;
  reportHref?: string | null;
  /** Approve and decline, only while the plan waits for the owner. */
  decision?: { approve: ReactNode; decline: ReactNode } | null;
  status?: ReactNode;
  linkAs?: LinkComponent;
  className?: string;
}) {
  const LinkAs = linkAs ?? "a";
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [moves.length, heading]);
  const move = moves[i];
  const last = i >= moves.length - 1;
  const tone = { Buy: "positive", Sell: "negative", Hold: "neutral" } as const;
  return (
    <section
      className={cn("flex flex-col gap-3", className)}
      data-testid="plan-stepper"
      aria-label="The agent's plan"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{heading}</p>
        {moves.length > 0 ? (
          <span className="numeric text-xs text-foreground-muted" data-testid="plan-step">
            Move {i + 1} of {moves.length}
          </span>
        ) : null}
      </div>
      {move ? (
        <article
          className="flex flex-col gap-3 rounded-md border border-border p-4"
          data-testid="plan-move"
          data-side={move.side}
        >
          <div className="flex items-center gap-3">
            <Badge tone={tone[move.side]}>{move.side}</Badge>
            <TokenMark symbol={move.symbol} />
            <span className="text-base font-semibold">{move.symbol}</span>
            <span className="numeric ml-auto text-sm">{move.amount}</span>
          </div>
          <p className="text-sm text-foreground-muted">{move.reason}</p>
          {reportHref ? (
            <LinkAs
              href={reportHref}
              className="inline-flex w-fit items-center gap-1 text-xs text-primary underline-offset-4 outline-none hover:underline is-focus:focus-ring"
            >
              <FileText aria-hidden className="size-3.5" /> View report
            </LinkAs>
          ) : null}
        </article>
      ) : (
        <p className="text-sm text-foreground-muted">The plan moves nothing.</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" disabled={i === 0} onClick={() => setI(i - 1)}>
          <ChevronLeft aria-hidden /> Back
        </Button>
        {!last ? (
          <Button variant="secondary" size="sm" onClick={() => setI(i + 1)} data-testid="plan-next">
            Next <ChevronRight aria-hidden />
          </Button>
        ) : decision ? (
          <>
            {decision.approve}
            {decision.decline}
          </>
        ) : null}
      </div>
      {status}
    </section>
  );
}

export interface TradeRowView {
  readonly id: string;
  readonly symbol: string;
  readonly side: "Buy" | "Sell";
  /** "2026-10-13 01:28". */
  readonly date: string;
  /** "0.02 USDC → 0.01998 WMON". */
  readonly amount: string;
  /** "Settled", "Failed", "Waiting for you". */
  readonly result: string;
  readonly resultTone: "positive" | "negative" | "neutral" | "warning";
}

/** Past trades, one dense row each: token, side, date, amount, result. */
function TradeList({
  trades,
  empty,
  className,
}: {
  trades: readonly TradeRowView[];
  empty: string;
  className?: string;
}) {
  if (trades.length === 0)
    return <p className={cn("text-sm text-foreground-muted", className)}>{empty}</p>;
  return (
    <ul
      className={cn(
        "flex flex-col divide-y divide-border rounded-md border border-border",
        className,
      )}
      data-testid="trade-list"
    >
      {trades.map((t) => (
        <li
          key={t.id}
          className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-0.5 px-3 py-2 text-xs sm:grid-cols-[auto_minmax(0,1fr)_auto_auto_minmax(0,2fr)_auto]"
          data-testid="trade-row"
        >
          <TokenMark symbol={t.symbol} className="size-6" />
          <span className="font-medium">{t.symbol}</span>
          <Badge
            tone={t.side === "Buy" ? "positive" : "negative"}
            className="justify-self-start sm:justify-self-auto"
          >
            {t.side}
          </Badge>
          <span className="numeric col-span-2 text-foreground-muted sm:col-span-1">{t.date}</span>
          <span className="numeric truncate sm:text-left">{t.amount}</span>
          <Badge tone={t.resultTone}>{t.result}</Badge>
        </li>
      ))}
    </ul>
  );
}

/** One short line that opens to the full explanation. */
function ExpandableLine({
  summary,
  children,
  className,
}: {
  summary: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details
      className={cn("group rounded-md border border-border", className)}
      data-testid="expandable-line"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm outline-none is-focus:focus-ring [&::-webkit-details-marker]:hidden">
        <span className="flex-1">{summary}</span>
        <ChevronDown
          aria-hidden
          className="size-4 text-foreground-muted transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="border-t border-border px-3 py-3">{children}</div>
    </details>
  );
}

/** A narrow panel for a page's right column: a title, its main figure, then whatever follows. */
function SidePanel({
  title,
  figure,
  note,
  actions,
  children,
  testId,
  emphasis = false,
  className,
}: {
  title: string;
  /** The panel's one number, already written. */
  figure?: ReactNode;
  /** The column's main panel: more room and a larger figure. */
  emphasis?: boolean;
  note?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <section
      aria-label={title}
      className={cn(
        "flex flex-col rounded-md border border-border",
        emphasis ? "gap-4 p-5" : "gap-2 p-3",
        className,
      )}
      data-testid={testId}
    >
      <h2 className="text-xs font-medium tracking-wide text-foreground-muted uppercase">{title}</h2>
      {figure !== undefined ? (
        <div className={cn("numeric font-semibold", emphasis ? "text-xl" : "text-base")}>
          {figure}
        </div>
      ) : null}
      {note ? <div className="text-xs text-foreground-muted">{note}</div> : null}
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      {children}
    </section>
  );
}

/** One line that asks for attention and leads to where it is handled. */
function LinkLine({
  href,
  children,
  action,
  linkAs,
  className,
}: {
  href: string;
  children: ReactNode;
  /** The link's words at the line's end, such as "Review". */
  action: string;
  linkAs?: LinkComponent;
  className?: string;
}) {
  const LinkAs = linkAs ?? "a";
  return (
    <LinkAs
      href={href}
      className={cn(
        "flex items-center gap-3 rounded-md border border-primary-muted px-3 py-2 text-sm outline-none transition-colors hover:border-primary is-focus:focus-ring",
        className,
      )}
    >
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full bg-primary motion-safe:animate-status-pulse"
      />
      <span className="flex-1">{children}</span>
      <span className="flex items-center gap-1 text-primary">
        {action} <ChevronRight aria-hidden className="size-4" />
      </span>
    </LinkAs>
  );
}

export {
  AgentListCard,
  LinkLine,
  SidePanel,
  AgentPageHeader,
  ExpandableLine,
  PageTabs,
  PlanStepper,
  TokenMark,
  TradeList,
};
