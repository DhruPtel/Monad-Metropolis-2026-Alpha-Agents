"use client";

import { type EnvironmentId, TESTNET_CHAIN } from "@alpha-agents/config";
import { addressEntry } from "@alpha-agents/domain";
import { useCallback, useMemo, useState } from "react";
import { type Address, getAddress, parseAbi } from "viem";
import { useWalletSession } from "@/auth/session";
import { useWalletTx } from "./use-wallet-tx";

/** 2026-10-16: the dev stack's test USDC (nad.fun's) has an open mint; this much per press. */
export const TEST_USDC_AMOUNT = 1_000_000_000n;
const MINT_ABI = parseAbi(["function mint(address to, uint256 amount)"]);

export type TestUsdcState =
  | { readonly state: "idle" }
  | { readonly state: "working"; readonly text: string }
  | { readonly state: "done"; readonly text: string; readonly hash: string }
  | { readonly state: "error"; readonly text: string };

/** Whether this build offers test USDC: the dev stack only, whose USDC anyone may mint. */
export const offersTestUsdc = (environment: EnvironmentId) =>
  environment === "testnet" && TESTNET_CHAIN.key === "monad-dev";

/** "Get test USDC": mints 1,000 test USDC to the connected wallet, on the dev stack only. */
export function useTestUsdc(environment: EnvironmentId) {
  const wallet = useWalletSession();
  const { checkNetwork, waitForReceipt } = useWalletTx(environment);
  const usdc = useMemo(() => {
    const e = addressEntry(environment, "usdc");
    return e.status === "verified" ? (e.address as Address) : null;
  }, [environment]);
  const [status, setStatus] = useState<TestUsdcState>({ state: "idle" });

  const get = useCallback(async () => {
    const to = wallet.address;
    if (!usdc || !to || status.state === "working") return;
    setStatus({ state: "working", text: "Confirm the mint in your wallet." });
    try {
      const network = await checkNetwork();
      if (!network.ok) {
        setStatus({ state: "error", text: network.message });
        return;
      }
      const hash = await wallet.writeContract({
        address: usdc,
        abi: MINT_ABI,
        functionName: "mint",
        args: [getAddress(to), TEST_USDC_AMOUNT],
      });
      setStatus({ state: "working", text: "Minting 1,000 test USDC." });
      const result = await waitForReceipt(hash);
      setStatus(
        result === "success"
          ? { state: "done", text: "1,000 test USDC are in your wallet.", hash }
          : { state: "error", text: "The mint reverted; nothing was minted." },
      );
    } catch (err) {
      setStatus({
        state: "error",
        text:
          err instanceof Error && /reject|denied/i.test(err.message)
            ? "The mint was cancelled in the wallet."
            : "The mint could not be sent; try again.",
      });
    }
  }, [checkNetwork, status.state, usdc, waitForReceipt, wallet]);

  return { available: offersTestUsdc(environment) && usdc !== null, status, get };
}
