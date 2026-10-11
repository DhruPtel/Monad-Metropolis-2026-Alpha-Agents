import { describe, expect, it } from "vitest";
import { flightState, wantsFlight } from "./flight";

describe("the viewer's flight during the activation sweep (F-U10)", () => {
  it("flies only while the sweep runs, after the walk-in, with animation on", () => {
    expect(wantsFlight({ enabled: true, hover: true, phase: "idle" })).toBe(true);
    expect(wantsFlight({ enabled: true, hover: true, phase: "approach" })).toBe(false);
    expect(wantsFlight({ enabled: true, hover: true, phase: "settle" })).toBe(false);
    expect(wantsFlight({ enabled: true, hover: false, phase: "idle" })).toBe(false);
    expect(wantsFlight({ enabled: true, hover: null, phase: "idle" })).toBe(false);
    expect(wantsFlight({ enabled: true, hover: undefined, phase: "idle" })).toBe(false);
    // Reduced motion turns animation off: grounded whatever the sweep does.
    expect(wantsFlight({ enabled: false, hover: true, phase: "idle" })).toBe(false);
  });

  it("reports taking off, hovering and landing from the lift, and the walk otherwise", () => {
    expect(flightState({ wantFly: false, lift: 0, phase: "approach" })).toBe("walking");
    expect(flightState({ wantFly: false, lift: 0, phase: "settle" })).toBe("settling");
    expect(flightState({ wantFly: false, lift: 0, phase: "idle" })).toBe("idle");
    expect(flightState({ wantFly: true, lift: 0, phase: "idle" })).toBe("takingOff");
    expect(flightState({ wantFly: true, lift: 0.5, phase: "idle" })).toBe("takingOff");
    expect(flightState({ wantFly: true, lift: 1, phase: "idle" })).toBe("hovering");
    expect(flightState({ wantFly: false, lift: 0.4, phase: "idle" })).toBe("landing");
  });
});
