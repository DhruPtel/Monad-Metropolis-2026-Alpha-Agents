import { SCAN_MIN_CREDITS_USDC_E6 } from "@alpha-agents/accounting";
import { sql } from "@alpha-agents/db";
import { SPECIES, TIER_IDS } from "@alpha-agents/domain";
import { revokeTestSessionGrant, registerTestSessionGrant } from "@alpha-agents/devenv";
import { armingJson, intentJson } from "@alpha-agents/trading";
import { Hono } from "hono";
import { RefundOpenError } from "./credits/refunds.ts";
import { CreditsExhaustedError, type Orchestrator, ScanOpenError } from "./orchestrator.ts";
import type { RevealSteering, SteerRecord, SteerTarget } from "./reveal-steer.ts";
import type { SignerWorker } from "./signer-worker.ts";
import type { Runtime, Store, Task } from "./store.ts";

/**
 * The orchestrator's internal API (D-205), on loopback only. Reads serve the
 * dev console: runtimes with their lease and latest task, one task, and the
 * keeper's recent actions, and (P1-U7) each agent's tool calls and activity
 * entries. The write routes (run the no-op task or a Scan, reset an agent)
 * exist only when `devActions` is on, which main.ts allows only with
 * APP_ENV=local. Nothing here returns a key, a token or a ciphertext.
 */
export interface ApiOptions {
  readonly orchestrator: Orchestrator;
  readonly store: Store;
  readonly chainId: number;
  readonly devActions: boolean;
  /** The signer worker (P2-U4), when it runs. */
  readonly signer?: SignerWorker | null;
  /** P2-U6: the local fork, for the console's arm and disarm (the owner's wallet calls, impersonated). */
  readonly forkUrl?: string | null;
}

const runtimeView = (r: Runtime) => ({
  agentId: String(r.agentId),
  generation: r.generation,
  status: r.status,
  tier: TIER_IDS[r.tier - 1] ?? null,
  species: r.species,
  slots: (r.config as { tier?: { slots?: number } }).tier?.slots ?? null,
  playbook:
    (r.config as { tier?: { playbook?: { version?: string } } }).tier?.playbook?.version ?? null,
  configHash: r.configHash,
  keyAlias: r.keyAlias,
  budgetUsd: r.budgetUsd,
  lastError: r.lastError,
  provisionedAt: r.provisionedAt?.toISOString() ?? null,
  updatedAt: r.updatedAt.toISOString(),
});

export const taskView = (t: Task) => ({
  taskId: t.taskId,
  agentId: String(t.agentId),
  kind: t.kind,
  status: t.status,
  result: t.result,
  error: t.error,
  createdAt: t.createdAt.toISOString(),
  startedAt: t.startedAt?.toISOString() ?? null,
  finishedAt: t.finishedAt?.toISOString() ?? null,
});

function agentRef(raw: string, chainId: number) {
  if (!/^[1-9]\d{0,4}$/.test(raw)) return null;
  return { chainId, agentId: Number(raw) };
}

export function createApi(o: ApiOptions): Hono {
  const app = new Hono();
  app.onError((err, c) => c.json({ error: "internal", message: err.message.slice(0, 200) }, 500));

  app.get("/health", (c) => c.json({ ok: true, runTag: o.orchestrator.runTag }));

  app.get("/v1/runtimes", async (c) => {
    const [runtimes, leases, tasks] = await Promise.all([
      o.store.runtimes(o.chainId),
      o.store.activeLeases(),
      o.store.latestTasks(o.chainId),
    ]);
    return c.json({
      devActions: o.devActions,
      runtimes: runtimes.map((r) => {
        const lease = leases.find((l) => l.chainId === r.chainId && l.agentId === r.agentId);
        const task = tasks.find((t) => t.agentId === r.agentId);
        return {
          ...runtimeView(r),
          lease: lease
            ? {
                leaseId: lease.leaseId,
                purpose: lease.purpose,
                sandboxId: lease.sandboxId,
                expiresAt: lease.expiresAt.toISOString(),
              }
            : null,
          latestTask: task ? taskView(task) : null,
        };
      }),
    });
  });

  app.get("/v1/tasks/:taskId", async (c) => {
    const task = await o.store.task(c.req.param("taskId"));
    return task ? c.json(taskView(task)) : c.json({ error: "not_found" }, 404);
  });

  /** P1-U6: every indexed agent's funding address, credits and recent ledger entries. */
  app.get("/v1/credits", async (c) => {
    const credits = o.orchestrator.credits;
    if (!credits) return c.json({ enabled: false, agents: [] });
    const rows = await o.store.db
      .selectFrom("indexer.agents as a")
      .leftJoin("platform.funding_addresses as f", (j) =>
        j.onRef("f.chain_id", "=", "a.chain_id").onRef("f.agent_id", "=", "a.agent_id"),
      )
      .select(["a.agent_id", "f.address"])
      .where("a.chain_id", "=", o.chainId)
      .orderBy("a.agent_id")
      .execute();
    const agents = [];
    for (const r of rows) {
      const v = await credits.creditsOf(r.agent_id);
      const recent = await o.orchestrator.ledger.recent(o.chainId, r.agent_id, 5);
      const since = new Date(Date.now() - 24 * 3_600_000);
      const spent = await o.store.db
        .selectFrom("platform.usage_receipts")
        .select(sql<string | null>`sum(charge_usdc_e6)`.as("total"))
        .where("chain_id", "=", o.chainId)
        .where("agent_id", "=", r.agent_id)
        .where("metered_at", ">", since)
        .executeTakeFirst();
      // P1-U7: paid tool calls that were answered (failed calls are reversed).
      const toolSpent = await o.store.db
        .selectFrom("platform.tool_calls")
        .select(sql<string | null>`sum(charge_usdc_e6)`.as("total"))
        .where("chain_id", "=", o.chainId)
        .where("agent_id", "=", r.agent_id)
        .where("status", "=", "succeeded")
        .where("started_at", ">", since)
        .executeTakeFirst();
      agents.push({
        agentId: String(r.agent_id),
        fundingAddress: r.address,
        creditsUsdcE6: v.credits.toString(),
        spendableUsdcE6: v.spendable.toString(),
        heldUsdcE6: v.held.toString(),
        unsettledUsdcE6: v.unsettled.toString(),
        fundingAddressUsdcE6: v.fundingAddress.toString(),
        restricted: v.restricted,
        spent24hUsdcE6: (BigInt(spent?.total ?? "0") + BigInt(toolSpent?.total ?? "0")).toString(),
        toolSpent24hUsdcE6: toolSpent?.total ?? "0",
        recent: recent.map((e) => ({
          kind: e.kind,
          creditsDeltaUsdcE6: e.creditsDelta.toString(),
          at: e.occurredAt.toISOString(),
        })),
      });
    }
    return c.json({ enabled: true, agents });
  });

  app.get("/v1/refunds/:refundId", async (c) => {
    const r = await o.store.db
      .selectFrom("platform.refunds")
      .select([
        "refund_id",
        "agent_id",
        "owner",
        "owner_epoch",
        "status",
        "credits_usdc_e6",
        "held_usdc_e6",
        "tx_hash",
        "reason",
        "created_at",
        "updated_at",
      ])
      .where("refund_id", "=", c.req.param("refundId"))
      .executeTakeFirst();
    if (!r) return c.json({ error: "not_found" }, 404);
    return c.json({
      refundId: r.refund_id,
      agentId: String(r.agent_id),
      owner: r.owner,
      ownerEpoch: String(r.owner_epoch),
      status: r.status,
      creditsUsdcE6: r.credits_usdc_e6,
      heldUsdcE6: r.held_usdc_e6,
      txHash: r.tx_hash,
      reason: r.reason,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    });
  });

  /**
   * D-221: the local fork's reveal steering; null when there is none (any other
   * environment). Each pending steer says exactly which agent it will apply to,
   * read from the index: an agent target's own row, or a wallet's lowest
   * unrevealed agent, else the next agent that wallet mints.
   */
  const slugOf = (i: number | null) => (i === null ? null : (SPECIES[i - 1]?.slug ?? null));
  const appliesTo = async (t: SteerTarget) => {
    const q = o.store.db
      .selectFrom("indexer.agents")
      .select(["agent_id", "owner", "species"])
      .where("chain_id", "=", o.chainId);
    if (t.kind === "agent") {
      const row = await q.where("agent_id", "=", t.agentId).executeTakeFirst();
      if (!row) return { agentId: null, text: `agent #${t.agentId} is not indexed on this fork` };
      if (row.species !== 0)
        return { agentId: null, text: `agent #${t.agentId} is already revealed; this will fail` };
      if (row.owner.toLowerCase() !== t.owner.toLowerCase())
        return {
          agentId: null,
          text: `agent #${t.agentId} now belongs to ${row.owner}; this will fail`,
        };
      return {
        agentId: String(t.agentId),
        text: `agent #${t.agentId}, unrevealed, owned by ${row.owner}`,
      };
    }
    const row = await q
      .where("owner", "=", t.wallet.toLowerCase())
      .where("species", "=", 0)
      .orderBy("agent_id", "asc")
      .executeTakeFirst();
    return row
      ? {
          agentId: String(row.agent_id),
          text: `agent #${row.agent_id}, this wallet's unrevealed agent`,
        }
      : { agentId: null, text: "the next agent this wallet mints" };
  };
  const steerView = async (r: SteerRecord) => ({
    steerId: r.steerId,
    target:
      r.target.kind === "wallet"
        ? { kind: "wallet" as const, wallet: r.target.wallet }
        : { kind: "agent" as const, agentId: String(r.target.agentId), owner: r.target.owner },
    species: slugOf(r.species),
    status: r.status,
    appliesTo: r.status === "pending" ? await appliesTo(r.target) : null,
    appliedAgentId: r.appliedAgentId === null ? null : String(r.appliedAgentId),
    note: r.note,
    createdAt: r.createdAt.toISOString(),
  });
  const steeringView = async () => {
    const s: RevealSteering | null = o.orchestrator.revealSteering;
    if (!s) return null;
    const resolved = (await s.store.recent(s.chainId, 20)).filter((r) => r.status !== "pending");
    return {
      firstReveal: slugOf(s.firstSpecies),
      pending: await Promise.all((await s.store.pending(s.chainId)).map(steerView)),
      recent: await Promise.all(resolved.slice(0, 5).map(steerView)),
    };
  };

  app.get("/v1/keeper", async (c) => {
    const keeper = o.orchestrator.keeper;
    if (!keeper) return c.json({ running: false, recent: [], steering: await steeringView() });
    const recent = keeper.actions
      .filter((a) => a.kind !== "idle" && a.kind !== "waiting")
      .slice(-20)
      .map((a) =>
        JSON.parse(JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? String(v) : v))),
      );
    return c.json({ running: true, recent, steering: await steeringView() });
  });

  /**
   * P1-U7: an agent's recent tool calls, for the console's history. Inputs are
   * reduced to what the console shows (the query, or the URL's host); page
   * text and note text are never stored here.
   */
  app.get("/v1/agents/:agentId/tool-calls", async (c) => {
    const ref = agentRef(c.req.param("agentId"), o.chainId);
    if (!ref) return c.json({ error: "bad_agent_id" }, 400);
    const rows = await o.store.db
      .selectFrom("platform.tool_calls")
      .selectAll()
      .where("chain_id", "=", ref.chainId)
      .where("agent_id", "=", ref.agentId)
      .orderBy("started_at", "desc")
      .limit(50)
      .execute();
    return c.json({
      agentId: String(ref.agentId),
      calls: rows.map((r) => {
        const input = r.input as {
          query?: unknown;
          url?: unknown;
          stage?: unknown;
          sell?: unknown;
          buy?: unknown;
          amount?: unknown;
          intentId?: unknown;
        };
        let target: string | null = null;
        if (typeof input.query === "string") target = input.query.slice(0, 120);
        else if (typeof input.sell === "string" && typeof input.buy === "string")
          target = `${String(input.amount ?? "")} ${input.sell} to ${input.buy}`
            .trim()
            .slice(0, 60);
        else if (typeof input.intentId === "string") target = input.intentId.slice(0, 48);
        else if (typeof input.url === "string")
          try {
            target = new URL(input.url).hostname;
          } catch {
            target = "invalid URL";
          }
        else if (typeof input.stage === "string") target = input.stage;
        return {
          callId: r.call_id,
          leaseId: r.lease_id,
          server: r.server,
          tool: r.tool,
          target,
          status: r.status,
          errorCode: r.error_code,
          chargeUsdcE6: r.charge_usdc_e6,
          reversed: r.reversal_entry_id !== null,
          cacheHit: r.cache_hit,
          results: (r.summary as { results?: unknown } | null)?.results ?? null,
          startedAt: new Date(r.started_at).toISOString(),
        };
      }),
    });
  });

  /**
   * P2-U5: what the chain tools saw and recorded for an agent: its latest
   * portfolio reading (the summary of its last successful get_portfolio) and
   * its intents with their states and every reason code. No calldata exists.
   */
  app.get("/v1/agents/:agentId/chain", async (c) => {
    const ref = agentRef(c.req.param("agentId"), o.chainId);
    if (!ref) return c.json({ error: "bad_agent_id" }, 400);
    const reading = await o.store.db
      .selectFrom("platform.tool_calls")
      .select(["summary", "finished_at", "lease_id"])
      .where("chain_id", "=", ref.chainId)
      .where("agent_id", "=", ref.agentId)
      .where("server", "=", "chain")
      .where("tool", "=", "get_portfolio")
      .where("status", "=", "succeeded")
      .orderBy("started_at", "desc")
      .limit(1)
      .executeTakeFirst();
    const intents = await o.orchestrator.trades.intents(ref.chainId, ref.agentId, 20);
    const { last } = await o.orchestrator.arming(ref);
    return c.json({
      agentId: String(ref.agentId),
      portfolio: reading
        ? {
            ...(reading.summary as Record<string, unknown>),
            at: reading.finished_at ? new Date(reading.finished_at).toISOString() : null,
          }
        : null,
      arming: armingJson(last, Math.floor(Date.now() / 1000)),
      tradeFlow: Boolean(o.orchestrator.tradeFlow),
      intents: intents.map(intentJson),
    });
  });

  /** P2-U6: why the agent did not trade: its arming and its recent blocked trades. */
  app.get("/v1/agents/:agentId/why-not-traded", async (c) => {
    const ref = agentRef(c.req.param("agentId"), o.chainId);
    if (!ref) return c.json({ error: "bad_agent_id" }, 400);
    return c.json({ agentId: String(ref.agentId), ...(await o.orchestrator.whyNotTraded(ref)) });
  });

  /** P1-U7: an agent's activity entries, newest first (D-217). */
  app.get("/v1/agents/:agentId/activity", async (c) => {
    const ref = agentRef(c.req.param("agentId"), o.chainId);
    if (!ref) return c.json({ error: "bad_agent_id" }, 400);
    const rows = await o.store.db
      .selectFrom("platform.activity_entries")
      .select(["entry_id", "task_id", "kind", "text", "rendered_by", "rejections", "created_at"])
      .where("chain_id", "=", ref.chainId)
      .where("agent_id", "=", ref.agentId)
      .orderBy("created_at", "desc")
      .limit(20)
      .execute();
    return c.json({
      agentId: String(ref.agentId),
      entries: rows.map((r) => ({
        entryId: r.entry_id,
        taskId: r.task_id,
        kind: r.kind,
        text: r.text,
        renderedBy: r.rendered_by,
        rejected: r.rejections.length,
        at: new Date(r.created_at).toISOString(),
      })),
    });
  });

  /**
   * P2-U4: the signer's outbox, newest first, with each transaction's states,
   * hash, refusal reason code, balances and ledger entry. Never the signed
   * bytes or anything about a key but its address.
   */
  app.get("/v1/signer", (c) =>
    c.json({
      on: Boolean(o.signer),
      chainId: o.signer?.signer.pinnedChainId ?? null,
    }),
  );

  app.get("/v1/signer/outbox", async (c) => {
    if (!o.signer)
      return c.json({ error: "signer_off", message: "The signer is not running." }, 409);
    const raw = c.req.query("agentId");
    const ref = raw === undefined ? null : agentRef(raw, o.chainId);
    if (raw !== undefined && !ref) return c.json({ error: "bad_agent_id" }, 400);
    return c.json({ transactions: await o.signer.signer.outbox(ref?.agentId, 20) });
  });

  app.get("/v1/signer/ledger/:entryId", async (c) => {
    if (!o.signer)
      return c.json({ error: "signer_off", message: "The signer is not running." }, 409);
    const id = c.req.param("entryId");
    if (!/^[0-9a-f-]{36}$/.test(id)) return c.json({ error: "bad_entry_id" }, 400);
    const entry = await o.signer.signer.ledgerEntry(id);
    return entry ? c.json(entry) : c.json({ error: "not_found" }, 404);
  });

  app.get("/v1/agents/:agentId/session-key", async (c) => {
    const ref = agentRef(c.req.param("agentId"), o.chainId);
    if (!ref) return c.json({ error: "bad_agent_id" }, 400);
    if (!o.signer)
      return c.json({ error: "signer_off", message: "The signer is not running." }, 409);
    return c.json({ address: await o.signer.signer.keyAddress(ref.agentId) });
  });

  if (o.devActions) {
    /**
     * D-221: steer a reveal on the local fork, once: `{ "species": "bee",
     * "wallet": "0x..." }` for that wallet's next reveal, or `{ "species":
     * "bee", "agentId": "3" }` for one unrevealed agent. Recorded in Postgres;
     * a newer choice for the same target replaces the older one. Only with dev
     * actions on and steering present, which is the local fork only.
     */
    app.post("/v1/keeper/reveal-steers", async (c) => {
      const steering = o.orchestrator.revealSteering;
      if (!steering)
        return c.json(
          { error: "not_local", message: "Steered reveals exist only on the local fork." },
          404,
        );
      const body = (await c.req.json().catch(() => null)) as {
        species?: unknown;
        wallet?: unknown;
        agentId?: unknown;
      } | null;
      const species =
        typeof body?.species === "string"
          ? SPECIES.find((s) => s.slug === body.species)
          : undefined;
      if (!species)
        return c.json({ error: "bad_species", message: "Name a species by its slug." }, 400);
      let target: SteerTarget;
      if (typeof body?.wallet === "string" && body.agentId === undefined) {
        if (!/^0x[0-9a-fA-F]{40}$/.test(body.wallet))
          return c.json({ error: "bad_wallet", message: "That is not a wallet address." }, 400);
        target = { kind: "wallet", wallet: body.wallet.toLowerCase() };
      } else if (typeof body?.agentId === "string" && body.wallet === undefined) {
        const ref = agentRef(body.agentId, o.chainId);
        if (!ref)
          return c.json({ error: "bad_agent_id", message: "That is not an agent ID." }, 400);
        const row = await o.store.db
          .selectFrom("indexer.agents")
          .select(["owner", "species"])
          .where("chain_id", "=", ref.chainId)
          .where("agent_id", "=", ref.agentId)
          .executeTakeFirst();
        if (!row)
          return c.json(
            {
              error: "unknown_agent",
              message: `Agent #${ref.agentId} is not indexed on this fork.`,
            },
            400,
          );
        if (row.species !== 0)
          return c.json(
            { error: "revealed", message: `Agent #${ref.agentId} is already revealed.` },
            400,
          );
        target = { kind: "agent", agentId: ref.agentId, owner: row.owner.toLowerCase() };
      } else
        return c.json(
          { error: "bad_target", message: "Name either a wallet or a pending agent." },
          400,
        );
      const steer = await steering.store.create(steering.chainId, target, species.index);
      return c.json({ steer: await steerView(steer), steering: await steeringView() });
    });

    /** D-221: cancel a pending steer. */
    app.post("/v1/keeper/reveal-steers/:steerId/cancel", async (c) => {
      const steering = o.orchestrator.revealSteering;
      if (!steering)
        return c.json(
          { error: "not_local", message: "Steered reveals exist only on the local fork." },
          404,
        );
      const done = await steering.store.resolve(c.req.param("steerId"), {
        status: "cancelled",
        note: "cancelled in the dev console",
      });
      if (!done)
        return c.json({ error: "not_pending", message: "That steer is no longer pending." }, 409);
      return c.json({ steering: await steeringView() });
    });

    /** P2-U5: run the chain check now: the agent reads its account and proposes a small swap. */
    app.post("/v1/agents/:agentId/tasks/chain-check", async (c) => {
      const ref = agentRef(c.req.param("agentId"), o.chainId);
      if (!ref) return c.json({ error: "bad_agent_id" }, 400);
      const runtime = await o.store.runtime(ref);
      if (runtime?.status !== "ready")
        return c.json(
          { error: "not_provisioned", message: `Agent ${ref.agentId} is not provisioned yet.` },
          409,
        );
      if (await o.store.activeLease(ref))
        return c.json(
          { error: "lease_held", message: `Agent ${ref.agentId} already has a sandbox running.` },
          409,
        );
      try {
        return c.json({ taskId: await o.orchestrator.enqueueChainCheck(ref) }, 202);
      } catch (err) {
        if (err instanceof CreditsExhaustedError)
          return c.json({ error: "credits_exhausted", message: err.message }, 409);
        throw err;
      }
    });

    /**
     * P2-U6: arm the agent as its owner would: the owner's wallet registers a
     * session grant to the funding address (impersonated on the local fork),
     * then the grant is checked on chain and recorded. `{ "days"?: 1..30 }`.
     */
    app.post("/v1/agents/:agentId/arm", async (c) => {
      const ref = agentRef(c.req.param("agentId"), o.chainId);
      if (!ref) return c.json({ error: "bad_agent_id" }, 400);
      if (!o.forkUrl) return c.json({ error: "no_fork", message: "Arming here needs the local fork." }, 409);
      const body = (await c.req.json().catch(() => null)) as { days?: unknown } | null;
      const days = body?.days === undefined ? 30 : Number(body.days);
      if (!Number.isInteger(days) || days < 1 || days > 30)
        return c.json({ error: "bad_days", message: "A grant lasts 1 to 30 days." }, 400);
      const [owner, funding] = await Promise.all([
        o.orchestrator.chainOwner(ref.agentId),
        o.orchestrator.fundingAddress(ref),
      ]);
      if (!owner)
        return c.json({ error: "not_deployed", message: "The agent or the trading contracts are not on this chain." }, 409);
      if (!funding)
        return c.json({ error: "no_funding_address", message: "The agent has no funding address yet." }, 409);
      await registerTestSessionGrant(o.forkUrl, ref.agentId, owner, funding, days);
      const r = await o.orchestrator.confirmArming(ref, owner);
      if (!r.ok) return c.json({ error: r.code.toLowerCase(), message: r.message }, 409);
      return c.json({ renewed: r.renewed, arming: armingJson(r.record, Math.floor(Date.now() / 1000)) }, 201);
    });

    /** P2-U6: disarm now, and revoke the grant as the owner's wallet would (impersonated on the fork). */
    app.post("/v1/agents/:agentId/disarm", async (c) => {
      const ref = agentRef(c.req.param("agentId"), o.chainId);
      if (!ref) return c.json({ error: "bad_agent_id" }, 400);
      const ended = await o.orchestrator.disarm(ref);
      const owner = await o.orchestrator.chainOwner(ref.agentId);
      if (o.forkUrl && owner) await revokeTestSessionGrant(o.forkUrl, ref.agentId, owner);
      const { last } = await o.orchestrator.arming(ref);
      return c.json({ disarmed: ended !== null, arming: armingJson(last, Math.floor(Date.now() / 1000)) });
    });

    /** P2-U6: approve a waiting intent as the owner; the first approval after the grant arms the agent. */
    app.post("/v1/agents/:agentId/intents/:intentId/approve", async (c) => {
      const ref = agentRef(c.req.param("agentId"), o.chainId);
      if (!ref) return c.json({ error: "bad_agent_id" }, 400);
      const intentId = c.req.param("intentId");
      if (!/^intent-[0-9a-f-]{36}$/.test(intentId)) return c.json({ error: "bad_intent_id" }, 400);
      const r = await o.orchestrator.approveIntent(ref, intentId);
      if (!r.ok)
        return c.json({ error: r.code.toLowerCase(), message: r.message }, r.code === "NOT_FOUND" ? 404 : 409);
      return c.json({ intent: intentJson(r.intent), armed: r.armed !== null });
    });

    /** P1-U7: queue a Scan now (D-216); the scheduler also queues them on its cadence. */
    app.post("/v1/agents/:agentId/tasks/scan", async (c) => {
      const ref = agentRef(c.req.param("agentId"), o.chainId);
      if (!ref) return c.json({ error: "bad_agent_id" }, 400);
      const runtime = await o.store.runtime(ref);
      if (runtime?.status !== "ready")
        return c.json(
          { error: "not_provisioned", message: `Agent ${ref.agentId} is not provisioned yet.` },
          409,
        );
      const held = await o.store.activeLease(ref);
      if (held)
        return c.json(
          { error: "lease_held", message: `Agent ${ref.agentId} already has a sandbox running.` },
          409,
        );
      try {
        const taskId = await o.orchestrator.enqueueScan(ref);
        return c.json({ taskId }, 202);
      } catch (err) {
        if (err instanceof CreditsExhaustedError)
          return c.json(
            {
              error: "credits_exhausted",
              message: `Agent ${ref.agentId} needs at least ${Number(SCAN_MIN_CREDITS_USDC_E6) / 1e6} USDC of credits for a Scan.`,
            },
            409,
          );
        if (err instanceof ScanOpenError)
          return c.json({ error: "scan_open", message: err.message }, 409);
        throw err;
      }
    });

    app.post("/v1/agents/:agentId/tasks/noop", async (c) => {
      const ref = agentRef(c.req.param("agentId"), o.chainId);
      if (!ref) return c.json({ error: "bad_agent_id" }, 400);
      const runtime = await o.store.runtime(ref);
      if (runtime?.status !== "ready")
        return c.json(
          { error: "not_provisioned", message: `Agent ${ref.agentId} is not provisioned yet.` },
          409,
        );
      const held = await o.store.activeLease(ref);
      if (held)
        return c.json(
          { error: "lease_held", message: `Agent ${ref.agentId} already has a sandbox running.` },
          409,
        );
      try {
        const taskId = await o.orchestrator.enqueueNoop(ref);
        return c.json({ taskId }, 202);
      } catch (err) {
        if (err instanceof CreditsExhaustedError)
          return c.json({ error: "credits_exhausted", message: err.message }, 409);
        throw err;
      }
    });

    /** The console's refund: for the agent's current owner and epoch, read from the chain. */
    app.post("/v1/agents/:agentId/refund", async (c) => {
      const ref = agentRef(c.req.param("agentId"), o.chainId);
      if (!ref) return c.json({ error: "bad_agent_id" }, 400);
      const refunds = o.orchestrator.refunds;
      if (!refunds) return c.json({ error: "not_configured", message: "Refunds are off." }, 503);
      const ownership = await o.orchestrator.ownership(ref.agentId);
      if (!ownership)
        return c.json({ error: "not_found", message: `Agent ${ref.agentId} does not exist.` }, 404);
      try {
        const refundId = await refunds.request(
          ref.agentId,
          ownership.owner,
          ownership.epoch,
          "console",
        );
        return c.json(
          { refundId, owner: ownership.owner, ownerEpoch: String(ownership.epoch) },
          202,
        );
      } catch (err) {
        if (err instanceof RefundOpenError)
          return c.json({ error: "refund_open", message: err.message }, 409);
        throw err;
      }
    });

    /** P2-U4: creates the agent's session key in the signer; the key never leaves it. */
    app.post("/v1/agents/:agentId/session-key", async (c) => {
      const ref = agentRef(c.req.param("agentId"), o.chainId);
      if (!ref) return c.json({ error: "bad_agent_id" }, 400);
      if (!o.signer)
        return c.json({ error: "signer_off", message: "The signer is not running." }, 409);
      return c.json({ address: await o.signer.signer.createKey(ref.agentId) }, 201);
    });

    /**
     * P2-U4: a test swap on the local fork through the signer and the
     * Executor: `{ "direction": "buy" | "sell", "amount": "5", "breakLimit"?: code }`.
     */
    app.post("/v1/agents/:agentId/test-swap", async (c) => {
      const ref = agentRef(c.req.param("agentId"), o.chainId);
      if (!ref) return c.json({ error: "bad_agent_id" }, 400);
      if (!o.signer)
        return c.json({ error: "signer_off", message: "The signer is not running." }, 409);
      const body = (await c.req.json().catch(() => null)) as {
        direction?: unknown;
        amount?: unknown;
        breakLimit?: unknown;
      } | null;
      const direction = body?.direction;
      if (direction !== "buy" && direction !== "sell")
        return c.json({ error: "bad_direction", message: "direction is buy or sell" }, 400);
      if (typeof body?.amount !== "string")
        return c.json({ error: "bad_amount", message: "amount is a decimal string" }, 400);
      const breakLimit = typeof body.breakLimit === "string" ? body.breakLimit : undefined;
      try {
        return c.json(
          await o.signer.testSwap(ref.agentId, direction, body.amount, breakLimit),
          202,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof RangeError || /has no (PersonalAccount|session key)/.test(message))
          return c.json({ error: "refused", message: message.slice(0, 200) }, 409);
        throw err;
      }
    });

    app.post("/v1/agents/:agentId/reset", async (c) => {
      const ref = agentRef(c.req.param("agentId"), o.chainId);
      if (!ref) return c.json({ error: "bad_agent_id" }, 400);
      if (!(await o.store.runtime(ref)))
        return c.json(
          { error: "not_provisioned", message: `Agent ${ref.agentId} has no runtime.` },
          409,
        );
      await o.orchestrator.enqueueReset(ref);
      return c.json({ queued: true }, 202);
    });
  }

  return app;
}
