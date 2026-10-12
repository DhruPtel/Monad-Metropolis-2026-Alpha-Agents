// @ts-check
import { describe, expect, it } from "vitest";
import { compareState, localIntent } from "./state-assert.js";

const A = /** @type {const} */ ({
  factory: "0x1000000000000000000000000000000000000001",
  executor: "0x1000000000000000000000000000000000000002",
  routeAdapter: "0x1000000000000000000000000000000000000003",
  protocolRegistry: "0x1000000000000000000000000000000000000004",
  oracle: "0x1000000000000000000000000000000000000005",
  tokenRegistry: "0x1000000000000000000000000000000000000006",
  agentNft: "0x1000000000000000000000000000000000000007",
  usdc: "0x1000000000000000000000000000000000000008",
});

/** A reading that matches the intent exactly, as the chain would serve it. */
function matching() {
  return structuredClone(localIntent(A));
}

describe("MV-S15 compareState", () => {
  it("passes a reading that matches the intent, whatever the case of its addresses and the type of its numbers", () => {
    const actual = matching();
    actual.factory.owner = /** @type {`0x${string}`} */ (actual.factory.owner.toLowerCase());
    actual.executor.policy = /** @type {typeof actual.executor.policy} */ (
      /** @type {unknown} */ (
        Object.fromEntries(Object.entries(actual.executor.policy).map(([k, v]) => [k, BigInt(v)]))
      )
    );
    expect(compareState(localIntent(A), actual)).toEqual([]);
  });

  it("names every value that differs: a cap, a flag, a role, an allowlist entry and a policy limit", () => {
    const actual = matching();
    actual.factory.vaultCap = 1n;
    actual.factory.depositsEnabled = true;
    actual.executor.guardian = A.usdc;
    const first = Object.keys(actual.factory.allowlisted)[0] ?? "";
    actual.factory.allowlisted[first] = false;
    actual.executor.policy = { ...actual.executor.policy, maxTradeBps: 1_001 };
    const paths = compareState(localIntent(A), actual).map((m) => m.path);
    expect(paths).toEqual([
      "factory.vaultCap",
      "factory.depositsEnabled",
      `factory.allowlisted.${first}`,
      "executor.guardian",
      "executor.policy.maxTradeBps",
    ]);
  });

  it("fails a reading with a value missing", () => {
    const actual = matching();
    // @ts-expect-error a missing field
    delete actual.oracle.pools;
    expect(compareState(localIntent(A), actual)).toEqual([
      { path: "oracle.pools", expected: A.protocolRegistry.toLowerCase(), actual: "(missing)" },
    ]);
  });

  it("states the beta's intent: the allowlist on, public vault deposits off, the vault cap between the personal and platform caps", () => {
    const intent = localIntent(A);
    expect(intent.factory.allowlistEnabled).toBe(true);
    expect(intent.factory.depositsEnabled).toBe(false);
    expect(intent.factory.vaultCap).toBeGreaterThan(intent.factory.personalCap);
    expect(intent.factory.vaultCap).toBeLessThan(intent.factory.platformCap);
    expect(intent.executor.policy.maxTradeBps).toBe(1_000);
  });
});
