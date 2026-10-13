import { type Tier, speciesAsset, speciesByIndex } from "@alpha-agents/domain";
import { percentFromBps, usdcCents } from "@alpha-agents/ui";
import type { ActivityJson, ApiAgent, VaultResponseJson } from "@/api/client";

/**
 * UI-FAST: the home page from public data only. Each agent brings its index
 * row, its newest activity (the API serves the latest ACTIVITY_PAGE entries),
 * its public vault read and goal summary, and its personal account's value and
 * principal read onchain. Pure: every figure is a sum or a count of those,
 * and a count that may have more behind the page's limit says so ("N+").
 */
export const ACTIVITY_PAGE = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
/** An agent with activity this recent wears a live dot. */
const LIVE_MS = 60 * 60 * 1000;

export interface HomeAgentInput {
  readonly agent: ApiAgent;
  /** Null when the read failed. */
  readonly activity: readonly ActivityJson[] | null;
  readonly vault: VaultResponseJson | null;
  /** The personal account's value and principal; "none" without an account; null when the read failed. */
  readonly account:
    { readonly navUsdcE6: bigint; readonly principalUsdcE6: bigint } | "none" | null;
  readonly goal: { readonly configured: boolean; readonly aggressiveness: string | null } | null;
  /** When the agent was minted, in unix seconds, from its mint block; null when unread. */
  readonly mintedAt?: number | null;
}

export interface CountView {
  readonly n: number;
  /** True when an agent's activity page was full, so the real count may be higher. */
  readonly atLeast: boolean;
}

export const countText = (c: CountView) => `${c.n.toLocaleString("en-US")}${c.atLeast ? "+" : ""}`;

const RESEARCH_DONE = new Set(["scan", "proposal"]);
const RESEARCH_ANY = new Set(["scan", "stage", "activation", "proposal"]);
const PLANS = new Set(["proposal", "intent"]);

const GOAL_WORD: Readonly<Record<string, string>> = {
  CONSERVATIVE: "Conservative",
  BALANCED: "Balanced",
  AGGRESSIVE: "Aggressive",
};

export interface HomeAgentView {
  readonly id: bigint;
  readonly name: string;
  readonly tier: Tier | null;
  readonly speciesName: string | null;
  readonly image: string | null;
  readonly owner: string;
  readonly goal: string;
  /** Personal account plus vault, in USDC; null when nothing could be read. */
  readonly valueE6: bigint | null;
  /** The personal account's value against its principal, as "+1.20%"; null without deposits or a read. */
  readonly accountReturnText: string | null;
  readonly accountReturnBps: number | null;
  readonly mintedAt: number | null;
  /** Activity entries of any kind in the last 24 hours, for Trending. */
  readonly activity24h: number;
  /** Principal in the account and the vault; null when the account could not be read. */
  readonly depositedE6: bigint | null;
  readonly lastResearchAt: string | null;
  readonly live: boolean;
  readonly research: CountView;
  readonly researchToday: CountView;
  readonly plans: CountView;
  readonly trades: CountView;
  readonly activeToday: boolean;
  readonly vault: {
    readonly navE6: bigint | null;
    readonly returnText: string | null;
    readonly returnBps: number | null;
  } | null;
}

export interface HomeView {
  readonly stats: {
    readonly activeToday: number;
    readonly agents: number;
    readonly vaults: number;
    readonly totalValueE6: bigint;
    /** True when some agent's value could not be read, so the total leaves it out. */
    readonly valuePartial: boolean;
    readonly researchToday: CountView;
    readonly tradesSettled: CountView;
  };
  readonly agents: readonly HomeAgentView[];
}

function count(
  entries: readonly ActivityJson[] | null,
  kinds: Set<string>,
  since: number | null,
): CountView {
  const list = entries ?? [];
  const n = list.filter(
    (e) => kinds.has(e.kind) && (since === null || Date.parse(e.at) >= since),
  ).length;
  // The page is full: older entries exist; they matter when the window reaches past the oldest one.
  const oldest = list.at(-1);
  const atLeast =
    list.length >= ACTIVITY_PAGE &&
    (since === null || (oldest !== undefined && Date.parse(oldest.at) >= since));
  return { n, atLeast };
}

const sum = (cs: readonly CountView[]): CountView => ({
  n: cs.reduce((s, c) => s + c.n, 0),
  atLeast: cs.some((c) => c.atLeast),
});

export function homeView(inputs: readonly HomeAgentInput[], now: number): HomeView {
  const dayAgo = now - DAY_MS;
  const agents = inputs.map((x): HomeAgentView => {
    const a = x.agent;
    const species = a.species > 0 ? speciesByIndex(a.species) : null;
    const v = x.vault?.vault ?? null;
    const vaultState = v?.vault ? v.state : null;
    const vaultNav = vaultState?.navUsdcE6 ? BigInt(vaultState.navUsdcE6) : null;
    const score = x.vault?.performance.scores.returnSinceStart;
    const account = x.account === "none" ? { navUsdcE6: 0n, principalUsdcE6: 0n } : x.account;
    const valueE6 = account === null ? null : account.navUsdcE6 + (vaultNav ?? 0n);
    const entries = x.activity ?? [];
    const accountBps =
      account && account.principalUsdcE6 > 0n
        ? Number(
            ((account.navUsdcE6 - account.principalUsdcE6) * 10_000n) / account.principalUsdcE6,
          )
        : null;
    const lastResearch = entries.find((e) => RESEARCH_ANY.has(e.kind));
    const newest = entries[0];
    return {
      id: a.id,
      name: `Agent #${a.id.toString()}`,
      tier: species?.tier ?? null,
      speciesName: species?.name ?? null,
      image: species ? speciesAsset(a.species).image : null,
      owner: a.owner,
      goal: x.goal?.configured
        ? (GOAL_WORD[x.goal.aggressiveness ?? ""] ?? "Goal set")
        : "No goal set",
      valueE6,
      accountReturnText: accountBps === null ? null : percentFromBps(accountBps, true),
      accountReturnBps: accountBps,
      mintedAt: x.mintedAt ?? null,
      activity24h: entries.filter((e) => Date.parse(e.at) >= dayAgo).length,
      depositedE6:
        account === null
          ? null
          : account.principalUsdcE6 + (vaultState ? BigInt(vaultState.principalUsdcE6) : 0n),
      lastResearchAt: lastResearch?.at ?? null,
      live: newest !== undefined && now - Date.parse(newest.at) < LIVE_MS,
      research: count(x.activity, RESEARCH_DONE, null),
      researchToday: count(x.activity, RESEARCH_DONE, dayAgo),
      plans: count(x.activity, PLANS, null),
      trades: count(x.activity, new Set(["trade"]), null),
      activeToday: newest !== undefined && Date.parse(newest.at) >= dayAgo,
      vault: v?.vault
        ? {
            navE6: vaultNav,
            returnText: score?.ok ? percentFromBps(score.bps, true) : null,
            returnBps: score?.ok ? score.bps : null,
          }
        : null,
    };
  });
  return {
    stats: {
      activeToday: agents.filter((a) => a.activeToday).length,
      agents: agents.length,
      vaults: agents.filter((a) => a.vault !== null).length,
      totalValueE6: agents.reduce((s, a) => s + (a.valueE6 ?? 0n), 0n),
      valuePartial: agents.some((a) => a.valueE6 === null),
      researchToday: sum(agents.map((a) => a.researchToday)),
      tradesSettled: sum(agents.map((a) => a.trades)),
    },
    agents,
  };
}

export const usdcText = (e6: bigint | null) => (e6 === null ? "–" : `${usdcCents(e6)} USDC`);

/** "4 min ago", "3 h ago", "2 d ago": rough on purpose. */
export function ago(iso: string | null, now: number): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

export type AgentFilter = "trending" | "top" | "gainers" | "new";

/** A missing number sorts last whichever way the list runs. */
const desc = (a: number | null, b: number | null) =>
  a === null ? (b === null ? 0 : 1) : b === null ? -1 : b - a;
const byId = (a: HomeAgentView, b: HomeAgentView) => Number(a.id - b.id);

/**
 * The table's order per tab: Trending by activity in the last 24 hours, Top
 * by value, Gainers by the trading account's return on deposits, New by mint
 * time. Ties fall back to value, then id.
 */
export function sortAgents(
  agents: readonly HomeAgentView[],
  filter: AgentFilter,
): HomeAgentView[] {
  const value = (a: HomeAgentView) => (a.valueE6 === null ? null : Number(a.valueE6));
  const key: Record<AgentFilter, (a: HomeAgentView, b: HomeAgentView) => number> = {
    trending: (a, b) => b.activity24h - a.activity24h,
    top: () => 0,
    gainers: (a, b) => desc(a.accountReturnBps, b.accountReturnBps),
    new: (a, b) => desc(a.mintedAt, b.mintedAt),
  };
  return [...agents].sort(
    (a, b) => key[filter](a, b) || desc(value(a), value(b)) || byId(a, b),
  );
}

export type TopCard =
  | { readonly kind: "vault"; readonly agent: HomeAgentView }
  | { readonly kind: "agent"; readonly agent: HomeAgentView };

/**
 * The row of three: vaults ranked by return (then value), and while there are
 * fewer than three, the most valuable agents whose vault is not already shown.
 */
export function topCards(agents: readonly HomeAgentView[], n = 3): TopCard[] {
  const vaults = agents
    .filter((a) => a.vault !== null)
    .sort(
      (a, b) =>
        desc(a.vault?.returnBps ?? null, b.vault?.returnBps ?? null) ||
        desc(
          a.vault?.navE6 == null ? null : Number(a.vault.navE6),
          b.vault?.navE6 == null ? null : Number(b.vault.navE6),
        ) ||
        byId(a, b),
    )
    .slice(0, n)
    .map((agent): TopCard => ({ kind: "vault", agent }));
  const shown = new Set(vaults.map((c) => c.agent.id));
  const fill = sortAgents(
    agents.filter((a) => !shown.has(a.id)),
    "top",
  )
    .slice(0, n - vaults.length)
    .map((agent): TopCard => ({ kind: "agent", agent }));
  return [...vaults, ...fill];
}

/** "6 h", "3 d": an agent's age from its mint time; "–" when unknown. */
export function ageText(mintedAt: number | null, now: number): string {
  if (mintedAt === null) return "–";
  const s = Math.max(0, Math.round(now / 1000 - mintedAt));
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86_400)} d`;
}
