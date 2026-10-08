"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import { agentNftDeployment } from "@alpha-agents/domain";
import { useCallback, useMemo } from "react";
import type { Hex, PublicClient } from "viem";
import { useWalletSession } from "@/auth/session";
import { chainClient } from "./chain";
import { type NetworkCheck, type Rpc, checkWalletNetwork } from "./network-check";
import { waitForReceiptOnAppNetwork } from "./receipt-watch";
import { StuckNonceError, readNonceReport, stuckNonce } from "./stuck-nonce";

/**
 * What every wallet transaction on the money pages shares (P2-U7, Phase 2
 * tuning): the app's own RPC client, the network guard through the connected
 * wallet's provider (chain ID, a fixed block, AgentNFT's code), and the wait
 * for the receipt on the app's network, which names a send that landed
 * elsewhere (L-53) and, on the local fork, a stuck nonce, then reads whether
 * the transaction succeeded.
 */
export interface WalletTx {
  /** The app's own RPC client, for reads and simulations. */
  readonly client: PublicClient;
  readonly appRpc: Rpc;
  checkNetwork(): Promise<NetworkCheck>;
  waitForReceipt(hash: Hex): Promise<"success" | "reverted">;
}

export function useWalletTx(environment: EnvironmentId): WalletTx {
  const wallet = useWalletSession();
  const deployment = useMemo(() => agentNftDeployment(environment), [environment]);
  const client = useMemo(() => chainClient(wallet.target), [wallet.target]);

  const appRpc: Rpc = useCallback(
    (method, params) => client.request({ method, params } as never),
    [client],
  );

  const checkNetwork = useCallback(() => {
    if (!deployment)
      return Promise.resolve({
        ok: false as const,
        reason: "no-contract-in-app" as const,
        message: "AgentNFT is not deployed in this environment.",
      });
    return checkWalletNetwork({
      wallet: wallet.walletRequest,
      app: appRpc,
      target: wallet.target,
      referenceBlock: deployment.referenceBlock,
      contract: deployment.address,
    });
  }, [appRpc, deployment, wallet]);

  /** Waits on the app's RPC, names a send to another network (L-53), and reads the receipt's status. */
  const waitForReceipt = useCallback(
    async (hash: Hex): Promise<"success" | "reverted"> => {
      const address = wallet.address;
      await waitForReceiptOnAppNetwork({
        hash,
        app: appRpc,
        wallet: wallet.walletRequest,
        appNetwork: wallet.target.name,
        ...(environment === "local" && address
          ? {
              stuckCheck: async () => {
                const gap = stuckNonce(await readNonceReport(appRpc, address, hash));
                return gap ? new StuckNonceError(gap) : null;
              },
            }
          : {}),
      });
      const receipt = await client.getTransactionReceipt({ hash });
      return receipt.status === "success" ? "success" : "reverted";
    },
    [appRpc, client, environment, wallet],
  );

  return { client, appRpc, checkNetwork, waitForReceipt };
}

export type { NetworkCheck };
