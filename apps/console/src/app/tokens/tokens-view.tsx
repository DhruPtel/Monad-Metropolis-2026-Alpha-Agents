import {
  AddressDisplay,
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
import Link from "next/link";
import type { ReactNode } from "react";
import {
  type CheckJson,
  DEX_LABEL,
  type PoolJson,
  type RunJson,
  SCREEN_STATE_LABEL,
  type ScreenJson,
  type TokenRowJson,
  type TokensJson,
  age,
  evidenceText,
  feePct,
  screenState,
  screenTone,
  usd,
} from "./tokens";

/**
 * The console's token registry views (F-U1): the counts and the last
 * discovery, the token table with class, liquidity, pool age and latest
 * screen, and one token's screen with every check's reason and evidence, its
 * pools and its screen history.
 */
const when = (iso: string) => iso.replace("T", " ").slice(0, 16);

export function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <CardTitle>{title}</CardTitle>
        {action}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs text-foreground-muted">{label}</span>
      <span className="numeric text-base font-semibold">{value}</span>
    </div>
  );
}

export function Summary({ data }: { data: TokensJson }) {
  const c = data.counts;
  const last: RunJson | undefined = data.runs[0];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <Badge tone={data.configured.discovery ? "positive" : "warning"}>
          Discovery: {data.configured.discovery ? "configured" : "not configured"}
        </Badge>
        <Badge tone={data.configured.screen ? "positive" : "warning"}>
          Screens: {data.configured.screen ? "on a fork of the latest block" : "not configured"}
        </Badge>
      </div>
      <div className="grid gap-6 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Tokens" value={c.tokens} />
        <Stat label="Class F (feed)" value={c.classF} />
        <Stat label="Class A (no feed)" value={c.classA} />
        <Stat label="Passing screen" value={c.passing} />
        <Stat label="Refused" value={c.refused} />
        <Stat label="Pools (routable)" value={`${c.pools} (${c.routable})`} />
      </div>
      {last ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-foreground-muted">
            Last discovery {when(last.startedAt)} UTC:{" "}
            {last.status === "completed"
              ? `${last.tokensSeen} tokens in ${last.poolsSeen} pools, ${last.newPools} new.`
              : last.status === "failed"
                ? `failed (${last.error ?? "no reason"}).`
                : "running."}
          </p>
          <ul className="flex flex-col gap-1" aria-label="Discovery sources">
            {Object.entries(last.sources).map(([name, src]) => (
              <li key={name} className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
                <Badge tone={src.ok ? "positive" : "warning"}>
                  {name}: {src.ok ? "ok" : "unavailable"}
                </Badge>
                <span className="min-w-0 break-words text-foreground-muted">{src.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-foreground-muted">No discovery has run yet.</p>
      )}
    </div>
  );
}

function ClassBadge({ t }: { t: TokenRowJson }) {
  return t.priceClass === "F" ? (
    <Badge tone="detail" title={(t.feed?.legs ?? []).map((l) => l.description).join(" x ")}>
      F
    </Badge>
  ) : (
    <Badge tone="neutral">A</Badge>
  );
}

export function TokensTable({ tokens, nowMs }: { tokens: readonly TokenRowJson[]; nowMs: number }) {
  return (
    <Table label="Tokens in the registry" stack>
      <TableHeader>
        <TableRow>
          <TableHead>Token</TableHead>
          <TableHead>Class</TableHead>
          <TableHead>Routable liquidity</TableHead>
          <TableHead>Volume 24h</TableHead>
          <TableHead>Oldest pool</TableHead>
          <TableHead>Screen</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tokens.map((t) => {
          const state = screenState(t.screen);
          return (
            <TableRow key={t.address}>
              <TableCell>
                <Link
                  href={`/tokens?token=${t.address}`}
                  className="flex min-w-0 flex-col rounded-sm outline-none is-focus:focus-ring"
                >
                  <span className="font-medium">{t.symbol}</span>
                  <span className="truncate text-xs text-foreground-muted">{t.name}</span>
                </Link>
              </TableCell>
              <TableCell label="Class">
                <ClassBadge t={t} />
              </TableCell>
              <TableCell label="Routable liquidity" className="numeric">
                {usd(t.liquidityUsd)}
              </TableCell>
              <TableCell label="Volume 24h" className="numeric">
                {usd(t.volume24hUsd)}
              </TableCell>
              <TableCell label="Oldest pool" className="numeric">
                {age(t.oldestPoolAt, nowMs)}
              </TableCell>
              <TableCell label="Screen">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone={screenTone(state)}>{SCREEN_STATE_LABEL[state]}</Badge>
                  {t.screen ? (
                    <span className="numeric text-xs text-foreground-muted">
                      {when(t.screen.screenedAt)}
                    </span>
                  ) : null}
                </span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function TokenFacts({ t, nowMs }: { t: TokenRowJson; nowMs: number }) {
  const cmc = t.listings.coinmarketcap;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <ClassBadge t={t} />
        <span className="text-sm text-foreground-muted">
          {t.priceClass === "F"
            ? "Priced by a verified Chainlink feed"
            : "No verified feed: class A"}
        </span>
        <AddressDisplay address={t.address} label={`${t.symbol} token address`} />
      </div>
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Deepest routable pool" value={usd(t.liquidityUsd)} />
        <Stat label="Volume 24h" value={usd(t.volume24hUsd)} />
        <Stat label="Oldest pool" value={age(t.oldestPoolAt, nowMs)} />
        <Stat label="Decimals" value={t.decimals} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Badge tone={t.listings.coingecko ? "positive" : "neutral"}>
          CoinGecko:{" "}
          {t.listings.coingecko
            ? `listed at this address (${t.listings.coingecko.id})`
            : "not listed"}
        </Badge>
        <Badge tone={cmc ? "positive" : "neutral"}>
          CoinMarketCap:{" "}
          {cmc
            ? `listed (${cmc.match === "address" ? "by address" : "by symbol and name"}${cmc.rank ? `, rank ${cmc.rank}` : ""})`
            : "not matched"}
        </Badge>
      </div>
      {t.feed?.legs?.length ? (
        <Table label="Price feed">
          <TableHeader>
            <TableRow>
              <TableHead>Feed</TableHead>
              <TableHead>Heartbeat</TableHead>
              <TableHead>State</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {t.feed.legs.map((l) => (
              <TableRow key={l.description}>
                <TableCell className="font-medium">{l.description}</TableCell>
                <TableCell className="numeric">{Math.round(l.heartbeatSeconds / 60)} min</TableCell>
                <TableCell>
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone={l.ok ? "positive" : "negative"}>{l.ok ? "Fresh" : "Failed"}</Badge>
                    <span className="text-xs text-foreground-muted">{l.reason}</span>
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </div>
  );
}

function Evidence({ evidence }: { evidence: CheckJson["evidence"] }) {
  const entries = Object.entries(evidence);
  if (entries.length === 0) return <span className="text-foreground-muted">None</span>;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-foreground-muted">{k}</dt>
          <dd className="numeric min-w-0 break-all">{evidenceText(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ScreenResult({
  s,
  labels,
}: {
  s: ScreenJson;
  labels: Readonly<Record<string, string>>;
}) {
  return (
    <div className="flex flex-col gap-4" data-testid="screen-result">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={screenTone(s.verdict)}>{s.verdict === "passed" ? "Passed" : "Refused"}</Badge>
        <span className="text-sm text-foreground-muted">
          Screened {when(s.createdAt)} UTC by {s.requestedBy}
          {s.forkBlock ? ` at block ${s.forkBlock.toLocaleString("en-US")}` : ""}, expires{" "}
          {when(s.expiresAt)} UTC
          {s.route?.dex
            ? `, routed through ${DEX_LABEL[s.route.dex as PoolJson["dex"]] ?? s.route.dex} against ${s.route.base}`
            : ""}
          .
        </span>
      </div>
      <Table label="Screen checks" stack>
        <TableHeader>
          <TableRow>
            <TableHead>Check</TableHead>
            <TableHead>Result</TableHead>
            <TableHead>Reason</TableHead>
            <TableHead>Evidence</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {s.checks.map((c) => (
            <TableRow key={c.code}>
              <TableCell className="font-medium">{labels[c.code] ?? c.code}</TableCell>
              <TableCell label="Result">
                <Badge tone={screenTone(c.status)}>
                  {c.status === "pass" ? "Pass" : c.status === "fail" ? "Fail" : "Skipped"}
                </Badge>
              </TableCell>
              <TableCell label="Reason">{c.reason}</TableCell>
              <TableCell label="Evidence">
                <Evidence evidence={c.evidence} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function PoolsTable({ pools }: { pools: readonly PoolJson[] }) {
  return (
    <Table label="Pools holding the token" stack>
      <TableHeader>
        <TableRow>
          <TableHead>Pair</TableHead>
          <TableHead>Venue</TableHead>
          <TableHead>Fee</TableHead>
          <TableHead>Liquidity</TableHead>
          <TableHead>Age</TableHead>
          <TableHead>Route</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {pools.map((p) => (
          <TableRow key={p.pool}>
            <TableCell className="font-medium">{p.pair}</TableCell>
            <TableCell label="Venue">{DEX_LABEL[p.dex]}</TableCell>
            <TableCell label="Fee" className="numeric">
              {feePct(p.fee)}
            </TableCell>
            <TableCell label="Liquidity" className="numeric">
              {usd(p.liquidityUsd)}
            </TableCell>
            <TableCell label="Age" className="numeric">
              {p.ageHours === null
                ? "Unknown"
                : p.ageHours < 72
                  ? `${p.ageHours} hours`
                  : `${Math.floor(p.ageHours / 24)} days`}
            </TableCell>
            <TableCell label="Route">
              <span className="flex flex-col gap-1">
                <Badge tone={p.routable ? "positive" : "neutral"}>
                  {p.routable ? "Routable" : "Not routed"}
                </Badge>
                <span className="text-xs text-foreground-muted">{p.routeNote}</span>
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function HistoryTable({ screens }: { screens: readonly ScreenJson[] }) {
  return (
    <Table label="Screen history" stack>
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead>Verdict</TableHead>
          <TableHead>Failed checks</TableHead>
          <TableHead>Asked by</TableHead>
          <TableHead>Took</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {screens.map((s) => (
          <TableRow key={s.screenId}>
            <TableCell className="numeric">{when(s.createdAt)}</TableCell>
            <TableCell label="Verdict">
              <Badge tone={screenTone(s.verdict)}>
                {s.verdict === "passed" ? "Passed" : "Refused"}
              </Badge>
            </TableCell>
            <TableCell label="Failed checks">
              {s.checks
                .filter((c) => c.status === "fail")
                .map((c) => c.code)
                .join(", ") || "None"}
            </TableCell>
            <TableCell label="Asked by">{s.requestedBy}</TableCell>
            <TableCell label="Took" className="numeric">
              {(s.durationMs / 1000).toFixed(1)} s
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
