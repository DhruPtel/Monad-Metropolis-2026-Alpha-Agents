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
