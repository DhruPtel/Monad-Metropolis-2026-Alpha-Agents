"use client";

import { type EnvironmentId, ENVIRONMENTS } from "@alpha-agents/config";
import {
  AgentTable,
  Button,
  type AgentRowView,
  EmptyState,
  type FlowPillView,
  FlowPills,
  HeroVisualSlot,
  HomeHero,
  type HomeRankedView,
  type HomeStatView,
  RankedCards,
  SectionLabel,
  Skeleton,
  Wordmark,
} from "@alpha-agents/ui";
import { PlugZap } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import {
  type AgentFilter,
  type HomeAgentView,
  type HomeView,
  ageText,
  countText,
  sortAgents,
  topCards,
  usdcText,
} from "@/agent/home-view";
import { useHome } from "@/agent/use-home";
import { HeroVisual } from "./hero-visual";

const FILTERS: readonly { id: AgentFilter; label: string }[] = [
  { id: "trending", label: "Trending" },
  { id: "top", label: "Top" },
  { id: "gainers", label: "Gainers" },
  { id: "new", label: "New" },
];

const LEDE =
  "Mint an AI agent as an NFT, set its goal and fund it. It researches the market and proposes a plan for your approval. It trades only within hard limits our contracts enforce onchain. You can withdraw your money at any time.";

/** A failed onchain read is never shown as zero: "–" when nothing was read, "at least" when some was. */
const partialUsdc = (e6: bigint, partial: boolean) =>
  !partial ? usdcText(e6) : e6 === 0n ? "–" : `at least ${usdcText(e6)}`;

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function stats(v: HomeView, network: string): HomeStatView[] {
  const s = v.stats;
  const list: HomeStatView[] = [
    {
      label: plural(s.agents, "agent", "agents"),
      value: s.agents.toLocaleString("en-US"),
      meaning: `Every agent minted on ${network}.`,
    },
    {
      label: "active today",
      value: s.activeToday.toLocaleString("en-US"),
      meaning: "Agents with any recorded activity in the last 24 hours.",
    },
    {
      label: "managed",
      value: partialUsdc(s.totalValueE6, s.valuePartial),
      meaning: `Every agent's trading account and vault, valued onchain in USDC${s.valuePartial ? "; some accounts could not be read and are left out" : ""}.`,
    },
    {
      label: plural(s.researchToday.n, "research run today", "research runs today"),
      value: countText(s.researchToday),
      meaning: "Scans and research cycles finished in the last 24 hours.",
    },
    {
      label: plural(s.tradesSettled.n, "trade settled", "trades settled"),
      value: countText(s.tradesSettled),
      meaning: "Trades settled onchain, from each agent's latest activity.",
    },
  ];
  if (s.vaults > 0)
    list.splice(2, 0, {
      label: plural(s.vaults, "vault", "vaults"),
      value: s.vaults.toLocaleString("en-US"),
      meaning: "Strategy vaults open for deposits.",
    });
  return list;
}

function vaultCard(a: HomeAgentView): HomeRankedView {
  return {
    id: `vault-${a.id.toString()}`,
    name: a.name,
    image: a.image,
    tier: a.tier,
    speciesName: a.speciesName,
    value: usdcText(a.vault?.navE6 ?? null),
    returnText: a.vault?.returnText ?? null,
    research: countText(a.research),
    trades: countText(a.trades),
    kindLabel: "Vault",
    live: a.live,
    href: `/agents/${a.id.toString()}/vault`,
  };
}

/** An agent and its trading account as a card, linking to its portfolio. */
function agentCard(a: HomeAgentView): HomeRankedView {
  return {
    id: `agent-${a.id.toString()}`,
    name: a.name,
    image: a.image,
    tier: a.tier,
    speciesName: a.speciesName,
    value: usdcText(a.valueE6),
    returnText: a.accountReturnText,
    returnEmpty: a.valueE6 === null ? "–" : "No deposits",
    research: countText(a.research),
    trades: countText(a.trades),
    goal: a.goal,
    kindLabel: "Agent",
    live: a.live,
    href: `/agents/${a.id.toString()}`,
  };
}

function agentRow(a: HomeAgentView, at: number): AgentRowView {
  return {
    id: a.id.toString(),
    name: a.name,
    image: a.image,
    tier: a.tier,
    speciesName: a.speciesName,
    value: usdcText(a.valueE6),
    returnText: a.accountReturnText,
    returnEmpty: a.valueE6 === null ? "–" : "No deposits",
    research: countText(a.research),
    trades: countText(a.trades),
    age: ageText(a.mintedAt, at),
    live: a.live,
    href: `/agents/${a.id.toString()}`,
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
  const [filter, setFilter] = useState<AgentFilter>("trending");
  const network = ENVIRONMENTS[environment].label;
  const sum = (pick: (a: HomeAgentView) => { n: number; atLeast: boolean }) =>
    countText({
      n: view.agents.reduce((s, a) => s + pick(a).n, 0),
      atLeast: view.agents.some((a) => pick(a).atLeast),
    });
  const deposited = view.agents.reduce((s, a) => s + (a.depositedE6 ?? 0n), 0n);
  const research = view.agents.reduce((s, a) => s + a.research.n, 0);
  const plans = view.agents.reduce((s, a) => s + a.plans.n, 0);
  const trades = view.agents.reduce((s, a) => s + a.trades.n, 0);
  const flowSteps: FlowPillView[] = [
    {
      label: "Deposits",
      value: partialUsdc(deposited, view.stats.valuePartial),
      active: false,
    },
    { label: "Research", value: sum((a) => a.research), active: research > 0 },
    { label: "Plans", value: sum((a) => a.plans), active: plans > 0 },
    {
      label: "Portfolios",
      value: partialUsdc(view.stats.totalValueE6, view.stats.valuePartial),
      active: trades > 0,
    },
  ];
  const cards = topCards(view.agents).map((c) =>
    c.kind === "vault" ? vaultCard(c.agent) : agentCard(c.agent),
  );
  const vaultCount = view.stats.vaults;

  return (
    <>
      <HomeHero
        // 2026-10-14: the viewport less the nav and the Top agents row, so the first screen is
        // the hero and that row; at least 26rem on short screens.
        className="min-h-[max(26rem,calc(100svh-21rem))]"
        title={<Wordmark src="/brand/vivarium-wordmark.webp" className="h-7" />}
        lede={LEDE}
        stats={stats(view, network)}
        below={<FlowPills steps={flowSteps} />}
        action={
          <Button asChild data-testid="hero-mint">
            <Link href="/mint">Mint an agent</Link>
          </Button>
        }
        background={
          // 2026-10-14: the hero scene as atmosphere: darkened overall (more on phones, where the
          // text spans the width), a light shade on the left, focused up on the fish, and a short
          // fade into the page. HomeHero puts the text in a panel.
          <>
            {/* On wide screens, a little smaller than the hero and shifted right, its left edge
                fading into the page: the snake stays in view on the right, and the mantis stands
                between the text panel and the logo. */}
            <div className="absolute inset-y-0 left-0 w-full lg:left-[10%] lg:w-[95%] lg:[mask-image:linear-gradient(to_right,transparent,rgb(0_0_0/0.15)_12%,rgb(0_0_0/0.55)_25%,black_40%)]">
              <Image
                src="/images/home/hero-scene.webp"
                alt=""
                fill
                priority
                sizes="100vw"
                quality={70}
                className="object-cover object-[50%_45%]"
              />
            </div>
            <div className="absolute inset-0 bg-background/80 lg:bg-background/62" />
            <div className="absolute inset-0 hidden bg-linear-to-r from-background from-5% via-background/70 via-20% to-transparent to-45% lg:block" />
            <div className="absolute inset-x-0 bottom-0 h-10 bg-linear-to-b from-transparent to-background" />
          </>
        }
        visual={
          // 2026-10-14: no taller than the text column and level with its top, so the model
          // sits beside the title and description and never past the hero.
          <HeroVisualSlot className="max-w-100 lg:self-start">
            <HeroVisual />
          </HeroVisualSlot>
        }
      />

      <section aria-labelledby="home-top" className="flex flex-col gap-3">
        <SectionLabel as="h2" id="home-top">
          {vaultCount >= 3 ? "Top vaults" : vaultCount > 0 ? "Top vaults and agents" : "Top agents"}
        </SectionLabel>
        {cards.length === 0 ? (
          <p className="text-xs text-foreground-muted">No agents yet.</p>
        ) : (
          <RankedCards items={cards} linkAs={Link} />
        )}
      </section>

      <section aria-labelledby="home-all" className="flex flex-col gap-2">
        <SectionLabel as="h2" id="home-all">
          All agents
        </SectionLabel>
        <AgentTable
          filters={FILTERS}
          filter={filter}
          onFilter={(id) => setFilter(id as AgentFilter)}
          rows={sortAgents(view.agents, filter).map((a) => agentRow(a, at))}
          linkAs={Link}
        />
      </section>
    </>
  );
}

/** UI-FAST: the home page: the quiet hero with its flow pills, your agents, and the vaults or agents. */
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
