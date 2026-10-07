import { AGENT_MAX_SUPPLY, SPECIES } from "@alpha-agents/domain";
import type { Page, Route } from "@playwright/test";
import { type Address, getAddress } from "viem";
import { MOCK_ACCESS_TOKEN } from "../src/auth/mock-wallet-constants";

/** The wallet a mock token was issued for, as the real API reads it from Privy; null when none. */
function linkedWallet(authorization: string | undefined): string | null {
  const prefix = `Bearer ${MOCK_ACCESS_TOKEN}:`;
  return authorization?.startsWith(prefix) ? authorization.slice(prefix.length) : null;
}
import { AGENT_NFT, type FakeChain } from "./fake-chain";

/**
 * A stand-in for the control API (P1-U4) for the screenshot suite, which runs
 * in the pinned Playwright image with no API: it answers the routes the pages
 * call from FakeChain's agents, so the index and the chain always agree. The
 * live suite runs the real API, indexer and fork.
 */
export const FAKE_API_PORT = "4100";

/** One agent's owner-only summary and activity as the fake serves them (P1-U9). */
export interface FakeDashboard {
  runStatus: string;
  credits: {
    fundingAddress: string;
    creditsUsdcE6: string;
    spendableUsdcE6: string;
    heldUsdcE6: string;
    ownRefundUsdcE6: string;
    restricted: boolean;
  } | null;
  spent24hUsdcE6: string;
  charges: { entryId: string; at: string; kind: string; label: string; amountUsdcE6: string }[];
  latestScan: {
    taskId: string;
    status: string;
    stopReason: string | null;
    error: string | null;
    requestedBy: string | null;
    createdAt: string;
    finishedAt: string | null;
  } | null;
  activity: { entryId: string; kind: string; text: string; renderedBy: string; at: string }[];
}

export const FUNDING_ADDRESS = "0x9F8e2B1C0d3a4E5f60718293A4B5c6D7E8f90a1B";

/** A funded, provisioned agent with charges and two entries, at fixed times. */
export function fundedDashboard(over: Partial<FakeDashboard> = {}): FakeDashboard {
  return {
    runStatus: "ready",
    credits: {
      fundingAddress: FUNDING_ADDRESS,
      creditsUsdcE6: "4994400",
      spendableUsdcE6: "4994400",
      heldUsdcE6: "2000000",
      ownRefundUsdcE6: "6994400",
      restricted: false,
    },
    spent24hUsdcE6: "171600",
    charges: [
      {
        entryId: "c4",
        at: "2026-10-06T16:41:20.000Z",
        kind: "model",
        label: "scan-cheap",
        amountUsdcE6: "137600",
      },
      {
        entryId: "c3",
        at: "2026-10-06T16:41:05.000Z",
        kind: "tool",
        label: "read_url",
        amountUsdcE6: "2000",
      },
      {
        entryId: "c2",
        at: "2026-10-06T16:40:40.000Z",
        kind: "reversal",
        label: "web_search",
        amountUsdcE6: "-10000",
      },
      {
        entryId: "c1",
        at: "2026-10-06T16:40:30.000Z",
        kind: "tool",
        label: "web_search",
        amountUsdcE6: "10000",
      },
    ],
    latestScan: {
      taskId: "scan-0",
      status: "succeeded",
      stopReason: "COMPLETED",
      error: null,
      requestedBy: "schedule",
      createdAt: "2026-10-06T16:40:00.000Z",
      finishedAt: "2026-10-06T16:41:30.000Z",
    },
    activity: [
      {
        entryId: "a2",
        kind: "scan",
        text: "Agent #7 searched for Monad DEX volume and network upgrades, read 1 page and flagged WMON at 55% confidence. Tools cost 0.012 USDC.",
        renderedBy: "narrator",
        at: "2026-10-06T16:41:30.000Z",
      },
      {
        entryId: "a1",
        kind: "scan",
        text: "Agent #7 finished a Scan. It ran 1 web search and read 0 pages. It found no candidates. Tools cost 0.01 USDC; 5.1 USDC of credits left.",
        renderedBy: "template",
        at: "2026-10-06T10:41:30.000Z",
      },
    ],
    ...over,
  };
}

export interface FakeApiOptions {
  /** Wallets on the mint allowlist (lowercase). Defaults to every wallet. */
  readonly allowlist?: readonly string[] | "everyone";
  /** False: the API has no claim key, so the claim is refused with 503. */
  readonly signer?: boolean;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, x-owner-session",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

export class FakeApi {
  private readonly chain: FakeChain;
  allowlist: readonly string[] | "everyone";
  signer: boolean;
  /** Claims the fake issued, for tests that check none was asked for. */
  readonly claims: Address[] = [];
  /** P1-U9: each agent's owner-only summary and activity; a minted agent without one is "setting up". */
  readonly dashboards = new Map<bigint, FakeDashboard>();
  /** Owner-only requests, for tests that check another wallet made none. */
  readonly ownerCalls: string[] = [];
  /** Requests refused because the token's wallet was not the one asked about, as "path wallet". */
  readonly notLinked: string[] = [];

  constructor(chain: FakeChain, options: FakeApiOptions = {}) {
    this.chain = chain;
    this.allowlist = options.allowlist ?? "everyone";
    this.signer = options.signer ?? true;
  }

  async install(page: Page): Promise<void> {
    await page.route(
      (url) => url.hostname === "127.0.0.1" && url.port === FAKE_API_PORT,
      (route) => this.answer(route),
    );
  }

  private watermark() {
    return {
      block: 109_670_100,
      hash: `0x${"ab".repeat(32)}`,
      updatedAt: "2026-10-05T00:00:00.000Z",
    };
  }

  private agentJson(id: bigint) {
    const a = this.chain.agents.get(id);
    if (!a) return null;
    return {
      agentId: a.id.toString(),
      owner: getAddress(a.owner),
      tba: getAddress(a.tba),
      species: a.species,
      tier: a.species === 0 ? null : (SPECIES[a.species - 1]?.tier ?? null),
      ownerEpoch: a.ownerEpoch.toString(),
      mintedBlock: 109_670_010,
      mintedTx: `0x${a.id.toString(16).padStart(64, "a")}`,
    };
  }

  supply() {
    if (this.chain.supply) {
      return {
        maxSupply: AGENT_MAX_SUPPLY,
        totalMinted: this.chain.supply.totalMinted,
        remaining: this.chain.supply.remaining,
      };
    }
    const drawn = (index: number) =>
      [...this.chain.agents.values()].filter((a) => a.species === index).length;
    return {
      maxSupply: AGENT_MAX_SUPPLY,
      totalMinted: this.chain.agents.size,
      remaining: SPECIES.map((s) => s.count - drawn(s.index)),
    };
  }

  private minted(wallet: string): boolean {
    return [...this.chain.agents.values()].some((a) => same(a.receivedBy[0] ?? "", wallet));
  }

  private eligibility(wallet: string) {
    const allowed = this.allowlist === "everyone" || this.allowlist.some((w) => same(w, wallet));
    const reason = !allowed
      ? "not_allowlisted"
      : this.minted(wallet)
        ? "already_minted"
        : this.supply().totalMinted >= AGENT_MAX_SUPPLY
          ? "sold_out"
          : "eligible";
    const message = {
      eligible: "This wallet can mint one agent.",
      not_allowlisted: "This wallet is not on the beta mint allowlist.",
      already_minted: "This wallet has already minted an agent.",
      sold_out: "All agents have been minted.",
    }[reason];
    return { wallet: getAddress(wallet), eligible: reason === "eligible", reason, message };
  }

  private async answer(route: Route): Promise<void> {
    const request = route.request();
    const reply = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: CORS,
        body: JSON.stringify(body),
      });
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(request.url());
    const meta = { environment: "fork", chainId: 143143, watermark: this.watermark() };
    const linked = linkedWallet(request.headers()["authorization"]);
    const notLinked = (wallet: string) => {
      this.notLinked.push(`${url.pathname} ${wallet}`);
      return reply(403, {
        error: "wallet_not_linked",
        message: "That wallet is not linked to your login.",
      });
    };

    if (url.pathname === "/v1/supply") return reply(200, { ...meta, ...this.supply() });
    if (url.pathname === "/v1/agents") {
      const owner = url.searchParams.get("owner");
      const minter = url.searchParams.get("minter");
      const agents = [...this.chain.agents.values()]
        .filter((a) => (owner ? same(a.owner, owner) : true))
        .filter((a) => (minter ? same(a.receivedBy[0] ?? "", minter) : true))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((a) => this.agentJson(a.id));
      return reply(200, { ...meta, agents });
    }
    const one = /^\/v1\/agents\/(\d+)$/.exec(url.pathname);
    if (one?.[1]) {
      const agent = this.agentJson(BigInt(one[1]));
      return agent
        ? reply(200, { ...meta, agent })
        : reply(404, { error: "not_found", message: "Not in the index." });
    }
    const mine = /^\/v1\/agents\/(\d+)\/(session|summary|scan|credits\/refund)$/.exec(url.pathname);
    if (mine?.[1] && mine[2]) return this.owner(BigInt(mine[1]), mine[2], request, reply, meta);
    const activity = /^\/v1\/agents\/(\d+)\/activity$/.exec(url.pathname);
    if (activity?.[1]) {
      const d = this.dashboards.get(BigInt(activity[1]));
      return reply(200, { ...meta, agentId: activity[1], entries: d?.activity ?? [] });
    }
    const refund = /^\/v1\/agents\/(\d+)\/credits\/refunds\/([\w-]+)$/.exec(url.pathname);
    if (refund?.[1]) {
      return reply(200, {
        refundId: refund[2],
        agentId: refund[1],
        status: "sent",
        creditsUsdcE6: "4994400",
        heldUsdcE6: "2000000",
        txHash: `0x${"ef".repeat(32)}`,
        reason: null,
      });
    }
    if (url.pathname === "/v1/mint/eligibility") {
      if (!linked) return reply(401, { error: "invalid_token", message: "Log in first." });
      const wallet = url.searchParams.get("wallet") ?? "";
      if (!same(wallet, linked)) return notLinked(wallet);
      return reply(200, this.eligibility(wallet));
    }
    if (url.pathname === "/v1/mint/claim") {
      if (!linked) return reply(401, { error: "invalid_token", message: "Log in first." });
      const wallet = String((request.postDataJSON() as { wallet?: string } | null)?.wallet ?? "");
      if (!same(wallet, linked)) return notLinked(wallet);
      const e = this.eligibility(wallet);
      if (!e.eligible)
        return reply(e.reason === "not_allowlisted" ? 403 : 409, {
          error: e.reason,
          message: e.message,
        });
      if (!this.signer) {
        return reply(503, {
          error: "not_configured",
          message: "Minting is not configured: set CLAIM_SIGNER_PRIVATE_KEY for the control API.",
        });
      }
      this.claims.push(getAddress(wallet));
      return reply(200, {
        wallet: getAddress(wallet),
        nonce: `0x${"ab".repeat(32)}`,
        deadline: "4102444800",
        signature: `0x${"cd".repeat(65)}`,
        contract: AGENT_NFT,
      });
    }
    return reply(404, { error: "not_found", message: "No such route." });
  }

  /**
   * The owner-only routes. A session names the agent and the wallet that owns
   * it now; a transfer makes it stale, as in the real API. A Scan reads as
   * queued once, then completed with a new entry and charge; a refund is sent
   * at once and leaves the agent without credits.
   */
  private owner(
    id: bigint,
    action: string,
    request: ReturnType<Route["request"]>,
    reply: (status: number, body: unknown) => Promise<void>,
    meta: Record<string, unknown>,
  ): Promise<void> {
    const agent = this.chain.agents.get(id);
    if (!agent) return reply(404, { error: "not_found", message: "No such agent." });
    this.ownerCalls.push(`${action} ${id.toString()}`);
    const session = `fake-session-${id.toString()}-${agent.owner.toLowerCase()}-${agent.ownerEpoch.toString()}`;
    if (action === "session") {
      const linked = linkedWallet(request.headers()["authorization"]);
      if (!linked) return reply(401, { error: "invalid_token", message: "Log in first." });
      if (!same(linked, agent.owner))
        return reply(403, {
          error: "not_owner",
          message: `None of your linked wallets owns agent #${id.toString()}.`,
        });
      return reply(200, {
        token: session,
        expiresAt: 4_102_444_800,
        wallet: getAddress(agent.owner),
        agentId: id.toString(),
        ownerEpoch: agent.ownerEpoch.toString(),
      });
    }
    if (request.headers()["x-owner-session"] !== session)
      return reply(403, {
        error: "session_stale",
        message: `Agent #${id.toString()} changed hands.`,
      });
    const d =
      this.dashboards.get(id) ??
      ({
        runStatus: agent.species === 0 ? "awaiting_reveal" : "provisioning",
        credits: null,
        spent24hUsdcE6: "0",
        charges: [],
        latestScan: null,
        activity: [],
      } satisfies FakeDashboard);
    if (action === "summary") {
      const body = {
        ...meta,
        agentId: id.toString(),
        wallet: getAddress(agent.owner),
        ownerEpoch: agent.ownerEpoch.toString(),
        runStatus: d.runStatus,
        credits: d.credits,
        spent24hUsdcE6: d.spent24hUsdcE6,
        charges: d.charges,
        latestScan: d.latestScan,
        scan: { minimumUsdcE6: "150000", estimateUsdcE6: { low: "150000", high: "300000" } },
      };
      if (d.latestScan?.status === "queued") {
        // Served queued once; the next read finds it finished, narrated and charged.
        d.latestScan = {
          ...d.latestScan,
          status: "succeeded",
          stopReason: "COMPLETED",
          finishedAt: "2026-10-06T17:02:00.000Z",
        };
        d.activity = [
          {
            entryId: "a-new",
            kind: "scan",
            text: `Agent #${id.toString()} ran 2 web searches, read 1 page and flagged WMON at 60% confidence. Tools cost 0.022 USDC.`,
            renderedBy: "narrator",
            at: "2026-10-06T17:02:00.000Z",
          },
          ...d.activity,
        ];
      }
      return reply(200, body);
    }
    if (action === "scan") {
      if (!d.credits || BigInt(d.credits.spendableUsdcE6) < 150_000n)
        return reply(409, {
          error: "credits_low",
          message: "A Scan needs at least 0.15 USDC of credits. Add USDC to the funding address.",
        });
      d.latestScan = {
        taskId: "scan-new",
        status: "queued",
        stopReason: null,
        error: null,
        requestedBy: "owner",
        createdAt: "2026-10-06T17:00:00.000Z",
        finishedAt: null,
      };
      return reply(202, { taskId: "scan-new" });
    }
    // The refund: sent at once; the agent is left with nothing to spend.
    if (d.credits)
      d.credits = {
        ...d.credits,
        creditsUsdcE6: "0",
        spendableUsdcE6: "0",
        heldUsdcE6: "0",
        ownRefundUsdcE6: "0",
        restricted: true,
      };
    d.runStatus = "restricted";
    return reply(202, {
      refundId: "refund-1",
      wallet: getAddress(agent.owner),
      ownerEpoch: agent.ownerEpoch.toString(),
    });
  }
}
