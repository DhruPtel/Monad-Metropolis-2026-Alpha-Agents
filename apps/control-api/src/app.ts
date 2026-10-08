import { SCAN_COST_ESTIMATE_USDC_E6, SCAN_MIN_CREDITS_USDC_E6 } from "@alpha-agents/accounting";
import type { Environment } from "@alpha-agents/config";
import type { Db } from "@alpha-agents/db";
import type { AgentNftDeployment } from "@alpha-agents/domain";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { type Address, type Hex, getAddress, isAddress, isAddressEqual } from "viem";
import {
  type AgentViewReader,
  TradeStore,
  approveByOwner,
  armingJson,
  confirmArming,
  disarm,
  intentJson,
  registerCall,
  revokeCall,
  MAX_GRANT_SECONDS,
} from "@alpha-agents/trading";
import { TtlCache } from "./cache.ts";
import type { ChainReader } from "./chain.ts";
import { type ClaimSigner, ELIGIBILITY_MESSAGES, type Eligibility, signClaim } from "./claims.ts";
import type { Identity, VerifiedSession } from "./identity.ts";
import { issueOwnerSession, readOwnerSession } from "./owner-session.ts";
import {
  type SupplyJson,
  type WatermarkView,
  getAgent,
  insertRefund,
  isAllowlisted,
  listAgents,
  readActivity,
  readCredits,
  readSummary,
  requestScan,
  readRefund,
  readSupply,
  readWatermark,
} from "./queries.ts";

/**
 * The control API (P1-U4). Index reads (agents, supply) are public and cached
 * for a moment; identity comes from a Privy access token; owner-only actions
 * use an owner session checked against a fresh chain read; the mint claim is
 * signed only for a linked, allowlisted wallet that has not minted.
 *
 * Nothing here logs a token, a key or a URL. Error bodies are
 * `{ error, message }` with a stable code.
 */
export interface ApiDeps {
  readonly db: Db;
  readonly environment: Environment;
  /** AgentNFT here, or null where it is not deployed. */
  readonly deployment: AgentNftDeployment | null;
  readonly chain: ChainReader | null;
  /** Null when login is not configured: every route that needs it answers 503. */
  readonly identity: Identity | null;
  /** Null when the claim key is not configured: the claim route answers 503. */
  readonly signer: ClaimSigner | null;
  readonly sessionSecret: string;
  readonly allowOrigin: (origin: string) => boolean;
  /** Milliseconds. */
  readonly now: () => number;
  readonly randomNonce: () => Hex;
  /** How long index reads are cached. */
  readonly cacheMs?: number;
  /**
   * P2-U6: fresh reads of the agent's grant and epochs, and the Executor the
   * owner's wallet calls; null where the trading contracts are not deployed.
   */
  readonly trading?: { readonly reader: AgentViewReader; readonly executor: Hex } | null;
}

export type ApiError =
  | "bad_request"
  | "not_found"
  | "not_deployed"
  | "not_configured"
  | "missing_token"
  | "invalid_token"
  | "privy_unavailable"
  | "wallet_not_linked"
  | "not_owner"
  | "session_stale"
  | "refund_open"
  | "not_provisioned"
  | "credits_low"
  | "scan_open"
  | "not_armed"
  | "not_waiting"
  | "grant_invalid"
  | "no_funding_address"
  | Eligibility;

const fail = (c: Context, status: number, error: ApiError, message: string) =>
  c.json({ error, message }, status as 400);

function bearer(c: Context): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "");
  return match?.[1] ?? null;
}

export function createApp(deps: ApiDeps): Hono {
  const app = new Hono();
  const chainId = deps.environment.chainId;
  const nowSeconds = () => Math.floor(deps.now() / 1000);
  const cache = new TtlCache<unknown>(deps.cacheMs ?? 1_000, deps.now);
  const cached = <T>(key: string, load: () => Promise<T>) => cache.get(key, load) as Promise<T>;
  const watermark = () =>
    cached<WatermarkView | null>("watermark", () => readWatermark(deps.db, chainId));
  const meta = async () => ({
    environment: deps.environment.label,
    chainId,
    watermark: await watermark(),
  });

  app.use(
    "*",
    cors({
      origin: (origin) => (deps.allowOrigin(origin) ? origin : null),
      allowHeaders: ["authorization", "content-type", "x-owner-session"],
      allowMethods: ["GET", "POST", "OPTIONS"],
      maxAge: 600,
    }),
  );
  app.use("*", async (c, next) => {
    await next();
    if (!c.res.headers.has("cache-control")) c.header("cache-control", "no-store");
  });

  app.get("/health", async (c) =>
    c.json({
      ok: true,
      environment: deps.environment.label,
      chainId,
      agentNft: deps.deployment?.address ?? null,
      watermark: await watermark(),
    }),
  );

  /** Who the caller is, from their Privy token; or a response that says why not. */
  async function caller(c: Context): Promise<VerifiedSession | Response> {
    if (!deps.identity) {
      return fail(
        c,
        503,
        "not_configured",
        "Login is not configured: set PRIVY_APP_ID and PRIVY_APP_SECRET.",
      );
    }
    const token = bearer(c);
    if (!token) return fail(c, 401, "missing_token", "Log in first.");
    try {
      return await deps.identity.verify(token);
    } catch {
      // Never say why a token failed, so the route cannot probe the verifier.
      return fail(c, 401, "invalid_token", "Log in first.");
    }
  }

  async function linkedWallets(
    c: Context,
    session: VerifiedSession,
  ): Promise<readonly string[] | Response> {
    try {
      return await (deps.identity as Identity).walletsOf(session);
    } catch {
      return fail(
        c,
        503,
        "privy_unavailable",
        "Could not read your linked wallets from Privy. Check PRIVY_APP_SECRET is the real secret, not the dashboard's masked copy.",
      );
    }
  }

  // --- Session -------------------------------------------------------------

  app.get("/v1/session", async (c) => {
    const session = await caller(c);
    if (session instanceof Response) return session;
    const wallets = await linkedWallets(c, session);
    if (wallets instanceof Response) return wallets;
    return c.json({ ...session, wallets: wallets.map((w) => getAddress(w)) });
  });

  // --- Index reads ---------------------------------------------------------

  app.get("/v1/supply", async (c) => {
    const supply = await cached<SupplyJson>("supply", () => readSupply(deps.db, chainId));
    c.header("cache-control", "public, max-age=1");
    return c.json({ ...(await meta()), ...supply });
  });

  app.get("/v1/agents", async (c) => {
    const owner = c.req.query("owner");
    const minter = c.req.query("minter");
    for (const a of [owner, minter]) {
      if (a !== undefined && !isAddress(a, { strict: false })) {
        return fail(c, 400, "bad_request", "owner and minter must be addresses.");
      }
    }
    const filter = { ...(owner ? { owner } : {}), ...(minter ? { minter } : {}) };
    const agents = await cached(`agents:${JSON.stringify(filter)}`, () =>
      listAgents(deps.db, chainId, filter),
    );
    c.header("cache-control", "public, max-age=1");
    return c.json({ ...(await meta()), agents });
  });

  app.get("/v1/agents/:id{[0-9]+}", async (c) => {
    const id = Number(c.req.param("id"));
    const agent = await cached(`agent:${id}`, () => getAgent(deps.db, chainId, id));
    if (!agent) return fail(c, 404, "not_found", `Agent #${id} is not in the index.`);
    c.header("cache-control", "public, max-age=1");
    return c.json({ ...(await meta()), agent });
  });

  // --- Owner sessions (D-199) ---------------------------------------------

  app.post("/v1/agents/:id{[0-9]+}/session", async (c) => {
    const session = await caller(c);
    if (session instanceof Response) return session;
    if (!deps.chain)
      return fail(c, 503, "not_deployed", `AgentNFT is not deployed on ${deps.environment.label}.`);
    const agentId = BigInt(c.req.param("id"));
    const ownership = await deps.chain.ownership(agentId);
    if (!ownership) return fail(c, 404, "not_found", `Agent #${agentId} does not exist.`);
    const wallets = await linkedWallets(c, session);
    if (wallets instanceof Response) return wallets;
    if (!wallets.some((w) => isAddressEqual(w as Address, ownership.owner))) {
      return fail(c, 403, "not_owner", `None of your linked wallets owns agent #${agentId}.`);
    }
    const issued = await issueOwnerSession(
      deps.sessionSecret,
      {
        wallet: ownership.owner,
        agentId,
        ownerEpoch: ownership.epoch,
        chainId,
        userId: session.userId,
      },
      nowSeconds(),
    );
    return c.json({
      token: issued.token,
      expiresAt: issued.expiresAt,
      wallet: ownership.owner,
      agentId: agentId.toString(),
      ownerEpoch: ownership.epoch.toString(),
    });
  });

  /**
   * The owner check every owner-only action uses: a valid owner session for
   * this agent, and a fresh chain read that still shows the session's wallet
   * as owner at the session's ownership epoch.
   */
  async function ownerOnly(
    c: Context,
    agentId: bigint,
  ): Promise<{ wallet: Address; epoch: bigint } | Response> {
    const token = c.req.header("x-owner-session");
    if (!token)
      return fail(c, 401, "missing_token", "Start an owner session for this agent first.");
    let claims;
    try {
      claims = await readOwnerSession(deps.sessionSecret, token, nowSeconds());
    } catch {
      return fail(
        c,
        401,
        "invalid_token",
        "The owner session is invalid or expired; start a new one.",
      );
    }
    if (claims.agentId !== agentId || claims.chainId !== chainId) {
      return fail(c, 403, "not_owner", "This owner session is for another agent.");
    }
    if (!deps.chain)
      return fail(c, 503, "not_deployed", `AgentNFT is not deployed on ${deps.environment.label}.`);
    // A fresh read decides: the index may lag, and ownership is the whole control model.
    const ownership = await deps.chain.ownership(agentId);
    if (!ownership || !isAddressEqual(ownership.owner, claims.wallet)) {
      return fail(
        c,
        403,
        "session_stale",
        `Agent #${agentId} has a new owner; this session has ended.`,
      );
    }
    if (ownership.epoch !== claims.ownerEpoch) {
      return fail(
        c,
        403,
        "session_stale",
        `Agent #${agentId} changed hands since this session began; it has ended.`,
      );
    }
    return { wallet: claims.wallet, epoch: ownership.epoch };
  }

  /** The owner-only view of an agent: the gate every later owner-only action uses. */
  app.get("/v1/agents/:id{[0-9]+}/owner", async (c) => {
    const agentId = BigInt(c.req.param("id"));
    const owner = await ownerOnly(c, agentId);
    if (owner instanceof Response) return owner;
    const agent = await getAgent(deps.db, chainId, Number(agentId));
    return c.json({
      ...(await meta()),
      agentId: agentId.toString(),
      wallet: owner.wallet,
      ownerEpoch: owner.epoch.toString(),
      agent,
    });
  });

  // --- Activity (P1-U7, D-217) ---------------------------------------------

  /** An agent's activity feed: public, as on the agent profile (FINAL_PLAN 4.10). */
  app.get("/v1/agents/:id{[0-9]+}/activity", async (c) => {
    const agentId = Number(c.req.param("id"));
    const entries = await cached(`activity:${agentId}`, () =>
      readActivity(deps.db, chainId, agentId),
    );
    c.header("cache-control", "public, max-age=1");
    return c.json({ ...(await meta()), agentId: String(agentId), entries });
  });

  // --- Credits (P1-U6, D-208, D-210) ---------------------------------------

  /** An agent's funding address and credits. Public: the funding address's USDC is on chain anyway. */
  app.get("/v1/agents/:id{[0-9]+}/credits", async (c) => {
    const agentId = Number(c.req.param("id"));
    const view = await readCredits(deps.db, chainId, agentId);
    if (!view) return fail(c, 404, "not_found", `Agent #${agentId} has no funding address yet.`);
    return c.json({ ...(await meta()), agentId: String(agentId), ...view });
  });

  /**
   * The owner asks for their agent's remaining credits back. The request is
   * recorded under the session's wallet and ownership epoch; the orchestrator
   * rechecks both on chain before it pays, so a sale in between refuses it.
   */
  app.post("/v1/agents/:id{[0-9]+}/credits/refund", async (c) => {
    const agentId = BigInt(c.req.param("id"));
    const owner = await ownerOnly(c, agentId);
    if (owner instanceof Response) return owner;
    const result = await insertRefund(deps.db, chainId, Number(agentId), owner.wallet, owner.epoch);
    if (result === "open")
      return fail(c, 409, "refund_open", `Agent #${agentId} already has a refund in progress.`);
    return c.json(
      { refundId: result, wallet: owner.wallet, ownerEpoch: owner.epoch.toString() },
      202,
    );
  });

  app.get("/v1/agents/:id{[0-9]+}/credits/refunds/:refundId", async (c) => {
    const refund = await readRefund(
      deps.db,
      chainId,
      Number(c.req.param("id")),
      c.req.param("refundId"),
    );
    if (!refund) return fail(c, 404, "not_found", "No such refund for this agent.");
    return c.json(refund);
  });

  // --- My Agents (P1-U9, D-218, D-219) -------------------------------------

  /**
   * Everything the owner's My Agents card needs that is not public: what the
   * agent is doing, its spend and charges, and its latest Scan. Owner only.
   */
  app.get("/v1/agents/:id{[0-9]+}/summary", async (c) => {
    const agentId = BigInt(c.req.param("id"));
    const owner = await ownerOnly(c, agentId);
    if (owner instanceof Response) return owner;
    const summary = await readSummary(deps.db, chainId, Number(agentId));
    return c.json({
      ...(await meta()),
      agentId: agentId.toString(),
      wallet: owner.wallet,
      ownerEpoch: owner.epoch.toString(),
      ...summary,
      scan: {
        minimumUsdcE6: SCAN_MIN_CREDITS_USDC_E6.toString(),
        estimateUsdcE6: {
          low: SCAN_COST_ESTIMATE_USDC_E6.low.toString(),
          high: SCAN_COST_ESTIMATE_USDC_E6.high.toString(),
        },
      },
    });
  });

  /** The owner asks for a Scan now; the orchestrator queues it within seconds (D-219). */
  app.post("/v1/agents/:id{[0-9]+}/scan", async (c) => {
    const agentId = BigInt(c.req.param("id"));
    const owner = await ownerOnly(c, agentId);
    if (owner instanceof Response) return owner;
    const result = await requestScan(deps.db, chainId, Number(agentId), SCAN_MIN_CREDITS_USDC_E6);
    if ("taskId" in result) return c.json({ taskId: result.taskId }, 202);
    const minimum = `${Number(SCAN_MIN_CREDITS_USDC_E6) / 1e6}`;
    const message = {
      not_provisioned: `Agent #${agentId} is not set up to run yet; try again in a minute.`,
      credits_low: `A Scan needs at least ${minimum} USDC of credits. Add USDC to the funding address.`,
      scan_open: `Agent #${agentId} already has a Scan queued or running.`,
    }[result.refused];
    return fail(c, 409, result.refused, message);
  });

  // --- The trade flow (P2-U6) ----------------------------------------------

  const trades = new TradeStore(deps.db, () => new Date(deps.now()));
  const REFUSAL_STATUS = {
    NOT_FOUND: [404, "not_found"],
    NOT_ARMED: [409, "not_armed"],
    NOT_WAITING: [409, "not_waiting"],
    GRANT_INVALID: [409, "grant_invalid"],
    NO_FUNDING_ADDRESS: [409, "no_funding_address"],
  } as const;
  const refused = (c: Context, r: { code: keyof typeof REFUSAL_STATUS; message: string }) =>
    fail(c, REFUSAL_STATUS[r.code][0], REFUSAL_STATUS[r.code][1], r.message);

  async function fundingAddressOf(agentId: number): Promise<Hex | null> {
    const row = await deps.db
      .selectFrom("platform.funding_addresses")
      .select("address")
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .executeTakeFirst();
    return row ? getAddress(row.address) : null;
  }

  /**
   * The agent's arming for its owner, and the wallet call that arms it: a
   * session grant to the agent's funding address for at most 30 days.
   */
  app.get("/v1/agents/:id{[0-9]+}/arming", async (c) => {
    const agentId = BigInt(c.req.param("id"));
    const owner = await ownerOnly(c, agentId);
    if (owner instanceof Response) return owner;
    const id = Number(agentId);
    const funding = await fundingAddressOf(id);
    const t = deps.trading;
    const validUntil = BigInt(nowSeconds() + MAX_GRANT_SECONDS - 60);
    return c.json({
      ...(await meta()),
      agentId: agentId.toString(),
      arming: armingJson(await trades.lastArming(chainId, id), nowSeconds()),
      fundingAddress: funding,
      grantCall: t && funding ? registerCall(t.executor, id, funding, validUntil) : null,
      maxGrantDays: MAX_GRANT_SECONDS / 86_400,
    });
  });

  /** The owner's wallet registered the grant: check it on chain and record the arming. */
  app.post("/v1/agents/:id{[0-9]+}/arming", async (c) => {
    const agentId = BigInt(c.req.param("id"));
    const owner = await ownerOnly(c, agentId);
    if (owner instanceof Response) return owner;
    const t = deps.trading;
    if (!t)
      return fail(c, 503, "not_deployed", `Trading is not deployed on ${deps.environment.label}.`);
    const id = Number(agentId);
    const r = await confirmArming(trades, await t.reader.agent(id), {
      chainId,
      agentId: id,
      owner: owner.wallet,
      fundingAddress: await fundingAddressOf(id),
    });
    if (!r.ok) return refused(c, r);
    return c.json(
      {
        agentId: agentId.toString(),
        renewed: r.renewed,
        arming: armingJson(r.record, nowSeconds()),
      },
      r.renewed ? 200 : 201,
    );
  });

  /**
   * The owner disarms the agent: arming ends now, and the answer carries the
   * wallet call that revokes the grant on chain.
   */
  app.post("/v1/agents/:id{[0-9]+}/disarm", async (c) => {
    const agentId = BigInt(c.req.param("id"));
    const owner = await ownerOnly(c, agentId);
    if (owner instanceof Response) return owner;
    const id = Number(agentId);
    const ended = await disarm(trades, chainId, id);
    return c.json({
      agentId: agentId.toString(),
      disarmed: ended !== null,
      arming: armingJson(ended ?? (await trades.lastArming(chainId, id)), nowSeconds()),
      revokeCall: deps.trading ? revokeCall(deps.trading.executor, id) : null,
    });
  });

  /** The agent's intents for its owner, newest first, with every state and reason. */
  app.get("/v1/agents/:id{[0-9]+}/intents", async (c) => {
    const agentId = BigInt(c.req.param("id"));
    const owner = await ownerOnly(c, agentId);
    if (owner instanceof Response) return owner;
    const intents = await trades.intents(chainId, Number(agentId), 50);
    return c.json({
      ...(await meta()),
      agentId: agentId.toString(),
      intents: intents.map(intentJson),
    });
  });

  /** The owner approves one waiting intent; the first approval after the grant arms the agent. */
  app.post("/v1/agents/:id{[0-9]+}/intents/:intentId{intent-[0-9a-f-]{36}}/approve", async (c) => {
    const agentId = BigInt(c.req.param("id"));
    const owner = await ownerOnly(c, agentId);
    if (owner instanceof Response) return owner;
    const r = await approveByOwner(trades, chainId, Number(agentId), c.req.param("intentId"));
    if (!r.ok) return refused(c, r);
    return c.json({
      agentId: agentId.toString(),
      intent: intentJson(r.intent),
      armed: r.armed !== null,
    });
  });

  /**
   * Why the agent did not trade: whether it is armed (and why arming ended),
   * and every reason its recent trades were blocked, with when each may
   * clear. Public, like the activity feed.
   */
  app.get("/v1/agents/:id{[0-9]+}/why-not-traded", async (c) => {
    const agentId = Number(c.req.param("id"));
    const why = await trades.whyNotTraded(chainId, agentId);
    return c.json({ ...(await meta()), agentId: String(agentId), ...why });
  });

  // --- Mint eligibility and claims (D-198) ---------------------------------

  /** Who may mint: the caller, for one of their linked wallets. */
  async function mintCheck(
    c: Context,
    rawWallet: unknown,
  ): Promise<{ wallet: Address; session: VerifiedSession; eligibility: Eligibility } | Response> {
    if (!deps.deployment || !deps.chain) {
      return fail(
        c,
        503,
        "not_deployed",
        `AgentNFT is not deployed on ${deps.environment.label} yet.`,
      );
    }
    const session = await caller(c);
    if (session instanceof Response) return session;
    if (typeof rawWallet !== "string" || !isAddress(rawWallet, { strict: false })) {
      return fail(c, 400, "bad_request", "Say which wallet to mint for.");
    }
    const wallet = getAddress(rawWallet);
    const wallets = await linkedWallets(c, session);
    if (wallets instanceof Response) return wallets;
    if (!wallets.some((w) => isAddressEqual(w as Address, wallet))) {
      return fail(c, 403, "wallet_not_linked", "That wallet is not linked to your login.");
    }
    let eligibility: Eligibility = "eligible";
    if (!(await isAllowlisted(deps.db, wallet))) eligibility = "not_allowlisted";
    else if (await deps.chain.hasMinted(wallet)) eligibility = "already_minted";
    else if ((await deps.chain.totalMinted()) >= (await deps.chain.maxSupply()))
      eligibility = "sold_out";
    return { wallet, session, eligibility };
  }

  app.get("/v1/mint/eligibility", async (c) => {
    const check = await mintCheck(c, c.req.query("wallet"));
    if (check instanceof Response) return check;
    return c.json({
      wallet: check.wallet,
      eligible: check.eligibility === "eligible",
      reason: check.eligibility,
      message: ELIGIBILITY_MESSAGES[check.eligibility],
    });
  });

  app.post("/v1/mint/claim", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { wallet?: unknown } | null;
    const check = await mintCheck(c, body?.wallet);
    if (check instanceof Response) return check;
    if (check.eligibility !== "eligible") {
      return fail(
        c,
        check.eligibility === "not_allowlisted" ? 403 : 409,
        check.eligibility,
        ELIGIBILITY_MESSAGES[check.eligibility],
      );
    }
    if (!deps.signer) {
      return fail(
        c,
        503,
        "not_configured",
        "Minting is not configured: set CLAIM_SIGNER_PRIVATE_KEY for the control API.",
      );
    }
    const deployment = deps.deployment as AgentNftDeployment;
    const claim = await signClaim(deps.signer, {
      wallet: check.wallet,
      contract: deployment.address,
      chainId,
      nonce: deps.randomNonce(),
      nowSeconds: nowSeconds(),
    });
    await deps.db
      .insertInto("platform.mint_claims")
      .values({
        nonce: claim.nonce,
        wallet: check.wallet.toLowerCase(),
        chain_id: chainId,
        contract: deployment.address.toLowerCase(),
        deadline: Number(claim.deadline),
        user_id: check.session.userId,
      })
      .execute();
    return c.json(claim);
  });

  app.notFound((c) => fail(c, 404, "not_found", "No such route."));
  app.onError((err, c) => {
    // The message of an internal error can name a database or RPC; never send it.
    console.error(`control-api: ${c.req.method} ${c.req.path} failed: ${err.name}`);
    return c.json({ error: "internal", message: "The control API hit an error." }, 500);
  });
  return app;
}
