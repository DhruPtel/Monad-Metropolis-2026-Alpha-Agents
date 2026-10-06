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
  readonly runStatus: RunStatus;
  readonly wallet: string;
  readonly ownerEpoch: string;
  readonly credits: {
    readonly fundingAddress: string;
    readonly creditsUsdcE6: string;
    readonly spendableUsdcE6: string;
    readonly heldUsdcE6: string;
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
