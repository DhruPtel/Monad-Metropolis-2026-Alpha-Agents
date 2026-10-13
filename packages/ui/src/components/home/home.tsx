import { ArrowRight, Vault } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { cn } from "../../lib/utils";
import { type ArtTier, SpeciesArt } from "../agent/species-art";
import { EmptyState } from "../ui/empty-state";
import { Tag } from "../ui/tag";

/**
 * UI-FAST: the home page's parts around its centerpiece: the hero with live
 * stats, the connected owner's agents (or one mint call to action), the top
 * vaults as cards and every vault as a dense list. Presentational: the app
 * gives every figure, already written.
 */

type LinkComponent = ComponentType<{ href: string; className?: string; children?: ReactNode }>;

const TIER_NAME: Readonly<Record<ArtTier, string>> = { base: "Base", medium: "Medium", pro: "Pro" };
const TIER_TONE = { base: "neutral", medium: "rare", pro: "legendary" } as const;

export interface HomeStatView {
  readonly label: string;
  readonly value: string;
  /** What the figure counts, for the tooltip and screen readers. */
  readonly meaning: string;
}

/** A small green dot for an agent with activity in the last hour. */
function LiveDot({
  live,
  hideLabel = false,
  className,
}: {
  live: boolean;
  /** Keep the word for screen readers only, as in a dense row. */
  hideLabel?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn("inline-flex items-center gap-1 text-2xs text-foreground-muted", className)}
      data-testid="live-dot"
      data-live={live ? "" : undefined}
    >
      <span
        aria-hidden
        className={cn(
          "size-2 rounded-full",
          live ? "bg-positive motion-safe:animate-status-pulse" : "bg-border-strong",
        )}
      />
      <span className={hideLabel ? "sr-only" : undefined}>{live ? "Live" : "Idle"}</span>
    </span>
  );
}

function HomeHero({
  title,
  lede,
  stats,
  className,
}: {
  title: string;
  lede: string;
  stats: readonly HomeStatView[];
  className?: string;
}) {
  return (
    <header className={cn("flex flex-col gap-5", className)} data-testid="home-hero">
      <div className="flex max-w-2xl flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="text-base text-foreground-muted">{lede}</p>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
        {stats.map((s) => (
          <div
            key={s.label}
            className="flex flex-col gap-0.5"
            title={s.meaning}
            data-testid="home-stat"
          >
            <dt className="text-xs text-foreground-muted">{s.label}</dt>
            <dd className="numeric text-2xl font-semibold">{s.value}</dd>
          </div>
        ))}
      </dl>
    </header>
  );
}

export interface HomeAgentCardView {
  readonly id: string;
  readonly name: string;
  readonly image: string | null;
  readonly tier: ArtTier | null;
  readonly speciesName: string | null;
  readonly goal: string;
  readonly value: string;
  readonly lastResearch: string;
  readonly href: string;
  readonly live: boolean;
}

/** The connected owner's agents, side by side, each linking to its portfolio. */
function YourAgentsStrip({
  agents,
  linkAs,
  className,
}: {
  agents: readonly HomeAgentCardView[];
  linkAs?: LinkComponent;
  className?: string;
}) {
  const LinkAs = linkAs ?? "a";
  return (
    <ul
      className={cn("grid gap-3 sm:grid-cols-2 lg:grid-cols-3", className)}
      data-testid="your-agents"
    >
      {agents.map((a) => (
        <li key={a.id}>
          <LinkAs
            href={a.href}
            className="flex items-center gap-3 rounded-lg border bg-surface p-3 outline-none transition-colors hover:border-primary-muted is-focus:focus-ring"
          >
            <SpeciesArt
              compact
              image={a.image}
              speciesName={a.speciesName}
              tier={a.tier}
              className="w-16 shrink-0"
            />
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold">{a.name}</span>
                <LiveDot live={a.live} />
              </span>
              <span className="numeric text-base font-semibold">{a.value}</span>
              <span className="truncate text-2xs text-foreground-muted">
                {a.goal} · researched {a.lastResearch}
              </span>
            </span>
            <ArrowRight aria-hidden className="size-4 shrink-0 text-foreground-muted" />
          </LinkAs>
        </li>
      ))}
    </ul>
  );
}

/** One call to action in place of the strip: connect, or mint. */
function MintCallout({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description: string;
  action: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-start justify-between gap-3 rounded-lg border border-primary-muted bg-surface p-4 sm:flex-row sm:items-center",
        className,
      )}
      data-testid="mint-callout"
    >
      <div className="flex flex-col gap-0.5">
        <p className="text-base font-semibold">{title}</p>
        <p className="text-sm text-foreground-muted">{description}</p>
      </div>
      {action}
    </div>
  );
}

export interface HomeVaultView {
  readonly id: string;
  readonly name: string;
  readonly image: string | null;
  readonly tier: ArtTier | null;
  readonly speciesName: string | null;
  readonly value: string;
  /** "+1.20%", or null while there is not enough history. */
  readonly returnText: string | null;
  readonly research: string;
  readonly trades: string;
  readonly live: boolean;
  readonly href: string;
}

function VaultCards({
  vaults,
  linkAs,
  className,
}: {
  vaults: readonly HomeVaultView[];
  linkAs?: LinkComponent;
  className?: string;
}) {
  const LinkAs = linkAs ?? "a";
  return (
    <ul
      className={cn("grid gap-3 sm:grid-cols-2 lg:grid-cols-3", className)}
      data-testid="vault-cards"
    >
      {vaults.map((v) => (
        <li key={v.id}>
          <LinkAs
            href={v.href}
            className="flex flex-col gap-3 rounded-lg border bg-surface p-4 outline-none transition-colors hover:border-primary-muted is-focus:focus-ring"
          >
            <span className="flex items-center gap-3">
              <SpeciesArt
                compact
                image={v.image}
                speciesName={v.speciesName}
                tier={v.tier}
                className="w-14 shrink-0"
              />
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold">{v.name}</span>
                  {v.tier ? (
                    <Tag tone={TIER_TONE[v.tier]} size="sm">
                      {TIER_NAME[v.tier]}
                    </Tag>
                  ) : null}
                </span>
                <LiveDot live={v.live} />
              </span>
            </span>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <dt className="text-foreground-muted">Value</dt>
              <dd className="numeric text-right font-semibold">{v.value}</dd>
              <dt className="text-foreground-muted">Return</dt>
              <dd className="numeric text-right">{v.returnText ?? "Not enough data"}</dd>
              <dt className="text-foreground-muted">Research runs</dt>
              <dd className="numeric text-right">{v.research}</dd>
              <dt className="text-foreground-muted">Trades</dt>
              <dd className="numeric text-right">{v.trades}</dd>
            </dl>
          </LinkAs>
        </li>
      ))}
    </ul>
  );
}

/** Every vault as one dense row each, linking to the vault. */
function VaultList({
  vaults,
  linkAs,
  className,
}: {
  vaults: readonly HomeVaultView[];
  linkAs?: LinkComponent;
  className?: string;
}) {
  const LinkAs = linkAs ?? "a";
  return (
    <ul
      className={cn("flex flex-col divide-y rounded-lg border bg-surface", className)}
      data-testid="vault-list"
    >
      {vaults.map((v) => (
        <li key={v.id}>
          <LinkAs
            href={v.href}
            className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-0.5 px-3 py-2 text-sm outline-none hover:bg-surface-raised is-focus:focus-ring sm:grid-cols-[1.5fr_1fr_1fr_1fr_1fr_auto]"
            data-testid="vault-row"
          >
            <span className="flex items-center gap-2 font-medium">
              <LiveDot live={v.live} hideLabel />
              {v.name}
            </span>
            <span className="numeric text-right font-semibold">{v.value}</span>
            <span className="numeric hidden text-right sm:block">{v.returnText ?? "–"}</span>
            <span className="numeric hidden text-right text-foreground-muted sm:block">
              {v.research} research
            </span>
            <span className="numeric hidden text-right text-foreground-muted sm:block">
              {v.trades} trades
            </span>
            <ArrowRight aria-hidden className="hidden size-4 text-foreground-muted sm:block" />
          </LinkAs>
        </li>
      ))}
    </ul>
  );
}

/** Said once where the vault cards and list would be, while no vault exists. */
function NoVaults({ action, className }: { action?: ReactNode; className?: string }) {
  return (
    <EmptyState
      icon={Vault}
      title="No vaults yet"
      description="An agent's owner opens a vault from the agent's Vault page; open vaults show here with their value and return."
      {...(action ? { action } : {})}
      {...(className ? { className } : {})}
    />
  );
}

export { HomeHero, LiveDot, MintCallout, NoVaults, VaultCards, VaultList, YourAgentsStrip };
