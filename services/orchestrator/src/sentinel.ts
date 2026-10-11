import { randomUUID } from "node:crypto";
import type { Db } from "@alpha-agents/db";
import type { AccountMode, AgentState } from "@alpha-agents/domain";
import type { Hex } from "viem";

/**
 * The Risk Sentinel (P4-U2, D-138): a deterministic service, no model, that
 * watches every agent's account and held tokens and tightens when something
 * is wrong. It acts through its own sentinel key, which the custody core
 * lets set reduce-only, pause new risk and close deposits, and nothing else:
 * it can never unpause, loosen a limit, move funds or touch a withdrawal.
 * Off chain it sets the agent state RESTRICTED (no credits) or INCIDENT (an
 * operational fault that needs a human) with the breach's reason. Every
 * action is recorded with its reason, shown to the owner, and appears in the
 * agent terminal.
 *
 * The decisions are pure (`assess` over an observation, the rules and the
 * conditions already in force), so every rule is proven with records; the
 * service around them reads the platform and sends the transactions.
 */
export const BREACH_CODES = [
  "STALE_FEED",
  "DRAWDOWN_12",
  "DRAWDOWN_22",
  "RESCREEN_FAILED",
  "LIQUIDITY_DROP",
  "ZERO_CREDITS",
  "GAS_LOW",
  "SIGNER_DOWN",
  "CHAIN_STALE",
  "ADAPTER_OFF",
  "MANDATE_EXPIRED",
  "OWNER_CHANGED",
] as const;
export type BreachCode = (typeof BREACH_CODES)[number];

/** What the sentinel may do on chain: each tightens, none loosens. */
export type TightenAction = "REDUCE_ONLY" | "PAUSE" | "CLOSE_DEPOSITS";
export type SentinelAction = TightenAction | "RESTRICT" | "INCIDENT" | "NOTE" | "RESUME";

export const BREACH_TEXT: Readonly<Record<BreachCode, string>> = {
  STALE_FEED: "a held token's price feed is stale or unusable",
  DRAWDOWN_12: "the account fell 12% or more from its 7-day peak",
  DRAWDOWN_22: "the account fell 22% or more from its 7-day peak",
  RESCREEN_FAILED: "a held token failed its safety re-screen or went sell-only",
  LIQUIDITY_DROP: "a held token's liquidity fell by half or under the floor",
  ZERO_CREDITS: "the agent has no credits left",
  GAS_LOW: "the agent's funding address cannot pay for a trade's gas",
  SIGNER_DOWN: "the platform's signer is not running",
  CHAIN_STALE: "the chain has not produced a block for too long",
  ADAPTER_OFF: "the Executor or its route adapter is paused or disabled",
  MANDATE_EXPIRED: "the agent's trading permission has expired",
  OWNER_CHANGED: "the agent changed hands since it was armed",
};

export interface SentinelRules {
  /** The drop from the 7-day peak that sets reduce-only and pause (the breaker's own are 10% and 20%). */
  readonly drawdownReduceBps: number;
  readonly drawdownPauseBps: number;
  /** A class F price older than this counts as stale. */
  readonly feedMaxAgeSeconds: number;
  /** A chain whose latest block is older than this is stale; null where blocks only come with transactions (the fork). */
  readonly chainMaxAgeSeconds: number | null;
  /** A held token whose liquidity fell to this share of the baseline, or under the floor, is in trouble. */
  readonly liquidityDropBps: number;
  readonly liquidityFloorUsd: number;
}

export const DEFAULT_RULES: SentinelRules = {
  drawdownReduceBps: 1_200,
  drawdownPauseBps: 2_200,
  feedMaxAgeSeconds: 3_600,
  chainMaxAgeSeconds: 600,
  liquidityDropBps: 5_000,
  liquidityFloorUsd: 25_000,
};

export interface HeldObservation {
  readonly token: Hex;
  readonly symbol: string;
  /** The oracle's reason for the price: "OK" or why not. */
  readonly priceReason: string;
  readonly priceAgeSeconds: number | null;
  readonly screenVerdict: "passed" | "refused" | null;
  readonly registryStatus: "listed" | "sell_only" | "delisted" | null;
  readonly liquidityUsd: number | null;
}

/** One look at an agent, every reading null where unreadable. */
export interface SentinelObservation {
  readonly at: Date;
  readonly account: Hex | null;
  readonly mode: AccountMode | null;
  readonly depositsClosed: boolean | null;
  /** The breaker's drawdown from the 7-day peak after this pass's poke; null while the valuation reverts. */
  readonly drawdownBps: number | null;
  readonly navReadable: boolean;
  readonly held: readonly HeldObservation[];
  readonly creditsRestricted: boolean | null;
  readonly gasWei: bigint | null;
  readonly gasNeededWei: bigint | null;
  readonly signerAlive: boolean | null;
  readonly chainAgeSeconds: number | null;
  readonly executorPaused: boolean | null;
  readonly adapterAllowed: boolean | null;
  /** The arming in force, if any, with the owner epoch it was made under and when it ends. */
  readonly arming: { readonly validUntil: bigint; readonly ownerEpoch: bigint } | null;
  readonly ownerEpoch: bigint | null;
  readonly agentState: AgentState | null;
}

export interface Breach {
  readonly code: BreachCode;
  /** The tightening on chain, or none. */
  readonly action: TightenAction | null;
  /** The agent state the breach calls for, or none. */
  readonly state: "RESTRICTED" | "INCIDENT" | null;
  readonly reason: string;
  readonly detail: Record<string, unknown>;
}

export interface SentinelBaseline {
  readonly takenAt: string;
  readonly liquidityUsd: Readonly<Record<string, number>>;
}

export function baselineFrom(o: SentinelObservation): SentinelBaseline {
  return {
    takenAt: o.at.toISOString(),
    liquidityUsd: Object.fromEntries(
      o.held
        .filter((h) => h.liquidityUsd !== null)
        .map((h) => [h.token.toLowerCase(), h.liquidityUsd as number]),
    ),
  };
}

/** Every breach the observation shows, against the rules and the baseline; pure. */
export function assess(
  o: SentinelObservation,
  rules: SentinelRules,
  baseline: SentinelBaseline | null,
): Breach[] {
  const out: Breach[] = [];
  const held = o.held;
  if (o.account) {
    const stale = held.filter(
      (h) =>
        h.priceReason !== "OK" ||
        (h.priceAgeSeconds !== null && h.priceAgeSeconds > rules.feedMaxAgeSeconds),
    );
    if (stale.length > 0 || !o.navReadable)
      out.push({
        code: "STALE_FEED",
        action: "REDUCE_ONLY",
        state: "INCIDENT",
        reason:
          stale.length > 0
            ? `${stale.map((h) => h.symbol).join(", ")}: ${stale.map((h) => (h.priceReason === "OK" ? `${h.priceAgeSeconds} s old` : h.priceReason.toLowerCase().replace(/_/g, " "))).join(", ")}`
            : "the account cannot be valued",
        detail: {
          tokens: stale.map((h) => ({
            token: h.token,
            symbol: h.symbol,
            reason: h.priceReason,
            ageSeconds: h.priceAgeSeconds,
          })),
          navReadable: o.navReadable,
        },
      });
    if (o.drawdownBps !== null) {
      if (o.drawdownBps >= rules.drawdownPauseBps)
        out.push({
          code: "DRAWDOWN_22",
          action: "PAUSE",
          state: null,
          reason: `${(o.drawdownBps / 100).toFixed(1)}% below the 7-day peak`,
          detail: { drawdownBps: o.drawdownBps, pauseBps: rules.drawdownPauseBps },
        });
      else if (o.drawdownBps >= rules.drawdownReduceBps)
        out.push({
          code: "DRAWDOWN_12",
          action: "REDUCE_ONLY",
          state: null,
          reason: `${(o.drawdownBps / 100).toFixed(1)}% below the 7-day peak`,
          detail: { drawdownBps: o.drawdownBps, reduceBps: rules.drawdownReduceBps },
        });
    }
    const failed = held.filter(
      (h) =>
        h.screenVerdict === "refused" ||
        h.registryStatus === "sell_only" ||
        h.registryStatus === "delisted",
    );
    if (failed.length > 0)
      out.push({
        code: "RESCREEN_FAILED",
        action: "REDUCE_ONLY",
        state: null,
        reason: failed
          .map(
            (h) =>
              `${h.symbol} ${h.screenVerdict === "refused" ? "refused by the screen" : (h.registryStatus ?? "").replace(/_/g, " ")}`,
          )
          .join(", "),
        detail: {
          tokens: failed.map((h) => ({
            token: h.token,
            symbol: h.symbol,
            verdict: h.screenVerdict,
            status: h.registryStatus,
          })),
        },
      });
    const thin = held.filter((h) => {
      if (h.liquidityUsd === null) return false;
      const then = baseline?.liquidityUsd[h.token.toLowerCase()];
      const halved =
        then !== undefined && then > 0 && h.liquidityUsd * 10_000 <= then * rules.liquidityDropBps;
      return halved || h.liquidityUsd < rules.liquidityFloorUsd;
    });
    if (thin.length > 0)
      out.push({
        code: "LIQUIDITY_DROP",
        action: "REDUCE_ONLY",
        state: null,
        reason: thin.map((h) => `${h.symbol} at ${Math.round(h.liquidityUsd ?? 0)} USD`).join(", "),
        detail: {
          tokens: thin.map((h) => ({
            token: h.token,
            symbol: h.symbol,
            liquidityUsd: h.liquidityUsd,
            baselineUsd: baseline?.liquidityUsd[h.token.toLowerCase()] ?? null,
          })),
          floorUsd: rules.liquidityFloorUsd,
        },
      });
  }
  if (o.creditsRestricted === true)
    out.push({
      code: "ZERO_CREDITS",
      action: null,
      state: "RESTRICTED",
      reason: "no spendable credits",
      detail: {},
    });
  if (
    o.gasWei !== null &&
    o.gasNeededWei !== null &&
    o.gasWei < o.gasNeededWei &&
    o.creditsRestricted !== true
  )
    out.push({
      code: "GAS_LOW",
      action: null,
      state: "INCIDENT",
      reason: "the funding address holds less MON than one trade's gas",
      detail: { gasWei: o.gasWei.toString(), neededWei: o.gasNeededWei.toString() },
    });
  if (o.signerAlive === false)
    out.push({
      code: "SIGNER_DOWN",
      action: null,
      state: "INCIDENT",
      reason: "the signer has not run",
      detail: {},
    });
  if (
    rules.chainMaxAgeSeconds !== null &&
    o.chainAgeSeconds !== null &&
    o.chainAgeSeconds > rules.chainMaxAgeSeconds
  )
    out.push({
      code: "CHAIN_STALE",
      action: null,
      state: "INCIDENT",
      reason: `the latest block is ${o.chainAgeSeconds} s old`,
      detail: { chainAgeSeconds: o.chainAgeSeconds, maxSeconds: rules.chainMaxAgeSeconds },
    });
  if (o.executorPaused === true || o.adapterAllowed === false)
    out.push({
      code: "ADAPTER_OFF",
      action: null,
      state: "INCIDENT",
      reason: o.executorPaused ? "Executor v3 is paused" : "the route adapter is not allowed",
      detail: { executorPaused: o.executorPaused, adapterAllowed: o.adapterAllowed },
    });
  if (o.arming) {
    const nowSeconds = BigInt(Math.floor(o.at.getTime() / 1000));
    if (o.arming.validUntil <= nowSeconds)
      out.push({
        code: "MANDATE_EXPIRED",
        action: null,
        state: "INCIDENT",
        reason: "the trading permission's time ran out",
        detail: { validUntil: o.arming.validUntil.toString() },
      });
    if (o.ownerEpoch !== null && o.ownerEpoch !== o.arming.ownerEpoch)
      out.push({
        code: "OWNER_CHANGED",
        action: null,
        state: "INCIDENT",
        reason: "the agent has a new owner; the old permission is void",
        detail: { armedEpoch: o.arming.ownerEpoch.toString(), ownerEpoch: o.ownerEpoch.toString() },
      });
  }
  return out;
}

/** The strongest agent state the breaches call for, or null. */
export function stateFor(breaches: readonly Breach[]): "RESTRICTED" | "INCIDENT" | null {
  if (breaches.some((b) => b.state === "INCIDENT")) return "INCIDENT";
  if (breaches.some((b) => b.state === "RESTRICTED")) return "RESTRICTED";
  return null;
}

/** Whether a tightening is still a tightening given the account's mode now. */
export function tightens(
  action: TightenAction,
  mode: AccountMode | null,
  depositsClosed: boolean | null,
): boolean {
  if (mode === null) return false;
  if (action === "REDUCE_ONLY") return mode === "NORMAL";
  if (action === "PAUSE") return mode !== "PAUSED" && mode !== "WIND_DOWN";
  return depositsClosed === false;
}

// ---------------------------------------------------------------------------
// The store

export interface SentinelActionRow {
  readonly actionId: string;
  readonly code: BreachCode | string;
  readonly action: SentinelAction;
  readonly state: string | null;
  readonly reason: string;
  readonly detail: Record<string, unknown>;
  readonly txHash: string | null;
  readonly status: "done" | "failed" | "skipped";
  readonly createdAt: Date;
}

export interface SentinelWatchRow {
  readonly active: Readonly<Record<string, string>>;
  readonly baseline: SentinelBaseline | null;
  readonly lastCheckedAt: Date | null;
}

export interface AgentRef {
  readonly chainId: number;
  readonly agentId: number;
}

export class SentinelStore {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async watch(ref: AgentRef): Promise<SentinelWatchRow> {
    const r = await this.db
      .selectFrom("platform.sentinel_watch")
      .selectAll()
      .where("chain_id", "=", ref.chainId)
      .where("agent_id", "=", ref.agentId)
      .executeTakeFirst();
    if (!r) return { active: {}, baseline: null, lastCheckedAt: null };
    return {
      active: r.active,
      baseline: (r.baseline as SentinelBaseline | null) ?? null,
      lastCheckedAt: r.last_checked_at ? new Date(r.last_checked_at) : null,
    };
  }

  async setWatch(
    ref: AgentRef,
    w: { active: Readonly<Record<string, string>>; baseline: SentinelBaseline | null },
    now: Date,
  ): Promise<void> {
    const values = {
      active: JSON.stringify(w.active),
      baseline: w.baseline ? JSON.stringify(w.baseline) : null,
      last_checked_at: now,
      updated_at: now,
    };
    await this.db
      .insertInto("platform.sentinel_watch")
      .values({ chain_id: ref.chainId, agent_id: ref.agentId, ...values })
      .onConflict((oc) => oc.columns(["chain_id", "agent_id"]).doUpdateSet(values))
      .execute();
  }

  async record(
    ref: AgentRef,
    a: {
      code: string;
      action: SentinelAction;
      state: string | null;
      reason: string;
      detail: Record<string, unknown>;
      txHash: string | null;
      status: "done" | "failed" | "skipped";
    },
    now: Date,
  ): Promise<string> {
    const actionId = `sentinel-${randomUUID()}`;
    await this.db
      .insertInto("platform.sentinel_actions")
      .values({
        action_id: actionId,
        chain_id: ref.chainId,
        agent_id: ref.agentId,
        code: a.code,
        action: a.action,
        state: a.state,
        reason: a.reason,
        detail: JSON.stringify(a.detail),
        tx_hash: a.txHash,
        status: a.status,
        created_at: now,
      })
      .execute();
    return actionId;
  }

  async actions(ref: AgentRef, limit = 20): Promise<SentinelActionRow[]> {
    const rows = await this.db
      .selectFrom("platform.sentinel_actions")
      .selectAll()
      .where("chain_id", "=", ref.chainId)
      .where("agent_id", "=", ref.agentId)
      .orderBy("created_at", "desc")
      .limit(limit)
      .execute();
    return rows.map((r) => ({
      actionId: r.action_id,
      code: r.code,
      action: r.action as SentinelAction,
      state: r.state,
      reason: r.reason,
      detail: r.detail,
      txHash: r.tx_hash,
      status: r.status,
      createdAt: new Date(r.created_at),
    }));
  }

  /** The actions within a window, oldest first, for the terminal. */
  async actionsBetween(ref: AgentRef, from: Date, to: Date): Promise<SentinelActionRow[]> {
    const rows = await this.db
      .selectFrom("platform.sentinel_actions")
      .selectAll()
      .where("chain_id", "=", ref.chainId)
      .where("agent_id", "=", ref.agentId)
      .where("created_at", ">=", from)
      .where("created_at", "<=", to)
      .orderBy("created_at", "asc")
      .limit(100)
      .execute();
    return rows.map((r) => ({
      actionId: r.action_id,
      code: r.code,
      action: r.action as SentinelAction,
      state: r.state,
      reason: r.reason,
      detail: r.detail,
      txHash: r.tx_hash,
      status: r.status,
      createdAt: new Date(r.created_at),
    }));
  }
}

// ---------------------------------------------------------------------------
// The service

/** The sentinel key's chain calls: the three tightenings and the free valuation, nothing else. */
export interface SentinelChain {
  readonly address: Hex;
  setReduceOnly(account: Hex): Promise<Hex>;
  pause(account: Hex): Promise<Hex>;
  closeDeposits(account: Hex): Promise<Hex>;
  /** Values the account and records the breaker's peak; reverts while a class F feed is unusable. */
  poke(account: Hex): Promise<Hex>;
}

export interface SentinelDeps {
  readonly chainId: number;
  readonly store: SentinelStore;
  readonly rules: SentinelRules;
  /** The chain, or null where no sentinel key is configured: then only the agent state is set. */
  readonly chain: SentinelChain | null;
  /** Every agent with a goal or an account; the ones worth a look. */
  readonly agents: () => Promise<number[]>;
  /** One look at an agent after a poke; null when the agent has no account and nothing to watch. */
  readonly observe: (ref: AgentRef, now: Date) => Promise<SentinelObservation | null>;
  /** Sets the agent state with the sentinel's reason; returns the state before. */
  readonly setState: (
    ref: AgentRef,
    to: AgentState,
    reason: string,
  ) => Promise<{ from: AgentState } | null>;
  /** What the agent's state should be with nothing wrong: RUNNING with an approved plan, else READY. */
  readonly restState: (ref: AgentRef) => Promise<AgentState>;
  readonly now?: () => Date;
  readonly log: (line: string) => void;
}

export class Sentinel {
  private readonly d: SentinelDeps;
  constructor(d: SentinelDeps) {
    this.d = d;
  }

  /** One pass over every agent; returns the actions recorded, by agent. */
  async tick(): Promise<{ agentId: number; code: string; action: SentinelAction }[]> {
    const now = this.d.now?.() ?? new Date();
    const out: { agentId: number; code: string; action: SentinelAction }[] = [];
    for (const agentId of await this.d.agents()) {
      const ref = { chainId: this.d.chainId, agentId };
      try {
        for (const a of await this.watchAgent(ref, now)) out.push({ agentId, ...a });
      } catch (err) {
        this.d.log(
          `sentinel: agent ${agentId}: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`,
        );
      }
    }
    return out;
  }

  async watchAgent(ref: AgentRef, now: Date): Promise<{ code: string; action: SentinelAction }[]> {
    const o = await this.d.observe(ref, now);
    if (!o) return [];
    const w = await this.d.store.watch(ref);
    const baseline = w.baseline ?? baselineFrom(o);
    const breaches = assess(o, this.d.rules, w.baseline);
    const out: { code: string; action: SentinelAction }[] = [];
    const active: Record<string, string> = { ...w.active };
    let mode = o.mode;
    let depositsClosed = o.depositsClosed;
    // New breaches act once; a breach already in force is left alone.
    for (const b of breaches) {
      if (active[b.code]) continue;
      active[b.code] = now.toISOString();
      if (b.action && o.account) {
        const already =
          (b.action === "REDUCE_ONLY" && mode === "REDUCE_ONLY") ||
          (b.action === "PAUSE" && mode === "PAUSED");
        if (already) {
          // The breaker tripped on this pass's poke, or the owner tightened first: the same end.
          await this.d.store.record(
            ref,
            {
              code: b.code,
              action: b.action,
              state: b.state,
              reason: b.reason,
              detail: { ...b.detail, alreadyTightened: true, modeNow: mode },
              txHash: null,
              status: "done",
            },
            now,
          );
          out.push({ code: b.code, action: b.action });
        } else if (!tightens(b.action, mode, depositsClosed)) {
          await this.d.store.record(
            ref,
            {
              code: b.code,
              action: b.action,
              state: b.state,
              reason: b.reason,
              detail: { ...b.detail, modeNow: mode },
              txHash: null,
              status: "skipped",
            },
            now,
          );
          out.push({ code: b.code, action: b.action });
        } else if (!this.d.chain) {
          await this.d.store.record(
            ref,
            {
              code: b.code,
              action: b.action,
              state: b.state,
              reason: b.reason,
              detail: { ...b.detail, noKey: true },
              txHash: null,
              status: "skipped",
            },
            now,
          );
          out.push({ code: b.code, action: b.action });
          this.d.log(
            `sentinel: agent ${ref.agentId}: ${b.code} would ${b.action} but no sentinel key is configured`,
          );
        } else {
          try {
            const tx =
              b.action === "REDUCE_ONLY"
                ? await this.d.chain.setReduceOnly(o.account)
                : b.action === "PAUSE"
                  ? await this.d.chain.pause(o.account)
                  : await this.d.chain.closeDeposits(o.account);
            if (b.action === "REDUCE_ONLY") mode = "REDUCE_ONLY";
            if (b.action === "PAUSE") mode = "PAUSED";
            if (b.action === "CLOSE_DEPOSITS") depositsClosed = true;
            await this.d.store.record(
              ref,
              {
                code: b.code,
                action: b.action,
                state: b.state,
                reason: b.reason,
                detail: b.detail,
                txHash: tx,
                status: "done",
              },
              now,
            );
            out.push({ code: b.code, action: b.action });
            this.d.log(`sentinel: agent ${ref.agentId}: ${b.action} (${b.code}: ${b.reason})`);
          } catch (err) {
            await this.d.store.record(
              ref,
              {
                code: b.code,
                action: b.action,
                state: b.state,
                reason: b.reason,
                detail: {
                  ...b.detail,
                  error: err instanceof Error ? err.message.slice(0, 200) : String(err),
                },
                txHash: null,
                status: "failed",
              },
              now,
            );
            out.push({ code: b.code, action: b.action });
            this.d.log(`sentinel: agent ${ref.agentId}: ${b.action} failed (${b.code})`);
          }
        }
      } else {
        await this.d.store.record(
          ref,
          {
            code: b.code,
            action:
              b.state === "INCIDENT" ? "INCIDENT" : b.state === "RESTRICTED" ? "RESTRICT" : "NOTE",
            state: b.state,
            reason: b.reason,
            detail: b.detail,
            txHash: null,
            status: "done",
          },
          now,
        );
        out.push({
          code: b.code,
          action:
            b.state === "INCIDENT" ? "INCIDENT" : b.state === "RESTRICTED" ? "RESTRICT" : "NOTE",
        });
      }
    }
    // Breaches that cleared: noted, never loosened on chain.
    const codesNow = new Set(breaches.map((b) => b.code));
    for (const code of Object.keys(active))
      if (!codesNow.has(code as BreachCode)) {
        await this.d.store.record(
          ref,
          {
            code,
            action: "NOTE",
            state: null,
            reason: "the condition cleared; the account's mode stays until its owner reviews it",
            detail: {},
            txHash: null,
            status: "done",
          },
          now,
        );
        out.push({ code, action: "NOTE" });
      }
    const stillActive = Object.fromEntries(
      Object.entries(active).filter(([code]) => codesNow.has(code as BreachCode)),
    );
    // The agent state: the strongest the breaches call for, set once; back to rest only from
    // a RESTRICTED or INCIDENT the sentinel itself set, once nothing is wrong (D-129's resume).
    const wanted = stateFor(breaches);
    if (
      wanted &&
      o.agentState !== wanted &&
      o.agentState !== "UNCONFIGURED" &&
      !(o.agentState === "INCIDENT" && wanted === "RESTRICTED")
    ) {
      const r = await this.d.setState(
        ref,
        wanted,
        `sentinel:${breaches.find((b) => b.state === wanted)?.code ?? "breach"}`,
      );
      if (r) {
        await this.d.store.record(
          ref,
          {
            code: breaches.find((b) => b.state === wanted)?.code ?? "STATE",
            action: wanted === "INCIDENT" ? "INCIDENT" : "RESTRICT",
            state: wanted,
            reason: `agent state ${r.from} to ${wanted}`,
            detail: { from: r.from },
            txHash: null,
            status: "done",
          },
          now,
        );
        out.push({ code: "STATE", action: wanted === "INCIDENT" ? "INCIDENT" : "RESTRICT" });
      }
    } else if (!wanted && o.agentState === "RESTRICTED" && w.active.ZERO_CREDITS) {
      const rest = await this.d.restState(ref);
      const r = await this.d.setState(ref, rest, "sentinel:credits_restored");
      if (r) {
        await this.d.store.record(
          ref,
          {
            code: "ZERO_CREDITS",
            action: "RESUME",
            state: rest,
            reason: `credits are back; agent state ${r.from} to ${rest}`,
            detail: {},
            txHash: null,
            status: "done",
          },
          now,
        );
        out.push({ code: "ZERO_CREDITS", action: "RESUME" });
      }
    }
    await this.d.store.setWatch(ref, { active: stillActive, baseline }, now);
    return out;
  }
}
