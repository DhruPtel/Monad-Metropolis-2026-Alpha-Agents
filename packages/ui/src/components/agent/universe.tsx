import { Telescope } from "lucide-react";
import { cn } from "../../lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Tag, type TagTone } from "../ui/tag";

/**
 * The universe a research cycle considered (F-U12): every token the agent
 * saw, its lane, whether this account could buy it and why not, which it
 * researched under which theme, and why each was dropped or proposed.
 */
export interface UniverseRowView {
  readonly token: string;
  readonly symbol: string;
  readonly priceClass: "USDC" | "F" | "A";
  readonly lane: "core" | "screened" | null;
  readonly status: "listed" | "sell_only" | "delisted" | null;
  readonly buyable: boolean;
  readonly whyNot: string | null;
  readonly held: boolean;
  readonly themeCode: string | null;
  readonly themeReason: string | null;
  readonly researched: boolean;
  readonly proposed: boolean;
  readonly droppedReason: string | null;
}

export interface UniverseView {
  readonly cycleId: string;
  readonly kind: string;
  readonly at: string;
  readonly rows: readonly UniverseRowView[];
}

const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const laneTone = (lane: UniverseRowView["lane"]): TagTone =>
  lane === "core" ? "accent" : lane === "screened" ? "legendary" : "neutral";

function outcomeOf(r: UniverseRowView): { text: string; tone: TagTone } {
  if (r.proposed) return { text: "proposed", tone: "accent" };
  if (r.droppedReason) return { text: "not proposed", tone: "warning" };
  if (r.researched) return { text: "researched", tone: "neutral" };
  return { text: "seen", tone: "neutral" };
}

function UniversePanel({
  universe,
  className,
}: {
  universe: UniverseView | null;
  className?: string;
}) {
  const rows = universe?.rows ?? [];
  const buyable = rows.filter((r) => r.buyable).length;
  const researched = rows.filter((r) => r.researched).length;
  return (
    <Card className={className} data-testid="universe-panel" data-rows={rows.length}>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <Telescope className="size-4 text-foreground-muted" aria-hidden="true" />
            Universe considered
          </CardTitle>
          {universe ? (
            <div className="flex flex-wrap gap-1.5">
              <Tag tone="neutral">{rows.length} seen</Tag>
              <Tag tone="accent">{buyable} buyable</Tag>
              <Tag tone="legendary">{researched} researched</Tag>
            </div>
          ) : null}
        </div>
        <CardDescription>
          {universe
            ? `Every token the agent could see in its ${universe.kind.toLowerCase().replace(/_/g, " ")} cycle of ${when(universe.at)}: whether this account could buy it and why not, which it researched, and why each was proposed or not.`
            : "The first cycle records every token the agent saw, what it could buy, what it researched and why each was dropped."}
        </CardDescription>
      </CardHeader>
      {universe ? (
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-foreground-muted">No token was seen.</p>
          ) : (
            <Table label="Universe considered">
              <TableHeader>
                <TableRow>
                  <TableHead>Token</TableHead>
                  <TableHead>Lane</TableHead>
                  <TableHead>Buyable</TableHead>
                  <TableHead>Researched</TableHead>
                  <TableHead>Outcome</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const outcome = outcomeOf(r);
                  return (
                    <TableRow key={r.token} data-token={r.token} data-buyable={r.buyable}>
                      <TableCell>
                        <span className="font-medium">{r.symbol}</span>
                        <span className="ml-1 text-xs text-foreground-muted">{r.priceClass}</span>
                        {r.held ? <Tag className="ml-1">held</Tag> : null}
                      </TableCell>
                      <TableCell>
                        <Tag tone={laneTone(r.lane)}>{r.lane ?? "not registered"}</Tag>
                        {r.status && r.status !== "listed" ? (
                          <Tag tone="warning" className="ml-1">
                            {r.status.replace(/_/g, " ")}
                          </Tag>
                        ) : null}
                      </TableCell>
                      <TableCell className={cn(!r.buyable && "text-foreground-muted")}>
                        {r.buyable ? "yes" : `no: ${r.whyNot ?? "no reason recorded"}`}
                      </TableCell>
                      <TableCell className="text-foreground-muted">
                        {r.themeCode ? (
                          <>
                            <span className="font-mono text-xs text-foreground">{r.themeCode}</span>
                            {r.themeReason ? ` · ${r.themeReason}` : ""}
                          </>
                        ) : (
                          "no theme"
                        )}
                      </TableCell>
                      <TableCell>
                        <Tag tone={outcome.tone}>{outcome.text}</Tag>
                        {r.droppedReason ? (
                          <span className="ml-1 text-xs text-foreground-muted">
                            {r.droppedReason}
                          </span>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      ) : null}
    </Card>
  );
}

export { UniversePanel };
