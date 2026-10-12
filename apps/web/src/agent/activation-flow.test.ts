import { describe, expect, it } from "vitest";
import { type TurnOnDeps, type TurnOnProgress, runTurnOn } from "./activation-flow";
import type { WalletCall } from "./arming-flow";

const HASH = `0x${"12".repeat(32)}` as const;
const GRANT: WalletCall = {
  to: "0x00000000000000000000000000000000000e0ec0",
  data: "0x1234",
  value: "0",
};

function deps(over: Partial<TurnOnDeps> = {}): TurnOnDeps & { sent: WalletCall[]; starts: number } {
  const d = {
    sent: [] as WalletCall[],
    starts: 0,
    checkNetwork: async () => ({ ok: true as const }),
    getArming: async () => ({ status: 200, body: { grantCall: GRANT } }),
    confirmArming: async () => ({
      status: 201,
      body: { arming: { state: "awaiting_first_trade" } },
    }),
    disarm: async () => ({ status: 200, body: { disarmed: true, revokeCall: null } }),
    send: async (call: WalletCall) => {
      d.sent.push(call);
      return HASH;
    },
    waitForReceipt: async () => undefined,
    startActivation: async () => {
      d.starts += 1;
      return { status: 202, body: { activation: { activationId: "act-1", status: "running" } } };
    },
    ...over,
  };
  return d;
}

async function run(d: TurnOnDeps, arming: "unarmed" | "awaiting_first_trade" | "armed") {
  const seen: TurnOnProgress[] = [];
  const result = await runTurnOn(d, arming, (p) => seen.push(p));
  return { result, states: seen.map((p) => p.state) };
}

describe("turning automatic trading on (F-U10)", () => {
  it("registers the grant from the wallet first, then starts the sweep", async () => {
    const d = deps();
    const { result, states } = await run(d, "unarmed");
    expect(states).toEqual([
      "checking",
      "signing",
      "confirming",
      "recording",
      "awaiting-first-trade",
      "starting",
      "started",
    ]);
    expect(result).toEqual({ state: "started", activationId: "act-1" });
    expect(d.sent).toEqual([GRANT]);
    expect(d.starts).toBe(1);
  });

  it("passes the chosen account to the grant before the sweep (Step 0, 2026-10-12)", async () => {
    const asked: (string | undefined)[] = [];
    const d = deps({
      getArming: async (account) => {
        asked.push(account);
        return { status: 200, body: { grantCall: GRANT } };
      },
      confirmArming: async (account) => {
        asked.push(account);
        return { status: 201, body: { arming: { state: "awaiting_first_trade" } } };
      },
    });
    const seen: TurnOnProgress[] = [];
    const result = await runTurnOn(d, "unarmed", (p) => seen.push(p), "personal");
    expect(result.state).toBe("started");
    expect(asked).toEqual(["personal", "personal"]);
    expect(d.starts).toBe(1);
  });

  it("skips the grant when the permission is already on chain", async () => {
    const d = deps();
    const { states } = await run(d, "awaiting_first_trade");
    expect(states).toEqual(["starting", "started"]);
    expect(d.sent).toEqual([]);
    expect(d.starts).toBe(1);
  });

  it("starts nothing when the grant is declined or fails", async () => {
    const declined = deps({
      send: async () => {
        throw { code: 4001, message: "User rejected the request." };
      },
    });
    expect((await run(declined, "unarmed")).result).toEqual({ state: "rejected" });
    expect(declined.starts).toBe(0);
    const wrongNetwork = deps({
      checkNetwork: async () => ({
        ok: false as const,
        reason: "different-block" as const,
        message: "Wrong network.",
      }),
    });
    expect((await run(wrongNetwork, "unarmed")).result).toEqual({
      state: "error",
      message: "Wrong network.",
    });
    expect(wrongNetwork.starts).toBe(0);
  });

  it("shows the platform's named refusal, and says when it cannot be reached", async () => {
    const refused = deps({
      startActivation: async () => ({
        status: 409,
        body: {
          error: "activation_credits",
          message: "Credits are short: 3.00 USDC available.",
          checks: [],
        },
      }),
    });
    expect((await run(refused, "armed")).result).toEqual({
      state: "error",
      message: "Credits are short: 3.00 USDC available.",
    });
    const down = deps({
      startActivation: async () => {
        throw new Error("fetch failed");
      },
    });
    expect((await run(down, "armed")).result).toEqual({
      state: "error",
      message: "Could not reach the platform.",
    });
  });
});
