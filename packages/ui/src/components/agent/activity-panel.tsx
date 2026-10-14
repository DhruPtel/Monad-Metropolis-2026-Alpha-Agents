"use client";

import { ArrowUpRight, FileText } from "lucide-react";
import { type ComponentType, type ReactNode, useState } from "react";
import { cn } from "../../lib/utils";
import { Badge, type BadgeTone } from "../ui/badge";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";

export type ActivityFilter = "all" | "trades" | "deposits" | "research";

/** One thing the agent or its owners did (2026-10-13), as the shared Activity panel lists it. */
export interface ActivityRowView {
  readonly id: string;
  readonly type: "Deposit" | "Withdrawal" | "Trade" | "Research" | "Credits" | "Plan";
  /** Which filter tab it belongs to besides All. */
  readonly filter: Exclude<ActivityFilter, "all">;
  readonly title: string;
  /** "5.00 USDC"; null where the row has no amount. */
  readonly amount: string | null;
  /** "2026-10-13 23:59" */
  readonly time: string;
  readonly link: {
    readonly href: string;
    readonly label: string;
    readonly external: boolean;
  } | null;
}

const TYPE_TONE: Readonly<Record<ActivityRowView["type"], BadgeTone>> = {
  Deposit: "positive",
  Withdrawal: "warning",
  Trade: "detail",
  Research: "neutral",
  Credits: "neutral",
  Plan: "detail",
};

const FILTERS: readonly { value: ActivityFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "trades", label: "Trades" },
  { value: "deposits", label: "Deposits" },
  { value: "research", label: "Research" },
];

type LinkComponent = ComponentType<{ href: string; className?: string; children?: ReactNode }>;
const LINK_CLASS =
  "inline-flex items-center gap-1 text-xs text-foreground underline underline-offset-2 hover:text-primary";

/**
 * Everything the agent and its owners do, newest first, in one list
 * (2026-10-13): deposits, withdrawals, trades, research runs with their cost,
 * credit top-ups and plan approvals, each with its type, amount, time and
 * link; tabs filter to trades, deposits or research.
 */
function ActivityPanel({
  rows,
  empty,
  note,
  linkAs,
  className,
}: {
  rows: readonly ActivityRowView[];
  empty: string;
  /** One plain line under the list, such as what only the owner sees. */
  note?: string | null;
  linkAs?: LinkComponent;
  className?: string;
}) {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const LinkAs = linkAs ?? "a";
  const shown = filter === "all" ? rows : rows.filter((r) => r.filter === filter);
  return (
    <div className={cn("flex flex-col gap-3", className)} data-testid="activity-panel">
      <Tabs value={filter} onValueChange={(v) => setFilter(v as ActivityFilter)}>
        <TabsList aria-label="Filter activity">
          {FILTERS.map((f) => (
            <TabsTrigger key={f.value} value={f.value} data-testid={`activity-filter-${f.value}`}>
              {f.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {shown.length === 0 ? (
        <p className="text-sm text-foreground-muted">{empty}</p>
      ) : (
        <ol className="flex flex-col divide-y divide-border rounded-md border border-border">
          {shown.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
              data-testid="activity-row"
              data-type={r.type}
            >
              <Badge tone={TYPE_TONE[r.type]}>{r.type}</Badge>
              <span className="min-w-0 flex-1 truncate" title={r.title}>
                {r.title}
              </span>
              {r.amount ? <span className="numeric font-medium">{r.amount}</span> : null}
              <span className="numeric text-xs text-foreground-subtle">{r.time}</span>
              {r.link ? (
                r.link.external ? (
                  <a
                    href={r.link.href}
                    target="_blank"
                    rel="noreferrer noopener"
                    className={LINK_CLASS}
                  >
                    {r.link.label} <ArrowUpRight aria-hidden className="size-3" />
                  </a>
                ) : (
                  <LinkAs href={r.link.href} className={LINK_CLASS}>
                    <FileText aria-hidden className="size-3" /> {r.link.label}
                  </LinkAs>
                )
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {note ? <p className="text-xs text-foreground-muted">{note}</p> : null}
    </div>
  );
}

export { ActivityPanel };
