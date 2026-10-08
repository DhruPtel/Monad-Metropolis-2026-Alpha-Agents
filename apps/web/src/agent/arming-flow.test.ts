import { describe, expect, it } from "vitest";
import {
  type ArmingFlowDeps,
  type ArmingProgress,
  type WalletCall,
  runArm,
  runDisarm,
} from "./arming-flow";
import { SentElsewhereError } from "./receipt-watch";

const HASH = `0x${"12".repeat(32)}` as const;
const GRANT: WalletCall = { to: "0x00000000000000000000000000000000000e0ec0", data: "0x1234", value: "0" };
const REVOKE: WalletCall = { to: "0x00000000000000000000000000000000000e0ec0", data: "0x5678", value: "0" };

function deps(over: Partial<ArmingFlowDeps> = {}): ArmingFlowDeps & { sent: WalletCall[] } {
  const sent: WalletCall[] = [];
  return {
    sent,
    checkNetwork: async () => ({ ok: true }),
    getArming: async () => ({ status: 200, body: { grantCall: GRANT } }),
    confirmArming: async () => ({ status: 201, body: { arming: { state: "awaiting_first_trade" } } }),
    disarm: async () => ({ status: 200, body: { disarmed: true, revokeCall: REVOKE } }),
    send: async (call) => {
      sent.push(call);
      return HASH;
    },
    waitForReceipt: async () => undefined,
    ...over,
  };
}

async function run(fn: typeof runArm, d: ArmingFlowDeps) {
  const seen: ArmingProgress[] = [];
  const result = await fn(d, (p) => seen.push(p));
  return { result, states: seen.map((p) => p.state) };
}

describe("arming from the owner's wallet (P2-U6)", () => {
  it("checks the network, sends the grant the API built, waits, then has it recorded", async () => {
    const d = deps();
    const { result, states } = await run(runArm, d);
    expect(states).toEqual(["checking", "signing", "confirming", "recording", "awaiting-first-trade"]);
    expect(result).toEqual({ state: "awaiting-first-trade", hash: HASH });
    expect(d.sent).toEqual([GRANT]);
  });

  it("sends nothing when the wallet is on another network", async () => {
    const d = deps({
      checkNetwork: async () => ({ ok: false, reason: "different-block", message: "Wrong network." }),
    });
    const { result } = await run(runArm, d);
    expect(result).toEqual({ state: "error", message: "Wrong network." });
    expect(d.sent).toEqual([]);
  });

  it("says when the owner rejects the wallet request, and when the API refuses the grant", async () => {
    const rejected = await run(
      runArm,
      deps({
        send: async () => {
          throw Object.assign(new Error("no"), { code: 4001 });
        },
      }),
    );
    expect(rejected.result.state).toBe("rejected");
    const refused = await run(
      runArm,
      deps({
        confirmArming: async () => ({
          status: 409,
          body: { error: "grant_invalid", message: "A trading permission can last at most 30 days." },
        }),
      }),
    );
    expect(refused.result).toMatchObject({
      state: "error",
      hash: HASH,
      message: "A trading permission can last at most 30 days.",
    });
  });

  it("reports a send to another network as it is", async () => {
    const { result } = await run(
      runArm,
      deps({
        waitForReceipt: async () => {
          throw new SentElsewhereError("Monad");
        },
      }),
    );
    expect(result.state).toBe("error");
    expect(result.message).toMatch(/different network/);
  });

  it("refuses to arm without a grant call (no funding address or contracts)", async () => {
    const d = deps({ getArming: async () => ({ status: 200, body: { grantCall: null } }) });
    expect((await run(runArm, d)).result.state).toBe("error");
    expect(d.sent).toEqual([]);
  });
});

describe("disarming", () => {
  it("disarms on the platform first, then sends the revoke", async () => {
    const d = deps();
    const { result, states } = await run(runDisarm, d);
    expect(states).toEqual(["checking", "signing", "confirming", "disarmed"]);
    expect(result).toEqual({ state: "disarmed", hash: HASH });
    expect(d.sent).toEqual([REVOKE]);
  });

  it("stays disarmed when the owner declines the revoke, and says the grant is still on chain", async () => {
    const { result } = await run(
      runDisarm,
      deps({
        send: async () => {
          throw Object.assign(new Error("no"), { code: 4001 });
        },
      }),
    );
    expect(result.state).toBe("disarmed");
    expect(result.message).toMatch(/stays on chain/);
  });
});
