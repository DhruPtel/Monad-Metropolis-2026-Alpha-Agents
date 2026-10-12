import { describe, expect, it } from "vitest";
import { type SetupFacts, setupSteps } from "./setup-flow";

const facts = (over: Partial<SetupFacts> = {}): SetupFacts => ({
  allowlisted: true,
  hasAccount: false,
  valueUsdcE6: null,
  goalConfigured: false,
  armingState: "unarmed",
  custody: "v3",
  ...over,
});
const ACTIONS = { open: "open", deposit: "deposit", goal: "goal", turnOn: "turnOn" } as const;
const states = (f: SetupFacts) => setupSteps(f, ACTIONS).map((s) => `${s.key}:${s.state}`);

describe("setupSteps (UI-U1)", () => {
  it("starts with opening the account, which carries the only action", () => {
    const steps = setupSteps(facts(), ACTIONS);
    expect(steps.map((s) => s.state)).toEqual(["next", "later", "later", "later"]);
    expect(steps.map((s) => s.action)).toEqual(["open", undefined, undefined, undefined]);
    expect(steps[0]?.detail).toContain("fund agent's set");
  });

  it("names the allowlist in plain words and blocks the first step, which keeps its action for the page to disable", () => {
    const steps = setupSteps(facts({ allowlisted: false }), ACTIONS);
    expect(steps[0]?.state).toBe("blocked");
    expect(steps[0]?.action).toBe("open");
    expect(steps.slice(1).map((s) => s.action)).toEqual([undefined, undefined, undefined]);
    expect(steps[0]?.detail).toContain("not yet allowed to deposit during the beta");
  });

  it("moves to the deposit once the account is open, and counts 5 USDC as enough", () => {
    expect(states(facts({ hasAccount: true, valueUsdcE6: 0n }))).toEqual([
      "open:done",
      "deposit:next",
      "goal:later",
      "turnOn:later",
    ]);
    const some = setupSteps(facts({ hasAccount: true, valueUsdcE6: 2_500_000n }), ACTIONS);
    expect(some[1]?.detail).toContain("2.50 USDC in the account; at least 5.00 USDC");
    expect(states(facts({ hasAccount: true, valueUsdcE6: 5_000_000n }))).toEqual([
      "open:done",
      "deposit:done",
      "goal:next",
      "turnOn:later",
    ]);
  });

  it("an API without goals has nothing to set, and arming completes the flow", () => {
    expect(
      states(facts({ hasAccount: true, valueUsdcE6: 40_000_000n, goalConfigured: null })),
    ).toEqual(["open:done", "deposit:done", "goal:done", "turnOn:next"]);
    const armed = setupSteps(
      facts({
        hasAccount: true,
        valueUsdcE6: 40_000_000n,
        goalConfigured: true,
        armingState: "armed",
      }),
      ACTIONS,
    );
    expect(armed.every((s) => s.state === "done")).toBe(true);
    expect(armed[3]?.detail).toContain("On.");
    const awaiting = setupSteps(
      facts({
        hasAccount: true,
        valueUsdcE6: 40_000_000n,
        goalConfigured: true,
        armingState: "awaiting_first_trade",
      }),
      ACTIONS,
    );
    expect(awaiting[3]?.state).toBe("done");
    expect(awaiting[3]?.detail).toContain("approving the agent's first plan");
  });
});
