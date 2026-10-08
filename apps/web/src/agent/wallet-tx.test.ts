import { ContractFunctionRevertedError, encodeErrorResult } from "viem";
import { describe, expect, it } from "vitest";
import { ACCOUNT_ABI } from "./custody";
import { SentElsewhereError } from "./receipt-watch";
import {
  type WalletTxDeps,
  type WalletTxProgress,
  runWalletSteps,
  walletTxText,
} from "./wallet-tx";

const HASH = `0x${"ab".repeat(32)}` as const;
const steps = [
  { label: "Approve 25 USDC", call: "approve" },
  { label: "Deposit 25 USDC", call: "deposit" },
];

function deps(over: Partial<WalletTxDeps<string>> = {}) {
  const sent: string[] = [];
  const d: WalletTxDeps<string> = {
    checkNetwork: async () => ({ ok: true }),
    send: async (c) => {
      sent.push(c);
      return HASH;
    },
    waitForReceipt: async () => "success",
    ...over,
  };
  return { d, sent };
}

async function run(d: WalletTxDeps<string>) {
  const seen: WalletTxProgress[] = [];
  const result = await runWalletSteps(d, steps, (p) => seen.push(p));
  return { result, seen };
}

describe("wallet transactions (P2-U7)", () => {
  it("sends each step after the last confirmed, showing each wait", async () => {
    const { d, sent } = deps();
    const { result, seen } = await run(d);
    expect(sent).toEqual(["approve", "deposit"]);
    expect(seen.map((p) => `${p.state}:${p.step ?? ""}`)).toEqual([
      "checking:",
      "waiting-wallet:1",
      "confirming:1",
      "waiting-wallet:2",
      "confirming:2",
      "confirmed:2",
    ]);
    expect(result).toMatchObject({ state: "confirmed", hash: HASH });
    expect(walletTxText(seen[1] as WalletTxProgress)).toBe(
      "Waiting for your wallet: Approve 25 USDC (step 1 of 2).",
    );
  });

  it("sends nothing on the wrong network", async () => {
    const { d, sent } = deps({
      checkNetwork: async () => ({
        ok: false,
        reason: "wrong-chain-id",
        message: "Switch networks.",
      }),
    });
    expect((await run(d)).result).toEqual({ state: "failed", message: "Switch networks." });
    expect(sent).toEqual([]);
  });

  it("stops at a declined step and sends nothing after it", async () => {
    let n = 0;
    const { d, sent } = deps({
      send: async (c) => {
        n += 1;
        if (n === 2) throw Object.assign(new Error("no"), { code: 4001 });
        sent.push(c);
        return HASH;
      },
    });
    const { result } = await run(d);
    expect(result).toMatchObject({ state: "rejected", step: 2, label: "Deposit 25 USDC" });
    expect(walletTxText(result)).toMatch(/declined/);
    expect(sent).toEqual(["approve"]);
  });

  it("names the contract's revert in the owner's words", async () => {
    const data = encodeErrorResult({ abi: ACCOUNT_ABI, errorName: "DepositsPaused" });
    const revert = new ContractFunctionRevertedError({
      abi: ACCOUNT_ABI,
      data,
      functionName: "deposit",
    });
    const { d } = deps({
      send: async (c) => {
        if (c === "deposit") throw revert;
        return HASH;
      },
    });
    expect((await run(d)).result).toMatchObject({
      state: "failed",
      step: 2,
      message: "The account is paused, so it takes no deposits. Withdrawals still work.",
    });
  });

  it("reports a reverted receipt and a send to another network", async () => {
    const reverted = await run(deps({ waitForReceipt: async () => "reverted" }).d);
    expect(reverted.result).toMatchObject({ state: "failed", step: 1, hash: HASH });
    expect(reverted.result.message).toMatch(/failed on chain/);
    const elsewhere = await run(
      deps({
        waitForReceipt: async () => {
          throw new SentElsewhereError("Monad");
        },
      }).d,
    );
    expect(elsewhere.result.message).toMatch(/different network/);
  });
});
