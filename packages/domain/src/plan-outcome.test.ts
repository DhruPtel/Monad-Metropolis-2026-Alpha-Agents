import { describe, expect, it } from "vitest";
import {
  type PlanCardRefs,
  type RunPlanRecords,
  finishView,
  planCardShows,
  runPlanOutcome,
} from "./plan-outcome.ts";

/**
 * 2026-10-17: the Research tab's finish strip and the Trading tab's plan card read one outcome per
 * run, so "Review plan" shows only when the card shows that run's proposal waiting.
 */
const STAGES_OK: RunPlanRecords["stages"] = [
  { stage: "SCAN", status: "completed", stopReason: "COMPLETED" },
  { stage: "DIVE", status: "completed", stopReason: "COMPLETED" },
  { stage: "CHALLENGE", status: "completed", stopReason: "COMPLETED" },
  { stage: "TEST", status: "completed", stopReason: "COMPLETED", checked: [] },
  { stage: "ZOOM_OUT", status: "completed", stopReason: "COMPLETED" },
];
const done = { kind: "ACTIVATION", status: "completed", stopReason: "COMPLETED" };
const proposal = (
  over: Partial<NonNullable<RunPlanRecords["proposal"]>>,
): NonNullable<RunPlanRecords["proposal"]> => ({
  proposalId: "prop-1",
  kind: "proposal",
  status: "pending_owner",
  reasonCode: null,
  decidedBy: null,
  findings: [],
  ...over,
});
const withChecked = (
  checked: NonNullable<RunPlanRecords["stages"][number]["checked"]>,
  zoom: { status: string; stopReason: string } = { status: "completed", stopReason: "COMPLETED" },
): RunPlanRecords["stages"] =>
  STAGES_OK.map((s) =>
    s.stage === "TEST" ? { ...s, checked } : s.stage === "ZOOM_OUT" ? { ...s, ...zoom } : s,
  );
const card = (over: Partial<PlanCardRefs> = {}): PlanCardRefs => ({
  pendingId: null,
  inForceId: null,
  planInForce: false,
  ...over,
});

describe("a run's plan outcome and the finish strip", () => {
  it("awaiting approval: Review plan only when the card shows this run's proposal waiting", () => {
    const o = runPlanOutcome({ cycle: done, stages: STAGES_OK, proposal: proposal({}) });
    expect(o).toMatchObject({ kind: "awaiting_approval", proposalId: "prop-1" });
    const c = card({ pendingId: "prop-1" });
    expect(planCardShows(c)).toBe("pending");
    expect(finishView(o, c)).toMatchObject({ button: "review_plan", tone: "done" });
    // The card shows another proposal (or none): never "Review plan" for this one.
    expect(finishView(o, card({ pendingId: "prop-2" })).button).not.toBe("review_plan");
    expect(finishView(o, card()).button).toBeNull();
  });

  it("applied at once (apply and tell): Plan applied with View plan, and the card shows it in force", () => {
    const o = runPlanOutcome({
      cycle: done,
      stages: STAGES_OK,
      proposal: proposal({ status: "applied" }),
    });
    expect(o).toMatchObject({ kind: "applied", appliedBy: "agent" });
    const c = card({ inForceId: "prop-1", planInForce: true });
    expect(planCardShows(c)).toBe("in_force");
    const f = finishView(o, c);
    expect(f.line).toBe("Plan applied: your goal applies plan changes at once");
    expect(f.button).toBe("view_plan");
    // Approved by the owner since: said as such.
    const owner = runPlanOutcome({
      cycle: done,
      stages: STAGES_OK,
      proposal: proposal({
        status: "applied",
        decidedBy: "0x00000000000000000000000000000000000000aa",
      }),
    });
    expect(finishView(owner, c).line).toBe("Plan approved and in force");
  });

  it("kept: Plan unchanged with View current plan when a plan is in force, the reason when none is", () => {
    const o = runPlanOutcome({
      cycle: done,
      stages: STAGES_OK,
      proposal: proposal({ kind: "no_change", status: "recorded", reasonCode: "EVIDENCE_THIN" }),
    });
    expect(o).toMatchObject({ kind: "kept", reasonCode: "EVIDENCE_THIN" });
    expect(o.reason).toBe("The research decided against a change: evidence thin.");
    const inForce = finishView(o, card({ inForceId: "prop-0", planInForce: true }));
    expect(inForce).toMatchObject({ line: "Plan unchanged", button: "view_current_plan" });
    const none = finishView(o, card());
    expect(none.button).toBeNull();
    expect(none.line).toBe("No plan: the research decided against a change: evidence thin.");
  });

  it("kept after the checks refused the draft: the refusal is part of the why", () => {
    const o = runPlanOutcome({
      cycle: done,
      stages: withChecked([{ passed: false, codes: ["NO_ACCOUNT"] }]),
      proposal: proposal({ kind: "no_change", status: "recorded", reasonCode: "EVIDENCE_THIN" }),
    });
    expect(o.kind).toBe("kept");
    expect(o.reason).toBe(
      "The research decided against a change (evidence thin) after the platform's checks refused the plan the agent drafted: the agent has no trading account yet (open one on the Trading tab).",
    );
  });

  it("refused: every draft refused and the plan step capped (agent #6 of 2026-10-17) names the checks", () => {
    const o = runPlanOutcome({
      cycle: { kind: "ACTIVATION", status: "completed", stopReason: "CEILING" },
      stages: withChecked(
        [
          { passed: false, codes: ["OUT_OF_BOUNDS", "OUT_OF_BOUNDS", "OUT_OF_BOUNDS", "DEPTH"] },
          { passed: false, codes: ["DEPTH"] },
        ],
        { status: "capped", stopReason: "CEILING" },
      ),
      proposal: null,
    });
    expect(o).toMatchObject({ kind: "refused", reasonCode: "DEPTH", proposalId: null });
    expect(o.reason).toBe(
      "The platform's checks refused the 2 plans the agent drafted: a position is too large for its pools; then the plan step stopped: the step reached its cost ceiling.",
    );
    const f = finishView(o, card());
    expect(f.tone).toBe("attention");
    expect(f.button).toBeNull();
    expect(f.line.startsWith("No plan: the platform's checks refused")).toBe(true);
  });

  it("refused by the evaluator: the stored findings, never Review plan", () => {
    const o = runPlanOutcome({
      cycle: done,
      stages: STAGES_OK,
      proposal: proposal({
        status: "rejected",
        findings: [{ code: "COOLDOWN", message: "Changed less than 24 hours ago." }],
      }),
    });
    expect(o).toMatchObject({ kind: "refused", reasonCode: "COOLDOWN" });
    expect(o.reason).toBe(
      "The platform's checks refused the plan: the agent changed the plan less than 24 hours ago.",
    );
    expect(finishView(o, card({ inForceId: "prop-0", planInForce: true }))).toMatchObject({
      button: "view_current_plan",
      tone: "attention",
    });
  });

  it("no plan: a run stopped on credits, and a plan step that ended without a decision", () => {
    const short = runPlanOutcome({
      cycle: { kind: "ACTIVATION", status: "stopped", stopReason: "CREDITS_SHORT" },
      stages: [
        { stage: "SCAN", status: "completed", stopReason: "COMPLETED" },
        { stage: "DIVE", status: "stopped", stopReason: "CREDITS_SHORT" },
      ],
      proposal: null,
    });
    expect(short).toMatchObject({ kind: "no_plan", reasonCode: "CREDITS_SHORT" });
    expect(finishView(short, card()).line).toBe(
      "No plan: a token's research stopped: the credits could not cover the next step.",
    );
    const capped = runPlanOutcome({
      cycle: { kind: "ACTIVATION", status: "completed", stopReason: "CEILING" },
      stages: withChecked([], { status: "capped", stopReason: "CEILING" }),
      proposal: null,
    });
    expect(capped).toMatchObject({ kind: "no_plan", reasonCode: "CEILING" });
    expect(capped.reason).toBe(
      "The plan step stopped before it decided: the step reached its cost ceiling.",
    );
    const nothing = runPlanOutcome({
      cycle: { kind: "ROUTINE", status: "completed", stopReason: "NOTHING_MATERIAL" },
      stages: [{ stage: "SCAN", status: "completed", stopReason: "COMPLETED" }],
      proposal: null,
    });
    expect(nothing).toMatchObject({ kind: "no_plan", reasonCode: "NOTHING_MATERIAL" });
    for (const o of [short, capped, nothing])
      expect(finishView(o, card()).button).not.toBe("review_plan");
  });

  it("declined, expired and superseded proposals never offer Review plan", () => {
    for (const [status, reasonCode, kind] of [
      ["declined", null, "declined"],
      ["expired", null, "expired"],
      ["expired", "SUPERSEDED", "superseded"],
    ] as const) {
      const o = runPlanOutcome({
        cycle: done,
        stages: STAGES_OK,
        proposal: proposal({ status, reasonCode }),
      });
      expect(o.kind).toBe(kind);
      const f = finishView(o, card({ pendingId: "prop-9" }));
      expect(f.button).not.toBe("review_plan");
      // A newer plan waits: the strip offers it as the other waiting plan.
      expect(f.otherWaiting).toBe(true);
    }
  });

  it("a run still going says so and offers nothing", () => {
    const o = runPlanOutcome({
      cycle: { kind: "ACTIVATION", status: "running", stopReason: null },
      stages: [],
      proposal: null,
    });
    expect(o.kind).toBe("running");
    expect(finishView(o, card()).button).toBeNull();
  });
});
