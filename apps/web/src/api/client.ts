import type {
  AgentState,
  GoalInput,
  OwnerLimitField,
  PlanChangeMode,
  ModelTier,
  ResearchIntensity,
  Aggressiveness,
} from "@alpha-agents/domain";
import type {
  AssetRow,
  HundredView,
  SeriesPoint,
  TradeMarkView,
  WindowScores,
} from "@alpha-agents/ui";
import { type Address, getAddress } from "viem";

/**
 * The control API as the browser calls it (P1-U4): agents and supply from the
 * index, mint eligibility and the mint claim. The base URL is inlined at build
 * time (next.config.ts); locally it is the API from `pnpm dev:api`.
 */
export const CONTROL_API_URL = process.env.CONTROL_API_URL || "http://127.0.0.1:4100";

export interface Watermark {
  readonly block: number;
  readonly hash: string;
  readonly updatedAt: string;
}

export interface ApiAgent {
  readonly id: bigint;
  readonly owner: Address;
  readonly tba: Address;
  /** 0 until revealed, then 1 to 25. */
  readonly species: number;
  readonly ownerEpoch: bigint;
}

export interface ApiSupply {
  readonly maxSupply: number;
  readonly totalMinted: number;
  readonly remaining: readonly number[];
  readonly watermark: Watermark | null;
}

export type EligibilityReason = "eligible" | "not_allowlisted" | "already_minted" | "sold_out";

export interface Eligibility {
  readonly wallet: Address;
  readonly eligible: boolean;
  readonly reason: EligibilityReason;
  readonly message: string;
}

/** An answer the API gave with an error code; the message is safe to show. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** The answer's body, when it had one: a refused goal carries each field's reason (P3-U1). */
  readonly body: unknown;

  constructor(status: number, code: string, message: string, body: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${CONTROL_API_URL}${path}`, init);
  } catch {
    throw new ApiError(0, "unreachable", "Could not reach the platform API.");
  }
  const body = (await res.json().catch(() => null)) as
    (T & { error?: string; message?: string }) | null;
  if (!res.ok || !body) {
    throw new ApiError(
      res.status,
      body?.error ?? "error",
      body?.message ?? `The platform API answered ${res.status}.`,
      body,
    );
  }
  return body;
}

interface AgentJson {
  agentId: string;
  owner: string;
  tba: string;
  species: number;
  ownerEpoch: string;
}

const toAgent = (a: AgentJson): ApiAgent => ({
  id: BigInt(a.agentId),
  owner: getAddress(a.owner),
  tba: getAddress(a.tba),
  species: a.species,
  ownerEpoch: BigInt(a.ownerEpoch),
});

export interface OwnerSession {
  readonly token: string;
  /** Unix seconds. */
  readonly expiresAt: number;
  readonly wallet: Address;
  readonly ownerEpoch: bigint;
}

export type RunStatus =
  "awaiting_reveal" | "provisioning" | "ready" | "running" | "restricted" | "failed" | "stopped";

/** GET /v1/agents/:id/summary, as the API sends it (amounts are decimal strings). */
export interface AgentSummaryJson {
  /** Phase 2 tuning: the per-agent credit cap in USDC base units. */
  readonly creditCapUsdcE6?: string;
  /** P3-U1: the agent's state and its goal's summary. */
  readonly goal?: {
    readonly state: AgentState;
    readonly configured: boolean;
    readonly aggressiveness: Aggressiveness | null;
  };
  readonly runStatus: RunStatus;
  readonly wallet: string;
  readonly ownerEpoch: string;
  readonly credits: {
    readonly fundingAddress: string;
    readonly creditsUsdcE6: string;
    readonly spendableUsdcE6: string;
    readonly heldUsdcE6: string;
    /** The current owner's own share of the credits (D-242). */
    readonly ownRefundUsdcE6: string;
    readonly restricted: boolean;
  } | null;
  readonly spent24hUsdcE6: string;
  readonly charges: readonly {
    readonly entryId: string;
    readonly at: string;
    readonly kind: "model" | "tool" | "reversal";
    readonly label: string;
    readonly amountUsdcE6: string;
  }[];
  readonly latestScan: {
    readonly taskId: string;
    readonly status: "queued" | "running" | "succeeded" | "failed";
    readonly stopReason: string | null;
    readonly error: string | null;
    readonly requestedBy: string | null;
    readonly createdAt: string;
    readonly finishedAt: string | null;
  } | null;
  readonly scan: {
    readonly minimumUsdcE6: string;
    readonly estimateUsdcE6: { readonly low: string; readonly high: string };
  };
}

export interface ActivityJson {
  readonly entryId: string;
  readonly kind: string;
  readonly text: string;
  readonly renderedBy: "narrator" | "template";
  readonly at: string;
}

export interface RefundJson {
  readonly refundId: string;
  readonly status: "requested" | "signed" | "sent" | "refused" | "failed";
  readonly creditsUsdcE6: string | null;
  readonly heldUsdcE6: string | null;
  readonly txHash: string | null;
  readonly reason: string | null;
}

const auth = (token: string | null): HeadersInit =>
  token ? { authorization: `Bearer ${token}` } : {};

/** An amount as the API gives it: decimal text and base units (P2-U6 intentJson). */
export interface TokenAmountJson {
  readonly asset: "USDC" | "WMON";
  readonly amount: string;
  readonly amountRaw: string;
}

/** One reason a trade was blocked, and how it clears (chain-tools' Blocker). */
export interface BlockerJson {
  readonly code: string;
  readonly message: string;
  readonly clears: "by_waiting" | "by_changing_the_trade" | "by_the_owner" | "by_the_platform";
  readonly clearsAt: string | null;
  readonly hint: string;
}

export interface IntentJson {
  readonly intentId: string;
  readonly status: string;
  readonly sell: TokenAmountJson;
  readonly buy: "USDC" | "WMON";
  readonly expectedOut: TokenAmountJson | null;
  readonly minAmountOut: TokenAmountJson | null;
  readonly amountOut: TokenAmountJson | null;
  readonly reason: string;
  readonly reasonCodes: readonly string[];
  readonly blockers: readonly BlockerJson[];
  readonly failure: string | null;
  readonly approvedBy: "owner" | "auto" | null;
  readonly txHash: string | null;
  readonly deadline: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly approvedAt: string | null;
  readonly submittedAt: string | null;
  readonly settledAt: string | null;
}

export interface ArmingJson {
  readonly state: "unarmed" | "awaiting_first_trade" | "armed";
  readonly armingId: string | null;
  /** Unix seconds. */
  readonly validUntil: number | null;
  readonly validUntilDate: string | null;
  readonly renewalDue: boolean;
  readonly armedAt: string | null;
  readonly firstIntentId: string | null;
  readonly ended: {
    readonly reason: string;
    readonly message: string;
    readonly at: string | null;
    readonly revokedOnchain: boolean;
  } | null;
}

/** A call for the owner's wallet, built by the API. */
export interface WalletCallJson {
  readonly to: Address;
  readonly data: `0x${string}`;
  readonly value: "0";
}

export interface ArmingViewJson {
  readonly arming: ArmingJson;
  readonly fundingAddress: Address | null;
  readonly grantCall: WalletCallJson | null;
  readonly maxGrantDays: number;
}

export interface WhyNotTradedJson {
  readonly armingState: ArmingJson["state"];
  readonly armingEnded: { readonly reason: string; readonly message: string } | null;
  readonly reasons: readonly (BlockerJson & {
    readonly intentId: string | null;
    readonly at: string;
  })[];
  readonly waitingForApproval: number;
}

export interface PriceJson {
  readonly priceE18: string;
  /** Unix seconds. */
  readonly updatedAt: number;
  readonly reason: string;
}

/** The owner's portfolio, read fresh from the chain (P2-U7); amounts in base units. */
/** D-315: every balance at an agent's addresses, as GET /v1/agents/:id/holdings serves it. */
export interface HoldingsJson {
  readonly agentId: number;
  readonly owner: Address;
  readonly block: string;
  readonly addresses: readonly {
    readonly role: "funding" | "token_bound" | "personal_account";
    readonly address: Address | null;
    readonly holdings: readonly {
      readonly symbol: string;
      readonly token: Address | null;
      readonly decimals: number;
      readonly raw: string;
      readonly use: "gas" | "credits" | "trading" | null;
      readonly status: "in_use" | "movable" | "platform_only" | "stuck";
      readonly recoverCall: WalletCallJson | null;
    }[];
  }[];
}

/** F-U9: a proposed position as the plan card shows it. */
export interface ProposalPositionJson {
  readonly token: string;
  readonly symbol: string;
  readonly targetWeightBps: number;
  readonly bandBps: number;
  readonly currentWeightBps: number | null;
  readonly action: "ADD" | "HOLD" | "TRIM" | "EXIT";
  readonly thesisCode: string | null;
  readonly thesis: string | null;
  readonly killCriterion: string;
  readonly recheckAt: string;
  readonly trimAboveBps: number | null;
  readonly confidence: "high" | "medium" | "low" | null;
  readonly sources: {
    readonly onchain: number;
    readonly market: number;
    readonly primary: number;
    readonly news: number;
    readonly social: number;
  };
  readonly verdict: "STANDS" | "WEAKENED" | "REJECTED" | null;
  readonly reason: string;
}

export interface ProposalJson {
  readonly proposalId: string;
  readonly kind: "proposal" | "no_change";
  readonly status: "pending_owner" | "applied" | "rejected" | "declined" | "expired" | "recorded";
  readonly needsApproval: boolean;
  readonly strategyEpoch: string;
  readonly ownerEpoch: string;
  readonly cycleId: string | null;
  readonly template: string | null;
  readonly plan: {
    readonly cashTargetBps?: number;
    readonly targetWmonBps?: number;
    readonly minTradeUsdcE6: string;
    readonly volatilityBrakeBps: number;
    readonly costHurdleBps: number;
    readonly maxLegBps: number;
  } | null;
  readonly positions: readonly ProposalPositionJson[];
  readonly rationale: {
    readonly decision: "NO_CHANGE" | "PROPOSE";
    readonly reasonCode: string | null;
    readonly portfolioView: string;
    readonly evidenceStrength: "strong" | "mixed" | "weak";
    readonly whatWouldChangeIt: string;
    readonly themeCodes: readonly string[];
  };
  readonly evaluation: {
    readonly checkedAt: string;
    readonly passed: boolean;
    readonly findings: readonly {
      readonly code: string;
      readonly field: string;
      readonly message: string;
    }[];
    readonly cost: {
      readonly legs: number;
      readonly turnoverUsdcE6: string;
      readonly estimatedCostUsdcE6: string;
      readonly costBps: number;
      readonly basis: string;
    } | null;
    readonly approval: "ask_first" | "first_plan_after_arming" | null;
  } | null;
  readonly reasonCode: string | null;
  readonly explanation: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

/** F-U9: the plan card's data, owner only. */
export interface PlanCardJson {
  readonly strategyEpoch: string;
  readonly planChanges: "ASK_FIRST" | "APPLY_AND_TELL" | null;
  readonly current: {
    readonly paramId: string;
    readonly template: string;
    readonly setBy: string;
    readonly setAt: string;
    readonly strategyEpoch: string;
    readonly positions: readonly {
      readonly token: string;
      readonly symbol: string;
      readonly targetWeightBps: number;
      readonly bandBps: number;
    }[];
    readonly cashTargetBps: number | null;
    readonly targetWmonBps: number | null;
  } | null;
  readonly pending: ProposalJson | null;
  readonly recent: readonly ProposalJson[];
  readonly noChange: ProposalJson | null;
}

/** F-U10: one step of the activation sweep as the panel shows it. */
export interface ActivationStepJson {
  readonly key: string;
  readonly label: string;
  readonly state: "pending" | "running" | "done" | "failed" | "skipped" | "capped";
  readonly result: string | null;
  readonly reason: string | null;
  readonly chargedUsdcE6: string;
  readonly ceilingUsdcE6: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export type ActivationStatusJson =
  | "running"
  | "plan_ready"
  | "active"
  | "off"
  | "declined"
  | "expired"
  | "no_plan"
  | "failed"
  | "capped"
  | "out_of_credits";

export interface ActivationJson {
  readonly activationId: string;
  readonly status: ActivationStatusJson;
  readonly tier: {
    readonly choice: "LOW" | "MEDIUM" | "HIGH";
    readonly label: string;
    readonly model: string;
  };
  readonly ceilingUsdcE6: string;
  readonly chargedUsdcE6: string;
  readonly steps: readonly ActivationStepJson[];
  readonly proposalId: string | null;
  readonly outcome: {
    readonly title: string;
    readonly message: string;
    readonly action: "approve" | "retry" | "add_credits" | "none";
  };
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface ActivationCheckJson {
  readonly code: string;
  readonly ok: boolean;
  readonly message: string;
  readonly blocking: boolean;
}

/** F-U10: the owner's read of the sweep: the newest one, and the checks before the next. */
export interface ActivationReadJson {
  readonly agentId: string;
  /** False where no orchestrator is reachable: the page keeps the P2-U6 arming alone. */
  readonly available: boolean;
  readonly activation: ActivationJson | null;
  readonly checks: readonly ActivationCheckJson[];
  readonly ceilingUsdcE6: string;
  readonly tier: { readonly choice: "LOW" | "MEDIUM" | "HIGH"; readonly label: string };
}

export interface PortfolioJson {
  readonly chainId: number;
  readonly block: string;
  /** The block's time, unix seconds. */
  readonly timestamp: number;
  readonly agentId: string;
  readonly owner: Address;
  readonly contracts: {
    readonly agentNft: Address;
    readonly accountFactory: Address;
    readonly oracle: Address;
    readonly usdc: Address;
    readonly wmon: Address;
    readonly executor: Address;
  };
  readonly account: Address | null;
  readonly predictedAccount: Address;
  readonly allowlist: { readonly enabled: boolean; readonly listed: boolean };
  readonly caps: {
    readonly personalUsdcE6: string;
    readonly platformUsdcE6: string;
    readonly platformTotalUsdcE6: string;
    readonly principalUsdcE6: string;
  };
  readonly balances: { readonly usdcE6: string; readonly wmonWei: string };
  readonly claimable: { readonly usdcE6: string; readonly wmonWei: string };
  readonly mode: "NORMAL" | "REDUCE_ONLY" | "PAUSED" | "HANDOVER" | "WIND_DOWN" | null;
  readonly depositsClosed: boolean;
  readonly breaker: {
    readonly navUsdcE6: string;
    readonly perUnitE18: string;
    readonly peakE18: string;
    readonly drawdownBps: number;
  } | null;
  readonly peak7dE18: string | null;
  readonly prices: { readonly monUsd: PriceJson; readonly usdcUsd: PriceJson };
  readonly wallet: { readonly usdcE6: string; readonly wmonWei: string; readonly monWei: string };
}

/**
 * F-U11: the portfolio window as the control API builds it: the holdings
 * (live, or the latest snapshot dated as such), the value-per-unit series,
 * the trades as markers, the closed positions, the scores and the $100 figure.
 */
export interface WindowJson {
  readonly agentId: string;
  readonly account: Address | null;
  readonly custody: "v2" | "v3" | null;
  readonly asOf: {
    readonly at: string;
    readonly block: string | null;
    readonly live: boolean;
  } | null;
  readonly totalValueUsdcE6: string | null;
  readonly holdings: readonly (AssetRow & { readonly token: Address | null })[];
  readonly series: readonly SeriesPoint[];
  readonly marks: readonly TradeMarkView[];
  readonly closed: readonly {
    readonly symbol: string;
    readonly spentUsdcE6: string;
    readonly receivedUsdcE6: string;
    readonly profitable: boolean;
  }[];
  readonly scores: WindowScores;
  readonly hundred: HundredView;
  readonly history: {
    readonly points: number;
    readonly from: string | null;
    readonly to: string | null;
    readonly capped: boolean;
  };
}

const owner = (session: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...(init.headers as Record<string, string> | undefined), "x-owner-session": session },
});

/** P2-U7: the owner's trading routes; each needs the owner session. */
export const tradingApi = {
  async portfolio(agentId: bigint, session: string): Promise<PortfolioJson> {
    return (
      await call<{ portfolio: PortfolioJson }>(
        `/v1/agents/${agentId.toString()}/portfolio`,
        owner(session),
      )
    ).portfolio;
  },
  async arming(agentId: bigint, session: string): Promise<ArmingViewJson> {
    return call<ArmingViewJson>(`/v1/agents/${agentId.toString()}/arming`, owner(session));
  },
  async intents(agentId: bigint, session: string): Promise<IntentJson[]> {
    return (
      await call<{ intents: IntentJson[] }>(
        `/v1/agents/${agentId.toString()}/intents`,
        owner(session),
      )
    ).intents;
  },
  async approve(agentId: bigint, intentId: string, session: string): Promise<boolean> {
    const body = await call<{ armed: boolean }>(
      `/v1/agents/${agentId.toString()}/intents/${encodeURIComponent(intentId)}/approve`,
      owner(session, { method: "POST" }),
    );
    return body.armed;
  },
  async reject(agentId: bigint, intentId: string, session: string): Promise<void> {
    await call(
      `/v1/agents/${agentId.toString()}/intents/${encodeURIComponent(intentId)}/reject`,
      owner(session, { method: "POST" }),
    );
  },
  /**
   * P2-EC (D-307): on testnet, asks the platform to re-date the feeds that
   * need it before a deposit; elsewhere it answers that nothing was needed.
   */
  async freshPrices(
    agentId: bigint,
    session: string,
  ): Promise<{ redated: unknown[]; error: string | null; needed: boolean }> {
    return call(
      `/v1/agents/${agentId.toString()}/prices/fresh`,
      owner(session, { method: "POST" }),
    );
  },
  /** D-315: every balance at the agent's addresses, with the owner's recovery calls. Owner only. */
  async holdings(agentId: bigint, session: string): Promise<HoldingsJson> {
    return (
      await call<{ holdings: HoldingsJson }>(
        `/v1/agents/${agentId.toString()}/holdings`,
        owner(session),
      )
    ).holdings;
  },
  /** F-U9: the plan card. Owner only. */
  async planCard(agentId: bigint, session: string): Promise<PlanCardJson> {
    return call<PlanCardJson>(`/v1/agents/${agentId.toString()}/plan-card`, owner(session));
  },
  /** F-U9: approve a waiting proposal; it becomes the plan the runner follows, or is rejected with findings. */
  async approveProposal(
    agentId: bigint,
    proposalId: string,
    session: string,
  ): Promise<{ proposal: ProposalJson }> {
    return call<{ proposal: ProposalJson }>(
      `/v1/agents/${agentId.toString()}/proposals/${encodeURIComponent(proposalId)}/approve`,
      owner(session, { method: "POST" }),
    );
  },
  async rejectProposal(
    agentId: bigint,
    proposalId: string,
    session: string,
  ): Promise<{ proposal: ProposalJson }> {
    return call<{ proposal: ProposalJson }>(
      `/v1/agents/${agentId.toString()}/proposals/${encodeURIComponent(proposalId)}/reject`,
      owner(session, { method: "POST" }),
    );
  },
  /** Public, like the activity feed. */
  async whyNotTraded(agentId: bigint): Promise<WhyNotTradedJson> {
    return call<WhyNotTradedJson>(`/v1/agents/${agentId.toString()}/why-not-traded`);
  },
  /** F-U10: the activation sweep as the owner reads it. Owner only. */
  async activation(agentId: bigint, session: string): Promise<ActivationReadJson> {
    return call<ActivationReadJson>(`/v1/agents/${agentId.toString()}/activation`, owner(session));
  },
  /** F-U11: the portfolio window. Owner only. */
  async window(agentId: bigint, session: string): Promise<WindowJson> {
    return (
      await call<{ window: WindowJson }>(`/v1/agents/${agentId.toString()}/window`, owner(session))
    ).window;
  },
  /** The arming and activation flows' raw calls: they read the status and body themselves. */
  async raw(
    agentId: bigint,
    path: "arming" | "disarm" | "activation",
    method: "GET" | "POST",
    session: string,
  ): Promise<{ status: number; body: unknown }> {
    try {
      const res = await fetch(
        `${CONTROL_API_URL}/v1/agents/${agentId.toString()}/${path}`,
        owner(session, { method }),
      );
      return { status: res.status, body: await res.json().catch(() => null) };
    } catch {
      return { status: 0, body: { message: "Could not reach the platform API." } };
    }
  },
};

export interface CreditsJson {
  readonly fundingAddress: Address;
  readonly creditsUsdcE6: string;
  readonly spendableUsdcE6: string;
  readonly heldUsdcE6: string;
  readonly creditCapUsdcE6: string;
}

export const api = {
  async supply(): Promise<ApiSupply> {
    return call<ApiSupply>("/v1/supply");
  },
  async agents(filter: { owner?: Address; minter?: Address }): Promise<ApiAgent[]> {
    const query = new URLSearchParams(
      Object.entries(filter).filter((e): e is [string, Address] => e[1] !== undefined),
    );
    const body = await call<{ agents: AgentJson[] }>(`/v1/agents?${query.toString()}`);
    return body.agents.map(toAgent);
  },
  /** The agent from the index, or null while the index has not seen it. */
  async agent(id: bigint): Promise<ApiAgent | null> {
    try {
      return toAgent((await call<{ agent: AgentJson }>(`/v1/agents/${id.toString()}`)).agent);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  },
  async eligibility(wallet: Address, token: string | null): Promise<Eligibility> {
    return call<Eligibility>(`/v1/mint/eligibility?wallet=${wallet}`, { headers: auth(token) });
  },
  // --- My Agents (P1-U9, D-218) ---

  /** An owner session for one agent, from the caller's login (P1-U4). */
  async ownerSession(agentId: bigint, token: string | null): Promise<OwnerSession> {
    const body = await call<{
      token: string;
      expiresAt: number;
      wallet: string;
      ownerEpoch: string;
    }>(`/v1/agents/${agentId.toString()}/session`, { method: "POST", headers: auth(token) });
    return {
      token: body.token,
      expiresAt: body.expiresAt,
      wallet: getAddress(body.wallet),
      ownerEpoch: BigInt(body.ownerEpoch),
    };
  },
  /** The owner-only summary: run status, credits, spend, charges and the latest Scan. */
  async summary(agentId: bigint, session: string): Promise<AgentSummaryJson> {
    return call<AgentSummaryJson>(`/v1/agents/${agentId.toString()}/summary`, {
      headers: { "x-owner-session": session },
    });
  },
  /** An agent's credits, public like its funding address's USDC (Phase 2 tuning). */
  async credits(agentId: bigint): Promise<CreditsJson> {
    return call<CreditsJson>(`/v1/agents/${agentId.toString()}/credits`);
  },
  /** The narrator's entries, newest first (public, D-217). */
  async activity(agentId: bigint): Promise<ActivityJson[]> {
    return (await call<{ entries: ActivityJson[] }>(`/v1/agents/${agentId.toString()}/activity`))
      .entries;
  },
  async requestRefund(agentId: bigint, session: string): Promise<string> {
    const body = await call<{ refundId: string }>(
      `/v1/agents/${agentId.toString()}/credits/refund`,
      { method: "POST", headers: { "x-owner-session": session } },
    );
    return body.refundId;
  },
  async refund(agentId: bigint, refundId: string): Promise<RefundJson> {
    return call<RefundJson>(
      `/v1/agents/${agentId.toString()}/credits/refunds/${encodeURIComponent(refundId)}`,
    );
  },
  async requestScan(agentId: bigint, session: string): Promise<string> {
    const body = await call<{ taskId: string }>(`/v1/agents/${agentId.toString()}/scan`, {
      method: "POST",
      headers: { "x-owner-session": session },
    });
    return body.taskId;
  },

  /** POSTs for a mint claim; resolves to the status and body, as the mint flow expects. */
  async claim(wallet: Address, token: string | null): Promise<{ status: number; body: unknown }> {
    try {
      const res = await fetch(`${CONTROL_API_URL}/v1/mint/claim`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth(token) },
        body: JSON.stringify({ wallet }),
      });
      return { status: res.status, body: (await res.json().catch(() => null)) as unknown };
    } catch {
      return { status: 0, body: { message: "Could not reach the platform API for a mint claim." } };
    }
  },
};

// --- The goal (P3-U1) ---

export type GoalInputJson = GoalInput;

export interface GoalErrorJson {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

/** The translated goal, as the API serves it: amounts are base-unit strings. */
export interface GoalConfigJson {
  readonly aggressiveness: Aggressiveness;
  readonly envelope: {
    readonly label: string;
    readonly classAAllowed: boolean;
    readonly maxPositionBps: number;
    readonly maxClassAPositionBps: number;
    readonly maxClassATotalBps: number;
    readonly minStableBps: number;
    readonly maxPositions: number;
    readonly reviewTriggerBps: number;
  };
  /** The brief the agent reads: a fixed text per level with the owner's choices (D-345). */
  readonly brief: string;
  readonly template: {
    readonly id: "rebalance_bands@1";
    readonly params: {
      readonly targetWmonBps: number;
      readonly bandHalfWidthBps: number;
      readonly minTradeUsdcE6: string;
      readonly volatilityBrakeBps: number;
      readonly costHurdleBps: number;
      readonly maxLegBps: number;
    };
  };
  readonly targetRange: { readonly minBps: number; readonly maxBps: number };
  readonly researchTriggerBps: number;
  readonly hardLimits: Readonly<Record<OwnerLimitField, number>>;
  readonly ownerLimits: Readonly<Record<OwnerLimitField, number>>;
  readonly research: {
    readonly intensity: ResearchIntensity;
    readonly scanEveryHours: number;
    readonly divesPerDay: number;
    readonly dailyBudgetUsdcE6: string;
    readonly monthlyMaxUsdcE6: string;
  };
  readonly model: { readonly choice: ModelTier; readonly alias: string };
  readonly creditReserveUsdcE6: string;
  readonly planChanges: { readonly mode: PlanChangeMode; readonly workflowMode: string };
}

export interface GoalFormJson {
  readonly defaults: GoalInput;
  /** F-U7: each aggressiveness with its summary, brief and envelope. */
  readonly levels: readonly {
    readonly id: Aggressiveness;
    readonly label: string;
    readonly summary: string;
    readonly brief: string;
    readonly envelope: GoalConfigJson["envelope"];
  }[];
  readonly tiers: readonly {
    readonly id: ModelTier;
    readonly label: string;
    readonly alias: string;
    readonly model: string;
    readonly note: string;
  }[];
  /** The registered tokens the owner may exclude. */
  readonly tokens: readonly {
    readonly address: string;
    readonly symbol: string;
    readonly priceClass: string;
  }[];
  readonly maxExcludedTokens: number;
  readonly hardLimits: Readonly<Record<OwnerLimitField, number>>;
  readonly limits: readonly {
    readonly field: OwnerLimitField;
    readonly direction: "max" | "min";
    readonly unit: "bps" | "trades";
    readonly min: number;
    readonly max: number;
    readonly hard: number;
  }[];
  readonly intensities: readonly {
    readonly id: ResearchIntensity;
    readonly scanEveryHours: number;
    readonly divesPerDay: number;
    readonly defaultDailyBudgetUsdcE6: string;
    readonly minDailyBudgetUsdcE6: string;
    readonly maxDailyBudgetUsdcE6: string;
    readonly monthlyAtDefaultUsdcE6: string;
  }[];
  readonly costPreviewDays: number;
  readonly sweepMaxUsdcE6: Readonly<Record<ModelTier, string>>;
  readonly maxCreditReserveUsdcE6: string;
}

export interface GoalViewJson {
  readonly agentId: string;
  readonly ownerEpoch: string;
  readonly state: AgentState;
  readonly strategyEpoch: string;
  readonly goal: GoalInput | null;
  readonly config: GoalConfigJson | null;
  readonly policyHash: string | null;
  readonly savedAt: string | null;
  readonly savedBy: string | null;
}

export interface GoalPageJson extends GoalViewJson {
  readonly form: GoalFormJson;
}

export interface GoalSavedJson extends GoalViewJson {
  readonly stateChange: { readonly from: AgentState; readonly to: AgentState } | null;
}

export type GoalPreviewJson =
  | { readonly ok: true; readonly config: GoalConfigJson; readonly errors: readonly [] }
  | { readonly ok: false; readonly config: null; readonly errors: readonly GoalErrorJson[] };

/** A goal the API refused, with each field's reason. */
export class GoalRefusedError extends Error {
  readonly errors: readonly GoalErrorJson[];

  constructor(message: string, errors: readonly GoalErrorJson[]) {
    super(message);
    this.name = "GoalRefusedError";
    this.errors = errors;
  }
}

/** P3-U1: the owner's goal routes, and the public preview. */
export const goalApi = {
  async get(agentId: bigint, session: string): Promise<GoalPageJson> {
    return call<GoalPageJson>(`/v1/agents/${agentId.toString()}/goal`, owner(session));
  },
  async save(agentId: bigint, goal: GoalInput, session: string): Promise<GoalSavedJson> {
    try {
      return await call<GoalSavedJson>(
        `/v1/agents/${agentId.toString()}/goal`,
        owner(session, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(goal),
        }),
      );
    } catch (err) {
      if (err instanceof ApiError && err.code === "goal_refused") {
        const errors = (err.body as { errors?: GoalErrorJson[] } | null)?.errors ?? [];
        throw new GoalRefusedError(err.message, errors);
      }
      throw err;
    }
  },
  async preview(goal: GoalInput): Promise<GoalPreviewJson> {
    return call<GoalPreviewJson>("/v1/goal/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(goal),
    });
  },
};
