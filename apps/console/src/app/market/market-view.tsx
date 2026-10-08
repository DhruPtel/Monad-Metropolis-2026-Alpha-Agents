import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  type FigureWarningCode,
  SourcedFigure,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@alpha-agents/ui";
import type { ReactNode } from "react";

/**
 * The console's market view (P3-U2): the snapshot the agents read, each
 * source's freshness in the shared cache, and every plausibility warning in
 * one list. Ages are measured from the snapshot's own time, so the view never
 * depends on the browser's clock.
 */
export interface FigureJson {
  readonly value: number | null;
  readonly source: string;
  readonly asOf: string;
  readonly warnings: readonly { readonly code: FigureWarningCode; readonly message: string }[];
}
type PartJson<T> =
  | { readonly ok: true; readonly data: T; readonly cacheHit: boolean }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export interface MarketJson {
  readonly cacheHit: boolean;
  readonly snapshot: {
    readonly asOf: string;
    readonly prices: PartJson<
      readonly {
        asset: string;
        priceUsd: FigureJson;
        change24hPct: FigureJson;
        volume24hUsd: FigureJson;
        marketCapUsd: FigureJson;
      }[]
    >;
    readonly oracleVsPool: PartJson<{
      chainlinkMonUsd: FigureJson;
      poolMonUsdc: FigureJson;
      deviationBps: FigureJson;
      block: string;
    }>;
    readonly volatility: PartJson<{
      method: string;
      windows: Record<"24h" | "7d" | "30d", FigureJson & { returns: number }>;
    }>;
    readonly poolDepth: PartJson<{
      block: string;
      midPriceUsd: FigureJson;
      activeLiquidity: FigureJson;
      rows: readonly {
        sizeUsd: number;
        side: string;
        impactBps: FigureJson;
        impactExFeeBps: FigureJson;
      }[];
    }>;
    readonly chainTvl: PartJson<{ tvlUsd: FigureJson; change7dPct: FigureJson }>;
    readonly dexVolumes: PartJson<{
      total24hUsd: FigureJson;
      change1dPct: FigureJson;
      top: readonly { name: string; volume24hUsd: FigureJson }[];
    }>;
    readonly topProtocols: PartJson<
      readonly { name: string; category: string | null; tvlUsd: FigureJson }[]
    >;
    readonly topYields: PartJson<
      readonly {
        pool: string;
        project: string;
        symbol: string;
        tvlUsd: FigureJson;
        apyPct: FigureJson;
      }[]
    >;
  };
  readonly freshness: readonly {
    readonly source: string;
    readonly fetchedAt: string;
    readonly ageSeconds: number;
    readonly expiresInSeconds: number;
  }[];
  readonly upstreamCalls: Readonly<Record<string, number>>;
  readonly coinmarketcapCreditsToday: number;
}

const usd = (v: number | null, digits = 0) =>
  v === null
    ? null
    : `${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })} USD`;
const pct = (v: number | null, digits = 2) => (v === null ? null : `${v.toFixed(digits)}%`);
const bps = (v: number | null) => (v === null ? null : `${v.toFixed(1)} bps`);

export function ageText(fromIso: string, toIso: string): string {
  const s = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000));
  const n = (v: number, unit: string) => `${v} ${unit}${v === 1 ? "" : "s"} old`;
  if (s < 60) return n(s, "second");
  if (s < 3_600) return n(Math.round(s / 60), "minute");
  if (s < 172_800) return n(Math.round(s / 3_600), "hour");
  return n(Math.round(s / 86_400), "day");
}

/** Every figure in the snapshot that carries a warning, with where it is. */
export function warningsIn(
  snapshot: MarketJson["snapshot"],
): { path: string; figure: FigureJson }[] {
  const out: { path: string; figure: FigureJson }[] = [];
  const walk = (v: unknown, path: string) => {
    if (!v || typeof v !== "object") return;
    if ("source" in v && "warnings" in v && "asOf" in v) {
      const f = v as FigureJson;
      if (f.warnings.length > 0) out.push({ path, figure: f });
      return;
    }
    for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(snapshot, "");
  return out;
}

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

function PartError({ part }: { part: { ok: false; error: { code: string; message: string } } }) {
  return (
    <p role="alert" className="text-sm text-negative" data-testid="market-part-error">
      {part.error.code}: {part.error.message}
    </p>
  );
}

export function MarketView({ data }: { data: MarketJson }) {
  const s = data.snapshot;
  const at = s.asOf;
  const fig = (label: string, f: FigureJson, text: string | null) => (
    <SourcedFigure
      label={label}
      value={text}
      source={f.source}
      ageText={ageText(f.asOf, at)}
      warnings={f.warnings}
    />
  );
  const warnings = warningsIn(s);
  return (
    <div className="flex flex-col gap-6" data-testid="market-view">
      <div className="flex flex-wrap items-center gap-2 text-sm text-foreground-muted">
        <span>Snapshot taken {at}</span>
        <Badge tone={data.cacheHit ? "neutral" : "detail"}>
          {data.cacheHit ? "Served from cache" : "Fresh read"}
        </Badge>
        <span>CoinMarketCap credits today: {data.coinmarketcapCreditsToday}</span>
      </div>

      <Section title="Plausibility warnings">
        {warnings.length === 0 ? (
          <p className="text-sm text-foreground-muted">No figure carries a warning.</p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="market-warnings">
            {warnings.map((w) => (
              <li key={w.path} className="flex flex-col gap-1">
                <span className="numeric text-xs text-foreground">{w.path}</span>
                {w.figure.warnings.map((x) => (
                  <span key={x.code} className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge tone={x.code === "REFUSED_OUT_OF_RANGE" ? "negative" : "warning"}>
                      {x.code}
                    </Badge>
                    <span className="text-foreground-muted">{x.message}</span>
                  </span>
                ))}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Prices">
        {s.prices.ok ? (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {s.prices.data.flatMap((q) => [
              <div key={`${q.asset}-p`}>
                {fig(`${q.asset} price`, q.priceUsd, usd(q.priceUsd.value, 4))}
              </div>,
              <div key={`${q.asset}-c`}>
                {fig(`${q.asset} 24h change`, q.change24hPct, pct(q.change24hPct.value))}
              </div>,
              <div key={`${q.asset}-v`}>
                {fig(`${q.asset} 24h volume`, q.volume24hUsd, usd(q.volume24hUsd.value))}
              </div>,
              <div key={`${q.asset}-m`}>
                {fig(`${q.asset} market cap`, q.marketCapUsd, usd(q.marketCapUsd.value))}
              </div>,
            ])}
          </div>
        ) : (
          <PartError part={s.prices} />
        )}
      </Section>

      <Section title="Oracle against the pool (Monad mainnet)">
        {s.oracleVsPool.ok ? (
          <div className="grid gap-6 sm:grid-cols-3">
            {fig(
              "Chainlink MON/USD",
              s.oracleVsPool.data.chainlinkMonUsd,
              usd(s.oracleVsPool.data.chainlinkMonUsd.value, 5),
            )}
            {fig(
              "Uniswap v4 pool",
              s.oracleVsPool.data.poolMonUsdc,
              usd(s.oracleVsPool.data.poolMonUsdc.value, 5),
            )}
            {fig(
              "Pool from oracle",
              s.oracleVsPool.data.deviationBps,
              bps(s.oracleVsPool.data.deviationBps.value),
            )}
          </div>
        ) : (
          <PartError part={s.oracleVsPool} />
        )}
      </Section>

      <Section title="Volatility">
        {s.volatility.ok ? (
          <>
            <div className="grid gap-6 sm:grid-cols-3">
              {(["24h", "7d", "30d"] as const).map((w) => (
                <div key={w}>
                  {fig(
                    `${w} (${s.volatility.ok ? s.volatility.data.windows[w].returns : 0} returns)`,
                    (s.volatility.ok ? s.volatility.data.windows[w] : null) as FigureJson,
                    pct((s.volatility.ok ? s.volatility.data.windows[w].value : null) ?? null, 1),
                  )}
                </div>
              ))}
            </div>
            <p className="text-xs text-foreground-muted">{s.volatility.data.method}</p>
          </>
        ) : (
          <PartError part={s.volatility} />
        )}
      </Section>

      <Section title="Pool depth (Monad mainnet)">
        {s.poolDepth.ok ? (
          <Table label="Pool depth" stack>
            <TableHeader>
              <TableRow>
                <TableHead>Size</TableHead>
                <TableHead>Side</TableHead>
                <TableHead>Impact</TableHead>
                <TableHead>Without the fee</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {s.poolDepth.data.rows.map((r) => (
                <TableRow key={`${r.sizeUsd}-${r.side}`}>
                  <TableCell className="numeric">{usd(r.sizeUsd)}</TableCell>
                  <TableCell label="Side">
                    {r.side === "buy_mon" ? "Buy MON" : "Sell MON"}
                  </TableCell>
                  <TableCell label="Impact" className="numeric">
                    {bps(r.impactBps.value) ?? "Refused"}
                  </TableCell>
                  <TableCell label="Without the fee" className="numeric">
                    {bps(r.impactExFeeBps.value) ?? "Refused"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <PartError part={s.poolDepth} />
        )}
      </Section>

      <Section title="Monad TVL, DEX volume, protocols and yields">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {s.chainTvl.ok ? (
            <>
              {fig("Monad TVL", s.chainTvl.data.tvlUsd, usd(s.chainTvl.data.tvlUsd.value))}
              {fig(
                "TVL 7-day change",
                s.chainTvl.data.change7dPct,
                pct(s.chainTvl.data.change7dPct.value),
              )}
            </>
          ) : (
            <PartError part={s.chainTvl} />
          )}
          {s.dexVolumes.ok ? (
            <>
              {fig(
                "DEX volume 24h",
                s.dexVolumes.data.total24hUsd,
                usd(s.dexVolumes.data.total24hUsd.value),
              )}
              {fig(
                "DEX volume 1-day change",
                s.dexVolumes.data.change1dPct,
                pct(s.dexVolumes.data.change1dPct.value),
              )}
            </>
          ) : (
            <PartError part={s.dexVolumes} />
          )}
        </div>
        {s.topProtocols.ok ? (
          <Table label="Top protocols on Monad" stack>
            <TableHeader>
              <TableRow>
                <TableHead>Protocol</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>TVL on Monad</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {s.topProtocols.data.map((p) => (
                <TableRow key={p.name}>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell label="Category">{p.category ?? "Unknown"}</TableCell>
                  <TableCell label="TVL on Monad" className="numeric">
                    {usd(p.tvlUsd.value) ?? "Refused"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <PartError part={s.topProtocols} />
        )}
        {s.topYields.ok ? (
          <Table label="Top yields on Monad" stack>
            <TableHeader>
              <TableRow>
                <TableHead>Pool</TableHead>
                <TableHead>Project</TableHead>
                <TableHead>TVL</TableHead>
                <TableHead>APY</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {s.topYields.data.map((y) => (
                <TableRow key={y.pool}>
                  <TableCell className="font-medium">{y.symbol}</TableCell>
                  <TableCell label="Project">{y.project}</TableCell>
                  <TableCell label="TVL" className="numeric">
                    {usd(y.tvlUsd.value) ?? "Refused"}
                  </TableCell>
                  <TableCell label="APY" className="numeric">
                    {pct(y.apyPct.value) ?? "Not available"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <PartError part={s.topYields} />
        )}
      </Section>

      <Section title="Freshness of each source">
        <Table label="Freshness of each source" stack>
          <TableHeader>
            <TableRow>
              <TableHead>Source</TableHead>
              <TableHead>Fetched</TableHead>
              <TableHead>Age</TableHead>
              <TableHead>Refreshes in</TableHead>
              <TableHead>Upstream calls</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.freshness.map((f) => (
              <TableRow key={f.source}>
                <TableCell className="font-medium">{f.source}</TableCell>
                <TableCell label="Fetched" className="numeric">
                  {f.fetchedAt}
                </TableCell>
                <TableCell label="Age" className="numeric">
                  {f.ageSeconds} s
                </TableCell>
                <TableCell label="Refreshes in" className="numeric">
                  {f.expiresInSeconds} s
                </TableCell>
                <TableCell label="Upstream calls" className="numeric">
                  {data.upstreamCalls[f.source.split(" ")[0] ?? ""] ?? 0}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>
    </div>
  );
}
