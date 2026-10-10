import type { PositionCall, ZoomOutDecision } from "@alpha-agents/platform-tools";

/**
 * The Zoom out's position calls against its decision (F-U8, FINAL_PLAN 0.7):
 * a proposed target portfolio must say, per position, what it does (ADD,
 * HOLD, TRIM or EXIT) and the calls must match the draft and the plan in
 * force, so an owner reading the RATIONALE sees exactly what the proposal
 * changes. Pure: every record comes in as an argument.
 */
export interface CurrentPosition {
  readonly token: string;
  readonly targetWeightBps: number;
}

const key = (t: string) => t.toLowerCase();

export function rationaleFindings(o: {
  readonly positions: readonly Pick<PositionCall, "token" | "symbol" | "action">[];
  readonly decision: ZoomOutDecision;
  /** The target portfolio in force, or none (no plan, or the two-asset plan). */
  readonly current: readonly CurrentPosition[];
}): string[] {
  const out: string[] = [];
  const name = (p: Pick<PositionCall, "token" | "symbol">) => `${p.symbol} (${p.token})`;
  if (o.decision.kind === "NO_CHANGE") return out;
  if (o.decision.template !== "target_portfolio@1") {
    if (o.positions.length > 0)
      out.push(
        "position calls belong to a target portfolio; a rebalance_bands@1 proposal has none",
      );
    return out;
  }
  const proposed = new Map(o.decision.params.positions.map((p) => [key(p.token), p]));
  const current = new Map(o.current.map((p) => [key(p.token), p]));
  const called = new Map(o.positions.map((p) => [key(p.token), p]));
  for (const p of o.positions) {
    const draft = proposed.get(key(p.token));
    const now = current.get(key(p.token));
    switch (p.action) {
      case "EXIT":
        if (draft) out.push(`${name(p)} is called EXIT but is still in the proposal`);
        else if (!now) out.push(`${name(p)} is called EXIT but is not in the plan in force`);
        break;
      case "ADD":
        if (!draft) out.push(`${name(p)} is called ADD but is not in the proposal`);
        else if (now && draft.targetWeightBps <= now.targetWeightBps)
          out.push(
            `${name(p)} is called ADD but its weight does not rise (${now.targetWeightBps} to ${draft.targetWeightBps} bps)`,
          );
        break;
      case "TRIM":
        if (!draft) out.push(`${name(p)} is called TRIM but is not in the proposal (an EXIT?)`);
        else if (!now) out.push(`${name(p)} is called TRIM but is not in the plan in force`);
        else if (draft.targetWeightBps >= now.targetWeightBps)
          out.push(
            `${name(p)} is called TRIM but its weight does not fall (${now.targetWeightBps} to ${draft.targetWeightBps} bps)`,
          );
        break;
      case "HOLD":
        if (!draft) out.push(`${name(p)} is called HOLD but is not in the proposal`);
        else if (!now) out.push(`${name(p)} is called HOLD but is new to the plan (an ADD?)`);
        else if (draft.targetWeightBps !== now.targetWeightBps)
          out.push(
            `${name(p)} is called HOLD but its weight changes (${now.targetWeightBps} to ${draft.targetWeightBps} bps)`,
          );
        break;
    }
  }
  for (const [k, p] of proposed)
    if (!called.has(k)) out.push(`${p.token} is in the proposal without a call in the RATIONALE`);
  for (const [k, p] of current)
    if (!proposed.has(k) && !called.has(k))
      out.push(`${p.token} leaves the plan without an EXIT call in the RATIONALE`);
  return out;
}
