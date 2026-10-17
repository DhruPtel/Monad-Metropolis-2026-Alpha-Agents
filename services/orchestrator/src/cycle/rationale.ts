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

/**
 * 2026-10-16 (owner): the agent decides every weight and how much stays in cash, from its
 * research; no range or minimum judges them. A proposed target portfolio says why this
 * allocation (allocationNote) and why this much cash (cashNote), and the report shows both.
 * Pure: the findings are plain sentences the agent reads and fixes.
 */
export function allocationFindings(i: {
  readonly allocationNote: string | null | undefined;
  readonly cashNote: string | null | undefined;
}): string[] {
  const out: string[] = [];
  if (!(i.allocationNote ?? "").trim())
    out.push(
      "say why this allocation in the RATIONALE's allocationNote: why these positions at these weights, from the research",
    );
  if (!(i.cashNote ?? "").trim())
    out.push("say why this much cash in the RATIONALE's cashNote, from the research");
  return out;
}

/**
 * 2026-10-17 (owner): a proposed target portfolio is a decision, so it never gives every
 * position the same weight (the sizing from expected return times confidence ranks them), and
 * it does not repeat the plan the runner follows unless the RATIONALE says why the research
 * leads to the same allocation again. Pure: plain sentences the agent reads and fixes.
 */
export function planShapeFindings(i: {
  readonly positions: readonly { readonly token: string; readonly targetWeightBps: number }[];
  /** Whether the draft keeps the allocation in force (the same tokens, weights and cash). */
  readonly repeatsCurrent: boolean;
  readonly allocationNote: string | null | undefined;
  readonly portfolioView: string | null | undefined;
}): string[] {
  const out: string[] = [];
  const weights = new Set(i.positions.map((p) => p.targetWeightBps));
  if (i.positions.length >= 2 && weights.size === 1)
    out.push(
      `every position has the same weight (${i.positions[0]?.targetWeightBps ?? 0} bps): size each from its expected return times your confidence under the goal's mindset, so a stronger idea gets more`,
    );
  const said = `${i.allocationNote ?? ""} ${i.portfolioView ?? ""}`;
  if (
    i.repeatsCurrent &&
    !/\b(keep|keeps|kept|unchanged|same|again|repeat|repeats|maintain|still)\b/i.test(said)
  )
    out.push(
      "the plan repeats the plan the runner follows (the same tokens, weights and cash): decide the weights fresh from this cycle's research, or say in allocationNote why the research leads to the same allocation again",
    );
  return out;
}
