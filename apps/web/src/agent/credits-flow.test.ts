import { describe, expect, it } from "vitest";
import {
  type CreditsFlowDeps,
  type CreditsProgress,
  creditsText,
  runAddCredits,
} from "./credits-flow";

const HASH = `0x${"ab".repeat(32)}` as const;
const step = { label: "Send 5 USDC to the funding address", call: "transfer" };
const usdc = (v: bigint) => (Number(v) / 1e6).toString();

function deps(
  totals: { credits: bigint; held: bigint }[],
  over: Partial<CreditsFlowDeps<string>> = {},
) {
  const sent: string[] = [];
  let read = 0;
  const d: CreditsFlowDeps<string> = {
    checkNetwork: async () => ({ ok: true }),
    send: async (c) => {
      sent.push(c);
      return HASH;
    },
    waitForReceipt: async () => "success",
    readCredits: async () =>
      totals[Math.min(read++, totals.length - 1)] as { credits: bigint; held: bigint },
    sleep: async () => undefined,
    pollMs: 0,
    ...over,
  };
  return { d, sent };
}

async function run(d: CreditsFlowDeps<string>, amount = 5_000_000n) {
  const seen: CreditsProgress[] = [];
  const result = await runAddCredits(d, step, amount, (p) => seen.push(p));
  return { result, seen };
}

describe("adding credits from the app (Phase 2 tuning)", () => {
  it("sends one transfer, then follows the crediting until it shows", async () => {
    const { d, sent } = deps([
      { credits: 1_000_000n, held: 0n },
      { credits: 1_000_000n, held: 0n },
      { credits: 6_000_000n, held: 0n },
    ]);
    const { result, seen } = await run(d);
    expect(sent).toEqual(["transfer"]);
    expect(seen.map((p) => p.state)).toEqual([
      "checking",
      "waiting-wallet",
      "confirming",
      "confirmed",
      "confirming",
      "confirmed",
    ]);
    expect(result).toMatchObject({ state: "confirmed", credited: 5_000_000n, held: 0n });
    expect(creditsText(result, usdc)).toBe("Credited 5 USDC.");
    expect(creditsText(seen[4] as CreditsProgress, usdc)).toBe(
      "Sent. Waiting for the platform to credit it.",
    );
  });

  it("says how much is held above the cap", async () => {
    const { d } = deps([
      { credits: 48_000_000n, held: 0n },
      { credits: 50_000_000n, held: 3_000_000n },
    ]);
    const { result } = await run(d);
    expect(result).toMatchObject({ credited: 2_000_000n, held: 3_000_000n });
    expect(creditsText(result, usdc)).toBe(
      "Credited 2 USDC. 3 USDC above the cap is held for you, not lost.",
    );
  });

  it("stops at a declined wallet request, and sends nothing", async () => {
    const { d } = deps([{ credits: 0n, held: 0n }], {
      send: async () => {
        throw Object.assign(new Error("no"), { code: 4001 });
      },
    });
    const { result } = await run(d);
    expect(result.state).toBe("rejected");
    expect(creditsText(result, usdc)).toBeNull();
  });

  it("says it was sent when the crediting does not show in time", async () => {
    const { d } = deps([{ credits: 0n, held: 0n }], { creditTimeoutMs: 0 });
    const { result } = await run(d);
    expect(result.state).toBe("confirmed");
    expect(creditsText(result, usdc)).toMatch(/not credited it yet/);
  });
});
