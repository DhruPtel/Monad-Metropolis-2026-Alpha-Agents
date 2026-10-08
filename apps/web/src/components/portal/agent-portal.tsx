"use client";

import { type EnvironmentId, ENVIRONMENTS } from "@alpha-agents/config";
import { slotsFor, speciesAsset, speciesByIndex } from "@alpha-agents/domain";
import {
  AddressDisplay,
  AgentCard,
  Button,
  EmptyState,
  MintButton,
  PendingAgentNotice,
  SectionLabel,
  SlotHex,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tag,
} from "@alpha-agents/ui";
import { Boxes, RotateCcw, Wallet } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { type ReactNode, useMemo, useState } from "react";
import { useWalletSession } from "@/auth/session";
import type { AgentView } from "@/agent/chain";
import { useMint, useOwnedAgents } from "@/agent/use-agents";
import { AgentStage } from "@/components/viewer/agent-stage";

const TIER_NAME = { base: "Base", medium: "Medium", pro: "Pro" } as const;

/** What a revealed agent is, from its onchain species index. */
function describe(agent: AgentView) {
  if (agent.species === 0) return null;
  const species = speciesByIndex(agent.species);
  return { species, asset: speciesAsset(agent.species), slots: slotsFor(species.tier) };
}

/** A centred note over the viewer: the gate before an agent can be shown. */
function Gate({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex max-w-sm flex-col items-center gap-3 rounded-lg border bg-surface/90 p-5 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children}
    </div>
  );
}

/** The agent's skill slots by tier, empty until skills exist (P6). */
function SlotStrip({ slots }: { slots: number }) {
  return (
    <ul aria-label="Skill slots" className="flex flex-wrap items-center gap-3">
      {Array.from({ length: slots }, (_, i) => (
        <li key={i} className="flex items-center gap-2">
          <SlotHex index={i} state="empty" />
          <span className="font-mono text-2xs text-foreground-muted">
            Slot {i + 1}
            <br />
            empty
          </span>
        </li>
      ))}
    </ul>
  );
}

function SkillsPanel() {
  return (
    <EmptyState
      icon={Boxes}
      title="No skills yet"
      description="Skills arrive with the marketplace. Equipped skills will appear in your agent's slots."
    />
  );
}

/**
 * The agent portal on the configure page (P1-U11): the prototype's layout of
 * header, skill inventory, viewer and agent overview, rebuilt on packages/ui,
 * with only real data from AgentNFT. Without a model the agent shows in 2D.
 */
export function AgentPortal({ environment }: { environment: EnvironmentId }) {
  const wallet = useWalletSession();
  const owned = useOwnedAgents(environment);
  const { progress, mint, reset } = useMint(environment, owned.refresh);
  const params = useSearchParams();
  const [tab, setTab] = useState("agent");
  const envLabel = ENVIRONMENTS[environment].label;

  const requested = params.get("agent");
  const selected = useMemo(() => {
    if (owned.agents.length === 0) return null;
    if (requested && /^\d+$/.test(requested)) {
      return owned.agents.find((a) => a.id === BigInt(requested)) ?? null;
    }
    return owned.agents[0] ?? null;
  }, [owned.agents, requested]);
  const info = selected ? describe(selected) : null;

  const revealedAs =
    progress.species !== undefined
      ? `${TIER_NAME[speciesByIndex(progress.species).tier]} · ${speciesByIndex(progress.species).name}`
      : undefined;
  const mintButton = (
    <MintButton
      state={progress.state}
      agentId={progress.agentId}
      revealedAs={revealedAs}
      message={progress.message}
      onMint={wallet.ready ? mint : undefined}
      onDismiss={reset}
    />
  );

  let overlay: ReactNode = null;
  if (!wallet.ready) {
    overlay = (
      <Gate title="Connect your wallet to see your agent.">
        {wallet.state === "logged-out" ? (
          <Button variant="secondary" onClick={wallet.connect}>
            <Wallet aria-hidden /> Connect wallet
          </Button>
        ) : null}
      </Gate>
    );
  } else if (owned.status === "not-deployed") {
    overlay = <Gate title={`AgentNFT is not deployed on ${envLabel} yet.`} />;
  } else if (owned.status === "loading") {
    overlay = <Gate title="Reading your agents from the chain" />;
  } else if (owned.status === "error" && owned.agents.length === 0) {
    overlay = (
      <Gate title="Could not read your agents from the chain.">
        <Button variant="secondary" onClick={owned.refresh}>
          <RotateCcw aria-hidden /> Try again
        </Button>
      </Gate>
    );
  } else if (requested && !selected && (owned.agents.length > 0 || owned.hasMinted)) {
    overlay = <Gate title={`Agent #${requested} is not in this wallet.`} />;
  } else if (!selected && owned.hasMinted) {
    // AgentNFT says this wallet minted, but no agent of it is here: it was transferred.
    // A wallet that minted is never offered the mint (P2-EC).
    overlay = <Gate title="The agent this wallet minted is no longer in it." />;
  } else if (!selected) {
    overlay = (
      <Gate title="No agent in this wallet yet. Mint one to get started.">{mintButton}</Gate>
    );
  } else if (!info) {
    overlay = (
      <Gate title={`Agent #${selected.id.toString()} is minted and waiting for its reveal.`}>
        {environment === "local" ? (
          <p className="text-xs text-foreground-muted">
            On the local fork, the reveal keeper in{" "}
            <span className="numeric whitespace-nowrap">pnpm dev:orchestrator</span> reveals it
            within about 15 seconds.
          </p>
        ) : null}
        {progress.state !== "idle" ? mintButton : null}
      </Gate>
    );
  }

  const badge = selected ? (
    <span className="flex items-center gap-2">
      <Tag size="md">
        <span className="numeric">#{selected.id.toString()}</span>
      </Tag>
      {info ? <Tag size="md">{info.species.name}</Tag> : null}
    </span>
  ) : null;

  const overview = selected ? (
    <div className="flex flex-col gap-4">
      {/* The viewer's gate already says an unrevealed agent waits for its reveal. */}
      {selected.pending === "indexing" ? (
        <PendingAgentNotice agentId={selected.id} stage="indexing" />
      ) : null}
      <AgentCard
        agentId={selected.id}
        tier={info?.species.tier ?? null}
        speciesName={info?.species.name ?? null}
        image={info?.asset.image ?? null}
        slots={info?.slots ?? 0}
        tba={selected.tba}
        owner={selected.owner}
        ownerEpoch={selected.ownerEpoch}
        environment={envLabel}
      />
      {info ? (
        <Button asChild variant="secondary" size="sm" className="self-start">
          <a href={`/agents/${selected.id.toString()}/goal`} data-testid="configure-goal-link">
            Set the goal
          </a>
        </Button>
      ) : null}
      {owned.agents.length > 1 ? (
        <nav aria-label="Your agents" className="flex flex-col gap-2">
          <SectionLabel as="h3">Your agents</SectionLabel>
          <ul className="flex flex-wrap gap-2">
            {owned.agents.map((a) => (
              <li key={a.id.toString()}>
                <Button
                  asChild
                  variant={a.id === selected.id ? "secondary-accent" : "secondary"}
                  size="sm"
                >
                  <a href={`/configure?agent=${a.id.toString()}`}>#{a.id.toString()}</a>
                </Button>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </div>
  ) : (
    <p className="text-sm text-foreground-muted">Your agent will appear here.</p>
  );

  const stage = (
    <AgentStage
      asset={info?.asset ?? null}
      agentKey={selected ? selected.id.toString() : "none"}
      badge={badge}
      overlay={overlay}
    />
  );

  return (
    <div className="flex flex-col gap-4" data-testid="agent-portal">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">
            {selected ? (
              <>
                Alpha Agent <span className="numeric text-primary">#{selected.id.toString()}</span>
              </>
            ) : (
              "Configure"
            )}
          </h1>
          {info ? (
            <Tag
              tone={
                info.species.tier === "pro"
                  ? "legendary"
                  : info.species.tier === "medium"
                    ? "rare"
                    : "neutral"
              }
              size="md"
            >
              {TIER_NAME[info.species.tier]}
            </Tag>
          ) : null}
          {selected ? (
            <AddressDisplay
              address={selected.owner}
              label={`Owner of agent ${selected.id.toString()}`}
            />
          ) : null}
        </div>
        <Tag size="md">{envLabel}</Tag>
      </header>

      {/* One viewer at every width (one WebGL canvas). Wide screens put the
          inventory and overview beside it; narrow screens put them in tabs below. */}
      <div className="grid gap-4 lg:grid-cols-12">
        <aside
          aria-label="Skill inventory"
          className="hidden rounded-lg border bg-surface p-4 lg:order-1 lg:col-span-3 lg:block"
        >
          <SectionLabel as="h2" className="mb-3">
            Skill inventory
          </SectionLabel>
          <SkillsPanel />
        </aside>
        <div className="h-96 overflow-hidden rounded-lg border lg:order-2 lg:col-span-6 lg:h-auto lg:min-h-120">
          {stage}
        </div>
        <aside
          aria-label="Agent overview"
          className="hidden rounded-lg border bg-surface p-4 lg:order-3 lg:col-span-3 lg:block"
        >
          <SectionLabel as="h2" className="mb-3">
            Agent
          </SectionLabel>
          {overview}
        </aside>
        <Tabs value={tab} onValueChange={setTab} className="lg:hidden">
          <TabsList aria-label="Panel">
            <TabsTrigger value="agent">Agent</TabsTrigger>
            <TabsTrigger value="skills">Skill inventory</TabsTrigger>
          </TabsList>
          <TabsContent value="agent" className="pt-3">
            {overview}
          </TabsContent>
          <TabsContent value="skills" className="pt-3">
            <SkillsPanel />
          </TabsContent>
        </Tabs>
      </div>

      {info ? (
        <section
          aria-label="Slots"
          className="flex flex-col gap-3 rounded-lg border bg-surface p-4"
        >
          <SectionLabel as="h2">Skill slots · {TIER_NAME[info.species.tier]} tier</SectionLabel>
          <SlotStrip slots={info.slots} />
        </section>
      ) : null}
    </div>
  );
}
