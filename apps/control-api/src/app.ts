import {
  CREDIT_CAP_USDC_E6,
  SCAN_COST_ESTIMATE_USDC_E6,
  SCAN_MIN_CREDITS_USDC_E6,
} from "@alpha-agents/accounting";
import type { Environment } from "@alpha-agents/config";
import type { Db } from "@alpha-agents/db";
import type { AgentNftDeployment, CustodyPath } from "@alpha-agents/domain";
import { type Context, Hono } from "hono";
import {
  type ProposalDeps,
  type ProposalStores,
  approveProposal,
  declineProposal,
  planCard,
  proposalJson,
} from "./proposals.ts";
import type { ActivationDeps } from "./activation.ts";
import type { WindowDeps } from "./window.ts";
import type { ResearchDeps } from "./research.ts";
import { cors } from "hono/cors";
import { type Address, type Hex, getAddress, isAddress, isAddressEqual } from "viem";
import { translateGoal } from "@alpha-agents/policy";
import {
  ActivationStore,
  type AgentViewReader,
  type CustodyPathReader,
  GoalStore,
  type HoldingsReader,
  MAX_GRANT_SECONDS,
  type PortfolioReader,
  type PortfolioReaderV3,
  portfolioV3Json,
  TradeStore,
  approveByOwner,
  armingJson,
  confirmArming,
  disarm,
  holdingsJson,
  intentJson,
  portfolioJson,
  registerCall,
  rejectByOwner,
  revokeCall,
  PlanStore,
  ProposalStore,
  SnapshotStore,
  WINDOW_INTENT_LIMIT,
  WINDOW_SNAPSHOT_LIMIT,
  buildWindow,
  isPortfolioPlan,
} from "@alpha-agents/trading";
import { TtlCache } from "./cache.ts";
import {
  goalErrorsJson,
  goalForm,
  goalSummaryJson,
  goalViewJson,
  configJson,
  tokenSymbols,
} from "./goals.ts";
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
  /**
   * P2-EC (D-307): re-dates testnet's feeds through the orchestrator before an
   * owner's deposit; absent elsewhere, where prices need no help (LocalFeed's
   * refresher on the fork, Chainlink on mainnet).
   */
  readonly freshPrices?: () => Promise<{ redated: unknown[]; error: string | null }>;
  /**
   * F-U9: the evaluator's re-check at approval time, through the orchestrator's Test stage v2;
   * absent where no orchestrator is reachable, and a portfolio approval then waits.
   */
  readonly proposals?: ProposalDeps | null;
  /**
   * F-U10: the activation sweep, read and started through the orchestrator;
   * absent where no orchestrator is reachable, and the routes answer 503.
   */
  readonly activation?: ActivationDeps | null;
  /**
   * F-U11: the window's live account reading through the orchestrator; absent
   * where none is reachable, and the window shows the latest snapshot instead.
   */
  readonly window?: WindowDeps | null;
  /**
   * P3-U10: the research loop and the agent terminal through the orchestrator;
   * absent where none is reachable, and the routes answer 503.
   */
  readonly research?: ResearchDeps | null;
  /** D-315: every balance at the agent's addresses; null where AgentNFT is not deployed. */
  readonly holdings?: HoldingsReader | null;
  /** How long index reads are cached. */
  readonly cacheMs?: number;
  /**
   * P2-U6: fresh reads of the agent's grant and epochs, and the Executor the
   * owner's wallet calls; null where the trading contracts are not deployed.
   */
  readonly trading?: {
    readonly reader: AgentViewReader;
    readonly executor: Hex;
    /** P2-U7: the owner's portfolio read from the chain; absent where custody is not deployed. */
    readonly portfolio?: PortfolioReader | null;
    /** F-U5 (D-367): the fund agent's set, where deployed: Executor v3, its grant reader and the agent's path. */
    readonly v3?: {
      readonly executor: Hex;
      readonly reader: AgentViewReader;
      readonly paths: CustodyPathReader;
      /** A-80: the owner's portfolio on the fund agent's set, which every agent is on where it is deployed. */
      readonly portfolio?: PortfolioReaderV3 | null;
    } | null;
  } | null;
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
  | "not_waiting"
  | "proposal_stale"
  | "proposal_rejected"
  | "not_provisioned"
  | "credits_low"
  | "scan_open"
  | "not_armed"
  | "not_waiting"
  | "grant_invalid"
  | "no_funding_address"
  | "goal_refused"
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
      allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
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
  /** The excluded token addresses a goal body names, for the brief's symbols; nothing else is read. */
  const excludedAddresses = (body: unknown): string[] => {
    const list = (body as { excludedTokens?: unknown } | null)?.excludedTokens;
    return Array.isArray(list) ? list.filter((t): t is string => typeof t === "string") : [];
  };

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

  // --- The goal (P3-U1) -----------------------------------------------------

  const goals = new GoalStore(deps.db);

  /** A JSON body, or null when it is not JSON. */
  const jsonBody = async (c: Context): Promise<unknown> => c.req.json().catch(() => null);

  /**
   * The owner's goal and the agent's state, with the form's ranges and the
   * cost preview. Owner only, after a fresh chain read; a goal another owner
   * saved does not apply (the agent reads UNCONFIGURED).
   */
  app.get("/v1/agents/:id{[0-9]+}/goal", async (c) => {
    const agentId = BigInt(c.req.param("id"));
    const owner = await ownerOnly(c, agentId);
    if (owner instanceof Response) return owner;
    const view = await goals.view(chainId, Number(agentId), owner.epoch);
    // F-U12: the screened-lane opt-in as the chain records it, for the page's onchain step.
    const v3 = deps.trading?.v3?.portfolio;
    const reading = v3 ? await v3.portfolio(Number(agentId)).catch(() => null) : null;
    return c.json({
      ...(await meta()),
      agentId: agentId.toString(),
      ownerEpoch: owner.epoch.toString(),
      ...goalViewJson(view),
      form: await goalForm(deps.db, chainId),
      chain: reading
        ? { account: reading.account, screenedOptIn: reading.screenedOptIn, mode: reading.mode }
        : null,
    });
  });

  /**
   * Saves the owner's goal: structured fields only, translated by
   * packages/policy, refused with every field's reason when anything would
   * loosen a hard limit. Saving bumps the strategy epoch and moves an
   * UNCONFIGURED agent to READY; it never touches arming (D-281).
   */
  app.put("/v1/agents/:id{[0-9]+}/goal", async (c) => {
    const agentId = BigInt(c.req.param("id"));
    const owner = await ownerOnly(c, agentId);
    if (owner instanceof Response) return owner;
    const body = await jsonBody(c);
    if (body === null) return fail(c, 400, "bad_request", "Send the goal as JSON.");
    const translated = translateGoal(body, undefined, {
      symbols: await tokenSymbols(deps.db, chainId, excludedAddresses(body)),
    });
    if (!translated.ok)
      return c.json(
        {
          error: "goal_refused" satisfies ApiError,
          message: "The goal was not saved; fix the fields named below.",
          errors: goalErrorsJson(translated.errors),
        },
        400,
      );
    const saved = await goals.save({
      chainId,
      agentId: Number(agentId),
      ownerEpoch: owner.epoch,
      savedBy: owner.wallet,
      config: translated.config,
    });
    return c.json({
      ...(await meta()),
      agentId: agentId.toString(),
      ownerEpoch: owner.epoch.toString(),
      ...goalViewJson(saved),
      stateChange: saved.changed
        ? { from: saved.changed.from, to: saved.changed.to, reason: saved.changed.reason }
        : null,
    });
  });

  /**
   * What a goal would set, without saving it: the same translator, so the page
   * shows the effective limits and the plan's range as the owner edits. Public:
   * it reads nothing about any agent.
   */
  app.post("/v1/goal/preview", async (c) => {
    const body = await jsonBody(c);
    if (body === null) return fail(c, 400, "bad_request", "Send the goal as JSON.");
    const translated = translateGoal(body, undefined, {
      symbols: await tokenSymbols(deps.db, chainId, excludedAddresses(body)),
    });
    return translated.ok
      ? c.json({ ok: true, config: configJson(translated.config), errors: [] })
      : c.json({ ok: false, config: null, errors: goalErrorsJson(translated.errors) });
  });

  /** The public goal summary (FINAL_PLAN 6.1): template and risk preset only. */
  app.get("/v1/agents/:id{[0-9]+}/goal/summary", async (c) => {
    const agentId = BigInt(c.req.param("id"));
    if (!deps.chain)
      return fail(c, 503, "not_deployed", `AgentNFT is not deployed on ${deps.environment.label}.`);
    const ownership = await deps.chain.ownership(agentId);
    if (!ownership) return fail(c, 404, "not_found", `Agent #${agentId} does not exist.`);
    const view = await goals.view(chainId, Number(agentId), ownership.epoch);
    return c.json({ ...(await meta()), agentId: agentId.toString(), ...goalSummaryJson(view) });
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
    return c.json({
      ...(await meta()),
      agentId: String(agentId),
      ...view,
      creditCapUsdcE6: CREDIT_CAP_USDC_E6.toString(),
    });
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
    const goal = await goals.view(chainId, Number(agentId), owner.epoch);
    return c.json({
      ...(await meta()),
      agentId: agentId.toString(),
      wallet: owner.wallet,
      ownerEpoch: owner.epoch.toString(),
      ...summary,
      // P3-U1: the agent's state and its goal's summary, for the card.
      goal: { state: goal.state, ...goalSummaryJson(goal) },
      // Phase 2 tuning: the per-agent credit cap, so the page shows the room left under it.
      creditCapUsdcE6: CREDIT_CAP_USDC_E6.toString(),
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
  // F-U11: the value snapshots the orchestrator records, under this environment's id.
  const snapshots = new SnapshotStore(deps.db, deps.environment.id, () => new Date(deps.now()));
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

  /** The Executor and grant reader of the agent's custody set (D-367): v3 where deployed and the agent is on it. */
  async function pathOf(
    t: NonNullable<ApiDeps["trading"]>,
    agentId: number,
  ): Promise<{ custody: CustodyPath; executor: Hex; reader: AgentViewReader }> {
    const v3 = t.v3;
    if (v3 && (await v3.paths.custodyPath(agentId)) === "v3")
      return { custody: "v3", executor: v3.executor, reader: v3.reader };
    return { custody: "v2", executor: t.executor, reader: t.reader };
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
    const path = t ? await pathOf(t, id) : null;
    // The Executor checks the expiry against its own block time, so the grant's clock is the
    // chain's (L-105): a fork's time sits at its pinned block, far behind the wall clock.
    const chainNow = path
      ? Number((await path.reader.agent(id))?.timestamp ?? nowSeconds())
      : nowSeconds();
    const validUntil = BigInt(chainNow + MAX_GRANT_SECONDS - 60);
    return c.json({
      ...(await meta()),
      agentId: agentId.toString(),
      arming: armingJson(await trades.lastArming(chainId, id), chainNow),
      fundingAddress: funding,
      custody: path?.custody ?? null,
      grantCall: path && funding ? registerCall(path.executor, id, funding, validUntil) : null,
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
    const path = await pathOf(t, id);
    const r = await confirmArming(trades, await path.reader.agent(id), {
      chainId,
      agentId: id,
      owner: owner.wallet,
      fundingAddress: await fundingAddressOf(id),
      custody: path.custody,
      executor: path.custody === "v3" ? path.executor : null,
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
    const last = ended ?? (await trades.lastArming(chainId, id));
    // The revoke goes to the Executor the grant was on (D-367).
    const executor =
      last?.executor ?? (deps.trading ? (await pathOf(deps.trading, id)).executor : null);
    return c.json({
      agentId: agentId.toString(),
      disarmed: ended !== null,
      arming: armingJson(last, nowSeconds()),
      revokeCall: executor ? revokeCall(executor, id) : null,
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

  /** The owner rejects one waiting intent; it is cancelled and frees its trade slot (P2-U7). */
  app.post("/v1/agents/:id{[0-9]+}/intents/:intentId{intent-[0-9a-f-]{36}}/reject", async (c) => {
    const agentId = BigInt(c.req.param("id"));
    const owner = await ownerOnly(c, agentId);
    if (owner instanceof Response) return owner;
    const r = await rejectByOwner(trades, chainId, Number(agentId), c.req.param("intentId"));
    if (!r.ok) return refused(c, r);
    return c.json({ agentId: agentId.toString(), intent: intentJson(r.intent) });
  });

  // --- Portfolio proposals and the plan card (F-U9) --------------------------

  const proposalStores = (): ProposalStores => ({
    db: deps.db,
    proposals: new ProposalStore(deps.db),
    plans: new PlanStore(deps.db),
    goals,
    trades,
    activations: new ActivationStore(deps.db),
    recheck: deps.proposals?.recheck ?? null,
    now: () => new Date(deps.now()),
  });
  const PROPOSAL_STATUS = {
    NOT_FOUND: [404, "not_found"],
    NOT_WAITING: [409, "not_waiting"],
    STALE: [409, "proposal_stale"],
    UNAVAILABLE: [503, "not_configured"],
    REJECTED: [409, "proposal_rejected"],
  } as const;

  /** The plan card: the plan in force, the proposal waiting for the owner, recent decisions, why no change. */
  app.get("/v1/agents/:id{[0-9]+}/plan-card", async (c) => {
    const agentId = BigInt(c.req.param("id"));
    const owner = await ownerOnly(c, agentId);
    if (owner instanceof Response) return owner;
    const s = proposalStores();
    const plan = await s.plans.active(chainId, Number(agentId));
    const pending = await s.proposals.pending(chainId, Number(agentId));
    const tokens = [
      ...(plan && isPortfolioPlan(plan) ? plan.params.positions.map((p) => p.token) : []),
      ...(pending?.positions.map((p) => p.token) ?? []),
    ];
    const symbols = await tokenSymbols(deps.db, chainId, tokens);
    return c.json({
      ...(await meta()),
      agentId: agentId.toString(),
      ...(await planCard(s, chainId, Number(agentId), symbols)),
    });
  });

  app.post(
    "/v1/agents/:id{[0-9]+}/proposals/:proposalId{prop-[0-9a-f-]{36}}/approve",
    async (c) => {
      const agentId = BigInt(c.req.param("id"));
      const owner = await ownerOnly(c, agentId);
      if (owner instanceof Response) return owner;
      const r = await approveProposal(
        proposalStores(),
        chainId,
        Number(agentId),
        c.req.param("proposalId"),
        owner,
      );
      if (!r.ok) {
        const [status, code] = PROPOSAL_STATUS[r.code];
        return c.json(
          {
            error: code,
            message: r.message,
            ...(r.code === "REJECTED"
              ? { findings: r.findings, proposal: proposalJson(r.proposal) }
              : {}),
          },
          status,
        );
      }
      return c.json({
        agentId: agentId.toString(),
        proposal: proposalJson(r.proposal),
        plan: { paramId: r.plan.paramId, strategyEpoch: r.plan.strategyEpoch.toString() },
        // F-U10 (D-291): approving the activation sweep's plan is what arms the agent.
        armed: r.armed,
      });
    },
  );

  // --- The activation sweep (F-U10) ------------------------------------------

  /**
   * The owner's sweep: the newest one with its steps, status and what they
   * can do, and the checks before the next may start. Owner only, read
   * through the orchestrator.
   */
  app.get("/v1/agents/:id{[0-9]+}/activation", async (c) => {
    const agentId = BigInt(c.req.param("id"));
    const owner = await ownerOnly(c, agentId);
    if (owner instanceof Response) return owner;
    // Without an orchestrator the sweep is not offered here: the page keeps the P2-U6 arming alone.
    if (!deps.activation)
      return c.json({
        ...(await meta()),
        agentId: agentId.toString(),
        available: false,
        activation: null,
        checks: [],
        ceilingUsdcE6: "0",
        tier: { choice: "MEDIUM", label: "Medium" },
      });
    const read = await deps.activation.read(Number(agentId));
    return c.json({ ...(await meta()), ...read, agentId: agentId.toString(), available: true });
  });

  /**
   * Turns automatic trading on: the grant must be on chain already (the
   * owner's wallet registers it first); the orchestrator runs every check,
   * names the one that fails, and otherwise queues the sweep.
   */
  app.post("/v1/agents/:id{[0-9]+}/activation", async (c) => {
    const agentId = BigInt(c.req.param("id"));
    const owner = await ownerOnly(c, agentId);
    if (owner instanceof Response) return owner;
    if (!deps.activation)
      return fail(
        c,
        503,
        "not_configured",
        "The platform cannot reach the agent's orchestrator right now; try again in a moment.",
      );
    const r = await deps.activation.start(Number(agentId));
    if (!r.ok)
      return c.json(
        { error: r.error, message: r.message, checks: r.checks, agentId: agentId.toString() },
        409,
      );
    return c.json({ agentId: agentId.toString(), activation: r.activation }, 202);
  });

  app.post("/v1/agents/:id{[0-9]+}/proposals/:proposalId{prop-[0-9a-f-]{36}}/reject", async (c) => {
    const agentId = BigInt(c.req.param("id"));
    const owner = await ownerOnly(c, agentId);
    if (owner instanceof Response) return owner;
    const r = await declineProposal(
      proposalStores(),
      chainId,
      Number(agentId),
      c.req.param("proposalId"),
      owner,
    );
    if (!r.ok) {
      const [status, code] = PROPOSAL_STATUS[r.code];
      return c.json({ error: code, message: r.message }, status);
    }
    return c.json({ agentId: agentId.toString(), proposal: proposalJson(r.proposal) });
  });

  /**
   * The owner's portfolio (P2-U7), read fresh from the chain: the trading
   * account or where it will be, balances, claimable credits, mode, breaker,
   * the deposit allowlist and caps, prices with their age, and the wallet's
   * own balances for the deposit form. Owner only, like everything about the
   * owner's money in the app.
   */
  app.get("/v1/agents/:id{[0-9]+}/portfolio", async (c) => {
    const agentId = BigInt(c.req.param("id"));
    const owner = await ownerOnly(c, agentId);
    if (owner instanceof Response) return owner;
    // A-80: where the fund agent's set is deployed every agent is on it, and the v2
    // account, if any, comes along as an older account to withdraw from.
    const v3 = deps.trading?.v3?.portfolio;
    if (v3) {
      const reading = await v3.portfolio(Number(agentId));
      if (!reading) return fail(c, 404, "not_found", `Agent #${agentId} does not exist.`);
      return c.json({ ...(await meta()), portfolio: portfolioV3Json(reading) });
    }
    const reader = deps.trading?.portfolio;
    if (!reader)
      return fail(
        c,
        503,
        "not_deployed",
        `Trading accounts are not deployed on ${deps.environment.label}.`,
      );
    const reading = await reader.portfolio(Number(agentId));
    if (!reading) return fail(c, 404, "not_found", `Agent #${agentId} does not exist.`);
    return c.json({ ...(await meta()), portfolio: portfolioJson(reading) });
  });

  /**
   * The portfolio window (F-U11): every held token with its share, value,
   * cost basis and gain; performance on the account's value per unit, with
   * the trades as markers; the three scores and the $100 figure. The holdings
   * are read live through the orchestrator when it answers, else from the
   * latest snapshot, dated as such. Owner only, like the portfolio.
   */
  app.get("/v1/agents/:id{[0-9]+}/window", async (c) => {
    const agentId = BigInt(c.req.param("id"));
    const owner = await ownerOnly(c, agentId);
    if (owner instanceof Response) return owner;
    const id = Number(agentId);
    const [live, rows, intents] = await Promise.all([
      deps.window ? deps.window.account(id).catch(() => null) : Promise.resolve(null),
      snapshots.since(chainId, id, new Date(0), WINDOW_SNAPSHOT_LIMIT),
      trades.intents(chainId, id, WINDOW_INTENT_LIMIT),
    ]);
    return c.json({
      ...(await meta()),
      window: buildWindow({ agentId: id, rows, intents, live, now: new Date(deps.now()) }),
    });
  });

  // --- The research loop and the agent terminal (P3-U10) ---------------------

  const researchOff = (c: Context) =>
    fail(
      c,
      503,
      "not_configured",
      "The platform cannot reach the agent's orchestrator right now; try again in a moment.",
    );

  /** The Research page's read: the schedule, the budget, the triggers, the records and the snapshot. Owner only. */
  app.get("/v1/agents/:id{[0-9]+}/research", async (c) => {
    const agentId = BigInt(c.req.param("id"));
    const owner = await ownerOnly(c, agentId);
    if (owner instanceof Response) return owner;
    if (!deps.research) return researchOff(c);
    const read = await deps.research.read(Number(agentId));
    return c.json({ ...(await meta()), ...read, agentId: agentId.toString() });
  });

  /** The agent terminal's events from a sequence on, the open cycle by default. Owner only. */
  app.get("/v1/agents/:id{[0-9]+}/terminal", async (c) => {
    const agentId = BigInt(c.req.param("id"));
    const owner = await ownerOnly(c, agentId);
    if (owner instanceof Response) return owner;
    if (!deps.research) return researchOff(c);
    const cycleId = c.req.query("cycleId") ?? null;
    if (cycleId !== null && !/^cycle-[0-9a-f-]{36}$/.test(cycleId))
      return fail(c, 400, "bad_request", "That is not a cycle ID.");
    const after = c.req.query("after") ?? "0";
    if (!/^\d{1,9}$/.test(after)) return fail(c, 400, "bad_request", "after is a sequence number.");
    const read = await deps.research.terminal(Number(agentId), cycleId, Number(after));
    return c.json({ ...read, agentId: agentId.toString() });
  });

  /** P4-U2: the Risk Sentinel's actions on the agent, with their reasons. Owner only. */
  app.get("/v1/agents/:id{[0-9]+}/sentinel", async (c) => {
    const agentId = BigInt(c.req.param("id"));
    const owner = await ownerOnly(c, agentId);
    if (owner instanceof Response) return owner;
    if (!deps.research) return researchOff(c);
    const read = await deps.research.sentinel(Number(agentId));
    return c.json({ ...read, agentId: agentId.toString() });
  });

  /** Pauses or resumes the agent's research loop. Owner only. */
  app.post("/v1/agents/:id{[0-9]+}/research/pause", async (c) => {
    const agentId = BigInt(c.req.param("id"));
    const owner = await ownerOnly(c, agentId);
    if (owner instanceof Response) return owner;
    if (!deps.research) return researchOff(c);
    const body = (await c.req.json().catch(() => null)) as { paused?: unknown } | null;
    if (!body || typeof body.paused !== "boolean")
      return fail(c, 400, "bad_request", "paused must be true or false.");
    const r = await deps.research.pause(Number(agentId), body.paused);
    return c.json({ agentId: agentId.toString(), paused: r.paused });
  });

  /**
   * P2-EC (D-307): fresh prices before the owner deposits. On testnet the
   * orchestrator re-dates the TestnetFeeds that need it; elsewhere nothing is
   * needed and nothing is sent. Owner only, so no one else can spend the
   * feed key's gas.
   */
  /**
   * D-315: everything the agent holds at its funding address, token-bound
   * account and PersonalAccount, what each balance does there, and for what
   * does nothing in the token-bound account, the call the owner signs to move
   * it to their wallet. Owner only, like the portfolio.
   */
  app.get("/v1/agents/:id{[0-9]+}/holdings", async (c) => {
    const agentId = BigInt(c.req.param("id"));
    const owner = await ownerOnly(c, agentId);
    if (owner instanceof Response) return owner;
    if (!deps.holdings)
      return fail(c, 503, "not_deployed", `Agents are not deployed on ${deps.environment.label}.`);
    const reading = await deps.holdings.holdings(
      Number(agentId),
      await fundingAddressOf(Number(agentId)),
    );
    if (!reading) return fail(c, 404, "not_found", `Agent #${agentId} does not exist.`);
    return c.json({ ...(await meta()), holdings: holdingsJson(reading) });
  });

  app.post("/v1/agents/:id{[0-9]+}/prices/fresh", async (c) => {
    const agentId = BigInt(c.req.param("id"));
    const owner = await ownerOnly(c, agentId);
    if (owner instanceof Response) return owner;
    if (!deps.freshPrices) return c.json({ redated: [], error: null, needed: false });
    const result = await deps.freshPrices().catch((err: unknown) => ({
      redated: [],
      error: err instanceof Error ? (err.message.split("\n")[0] ?? "failed") : "failed",
    }));
    return c.json({ ...result, needed: true });
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
