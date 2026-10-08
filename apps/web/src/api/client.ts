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

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
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
  /** Public, like the activity feed. */
  async whyNotTraded(agentId: bigint): Promise<WhyNotTradedJson> {
    return call<WhyNotTradedJson>(`/v1/agents/${agentId.toString()}/why-not-traded`);
  },
  /** The arming flow's raw calls: it reads the status and body itself. */
  async raw(
    agentId: bigint,
    path: "arming" | "disarm",
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
