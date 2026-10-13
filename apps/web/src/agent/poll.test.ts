import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schedulePoll } from "./poll";

describe("schedulePoll", () => {
  let state: "visible" | "hidden" = "visible";
  const listeners = new Set<() => void>();
  beforeEach(() => {
    vi.useFakeTimers();
    state = "visible";
    listeners.clear();
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("document", {
      get visibilityState() {
        return state;
      },
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const show = () => {
    state = "visible";
    for (const fn of [...listeners]) fn();
  };

  it("polls after the delay while the tab is shown", () => {
    const next = vi.fn();
    schedulePoll(next, 5_000);
    vi.advanceTimersByTime(4_999);
    expect(next).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("holds the poll while the tab is hidden and runs it once when shown", () => {
    const next = vi.fn();
    schedulePoll(next, 5_000);
    state = "hidden";
    vi.advanceTimersByTime(60_000);
    expect(next).not.toHaveBeenCalled();
    show();
    show();
    expect(next).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });

  it("cancels both the timer and a held poll", () => {
    const next = vi.fn();
    schedulePoll(next, 5_000)();
    vi.advanceTimersByTime(10_000);
    state = "hidden";
    const cancel = schedulePoll(next, 5_000);
    vi.advanceTimersByTime(5_000);
    cancel();
    show();
    expect(next).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });
});
