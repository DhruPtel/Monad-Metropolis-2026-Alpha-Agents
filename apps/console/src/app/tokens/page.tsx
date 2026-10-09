import { Button, EmptyState } from "@alpha-agents/ui";
import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import { PanelHeader } from "@/components/panel-header";
import { orchestratorUrl } from "../agents/extension";
import { DiscoverNowButton, ScreenNowButton } from "./token-controls";
import {
  HistoryTable,
  PoolsTable,
  ScreenResult,
  Section,
  Summary,
  TokenFacts,
  TokensTable,
} from "./tokens-view";
import { type TokenDetailJson, type TokensJson, isAddress } from "./tokens";

export const dynamic = "force-dynamic";

/** F-U1: the token registry, read through the orchestrator; reading fetches nothing upstream. */
async function read<T>(path: string): Promise<{ data: T } | { error: string }> {
  try {
    const res = await fetch(`${orchestratorUrl()}${path}`, { cache: "no-store" });
    if (res.status === 503)
      return { error: "The token registry is not configured in the orchestrator." };
    if (res.status === 404) return { error: "That token is not in the registry." };
    if (!res.ok) return { error: `The orchestrator answered ${res.status}.` };
    return { data: (await res.json()) as T };
  } catch {
    return { error: "The orchestrator is not running (pnpm dev:all starts it)." };
  }
}

const CLASSES = [
  ["all", "All classes"],
  ["F", "Class F"],
  ["A", "Class A"],
] as const;
const SCREENS = [
  ["all", "Any screen"],
  ["passed", "Passed"],
  ["refused", "Refused"],
  ["unscreened", "Not screened"],
  ["expired", "Expired"],
] as const;

function Filters({ cls, screen }: { cls: string; screen: string }) {
  const href = (c: string, s: string) => {
    const q = new URLSearchParams();
    if (c !== "all") q.set("class", c);
    if (s !== "all") q.set("screen", s);
    const qs = q.toString();
    return qs ? `/tokens?${qs}` : "/tokens";
  };
  return (
    <div className="flex flex-col gap-2">
      <nav aria-label="Price class" className="flex flex-wrap gap-2">
        {CLASSES.map(([value, label]) => (
          <Button key={value} asChild size="sm" variant={cls === value ? "primary" : "secondary"}>
            <Link href={href(value, screen)} aria-current={cls === value ? "page" : undefined}>
              {label}
            </Link>
          </Button>
        ))}
      </nav>
      <nav aria-label="Screen" className="flex flex-wrap gap-2">
        {SCREENS.map(([value, label]) => (
          <Button
            key={value}
            asChild
            size="sm"
            variant={screen === value ? "primary" : "secondary"}
          >
            <Link href={href(cls, value)} aria-current={screen === value ? "page" : undefined}>
              {label}
            </Link>
          </Button>
        ))}
      </nav>
    </div>
  );
}

export default async function TokensPage({
  searchParams,
}: {
  searchParams: Promise<{ class?: string; screen?: string; token?: string }>;
}) {
  const params = await searchParams;
  const header = (
    <PanelHeader
      title="Tokens"
      description="The tokens on Monad worth considering: each token with a pool of real liquidity on Uniswap v3, Uniswap v4 or PancakeSwap v3, confirmed on mainnet; its price class (F for a verified Chainlink feed, A for none); and its latest safety screen, a simulated buy, transfer and sell through the real route on a fork of the latest block, plus the contract, market, look-alike and GoPlus checks. No token can be bought without a passing screen under six hours old."
    />
  );

  if (isAddress(params.token)) {
    const d = await read<TokenDetailJson>(`/v1/tokens/${params.token}`);
    return (
      <div className="flex flex-col gap-6">
        {header}
        <div>
          <Button asChild size="sm" variant="ghost">
            <Link href="/tokens">Back to all tokens</Link>
          </Button>
        </div>
        {"data" in d ? (
          <>
            <Section
              title={`${d.data.token.symbol}: ${d.data.token.name}`}
              action={
                d.data.canAct ? (
                  <ScreenNowButton address={d.data.token.address} symbol={d.data.token.symbol} />
                ) : null
              }
            >
              <TokenFacts t={d.data.token} nowMs={Date.parse(d.data.token.lastSeenAt)} />
            </Section>
            <Section title="Latest screen">
              {d.data.screens[0] ? (
                <ScreenResult s={d.data.screens[0]} labels={d.data.labels} />
              ) : (
                <p className="text-sm text-foreground-muted">
                  Not screened yet. The platform screens the deepest tokens every ten minutes.
                </p>
              )}
            </Section>
            <Section title="Pools">
              <PoolsTable pools={d.data.pools} />
            </Section>
            {d.data.screens.length > 1 ? (
              <Section title="Screen history">
                <HistoryTable screens={d.data.screens} />
              </Section>
            ) : null}
          </>
        ) : (
          <EmptyState icon={ShieldCheck} title="No token" description={d.error} />
        )}
      </div>
    );
  }

  const cls = params.class === "F" || params.class === "A" ? params.class : "all";
  const screen = SCREENS.some(([v]) => v === params.screen) ? (params.screen as string) : "all";
  const q = new URLSearchParams();
  if (cls !== "all") q.set("priceClass", cls);
  if (screen !== "all") q.set("screen", screen);
  const r = await read<TokensJson>(`/v1/tokens${q.size ? `?${q.toString()}` : ""}`);
  if ("error" in r)
    return (
      <div className="flex flex-col gap-6">
        {header}
        <EmptyState icon={ShieldCheck} title="No token registry" description={r.error} />
      </div>
    );
  const nowMs = Date.parse(r.data.runs[0]?.startedAt ?? "") || Date.now();
  return (
    <div className="flex flex-col gap-6">
      {header}
      <Section title="Registry" action={r.data.canAct ? <DiscoverNowButton /> : null}>
        <Summary data={r.data} />
      </Section>
      <Section title="Tokens">
        <Filters cls={cls} screen={screen} />
        {r.data.tokens.length > 0 ? (
          <TokensTable tokens={r.data.tokens} nowMs={nowMs} />
        ) : (
          <p className="text-sm text-foreground-muted">No token matches these filters.</p>
        )}
      </Section>
    </div>
  );
}
