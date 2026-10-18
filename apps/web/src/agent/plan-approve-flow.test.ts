import { describe, expect, it } from "vitest";
import type { ArmingFlowDeps, WalletCall } from "./arming-flow";
import {
  type ApprovePlanDeps,
  type ApprovePlanProgress,
  runApproveAndStart,
} from "./plan-approve-flow";

const HASH = `0x${"34".repeat(32)}` as const;
const GRANT: WalletCall = {
  to: "0x00000000000000000000000000000000000e0ec0",
  data: "0x1234",
  value: "0",
};

function deps(over: Partial<ApprovePlanDeps> = {}) {
  const sent: WalletCall[] = [];
  const calls: string[] = [];
  const d: ApprovePlanDeps = {
    checkNetwork: async () => ({ ok: true }),
    getArming: async () => ({ status: 200, body: { grantCall: GRANT } }),
    confirmArming: async () => {
      calls.push("confirm");
      return { status: 201, body: { arming: { state: "awaiting_first_trade" } } };
    },
    disarm: async () => ({ status: 200, body: {} }),
    send: async (call) => {
      sent.push(call);
      calls.push("send");
      return HASH;
    },
    waitForReceipt: async () => undefined,
    approve: async () => {
      calls.push("approve");
      return { armed: true };
    },
    ...over,
  } satisfies ArmingFlowDeps & ApprovePlanDeps;
  return { d, sent, calls };
}

async function run(d: ApprovePlanDeps, state: "unarmed" | "awaiting_first_trade" | "armed") {
  const seen: ApprovePlanProgress[] = [];
  const result = await runApproveAndStart(d, state, (p) => seen.push(p));
  return { result, states: seen.map((p) => p.state) };
}

describe("Approve and start trading in one step (2026-10-18)", () => {
  it("an unarmed agent: the one wallet transaction for the permission, then the approval that arms it", async () => {
    const { d, sent, calls } = deps();
    const { result, states } = await run(d, "unarmed");
    expect(sent).toEqual([GRANT]);
    expect(calls).toEqual(["send", "confirm", "approve"]);
    expect(states).toEqual([
      "checking",
      "signing",
      "confirming",
      "recording",
      "awaiting-first-trade",
      "approving",
      "approved",
    ]);
    expect(result).toEqual({ state: "approved", trading: true });
  });

  it("an agent with its permission already on chain: the approval alone, no wallet transaction", async () => {
    for (const state of ["awaiting_first_trade", "armed"] as const) {
      let approved = 0;
      const { d, sent, calls } = deps({
        approve: async () => {
          approved += 1;
          return { armed: state === "awaiting_first_trade" };
        },
      });
      const { result } = await run(d, state);
      expect(sent).toEqual([]);
      expect(calls).toEqual([]);
      expect(approved).toBe(1);
      expect(result).toEqual({ state: "approved", trading: true });
    }
  });

  it("a permission the wallet refused leaves the plan waiting: nothing is approved", async () => {
    const { d, calls } = deps({
      send: async () => {
        throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      },
    });
    const { result } = await run(d, "unarmed");
    expect(result.state).toBe("rejected");
    expect(calls).not.toContain("approve");
  });

  it("an approval the platform refuses is an error with its message", async () => {
    const { d } = deps({
      approve: async () => {
        throw new Error("The proposal no longer passes the platform's checks and was not applied.");
      },
    });
    const { result } = await run(d, "armed");
    expect(result).toEqual({
      state: "error",
      message: "The proposal no longer passes the platform's checks and was not applied.",
    });
  });
});
