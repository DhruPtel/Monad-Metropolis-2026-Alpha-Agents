import { ENVIRONMENTS } from "@alpha-agents/config";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@alpha-agents/db/testing";
import { CLAIM_TYPES, SPECIES, claimDomain } from "@alpha-agents/domain";
import type { AgentChainView, PortfolioReading } from "@alpha-agents/trading";
import {
  type Address,
  type Hex,
  decodeFunctionData,
  getAddress,
  parseAbi,
  verifyTypedData,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type ApiDeps, createApp } from "./app.ts";
import type { ChainReader } from "./chain.ts";
import type { Identity } from "./identity.ts";

const available = await databaseAvailable();

const NFT = "0x60cacA6dE327331b321E140Ae19AcbCc4188Be6E" as Address;
const ALICE = "0x1111111111111111111111111111111111111111" as Address;
const BOB = "0x2222222222222222222222222222222222222222" as Address;
const CAROL = "0x3333333333333333333333333333333333333333" as Address;
const SECRET = "test-only-api-session-secret-0123456789abcdef";
const env = ENVIRONMENTS.local;

/** Two users: alice links ALICE and CAROL, bob links BOB. */
const identity: Identity & { down: boolean } = {
  down: false,
  async verify(token) {
    if (token === "alice-token")
      return { userId: "did:privy:alice", sessionId: "s1", expiresAt: 0 };
    if (token === "bob-token") return { userId: "did:privy:bob", sessionId: "s2", expiresAt: 0 };
    throw new Error("bad token");
  },
  async walletsOf(session) {
    if (this.down) throw new Error("privy down");
    return session.userId === "did:privy:alice" ? [ALICE, CAROL] : [BOB];
  },
};

/** The chain as a test sets it. */
const chain = {
  minted: new Set<string>(),
  total: 1,
  max: 1000,
  owners: new Map<bigint, { owner: Address; epoch: bigint }>(),
  reads: 0,
};
const chainReader: ChainReader = {
  async hasMinted(wallet) {
    chain.reads++;
    return chain.minted.has(wallet.toLowerCase());
  },
  async totalMinted() {
    chain.reads++;
    return chain.total;
  },
  async maxSupply() {
    return chain.max;
  },
  async ownership(agentId) {
    chain.reads++;
    return chain.owners.get(agentId) ?? null;
  },
};

/** A funded account as the chain reader returns it (P2-U7). */
const PORTFOLIO: PortfolioReading = {
  chainId: 143143,
  block: 109_670_100n,
  timestamp: 1_790_000_000n,
  agentId: 2,
  owner: BOB,
  contracts: {
    agentNft: NFT,
    accountFactory: "0x00000000000000000000000000000000000fac70",
    oracle: "0x000000000000000000000000000000000000041e",
    usdc: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    wmon: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A",
    executor: "0x00000000000000000000000000000000000e0ec0",
  },
  account: "0x00000000000000000000000000000000000ac002",
  predictedAccount: "0x00000000000000000000000000000000000ac002",
  allowlist: { enabled: true, listed: true },
  caps: {
    personal: 100_000_000n,
    platform: 2_000_000_000n,
    platformTotal: 250_000_000n,
    principal: 40_000_000n,
  },
  balances: { usdc: 40_000_000n, wmon: 0n },
  claimable: { usdc: 0n, wmon: 0n },
  mode: "NORMAL",
  depositsClosed: false,
  breaker: { navUsdc: 40_000_000n, perUnit: 10n ** 18n, peak: 10n ** 18n, drawdownBps: 0n },
  peak7d: 10n ** 18n,
  prices: {
    monUsd: { priceE18: 25_000_000_000_000_000n, updatedAt: 1_789_999_980n, reason: "OK" },
    usdcUsd: { priceE18: 10n ** 18n, updatedAt: 1_789_999_400n, reason: "OK" },
  },
  wallet: { usdc: 5_000_000n, wmon: 0n, mon: 10n ** 18n },
};

describe.skipIf(!available)("the control API (needs pnpm dev:up for Postgres)", () => {
  let t: TestDatabase;
  let now = 1_790_000_000_000;
  const signerKey = generatePrivateKey();
  const signer = privateKeyToAccount(signerKey);
  let nonce = 0;

  const deps = (over: Partial<ApiDeps> = {}): ApiDeps => ({
    db: t.db,
    environment: env,
    deployment: { address: NFT, fromBlock: 109_670_001n, referenceBlock: 109_670_000n },
    chain: chainReader,
    identity,
    signer,
    sessionSecret: SECRET,
    allowOrigin: (o) => o === "http://localhost:3000",
    now: () => now,
    randomNonce: () => `0x${(++nonce).toString(16).padStart(64, "0")}` as Hex,
    cacheMs: 0,
    ...over,
  });
  const call = (
    path: string,
    init: RequestInit & { token?: string } = {},
    over: Partial<ApiDeps> = {},
  ) => {
    const headers = new Headers(init.headers);
    if (init.token) headers.set("authorization", `Bearer ${init.token}`);
    return createApp(deps(over)).request(path, { ...init, headers });
  };
  const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

  async function seedAgents() {
    await t.db
      .insertInto("indexer.watermarks")
      .values({
        chain_id: env.chainId,
        source: "agent_nft",
        block_number: 109_670_009,
        block_hash: "0xabc",
      })
      .execute();
    const agent = (id: number, owner: Address, species: number) => ({
      chain_id: env.chainId,
      agent_id: id,
      owner: owner.toLowerCase(),
      tba: `0x${"7ba".padEnd(37, "0")}${id.toString(16).padStart(3, "0")}`,
      species,
      tier: species === 0 ? 0 : species <= 5 ? 1 : species <= 13 ? 2 : 3,
      owner_epoch: 0,
      minted_block: 109_670_001 + id,
      minted_tx: `0x${id.toString(16).padStart(64, "a")}`,
      block_number: 109_670_001 + id,
      block_hash: `0x${id.toString(16).padStart(64, "b")}`,
    });
    await t.db
      .insertInto("indexer.agents")
      .values([agent(1, ALICE, 14), agent(2, BOB, 3), agent(3, ALICE, 0)])
      .execute();
    // Agent 2 was minted by CAROL and later moved to BOB.
    const minted = (id: number, owner: Address) => ({
      chain_id: env.chainId,
      contract: NFT.toLowerCase(),
      block_number: 109_670_001 + id,
      block_hash: "0x0",
      tx_hash: `0x${id}`,
      log_index: 1,
      event_name: "AgentMinted",
      args: JSON.stringify({ agentId: String(id), owner: getAddress(owner), tba: "0x0" }),
    });
    await t.db
      .insertInto("indexer.agent_nft_events")
      .values([minted(1, ALICE), minted(2, CAROL), minted(3, ALICE)])
      .execute();
  }

  beforeAll(async () => {
    t = await createTestDatabase("api");
    await seedAgents();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);
  beforeEach(async () => {
    identity.down = false;
    chain.minted.clear();
    chain.total = 3;
    chain.max = 1000;
    chain.owners = new Map([
      [1n, { owner: ALICE, epoch: 0n }],
      [2n, { owner: BOB, epoch: 2n }],
    ]);
    await t.db.deleteFrom("platform.mint_allowlist").execute();
    await t.db.deleteFrom("platform.mint_claims").execute();
    await t.db.deleteFrom("platform.refunds").execute();
    await t.db.deleteFrom("platform.ledger_lines").execute();
    await t.db.deleteFrom("platform.ledger_entries").execute();
    await t.db.deleteFrom("platform.funding_addresses").execute();
    await t.db.deleteFrom("platform.agent_tasks").execute();
    await t.db.deleteFrom("platform.sandbox_leases").execute();
    await t.db.deleteFrom("platform.agent_runtimes").execute();
    await t.db.deleteFrom("platform.tool_calls").execute();
    await t.db.deleteFrom("indexer.usdc_transfers").execute();
  });

  describe("index reads", () => {
    it("health names the environment, AgentNFT and the watermark", async () => {
      const body = await json(await call("/health"));
      expect(body).toMatchObject({ ok: true, environment: "fork", chainId: 143143, agentNft: NFT });
      expect(body.watermark).toMatchObject({ block: 109_670_009, hash: "0xabc" });
    });

    it("supply: minted count and each species' remaining slots, as remainingOf would say", async () => {
      const body = await json(await call("/v1/supply"));
      expect(body).toMatchObject({ environment: "fork", maxSupply: 1000, totalMinted: 3 });
      const remaining = body.remaining as number[];
      expect(remaining).toHaveLength(25);
      expect(remaining[13]).toBe(0); // the bee, revealed
      expect(remaining[2]).toBe(119); // one ant revealed
      expect(remaining.reduce((a, b) => a + b, 0)).toBe(998); // the unrevealed agent still holds a slot
      expect(remaining.map((r, i) => r <= (SPECIES[i]?.count ?? 0))).not.toContain(false);
      expect((body.watermark as { block: number }).block).toBe(109_670_009);
    });

    it("agents by owner, by minter, and by ID, with checksummed addresses", async () => {
      const byOwner = await json(await call(`/v1/agents?owner=${ALICE.toLowerCase()}`));
      expect((byOwner.agents as { agentId: string }[]).map((a) => a.agentId)).toEqual(["1", "3"]);
      const byMinter = await json(await call(`/v1/agents?minter=${CAROL}`));
      expect(byMinter.agents).toMatchObject([
        { agentId: "2", owner: BOB, tier: "base", species: 3 },
      ]);
      const all = await json(await call("/v1/agents"));
      expect((all.agents as unknown[]).length).toBe(3);
      const one = await json(await call("/v1/agents/1"));
      expect(one.agent).toMatchObject({
        agentId: "1",
        owner: ALICE,
        species: 14,
        tier: "pro",
        ownerEpoch: "0",
      });
      expect((await json(await call("/v1/agents/3"))).agent).toMatchObject({
        species: 0,
        tier: null,
      });
    });

    it("an unknown agent is 404, a bad address 400, an unknown route 404", async () => {
      expect((await call("/v1/agents/99")).status).toBe(404);
      expect((await call("/v1/agents?owner=nope")).status).toBe(400);
      expect((await call("/v1/nothing")).status).toBe(404);
    });

    it("caches index reads for the configured moment", async () => {
      const app = createApp(deps({ cacheMs: 5_000 }));
      const first = await json(await app.request("/v1/supply"));
      await t.db
        .updateTable("indexer.agents")
        .set({ species: 3, tier: 1 })
        .where("agent_id", "=", 3)
        .execute();
      expect(await json(await app.request("/v1/supply"))).toEqual(first);
      now += 6_000;
      const later = await json(await app.request("/v1/supply"));
      expect((later.remaining as number[])[2]).toBe(118);
      await t.db
        .updateTable("indexer.agents")
        .set({ species: 0, tier: 0 })
        .where("agent_id", "=", 3)
        .execute();
    });

    it("reads no contract: the index answers", async () => {
      const before = chain.reads;
      await call("/v1/supply");
      await call(`/v1/agents?owner=${ALICE}`);
      await call("/v1/agents/1");
      expect(chain.reads).toBe(before);
    });
  });

  describe("session", () => {
    it("names the caller and their linked wallets", async () => {
      const body = await json(await call("/v1/session", { token: "alice-token" }));
      expect(body).toMatchObject({ userId: "did:privy:alice", wallets: [ALICE, CAROL] });
    });

    it("refuses a missing or invalid token alike, and says when login is not set up", async () => {
      expect((await call("/v1/session")).status).toBe(401);
      const bad = await call("/v1/session", { token: "forged" });
      expect([bad.status, (await json(bad)).error]).toEqual([401, "invalid_token"]);
      const off = await call("/v1/session", { token: "alice-token" }, { identity: null });
      expect([off.status, (await json(off)).error]).toEqual([503, "not_configured"]);
    });

    it("names a Privy outage instead of failing blindly", async () => {
      identity.down = true;
      const res = await call("/v1/session", { token: "alice-token" });
      expect([res.status, (await json(res)).error]).toEqual([503, "privy_unavailable"]);
    });
  });

  describe("mint eligibility and claims", () => {
    const allow = (wallet: Address) =>
      t.db
        .insertInto("platform.mint_allowlist")
        .values({ wallet: wallet.toLowerCase(), note: null })
        .execute();
    const eligibility = (wallet: Address, token = "alice-token") =>
      call(`/v1/mint/eligibility?wallet=${wallet}`, { token });
    const claim = (
      wallet: unknown,
      token: string | null = "alice-token",
      over: Partial<ApiDeps> = {},
    ) =>
      call(
        "/v1/mint/claim",
        {
          method: "POST",
          ...(token ? { token } : {}),
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ wallet }),
        },
        over,
      );
    const claims = () => t.db.selectFrom("platform.mint_claims").selectAll().execute();

    it("a wallet not on the allowlist is not eligible, and the claim is refused", async () => {
      expect(await json(await eligibility(ALICE))).toMatchObject({
        wallet: ALICE,
        eligible: false,
        reason: "not_allowlisted",
      });
      const res = await claim(ALICE);
      expect([res.status, (await json(res)).error]).toEqual([403, "not_allowlisted"]);
      expect(await claims()).toEqual([]);
    });

    it("an allowlisted wallet is eligible and gets a claim the signer signed for it", async () => {
      await allow(ALICE);
      expect(await json(await eligibility(ALICE))).toMatchObject({
        eligible: true,
        reason: "eligible",
      });
      const res = await claim(ALICE.toLowerCase());
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        wallet: Address;
        nonce: Hex;
        deadline: string;
        signature: Hex;
        contract: Address;
      };
      expect(body).toMatchObject({
        wallet: ALICE,
        contract: NFT,
        deadline: String(Math.floor(now / 1000) + 600),
      });
      const valid = await verifyTypedData({
        address: signer.address,
        domain: claimDomain(143143, NFT),
        types: CLAIM_TYPES,
        primaryType: "MintClaim",
        message: { wallet: ALICE, nonce: body.nonce, deadline: BigInt(body.deadline) },
        signature: body.signature,
      });
      expect(valid).toBe(true);
      expect(await claims()).toMatchObject([
        { nonce: body.nonce, wallet: ALICE.toLowerCase(), user_id: "did:privy:alice" },
      ]);
    });

    it("a wallet that already minted (read fresh from the chain) is refused", async () => {
      await allow(ALICE);
      chain.minted.add(ALICE.toLowerCase());
      expect(await json(await eligibility(ALICE))).toMatchObject({
        eligible: false,
        reason: "already_minted",
      });
      const res = await claim(ALICE);
      expect([res.status, (await json(res)).error]).toEqual([409, "already_minted"]);
      expect(await claims()).toEqual([]);
    });

    it("sold out is refused", async () => {
      await allow(ALICE);
      chain.total = 1000;
      expect((await json(await eligibility(ALICE))).reason).toBe("sold_out");
      expect((await claim(ALICE)).status).toBe(409);
    });

    it("an invalid or missing session is refused", async () => {
      await allow(ALICE);
      expect((await claim(ALICE, "forged")).status).toBe(401);
      expect((await claim(ALICE, null)).status).toBe(401);
      expect((await eligibility(ALICE, "forged")).status).toBe(401);
      expect(await claims()).toEqual([]);
    });

    it("a wallet linked to someone else is refused, even when allowlisted", async () => {
      await allow(BOB);
      const res = await claim(BOB, "alice-token");
      expect([res.status, (await json(res)).error]).toEqual([403, "wallet_not_linked"]);
      expect((await eligibility(BOB, "alice-token")).status).toBe(403);
    });

    it("a missing wallet is a bad request; no signer or no deployment is 503", async () => {
      expect((await claim(undefined)).status).toBe(400);
      await allow(ALICE);
      const noKey = await claim(ALICE, "alice-token", { signer: null });
      expect([noKey.status, (await json(noKey)).error]).toEqual([503, "not_configured"]);
      const notDeployed = await claim(ALICE, "alice-token", { deployment: null, chain: null });
      expect([notDeployed.status, (await json(notDeployed)).error]).toEqual([503, "not_deployed"]);
    });
  });

  describe("owner sessions", () => {
    const start = async (agent: number, token: string) =>
      call(`/v1/agents/${agent}/session`, { method: "POST", token });
    const ownerView = (agent: number, session: string) =>
      call(`/v1/agents/${agent}/owner`, { headers: { "x-owner-session": session } });

    it("the owner gets a session tied to the current owner and epoch, and uses it", async () => {
      const res = await start(2, "bob-token");
      const body = await json(res);
      expect(body).toMatchObject({ wallet: BOB, agentId: "2", ownerEpoch: "2" });
      const view = await ownerView(2, body.token as string);
      expect(view.status).toBe(200);
      expect(await json(view)).toMatchObject({
        wallet: BOB,
        ownerEpoch: "2",
        agent: { agentId: "2" },
      });
    });

    it("someone who does not own the agent gets no session", async () => {
      const res = await start(2, "alice-token");
      expect([res.status, (await json(res)).error]).toEqual([403, "not_owner"]);
      expect((await start(77, "alice-token")).status).toBe(404);
      expect((await start(2, "forged")).status).toBe(401);
    });

    it("a transfer ends the session: a new epoch or a new owner makes it stale", async () => {
      const { token } = await json(await start(2, "bob-token"));
      chain.owners.set(2n, { owner: BOB, epoch: 3n }); // out to the escrow and back
      const epoch = await ownerView(2, token as string);
      expect([epoch.status, (await json(epoch)).error]).toEqual([403, "session_stale"]);
      chain.owners.set(2n, { owner: CAROL, epoch: 2n });
      expect((await ownerView(2, token as string)).status).toBe(403);
    });

    it("serves an agent's activity entries, newest first, without their facts (P1-U7)", async () => {
      for (const [i, text] of ["Agent #2 ran 1 web search.", "Agent #2 read 1 page."].entries())
        await t.db
          .insertInto("platform.activity_entries")
          .values({
            entry_id: `act-${i}`,
            chain_id: env.chainId,
            agent_id: 2,
            task_id: `task-${i}`,
            kind: "scan",
            text,
            rendered_by: i === 0 ? "narrator" : "template",
            facts: JSON.stringify({ searches: [{ query: "PRIVATE_QUERY_TEXT" }] }),
            rejections: "[]",
            created_at: new Date(Date.now() + i * 1000),
          })
          .execute();
      const res = await call("/v1/agents/2/activity");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.entries).toEqual([
        expect.objectContaining({ text: "Agent #2 read 1 page.", renderedBy: "template" }),
        expect.objectContaining({ text: "Agent #2 ran 1 web search.", renderedBy: "narrator" }),
      ]);
      expect(JSON.stringify(body)).not.toContain("PRIVATE_QUERY_TEXT");
      expect(await json(await call("/v1/agents/9/activity"))).toMatchObject({ entries: [] });
    });

    describe("My Agents: the owner's summary and Scans (P1-U9)", () => {
      const summary = (agent: number, session: string | null) =>
        call(`/v1/agents/${agent}/summary`, {
          headers: session ? { "x-owner-session": session } : {},
        });
      const scan = (agent: number, session: string) =>
        call(`/v1/agents/${agent}/scan`, {
          method: "POST",
          headers: { "x-owner-session": session },
        });
      const bobSession = async () => (await json(await start(2, "bob-token"))).token as string;

      /** Agent 2's runtime, funding address and a ledger with a deposit, charges and a reversal. */
      async function seedBob(spendable: bigint, runtime = "ready") {
        await t.db
          .insertInto("platform.agent_runtimes")
          .values({
            chain_id: env.chainId,
            agent_id: 2,
            generation: 1,
            status: runtime as "ready",
            tier: 1,
            species: 3,
            config: "{}",
            config_hash: "h",
            key_alias: "aa-unit-2",
            budget_usd: "0",
          })
          .execute();
        await t.db
          .insertInto("platform.funding_addresses")
          .values({
            chain_id: env.chainId,
            agent_id: 2,
            address: "0x00000000000000000000000000000000000f00d2",
            derivation_path: "m/44'/60'/0'/0/2",
          })
          .execute();
        let n = 0;
        const entry = async (
          kind: string,
          creditsDelta: bigint,
          source: Record<string, unknown>,
        ) => {
          n += 1;
          const id = `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
          await t.db
            .insertInto("platform.ledger_entries")
            .values({
              entry_id: id,
              chain_id: env.chainId,
              agent_id: 2,
              kind,
              idempotency_key: `k${n}`,
              occurred_at: new Date(),
              source: JSON.stringify(source),
              created_at: new Date(Date.now() + n * 1000),
            })
            .execute();
          // Credits owed are negative on agent_credits; the other side keeps the entry balanced.
          await t.db
            .insertInto("platform.ledger_lines")
            .values([
              {
                entry_id: id,
                line_no: 0,
                chain_id: env.chainId,
                agent_id: 2,
                account: "agent_credits",
                asset: "USDC",
                amount: (-creditsDelta).toString(),
              },
              {
                entry_id: id,
                line_no: 1,
                chain_id: env.chainId,
                agent_id: 2,
                account: kind === "credits_received" ? "funding_address" : "usage_unsettled",
                asset: "USDC",
                amount: creditsDelta.toString(),
              },
            ])
            .execute();
        };
        await entry("credits_received", spendable + 22_000n, { kind: "usdc_transfer" });
        await entry("usage_metered", -10_000n, { kind: "litellm_request", model: "scan-cheap" });
        await t.db
          .insertInto("platform.tool_calls")
          .values({
            call_id: "call-1",
            chain_id: env.chainId,
            agent_id: 2,
            lease_id: "L",
            server: "data",
            tool: "web_search",
            input: "{}",
            status: "failed",
          })
          .execute();
        await entry("usage_metered", -12_000n, {
          kind: "tool_call",
          callId: "call-1",
          tool: "web_search",
        });
        await entry("usage_reversed", 12_000n, { kind: "tool_call_failed", callId: "call-1" });
        await entry("usage_metered", -12_000n, {
          kind: "tool_call",
          callId: "call-1",
          tool: "web_search",
        });
      }

      it("shows the owner the run status, credits, spend, charges and the Scan estimate", async () => {
        await seedBob(1_000_000n);
        const res = await summary(2, await bobSession());
        expect(res.status).toBe(200);
        const body = await json(res);
        expect(body).toMatchObject({
          agentId: "2",
          wallet: BOB,
          runStatus: "ready",
          credits: { spendableUsdcE6: "1000000", restricted: false },
          spent24hUsdcE6: "22000",
          latestScan: null,
          scan: { minimumUsdcE6: "150000", estimateUsdcE6: { low: "150000", high: "300000" } },
        });
        expect(
          (body.charges as { kind: string; label: string; amountUsdcE6: string }[]).map((c) => [
            c.kind,
            c.label,
            c.amountUsdcE6,
          ]),
        ).toEqual([
          ["tool", "web_search", "12000"],
          ["reversal", "web_search", "-12000"],
          ["tool", "web_search", "12000"],
          ["model", "scan-cheap", "10000"],
        ]);
      });

      it("reports running while a lease is active, restricted at zero, and waiting before reveal", async () => {
        await seedBob(0n);
        const session = await bobSession();
        expect((await json(await summary(2, session))).runStatus).toBe("restricted");
        await t.db
          .insertInto("platform.sandbox_leases")
          .values({
            lease_id: "lease-1",
            chain_id: env.chainId,
            agent_id: 2,
            run_tag: "r",
            namespace: "unit",
            purpose: "scan",
            gate_token_hash: "h",
            status: "active",
            expires_at: new Date(Date.now() + 60_000),
          })
          .execute();
        expect((await json(await summary(2, session))).runStatus).toBe("running");
        chain.owners.set(3n, { owner: ALICE, epoch: 0n });
        const alice = (await json(await start(3, "alice-token"))).token as string;
        expect((await json(await summary(3, alice))).runStatus).toBe("awaiting_reveal");
      });

      it("never shows another wallet an owner's summary, nor lets it run a Scan", async () => {
        await seedBob(1_000_000n);
        expect((await summary(2, null)).status).toBe(401);
        // Alice owns agent 1, not 2: her session for agent 1 does not open agent 2.
        const alice = (await json(await start(1, "alice-token"))).token as string;
        const crossed = await summary(2, alice);
        expect([crossed.status, (await json(crossed)).error]).toEqual([403, "not_owner"]);
        expect((await scan(2, alice)).status).toBe(403);
        expect((await start(2, "alice-token")).status).toBe(403);
        expect(await t.db.selectFrom("platform.agent_tasks").selectAll().execute()).toEqual([]);
      });

      it("queues the owner's Scan once, and says why one is refused", async () => {
        const session = await bobSession();
        const none = await scan(2, session);
        expect([none.status, (await json(none)).error]).toEqual([409, "not_provisioned"]);
        await seedBob(140_000n);
        const low = await scan(2, session);
        const lowBody = await json(low);
        expect([low.status, lowBody.error]).toEqual([409, "credits_low"]);
        expect(lowBody.message).toMatch(/at least 0.15 USDC/);
        await t.db.deleteFrom("platform.ledger_lines").execute();
        await t.db.deleteFrom("platform.ledger_entries").execute();
        await t.db.deleteFrom("platform.agent_runtimes").execute();
        await t.db.deleteFrom("platform.funding_addresses").execute();
        await t.db.deleteFrom("platform.tool_calls").execute();
        await seedBob(1_000_000n);
        const ok = await scan(2, session);
        expect(ok.status).toBe(202);
        const { taskId } = await json(ok);
        const again = await scan(2, session);
        expect([again.status, (await json(again)).error]).toEqual([409, "scan_open"]);
        const tasks = await t.db.selectFrom("platform.agent_tasks").selectAll().execute();
        expect(tasks).toMatchObject([
          { task_id: taskId, kind: "scan", status: "queued", requested_by: "owner" },
        ]);
        expect((await json(await summary(2, session))).latestScan).toMatchObject({
          taskId,
          status: "queued",
          requestedBy: "owner",
        });
      });

      it("ends with the session: a transfer makes the summary and the Scan stale", async () => {
        await seedBob(1_000_000n);
        const session = await bobSession();
        chain.owners.set(2n, { owner: CAROL, epoch: 3n });
        expect((await json(await summary(2, session))).error).toBe("session_stale");
        expect((await json(await scan(2, session))).error).toBe("session_stale");
      });
    });

    describe("the trade flow (P2-U6)", () => {
      const FUNDING = getAddress("0x00000000000000000000000000000000000f00d2");
      const EXECUTOR = "0x00000000000000000000000000000000000e0ec0" as Address;
      const views = new Map<number, AgentChainView>();
      const portfolioReads: number[] = [];
      const trading = {
        executor: EXECUTOR,
        reader: { agent: async (id: number) => views.get(id) ?? null },
        portfolio: {
          portfolio: async (id: number) => {
            portfolioReads.push(id);
            return id === 2 ? PORTFOLIO : null;
          },
        },
      };
      const owner = (session: string, path: string, method = "GET") =>
        call(path, { method, headers: { "x-owner-session": session } }, { trading });
      const bobSession = async () => (await json(await start(2, "bob-token"))).token as string;
      const grant = (over: Partial<NonNullable<AgentChainView["grant"]>> = {}) => {
        views.set(2, {
          owner: BOB,
          ownerEpoch: 2n,
          configEpoch: 0n,
          timestamp: BigInt(Math.floor(now / 1000)),
          grant: {
            key: FUNDING,
            ownerEpoch: 2n,
            configEpoch: 0n,
            validUntil: BigInt(Math.floor(now / 1000) + 29 * 86_400),
            ...over,
          },
        });
      };
      let n = 0;
      async function intent() {
        n += 1;
        const id = `intent-00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
        await t.db
          .insertInto("platform.intents")
          .values({
            intent_id: id,
            chain_id: env.chainId,
            agent_id: 2,
            lease_id: "lease-1",
            kind: "swap",
            sell: "USDC",
            buy: "WMON",
            amount_in: "5000000",
            reason: "test",
            idempotency_key: `k-${n}`,
            status: "awaiting_approval",
            reason_codes: "[]",
            checks: "{}",
            owner_epoch: "2",
            config_epoch: "0",
            expires_at: new Date(now + 1_800_000),
          })
          .execute();
        return id;
      }

      beforeEach(async () => {
        views.clear();
        await t.db.deleteFrom("platform.intents").execute();
        await t.db.deleteFrom("platform.arming").execute();
        await t.db
          .insertInto("platform.funding_addresses")
          .values({
            chain_id: env.chainId,
            agent_id: 2,
            address: FUNDING.toLowerCase(),
            derivation_path: "m/44'/60'/0'/0/2",
          })
          .execute();
      });

      it("gives the owner the arming state and the wallet call that grants the funding address 30 days at most", async () => {
        const session = await bobSession();
        const res = await owner(session, "/v1/agents/2/arming");
        expect(res.status).toBe(200);
        const body = await json(res);
        expect(body).toMatchObject({
          arming: { state: "unarmed", ended: null },
          fundingAddress: FUNDING,
          maxGrantDays: 30,
          grantCall: { to: EXECUTOR, value: "0" },
        });
        const call = body.grantCall as { data: Hex };
        const decoded = decodeFunctionData({
          abi: parseAbi([
            "function registerSession(uint256 agentId, address key, uint64 validUntil)",
          ]),
          data: call.data,
        });
        expect(decoded.args[0]).toBe(2n);
        expect(decoded.args[1]).toBe(FUNDING);
        expect(decoded.args[2]).toBeLessThanOrEqual(BigInt(Math.floor(now / 1000) + 30 * 86_400));
      });

      it("dates the grant from the chain's clock, not the wall clock (L-105)", async () => {
        const session = await bobSession();
        grant();
        const view = views.get(2);
        // A fork: its block time sits weeks behind the wall clock.
        const chainNow = BigInt(Math.floor(now / 1000) - 40 * 86_400);
        if (view) views.set(2, { ...view, timestamp: chainNow });
        const body = await json(await owner(session, "/v1/agents/2/arming"));
        const decoded = decodeFunctionData({
          abi: parseAbi([
            "function registerSession(uint256 agentId, address key, uint64 validUntil)",
          ]),
          data: (body.grantCall as { data: Hex }).data,
        });
        expect(decoded.args[2]).toBe(chainNow + 30n * 86_400n - 60n);
      });

      it("records the arming only for a valid grant on chain, and renews it in place", async () => {
        const session = await bobSession();
        grant();
        const view = views.get(2);
        if (view) views.set(2, { ...view, grant: null });
        const none = await owner(session, "/v1/agents/2/arming", "POST");
        expect([none.status, (await json(none)).error]).toEqual([409, "grant_invalid"]);
        grant({ key: BOB });
        const other = await json(await owner(session, "/v1/agents/2/arming", "POST"));
        expect(other).toMatchObject({
          error: "grant_invalid",
          message: expect.stringMatching(/different key/),
        });
        grant();
        const res = await owner(session, "/v1/agents/2/arming", "POST");
        expect(res.status).toBe(201);
        expect(await json(res)).toMatchObject({ arming: { state: "awaiting_first_trade" } });
        grant({ validUntil: BigInt(Math.floor(now / 1000) + 29 * 86_400 + 60) });
        const again = await owner(session, "/v1/agents/2/arming", "POST");
        expect([again.status, (await json(again)).renewed]).toEqual([200, true]);
      });

      it("approves a waiting intent only once armed by a grant, and the first approval arms the agent", async () => {
        const session = await bobSession();
        const id = await intent();
        const early = await owner(session, `/v1/agents/2/intents/${id}/approve`, "POST");
        expect([early.status, (await json(early)).error]).toEqual([409, "not_armed"]);
        grant();
        await owner(session, "/v1/agents/2/arming", "POST");
        const ok = await owner(session, `/v1/agents/2/intents/${id}/approve`, "POST");
        expect(ok.status).toBe(200);
        expect(await json(ok)).toMatchObject({
          armed: true,
          intent: { status: "approved", approvedBy: "owner" },
        });
        const twice = await owner(session, `/v1/agents/2/intents/${id}/approve`, "POST");
        expect([twice.status, (await json(twice)).error]).toEqual([409, "not_waiting"]);
        const listed = await json(await owner(session, "/v1/agents/2/intents"));
        expect(listed.intents).toEqual([
          expect.objectContaining({
            intentId: id,
            status: "approved",
            sell: expect.objectContaining({ amount: "5" }),
          }),
        ]);
        expect((await json(await owner(session, "/v1/agents/2/arming"))).arming).toMatchObject({
          state: "armed",
          firstIntentId: id,
        });
      });

      it("disarms at once and hands back the revoke call for the owner's wallet", async () => {
        const session = await bobSession();
        grant();
        await owner(session, "/v1/agents/2/arming", "POST");
        const res = await json(await owner(session, "/v1/agents/2/disarm", "POST"));
        expect(res).toMatchObject({
          disarmed: true,
          arming: { state: "unarmed", ended: { reason: "disarmed" } },
          revokeCall: { to: EXECUTOR },
        });
        const decoded = decodeFunctionData({
          abi: parseAbi(["function revokeSession(uint256 agentId)"]),
          data: (res.revokeCall as { data: Hex }).data,
        });
        expect(decoded).toMatchObject({ functionName: "revokeSession", args: [2n] });
      });

      it("refuses every owner route to another wallet and to a stale session", async () => {
        const alice = (await json(await start(1, "alice-token"))).token as string;
        const id = await intent();
        for (const [path, method] of [
          ["/v1/agents/2/arming", "GET"],
          ["/v1/agents/2/arming", "POST"],
          ["/v1/agents/2/disarm", "POST"],
          ["/v1/agents/2/intents", "GET"],
          [`/v1/agents/2/intents/${id}/approve`, "POST"],
        ] as const) {
          const res = await owner(alice, path, method);
          expect([res.status, (await json(res)).error], path).toEqual([403, "not_owner"]);
          const none = await call(path, { method }, { trading });
          expect(none.status, path).toBe(401);
        }
        const session = await bobSession();
        chain.owners.set(2n, { owner: CAROL, epoch: 3n });
        const stale = await owner(session, `/v1/agents/2/intents/${id}/approve`, "POST");
        expect((await json(stale)).error).toBe("session_stale");
        expect(
          (await t.db.selectFrom("platform.intents").select("status").executeTakeFirst())?.status,
        ).toBe("awaiting_approval");
      });

      it("serves the portfolio to the owner only, and lets the owner reject a waiting intent (P2-U7)", async () => {
        const session = await bobSession();
        const res = await owner(session, "/v1/agents/2/portfolio");
        expect(res.status).toBe(200);
        expect((await json(res)).portfolio).toMatchObject({
          account: PORTFOLIO.account,
          balances: { usdcE6: "40000000", wmonWei: "0" },
          caps: { personalUsdcE6: "100000000", platformTotalUsdcE6: "250000000" },
          allowlist: { enabled: true, listed: true },
          prices: { monUsd: { reason: "OK" } },
        });
        const alice = (await json(await start(1, "alice-token"))).token as string;
        portfolioReads.length = 0;
        for (const s of [alice, ""]) {
          const other = await owner(s, "/v1/agents/2/portfolio");
          expect([401, 403]).toContain(other.status);
        }
        expect(portfolioReads).toEqual([]);
        const off = await call(
          "/v1/agents/2/portfolio",
          { headers: { "x-owner-session": session } },
          { trading: { ...trading, portfolio: null } },
        );
        expect([off.status, (await json(off)).error]).toEqual([503, "not_deployed"]);
        const id = await intent();
        const byAlice = await owner(alice, `/v1/agents/2/intents/${id}/reject`, "POST");
        expect(byAlice.status).toBe(403);
        const rejected = await owner(session, `/v1/agents/2/intents/${id}/reject`, "POST");
        expect(await json(rejected)).toMatchObject({ intent: { status: "cancelled" } });
        const again = await owner(session, `/v1/agents/2/intents/${id}/reject`, "POST");
        expect([again.status, (await json(again)).error]).toEqual([409, "not_waiting"]);
      });

      it("serves every balance at the agent's addresses to its owner only (D-315)", async () => {
        const reads: number[] = [];
        const holdings = {
          holdings: async (id: number, funding: Hex | null) => {
            reads.push(id);
            return {
              chainId: 10143,
              block: 9n,
              agentId: id,
              owner: BOB,
              addresses: [
                { role: "funding" as const, address: funding, native: 1n, tokens: [] },
                {
                  role: "token_bound" as const,
                  address: "0x487ff500699226631e477F54eaeF41537a5eccAA" as Hex,
                  native: 3n * 10n ** 18n,
                  tokens: [],
                },
                { role: "personal_account" as const, address: null, native: 0n, tokens: [] },
              ],
            };
          },
        };
        const session = await bobSession();
        const res = await call(
          "/v1/agents/2/holdings",
          { headers: { "x-owner-session": session } },
          { trading, holdings },
        );
        expect(res.status).toBe(200);
        const body = (await json(res)).holdings as {
          addresses: {
            role: string;
            holdings: { symbol: string; status: string; recoverCall: unknown }[];
          }[];
        };
        expect(body.addresses.map((a) => a.role)).toEqual([
          "funding",
          "token_bound",
          "personal_account",
        ]);
        expect(body.addresses[1]?.holdings[0]).toMatchObject({ symbol: "MON", status: "movable" });
        expect(body.addresses[1]?.holdings[0]?.recoverCall).toMatchObject({ value: "0" });
        reads.length = 0;
        const alice = (await json(await start(1, "alice-token"))).token as string;
        for (const s of [alice, ""]) {
          const other = await call(
            "/v1/agents/2/holdings",
            { headers: { "x-owner-session": s } },
            { trading, holdings },
          );
          expect([401, 403]).toContain(other.status);
        }
        expect(reads).toEqual([]);
        const off = await call(
          "/v1/agents/2/holdings",
          { headers: { "x-owner-session": session } },
          { trading, holdings: null },
        );
        expect([off.status, (await json(off)).error]).toEqual([503, "not_deployed"]);
      });

      it("asks for fresh prices before a deposit, for the owner only, where it is needed (P2-EC, D-307)", async () => {
        const session = await bobSession();
        const local = await owner(session, "/v1/agents/2/prices/fresh", "POST");
        expect(await json(local)).toEqual({ redated: [], error: null, needed: false });
        let calls = 0;
        const freshPrices = async () => {
          calls += 1;
          return { redated: [{ label: "USDC/USD" }], error: null };
        };
        const testnet = await call(
          "/v1/agents/2/prices/fresh",
          { method: "POST", headers: { "x-owner-session": session } },
          { trading, freshPrices },
        );
        expect(await json(testnet)).toEqual({
          redated: [{ label: "USDC/USD" }],
          error: null,
          needed: true,
        });
        const alice = (await json(await start(1, "alice-token"))).token as string;
        const other = await call(
          "/v1/agents/2/prices/fresh",
          { method: "POST", headers: { "x-owner-session": alice } },
          { trading, freshPrices },
        );
        expect(other.status).toBe(403);
        expect(calls).toBe(1);
      });

      it("says publicly why the agent did not trade", async () => {
        const res = await call("/v1/agents/2/why-not-traded");
        expect(res.status).toBe(200);
        expect(await json(res)).toMatchObject({
          armingState: "unarmed",
          reasons: [expect.objectContaining({ code: "NOT_ARMED", clears: "by_the_owner" })],
        });
      });
    });

    describe("credits (P1-U6)", () => {
      const FUNDING = "0x00000000000000000000000000000000000f00d2";
      const credit = async (amount: bigint, account = "agent_credits", n = 1) => {
        const id = `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
        await t.db
          .insertInto("platform.ledger_entries")
          .values({
            entry_id: id,
            chain_id: env.chainId,
            agent_id: 2,
            kind: "credits_received",
            idempotency_key: `test:${n}`,
            occurred_at: new Date(),
            source: "{}",
          })
          .execute();
        await t.db
          .insertInto("platform.ledger_lines")
          .values([
            {
              entry_id: id,
              line_no: 0,
              chain_id: env.chainId,
              agent_id: 2,
              account: "funding_address",
              asset: "USDC",
              amount: amount.toString(),
            },
            {
              entry_id: id,
              line_no: 1,
              chain_id: env.chainId,
              agent_id: 2,
              account,
              asset: "USDC",
              amount: (-amount).toString(),
            },
          ])
          .execute();
      };
      const refund = (session: string) =>
        call("/v1/agents/2/credits/refund", {
          method: "POST",
          headers: { "x-owner-session": session },
        });

      beforeEach(async () => {
        await t.db
          .insertInto("platform.funding_addresses")
          .values({
            chain_id: env.chainId,
            agent_id: 2,
            address: FUNDING,
            derivation_path: "m/44'/60'/0'/0/2",
          })
          .execute();
      });

      it("shows the funding address and balances from the ledger, to anyone", async () => {
        await credit(7_000_000n);
        await credit(2_000_000n, "held_deposits", 2);
        const res = await call("/v1/agents/2/credits");
        expect(res.status).toBe(200);
        expect(await json(res)).toMatchObject({
          creditCapUsdcE6: "50000000",
          fundingAddress: "0x00000000000000000000000000000000000F00d2",
          creditsUsdcE6: "7000000",
          spendableUsdcE6: "7000000",
          heldUsdcE6: "2000000",
          restricted: false,
        });
        expect((await call("/v1/agents/9/credits")).status).toBe(404);
      });

      it("shows only the owner's own share as refundable (D-242)", async () => {
        const sent = (n: number, from: string, value: string) =>
          t.db
            .insertInto("indexer.usdc_transfers")
            .values({
              chain_id: env.chainId,
              block_number: 200 + n,
              block_hash: `0x${n.toString(16).padStart(64, "0")}`,
              tx_hash: `0x${(n + 500).toString(16).padStart(64, "0")}`,
              log_index: 0,
              from_address: from.toLowerCase(),
              to_address: FUNDING.toLowerCase(),
              value,
              agent_id: 2,
              direction: "in",
              account: "funding",
            })
            .execute();
        await credit(8_000_000n);
        const own = async () =>
          ((await json(await call("/v1/agents/2/credits"))) as { ownRefundUsdcE6: string })
            .ownRefundUsdcE6;
        expect(await own()).toBe("0");
        await sent(1, BOB, "2000000");
        await sent(2, ALICE, "6000000");
        expect(await own()).toBe("2000000");
      });

      it("records the owner's refund under their wallet and epoch, one at a time", async () => {
        const { token } = await json(await start(2, "bob-token"));
        const res = await refund(token as string);
        expect(res.status).toBe(202);
        const body = await json(res);
        expect(body).toMatchObject({ wallet: BOB, ownerEpoch: "2" });
        const row = await t.db.selectFrom("platform.refunds").selectAll().executeTakeFirstOrThrow();
        expect(row).toMatchObject({
          owner: BOB.toLowerCase(),
          owner_epoch: 2,
          status: "requested",
          requested_by: "owner",
        });
        const again = await refund(token as string);
        expect([again.status, (await json(again)).error]).toEqual([409, "refund_open"]);
        const seen = await call(`/v1/agents/2/credits/refunds/${String(body.refundId)}`);
        expect(await json(seen)).toMatchObject({ status: "requested", owner: BOB });
      });

      it("refuses a refund without a session, from someone else, or after the agent changed hands", async () => {
        expect((await call("/v1/agents/2/credits/refund", { method: "POST" })).status).toBe(401);
        const { token: alice } = await json(await start(1, "alice-token"));
        expect((await refund(alice as string)).status).toBe(403);
        const { token } = await json(await start(2, "bob-token"));
        chain.owners.set(2n, { owner: BOB, epoch: 3n }); // a stale ownership epoch
        const stale = await refund(token as string);
        expect([stale.status, (await json(stale)).error]).toEqual([403, "session_stale"]);
        expect(await t.db.selectFrom("platform.refunds").selectAll().execute()).toEqual([]);
      });
    });

    it("an expired, forged or other agent's session is refused", async () => {
      const { token } = await json(await start(1, "alice-token"));
      expect((await ownerView(2, token as string)).status).toBe(403);
      expect((await call("/v1/agents/1/owner")).status).toBe(401);
      expect((await ownerView(1, "not-a-jwt")).status).toBe(401);
      const other = await createApp(
        deps({ sessionSecret: "another-secret-0123456789abcdef0123" }),
      ).request("/v1/agents/1/owner", { headers: { "x-owner-session": token as string } });
      expect(other.status).toBe(401);
      now += 16 * 60 * 1000;
      expect((await ownerView(1, token as string)).status).toBe(401);
    });
  });

  describe("CORS and errors", () => {
    it("answers the web app's origin and no other", async () => {
      const ok = await call("/v1/supply", { headers: { origin: "http://localhost:3000" } });
      expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
      const other = await call("/v1/supply", { headers: { origin: "https://evil.example" } });
      expect(other.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("an internal error says nothing about the database", async () => {
      const broken = {
        ...t.db,
        selectFrom: () => {
          throw new Error("connect to postgres://alpha:pw@host failed");
        },
      };
      const res = await call("/v1/supply", {}, { db: broken as never });
      expect(res.status).toBe(500);
      expect(await res.text()).not.toMatch(/postgres|pw@/);
    });
  });
});
