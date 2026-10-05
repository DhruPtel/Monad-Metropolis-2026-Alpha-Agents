"use client";

import { type EnvironmentId, ENVIRONMENTS } from "@alpha-agents/config";
import {
  SPECIES,
  TIER_IDS,
  type Tier,
  slotsFor,
  speciesAsset,
  speciesByIndex,
} from "@alpha-agents/domain";
import {
  Button,
  Card,
  MintPanel,
  type MintPanelAgent,
  SectionLabel,
  Skeleton,
  StatBar,
  Tag,
  TierCard,
} from "@alpha-agents/ui";
import { RotateCcw } from "lucide-react";
import { type ReactNode, useCallback } from "react";
import { chainName, useWalletSession } from "@/auth/session";
import { agentNftDeployment } from "@/agent/agent-nft";
import { mintPageView } from "@/agent/mint-page-state";
import { type SupplySummary, type TierSupply, formatCount, formatOdds } from "@/agent/supply";
import { useMint } from "@/agent/use-agents";
import { useMintSupply, useWalletMint } from "@/agent/use-mint-page";

const TIER_NAME = { base: "Base", medium: "Medium", pro: "Pro" } as const;
const bps = (part: number, whole: number) => (whole > 0 ? (part / whole) * 10_000 : 0);

/** The agent as the panel shows it, from its onchain species index (0 before reveal). */
function panelAgent(agent: { id: bigint; species: number }): MintPanelAgent {
  if (agent.species === 0) return { id: agent.id, tier: null, speciesName: null, image: null };
  const species = speciesByIndex(agent.species);
  return {
    id: agent.id,
    tier: species.tier,
    speciesName: species.name,
    image: speciesAsset(agent.species).image,
  };
}

function TierCards({ supply }: { supply: SupplySummary | null }) {
  return (
    <div className="grid items-start gap-4 lg:grid-cols-3">
      {TIER_IDS.map((tier: Tier) => {
        const t: TierSupply | undefined = supply?.tiers.find((x) => x.tier === tier);
        const species = SPECIES.filter((s) => s.tier === tier);
        const total = species.reduce((sum, s) => sum + s.count, 0);
        return (
          <TierCard
            key={tier}
            tier={tier}
            slots={slotsFor(tier)}
            total={formatCount(t?.total ?? total)}
            remaining={t ? formatCount(t.remaining) : null}
            remainingBps={t ? bps(t.remaining, t.total) : 0}
            odds={t ? formatOdds(t.odds) : null}
            soldOut={t?.remaining === 0}
            species={species.map((s) => ({
              name: s.name,
              image: speciesAsset(s.index).image,
              total: s.count,
              remaining: t?.species.find((x) => x.species.index === s.index)?.remaining ?? null,
            }))}
          />
        );
      })}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-foreground-muted">{label}</dt>
      <dd className="numeric text-lg font-semibold">{children}</dd>
    </div>
  );
}

function SupplyCard({
  supply,
  failed,
  onRetry,
}: {
  supply: SupplySummary | null;
  failed: boolean;
  onRetry: () => void;
}) {
  return (
    <Card role="region" aria-label="Supply" className="gap-4">
      <SectionLabel as="h2">Supply</SectionLabel>
      {supply ? (
        <>
          <StatBar
            label="Minted"
            value={`${formatCount(supply.minted)} of ${formatCount(supply.maxSupply)}`}
            fillBps={bps(supply.minted, supply.maxSupply)}
          />
          <dl className="grid grid-cols-2 gap-4">
            <Fact label="Left to mint">{formatCount(supply.leftToMint)}</Fact>
            <Fact label="Waiting for reveal">{formatCount(supply.awaitingReveal)}</Fact>
          </dl>
          <p className="text-xs text-foreground-muted">
            A tier&apos;s remaining count falls when an agent is revealed, so it still includes
            minted agents waiting for their reveal. The chance per mint is a tier&apos;s remaining
            count over every tier&apos;s.
          </p>
        </>
      ) : failed ? null : (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-10 w-2/3" />
        </div>
      )}
      {failed ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="status" className="text-sm text-negative">
            {supply
              ? "Could not refresh the supply from the chain: showing the last reading."
              : "Could not read the supply from the chain."}
          </p>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            <RotateCcw aria-hidden /> Try again
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

/**
 * The mint page (P1-U10): the supply and the odds per tier, read from
 * AgentNFT, and the wallet's mint through P1-U11's mint flow, which checks
 * the wallet's network before anything is requested or sent.
 */
export function MintPage({ environment }: { environment: EnvironmentId }) {
  const wallet = useWalletSession();
  const deployed = agentNftDeployment(environment) !== null;
  const supply = useMintSupply(environment);
  const walletMint = useWalletMint(environment);
  const refreshSupply = supply.refresh;
  const refreshWallet = walletMint.refresh;
  const onChange = useCallback(() => {
    refreshSupply();
    refreshWallet();
  }, [refreshSupply, refreshWallet]);
  const { progress, mint, reset } = useMint(environment, onChange);
  const envLabel = ENVIRONMENTS[environment].label;

  const summary =
    supply.status === "ready"
      ? supply.supply
      : supply.status === "error"
        ? (supply.last ?? null)
        : null;
  const view = mintPageView({
    deployed,
    walletState: wallet.state,
    walletMint: walletMint.read,
    soldOut:
      supply.status === "ready"
        ? supply.supply.soldOut
        : supply.status === "error"
          ? "unknown"
          : "loading",
    progress,
  });

  const revealedAs =
    progress.species !== undefined
      ? `${TIER_NAME[speciesByIndex(progress.species).tier]} · ${speciesByIndex(progress.species).name}`
      : undefined;
  const agentId = view.agent?.id;

  return (
    <div className="flex flex-col gap-6" data-testid="mint-page">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex max-w-2xl flex-col gap-2">
          <h1 className="text-2xl font-semibold">Mint an agent</h1>
          <p className="text-sm text-foreground-muted">
            Every agent is free to mint: you pay only gas, one per wallet. Its tier and species are
            drawn at reveal from what is left, so the tiers below show your chances, not a choice.
          </p>
        </div>
        <Tag size="md">{envLabel}</Tag>
      </header>

      <div className="grid items-start gap-4 lg:grid-cols-12">
        <div className="lg:order-2 lg:col-span-5">
          <MintPanel
            state={view.state}
            mint={{
              state: progress.state,
              agentId: progress.agentId,
              revealedAs,
              message: progress.message,
              onMint: wallet.ready ? mint : undefined,
              onDismiss: reset,
            }}
            agent={view.agent ? panelAgent(view.agent) : undefined}
            agentHref={agentId !== undefined ? `/configure?agent=${agentId.toString()}` : undefined}
            message={`AgentNFT is not deployed on ${envLabel} yet.`}
            targetNetwork={wallet.target.name}
            walletNetwork={chainName(wallet.chainId, wallet.target)}
            maxSupply={summary ? formatCount(summary.maxSupply) : undefined}
            revealNote={
              environment === "local" ? (
                <>
                  On the local fork, reveal it with{" "}
                  <span className="numeric">pnpm agent-nft:local reveal</span>.
                </>
              ) : undefined
            }
            onConnect={wallet.configured ? wallet.connect : undefined}
            onRetry={refreshWallet}
          />
        </div>
        <div className="lg:order-1 lg:col-span-7">
          {deployed ? (
            <SupplyCard
              supply={summary}
              failed={supply.status === "error"}
              onRetry={refreshSupply}
            />
          ) : null}
        </div>
      </div>

      {deployed ? (
        <section aria-labelledby="tiers-title" className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 id="tiers-title" className="text-lg font-semibold">
              Tiers
            </h2>
            <p className="text-sm text-foreground-muted">
              The chance per mint is for the next agent minted. Pro one-of-ones are marked.
            </p>
          </div>
          <TierCards supply={summary} />
        </section>
      ) : null}
    </div>
  );
}
