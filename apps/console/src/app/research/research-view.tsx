import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@alpha-agents/ui";
import type { ReactNode } from "react";
import {
  LOOKUP_TOOLS,
  type ResearchCallJson,
  type ResearchJson,
  callSubject,
  usdc,
} from "./research";

export type { ResearchJson } from "./research";

/**
 * The console's research sources view (P3-U9): today's use of each paid
 * source against its cap, the recent calls across agents with their charge
 * and cache status, the X searches and Dune results the shared cache holds,
 * and the contract reads in the recent calls.
 */
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const cell = (v: number | string | null) =>
  v === null
    ? "None"
    : typeof v === "number"
      ? v.toLocaleString("en-US", { maximumFractionDigits: 2 })
      : v;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}

function Usage({ label, used, limit }: { label: string; used: number; limit: number }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs text-foreground-muted">{label}</span>
      <span className="numeric text-base font-semibold">
        {used} of {limit}
      </span>
    </div>
  );
}

function CallsTable({ label, calls }: { label: string; calls: readonly ResearchCallJson[] }) {
  return (
    <Table label={label} stack>
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead>Agent</TableHead>
          <TableHead>Tool</TableHead>
          <TableHead>Asked for</TableHead>
          <TableHead>Outcome</TableHead>
          <TableHead>Charge</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {calls.map((c) => (
          <TableRow key={c.callId}>
            <TableCell className="numeric">{c.at.replace("T", " ").slice(0, 19)}</TableCell>
            <TableCell label="Agent" className="numeric">
              {c.agentId}
            </TableCell>
            <TableCell label="Tool" className="font-medium">
              {c.tool}
            </TableCell>
            <TableCell label="Asked for" className="break-all">
              {callSubject(c)}
            </TableCell>
            <TableCell label="Outcome">
              <span className="flex flex-wrap items-center gap-2">
                <Badge
                  tone={
                    c.status === "succeeded"
                      ? "positive"
                      : c.status === "running"
                        ? "neutral"
                        : "negative"
                  }
                >
                  {c.status}
                </Badge>
                {c.errorCode ? (
                  <span className="text-xs text-foreground-muted">{c.errorCode}</span>
                ) : null}
                {c.cacheHit ? <Badge tone="detail">From cache</Badge> : null}
              </span>
            </TableCell>
            <TableCell label="Charge" className="numeric">
              {usdc(c.chargeUsdcE6)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function ResearchView({ data }: { data: ResearchJson }) {
  const search = data.recent.filter((c) => !LOOKUP_TOOLS.has(c.tool));
  const lookups = data.recent.filter((c) => LOOKUP_TOOLS.has(c.tool));
  const spent = data.recent.reduce((t, c) => t + Number(c.chargeUsdcE6), 0);
  return (
    <div className="flex flex-col gap-6" data-testid="research-view">
      <Section title="Today's use against the platform's caps">
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["X search", data.sources.x, false],
              ["Dune", data.sources.dune, true],
              ["Mainnet reads", data.sources.lookup, false],
            ] as const
          ).map(([label, on, optional]) => (
            <Badge key={label} tone={on ? "positive" : optional ? "neutral" : "warning"}>
              {label}: {on ? "configured" : optional ? "off (optional, no key)" : "not configured"}
            </Badge>
          ))}
        </div>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <Usage
            label="X posts read today"
            used={data.usage.xPostsRead}
            limit={data.usage.xPostsLimit}
          />
          <Usage
            label="Dune result reads today"
            used={data.usage.duneResultReads}
            limit={data.usage.duneResultReadsLimit}
          />
          <Usage
            label="Dune query runs today"
            used={data.usage.duneQueryRuns}
            limit={data.usage.duneQueryRunsLimit}
          />
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-xs text-foreground-muted">Charged in the calls below</span>
            <span className="numeric text-base font-semibold">{usdc(String(spent))}</span>
          </div>
        </div>
      </Section>

      <Section title="Recent X searches and Dune queries">
        {search.length === 0 ? (
          <p className="text-sm text-foreground-muted">
            No agent has searched X or run a Dune query yet.
          </p>
        ) : (
          <CallsTable label="Recent X searches and Dune queries" calls={search} />
        )}
      </Section>

      <Section title="X searches in the shared cache">
        {data.cachedX.length === 0 ? (
          <p className="text-sm text-foreground-muted">
            No X search is cached now. Posts leave the cache 15 minutes after they are read.
          </p>
        ) : (
          data.cachedX.map((s) => (
            <div
              key={`${s.topic}-${s.windowHours}`}
              className="flex flex-col gap-3"
              data-testid="cached-x"
            >
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{s.topic}</span>
                <span className="text-foreground-muted">
                  last {s.windowHours} h, read {s.searchedAt}, leaves the cache {s.expiresAt}
                </span>
                <Badge tone="warning">Untrusted web text</Badge>
              </div>
              <p className="numeric break-all text-xs text-foreground-muted">{s.query}</p>
              <ul className="flex flex-col gap-2">
                {s.posts.map((p) => (
                  <li key={p.url} className="flex flex-col gap-1 border-l-2 border-border pl-3">
                    <span className="text-sm">{p.text}</span>
                    <span className="numeric text-xs text-foreground-muted">
                      {p.createdAt}, {plural(p.likes, "like")}, {plural(p.reposts, "repost")},{" "}
                      {p.url}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </Section>

      <Section title="Dune results in the shared cache">
        {data.cachedDune.length === 0 ? (
          <p className="text-sm text-foreground-muted">No Dune result is cached now.</p>
        ) : (
          data.cachedDune.map((d) => (
            <div key={d.name} className="flex flex-col gap-3" data-testid="cached-dune">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{d.title}</span>
                <span className="text-foreground-muted">
                  computed by Dune {d.executedAt} ({d.ageHours} h old)
                  {d.executed ? ", run by the platform" : ""}
                </span>
                {d.warnings.map((w) => (
                  <Badge key={w.code} tone="warning">
                    {w.code}
                  </Badge>
                ))}
              </div>
              <Table label={d.title} stack>
                <TableHeader>
                  <TableRow>
                    {d.columns.map((c) => (
                      <TableHead key={c}>{c}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.rows.map((r, i) => (
                    <TableRow key={`${d.name}-${String(r[d.columns[0] ?? ""] ?? i)}-${i}`}>
                      {d.columns.map((c) => (
                        <TableCell key={c} label={c} className="numeric">
                          {cell(r[c] ?? null)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ))
        )}
      </Section>

      <Section title="Recent contract reads on Monad mainnet">
        {lookups.length === 0 ? (
          <p className="text-sm text-foreground-muted">No agent has read a contract yet.</p>
        ) : (
          <CallsTable label="Recent contract reads" calls={lookups} />
        )}
      </Section>
    </div>
  );
}
