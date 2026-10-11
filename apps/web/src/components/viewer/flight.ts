/**
 * The viewer's flight decision (F-U10), kept pure and apart from three.js:
 * the bee walks in and settles on the platform, takes off and hovers only
 * while the agent's activation sweep runs, and lands when it ends. With
 * animation off (reduced motion) nothing moves, so it stays grounded.
 */
export type SequencePhase = "approach" | "settle" | "idle";

export function wantsFlight(o: {
  readonly enabled: boolean;
  /** True while the sweep runs; false or null otherwise. */
  readonly hover: boolean | null | undefined;
  readonly phase: SequencePhase;
}): boolean {
  return o.enabled && o.hover === true && o.phase === "idle";
}

export type FlightState = "walking" | "settling" | "idle" | "takingOff" | "hovering" | "landing";

/** The state the viewer reports, from the flight wanted, the lift ramp and the walk phase. */
export function flightState(o: {
  readonly wantFly: boolean;
  /** The lift ramp's progress, 0 grounded to 1 at hover height. */
  readonly lift: number;
  readonly phase: SequencePhase;
}): FlightState {
  if (!o.wantFly && o.lift > 0) return "landing";
  if (o.lift > 0) return o.lift >= 0.98 ? "hovering" : "takingOff";
  if (o.phase === "approach") return "walking";
  if (o.phase === "settle") return "settling";
  return o.wantFly ? "takingOff" : "idle";
}
