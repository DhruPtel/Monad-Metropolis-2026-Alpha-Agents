"use client";

import { type EnvironmentId, ENVIRONMENTS } from "@alpha-agents/config";
import {
  Button,
  EmptyState,
  type FlowAgentNode,
  type HomeAgentCardView,
  HomeHero,
  type HomeStatView,
  type HomeVaultView,
  MintCallout,
  MoneyFlowMap,
  NoVaults,
  SectionLabel,
  Skeleton,
  VaultCards,
  VaultList,
  YourAgentsStrip,
} from "@alpha-agents/ui";
import { PlugZap, Wallet } from "lucide-react";
import Link from "next/link";
import { useWalletSession } from "@/auth/session";
import { type HomeAgentView, type HomeView, ago, countText, usdcText } from "@/agent/home-view";
import { useHome } from "@/agent/use-home";

/** How many agents the map draws before folding the rest into "+N more". */
const MAP_AGENTS = 8;
/** How many vaults get a card; the list below holds every one. */
const TOP_VAULTS = 3;

const LEDE =
  "AI agents you own as NFTs, researching and trading onchain inside hard limits our contracts enforce.";

/** A failed onchain read is never shown as zero: "–" when nothing was read, "at least" when some was. */
const partialUsdc = (e6: bigint, partial: boolean) =>
  !partial ? usdcText(e6) : e6 === 0n ? "–" : `at least ${usdcText(e6)}`;

function stats(v: HomeView, network: string): HomeStatView[] {
  const s = v.stats;
  return [
    {
      label: "Agents active today",
      value: `${s.activeToday} of ${s.agents}`,
      meaning: `Agents with any recorded activity in the last 24 hours, of every agent minted on ${network}.`,
    },
    {
      label: "Vaults",
      value: s.vaults.toLocaleString("en-US"),
      meaning: "Strategy vaults open for deposits.",
    },
    {
      label: "Total value",
      value: partialUsdc(s.totalValueE6, s.valuePartial),
      meaning: `Every agent's trading account and vault, valued onchain in USDC${s.valuePartial ? "; some accounts could not be read and are left out" : ""}.`,
    },
    {
      label: "Research runs today",
      value: countText(s.researchToday),
      meaning: "Scans and research cycles finished in the last 24 hours.",
    },
    {
      label: "Trades settled",
      value: countText(s.tradesSettled),
      meaning: "Trades settled onchain, from each agent's latest activity.",
    },
  ];
}

function flowAgents(v: HomeView): { nodes: FlowAgentNode[]; more: number } {
  const ranked = [...v.agents].sort(
    (a, b) =>
      Number((b.depositedE6 ?? 0n) - (a.depositedE6 ?? 0n)) ||
      b.research.n - a.research.n ||
      Number(a.id - b.id),
  );
  return {
    nodes: ranked.slice(0, MAP_AGENTS).map((a) => ({
      id: a.id.toString(),
      label: `#${a.id.toString()}`,
      image: a.image,
      depositText:
        a.depositedE6 === null
          ? "unread"
          : a.depositedE6 > 0n
            ? usdcText(a.depositedE6)
            : "no deposit",
      deposit: Number(a.depositedE6 ?? 0n) / 1e6,
      research: a.research.n,
      live: a.live,
    })),
    more: Math.max(0, ranked.length - MAP_AGENTS),
  };
}

function vaultView(a: HomeAgentView): HomeVaultView {
  return {
    id: a.id.toString(),
    name: a.name,
    image: a.image,
    tier: a.tier,
    speciesName: a.speciesName,
    value: usdcText(a.vault?.navE6 ?? null),
    returnText: a.vault?.returnText ?? null,
    research: countText(a.research),
    trades: countText(a.trades),
    live: a.live,
    href: `/agents/${a.id.toString()}/vault`,
  };
}

function HomeBody({
  view,
  at,
  environment,
}: {
  view: HomeView;
  at: number;
  environment: EnvironmentId;
}) {
  const wallet = useWalletSession();
  const network = ENVIRONMENTS[environment].label;
  const { nodes, more } = flowAgents(view);
  const sum = (pick: (a: HomeAgentView) => { n: number; atLeast: boolean }) =>
    countText({
      n: view.agents.reduce((s, a) => s + pick(a).n, 0),
      atLeast: view.agents.some((a) => pick(a).atLeast),
    });
  const deposited = view.agents.reduce((s, a) => s + (a.depositedE6 ?? 0n), 0n);
  const latest = view.latest[0];
  const mine: HomeAgentCardView[] = wallet.address
    ? view.agents
        .filter((a) => a.owner.toLowerCase() === wallet.address?.toLowerCase())
        .map((a) => ({
          id: a.id.toString(),
          name: a.name,
          image: a.image,
          tier: a.tier,
          speciesName: a.speciesName,
          goal: a.goal,
          value: usdcText(a.valueE6),
          lastResearch: ago(a.lastResearchAt, at),
          href: `/agents/${a.id.toString()}/portfolio`,
          live: a.live,
        }))
    : [];
  const mintLink = (
    <Button asChild>
      <Link href="/mint">Mint an agent</Link>
    </Button>
  );

  return (
    <>
      <HomeHero title="Vivarium" lede={LEDE} stats={stats(view, network)} />

      <section aria-labelledby="home-flow" className="flex flex-col gap-3">
        <SectionLabel as="h2" id="home-flow">
          Where the money goes
        </SectionLabel>
        <MoneyFlowMap
          deposits={{
            label: "Deposits",
            value: partialUsdc(deposited, view.stats.valuePartial),
          }}
          research={{ label: "Research", value: `${sum((a) => a.research)} runs` }}
          plans={{ label: "Plans", value: sum((a) => a.plans) }}
          portfolios={{
            label: "Portfolios",
            value: partialUsdc(view.stats.totalValueE6, view.stats.valuePartial),
          }}
          agents={nodes}
          moreAgents={more}
          planCount={view.agents.reduce((s, a) => s + a.plans.n, 0)}
          tradeCount={view.agents.reduce((s, a) => s + a.trades.n, 0)}
          caption={
            latest ? (
              <span data-testid="flow-latest">
                Latest, {ago(latest.at, at)}: {latest.text}
              </span>
            ) : (
              "No activity recorded yet."
            )
          }
        />
      </section>

      <section aria-labelledby="home-yours" className="flex flex-col gap-3">
        <SectionLabel as="h2" id="home-yours">
          Your agents
        </SectionLabel>
        {!wallet.ready ? (
          <MintCallout
            title="Own an agent"
            description="Free to mint: you pay only gas. Connect a wallet to see yours here."
            action={
              wallet.state === "logged-out" ? (
                <span className="flex gap-2">
                  <Button variant="secondary" onClick={wallet.connect}>
                    <Wallet aria-hidden /> Connect
                  </Button>
                  {mintLink}
                </span>
              ) : (
                mintLink
              )
            }
          />
        ) : mine.length === 0 ? (
          <MintCallout
            title="No agent in this wallet yet"
            description="Free to mint: you pay only gas, up to two per wallet."
            action={mintLink}
          />
        ) : (
          <YourAgentsStrip agents={mine} linkAs={Link} />
        )}
      </section>

      <section aria-labelledby="home-vaults" className="flex flex-col gap-3">
        <SectionLabel as="h2" id="home-vaults">
          Top vaults
        </SectionLabel>
        {view.vaults.length === 0 ? (
          <NoVaults />
        ) : (
          <>
            <VaultCards vaults={view.vaults.slice(0, TOP_VAULTS).map(vaultView)} linkAs={Link} />
            <SectionLabel as="h3" className="pt-2">
              All vaults
            </SectionLabel>
            <VaultList vaults={view.vaults.map(vaultView)} linkAs={Link} />
          </>
        )}
      </section>
    </>
  );
}

/** UI-FAST: the home page: the hero, the money-flow map, your agents, and the vaults. */
export function HomePage({ environment }: { environment: EnvironmentId }) {
  const home = useHome(environment);
  return (
    <div className="flex flex-col gap-10" data-testid="home-page">
      {home.state === "ready" ? (
        <HomeBody view={home.view} at={home.at} environment={environment} />
      ) : home.state === "loading" ? (
        <>
          <Skeleton className="h-32" />
          <Skeleton className="h-80" />
        </>
      ) : (
        <EmptyState
          icon={PlugZap}
          title={
            home.state === "not-deployed" ? "Not deployed here yet" : "Could not load the page"
          }
          description={
            home.state === "not-deployed"
              ? `AgentNFT is not deployed on ${ENVIRONMENTS[environment].label} yet.`
              : home.state === "error"
                ? home.message
                : ""
          }
        />
      )}
    </div>
  );
}
