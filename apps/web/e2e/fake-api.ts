import { AGENT_MAX_SUPPLY, SPECIES } from "@alpha-agents/domain";
import type { Page, Route } from "@playwright/test";
import { type Address, getAddress } from "viem";
import { MOCK_ACCESS_TOKEN } from "../src/auth/mock-wallet-constants";
import { AGENT_NFT, type FakeChain } from "./fake-chain";

/**
 * A stand-in for the control API (P1-U4) for the screenshot suite, which runs
 * in the pinned Playwright image with no API: it answers the routes the pages
 * call from FakeChain's agents, so the index and the chain always agree. The
 * live suite runs the real API, indexer and fork.
 */
export const FAKE_API_PORT = "4100";

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
    const authed = request.headers()["authorization"] === `Bearer ${MOCK_ACCESS_TOKEN}`;

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
    if (url.pathname === "/v1/mint/eligibility") {
      if (!authed) return reply(401, { error: "invalid_token", message: "Log in first." });
      return reply(200, this.eligibility(url.searchParams.get("wallet") ?? ""));
    }
    if (url.pathname === "/v1/mint/claim") {
      if (!authed) return reply(401, { error: "invalid_token", message: "Log in first." });
      const wallet = String((request.postDataJSON() as { wallet?: string } | null)?.wallet ?? "");
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
}
