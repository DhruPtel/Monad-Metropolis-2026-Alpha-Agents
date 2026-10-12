import { describe, expect, it } from "vitest";
import { type SeenStore, readRevealSeen, revealSeenKey, writeRevealSeen } from "./reveal-seen";

describe("the reveal's seen flag (UI-U2)", () => {
  it("keys by environment and agent, so a fork's agent never marks a mainnet one", () => {
    expect(revealSeenKey("local", 7n)).toBe("aa:reveal-seen:local:7");
    expect(revealSeenKey("beta", 7n)).not.toBe(revealSeenKey("local", 7n));
  });

  it("reads false until written, true after, and never throws when storage is blocked", () => {
    const map = new Map<string, string>();
    const store: SeenStore = {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
    };
    const key = revealSeenKey("local", 7n);
    expect(readRevealSeen(key, store)).toBe(false);
    writeRevealSeen(key, store);
    expect(readRevealSeen(key, store)).toBe(true);
    const blocked: SeenStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => writeRevealSeen(key, blocked)).not.toThrow();
    expect(readRevealSeen(key, blocked)).toBe(false);
    expect(readRevealSeen(key, null)).toBe(false);
  });
});
