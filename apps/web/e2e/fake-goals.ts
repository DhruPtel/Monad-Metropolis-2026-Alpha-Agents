import type { AgentState, GoalInput } from "@alpha-agents/domain";
import { getAddress } from "viem";
import { configJson, goalErrorsJson, goalForm } from "../../control-api/src/goals";
import { translateGoal } from "../../../packages/policy/src/goals";
import { WMON } from "./fake-trading";

/** The registry's tokens as the form lists them (F-U7): the API reads these from the database. */
const GOAL_FORM_TOKENS = [
  { address: WMON.toLowerCase(), symbol: "WMON", priceClass: "F" },
  { address: "0x0555e30da8f98308edb960aa94c0db47230d2b9c", symbol: "WBTC", priceClass: "F" },
  { address: "0x00000000000000000000000000000000000c0de5", symbol: "CHOG", priceClass: "A" },
];

/**
 * The goal routes for the screenshot suite (P3-U1), answered with the real
 * translator and the control API's own JSON, so the page sees exactly what the
 * API would send. One agent's goal and state per map entry; an agent with none
 * is UNCONFIGURED at strategy epoch 0.
 */
interface SavedGoal {
  goal: GoalInput;
  config: ReturnType<typeof configJson>;
  policyHash: string;
  strategyEpoch: bigint;
  state: AgentState;
  savedAt: string;
  savedBy: string;
}

export class FakeGoals {
  readonly saved = new Map<bigint, SavedGoal>();
  /** Every goal a PUT sent, refused ones included. */
  readonly puts: { agentId: bigint; body: unknown }[] = [];
  /** While set, a save waits for it: for the "saving" capture. */
  hold: Promise<void> | null = null;

  /** Saves a goal as the API would; returns the translator's refusal when there is one. */
  save(agentId: bigint, body: unknown, owner: string) {
    const t = translateGoal(body);
    if (!t.ok) return { ok: false as const, errors: goalErrorsJson(t.errors) };
    const old = this.saved.get(agentId);
    const entry: SavedGoal = {
      goal: t.config.goal,
      config: configJson(t.config),
      policyHash: t.config.policyHash,
      strategyEpoch: (old?.strategyEpoch ?? 0n) + 1n,
      state: old?.state ?? "READY",
      savedAt: "2026-10-08T12:00:00.000Z",
      savedBy: getAddress(owner),
    };
    this.saved.set(agentId, entry);
    return { ok: true as const, entry, from: old ? null : ("UNCONFIGURED" as const) };
  }

  view(agentId: bigint) {
    const s = this.saved.get(agentId);
    return {
      state: s?.state ?? "UNCONFIGURED",
      strategyEpoch: (s?.strategyEpoch ?? 0n).toString(),
      goal: s?.goal ?? null,
      config: s?.config ?? null,
      policyHash: s?.policyHash ?? null,
      savedAt: s?.savedAt ?? null,
      savedBy: s?.savedBy ?? null,
    };
  }

  summary(agentId: bigint) {
    const s = this.saved.get(agentId);
    return s
      ? {
          state: s.state,
          configured: true,
          aggressiveness: s.goal.aggressiveness,
        }
      : { state: "UNCONFIGURED", configured: false, aggressiveness: null };
  }

  /** The owner's GET or PUT, after the fake's session check. */
  async answer(agentId: bigint, method: string, body: unknown, owner: string, ownerEpoch: bigint) {
    const head = { agentId: agentId.toString(), ownerEpoch: ownerEpoch.toString() };
    if (method === "GET")
      return {
        status: 200,
        body: {
          ...head,
          ...this.view(agentId),
          form: { ...(await goalForm()), tokens: GOAL_FORM_TOKENS },
        },
      };
    this.puts.push({ agentId, body });
    if (this.hold) await this.hold;
    if (body === null)
      return { status: 400, body: { error: "bad_request", message: "Send the goal as JSON." } };
    const r = this.save(agentId, body, owner);
    if (!r.ok)
      return {
        status: 400,
        body: {
          error: "goal_refused",
          message: "The goal was not saved; fix the fields named below.",
          errors: r.errors,
        },
      };
    return {
      status: 200,
      body: {
        ...head,
        ...this.view(agentId),
        stateChange: r.from ? { from: r.from, to: "READY", reason: "goal_saved" } : null,
      },
    };
  }

  preview(body: unknown) {
    const t = translateGoal(body);
    return t.ok
      ? { ok: true, config: configJson(t.config), errors: [] }
      : { ok: false, config: null, errors: goalErrorsJson(t.errors) };
  }
}
