"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import type { HoldingAddress, HoldingAddressRole, HoldingLine } from "@alpha-agents/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Hex,
  BaseError,
  ContractFunctionRevertedError,
  decodeFunctionData,
  parseAbi,
} from "viem";
import { ApiError, type HoldingsJson, tradingApi } from "@/api/client";
import { useWalletSession } from "@/auth/session";
import { useOwnerSession } from "./use-owner-session";
import { useWalletTx } from "./use-wallet-tx";
import { type WalletTxProgress, runWalletSteps, walletTxText } from "./wallet-tx";

/** How often the holdings are re-read while the panel is open. */
const HOLDINGS_POLL_MS = 15_000;

const TBA_ABI = parseAbi([
  "function execute(address to, uint256 value, bytes data, uint8 operation) payable returns (bytes)",
]);

type MoveStatus = NonNullable<HoldingLine["move"]>;

/** The API's holdings as the design system's lines, with any move in progress attached. */
export function holdingAddresses(
  json: HoldingsJson,
  moves: Readonly<Record<string, MoveStatus>> = {},
): HoldingAddress[] {
  return json.addresses.map((a) => ({
    role: a.role,
    address: a.address,
    lines: a.holdings.map((h) => {
      const move = moves[`${a.role}:${h.symbol}`];
      return {
        symbol: h.symbol,
        raw: BigInt(h.raw),
        decimals: h.decimals,
        use: h.use,
        status: h.status,
        ...(move ? { move } : {}),
      };
    }),
    // A finished move whose balance is gone from the re-read keeps its outcome on the address.
    moved: Object.entries(moves).flatMap(([key, m]) => {
      const [role, symbol = ""] = key.split(":");
      return role === a.role &&
        m.state === "confirmed" &&
        !a.holdings.some((h) => h.symbol === symbol)
        ? [{ symbol, text: m.text, hash: m.hash ?? null }]
        : [];
    }),
  }));
}

/** The owner-facing reason for a refused move: only the agent's owner may move it. */
export function moveFailure(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  const name = revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined;
  return name === "NotAuthorized"
    ? "Only the agent's current owner can move this, from the wallet that holds the agent."
    : null;
}

/**
 * D-315: every balance at an agent's addresses, for its owner, and moving what
 * does nothing in the agent's own (token-bound) account to the owner's wallet:
 * the network guard, the call simulated from the owner's address so a refusal
 * names its reason, then sent from the connected wallet through its own
 * provider and confirmed by its receipt; every outcome is shown on the line.
 */
export function useHoldings(agentId: bigint, environment: EnvironmentId) {
  const wallet = useWalletSession();
  const asOwner = useOwnerSession(agentId);
  const { client, checkNetwork, waitForReceipt } = useWalletTx(environment);
  const [json, setJson] = useState<HoldingsJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** No holdings reader in this environment (503 not_deployed): there is nothing to show. */
  const [unavailable, setUnavailable] = useState(false);
  const [moves, setMoves] = useState<Record<string, MoveStatus>>({});
  const [tick, setTick] = useState(0);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Another wallet's holdings are never shown: a new account starts over.
  useEffect(() => {
    setJson(null);
    setMoves({});
  }, [wallet.address, agentId]);

  useEffect(() => {
    if (!wallet.ready || !wallet.address) return;
    let live = true;
    asOwner((t) => tradingApi.holdings(agentId, t)).then(
      (j) => {
        if (!live) return;
        setJson(j);
        setError(null);
        setUnavailable(false);
      },
      (err: unknown) => {
        if (!live) return;
        if (err instanceof ApiError && err.code === "not_deployed") setUnavailable(true);
        else setError("Could not read this agent's holdings. Try again in a moment.");
      },
    );
    const timer = window.setTimeout(() => setTick((n) => n + 1), HOLDINGS_POLL_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [agentId, asOwner, tick, wallet.address, wallet.ready]);

  const move = useCallback(
    (role: HoldingAddressRole, symbol: string) => {
      const line = json?.addresses
        .find((a) => a.role === role)
        ?.holdings.find((h) => h.symbol === symbol);
      const call = line?.recoverCall;
      if (!call || running.current || !wallet.address) return;
      running.current = true;
      const key = `${role}:${symbol}`;
      const report = (p: WalletTxProgress) =>
        mounted.current &&
        setMoves((m) => ({
          ...m,
          [key]: {
            state: p.state,
            text: p.state === "confirmed" ? `Moved ${symbol} to your wallet.` : walletTxText(p),
            hash: p.hash ?? null,
          },
        }));
      const owner = wallet.address;
      void runWalletSteps(
        {
          checkNetwork,
          send: async (c: { to: Hex; data: Hex }) => {
            const { args } = decodeFunctionData({ abi: TBA_ABI, data: c.data });
            const request = { address: c.to, abi: TBA_ABI, functionName: "execute", args } as const;
            try {
              await client.simulateContract({ ...request, account: owner });
            } catch (err) {
              const why = moveFailure(err);
              if (why) throw new Error(why, { cause: err });
              throw err;
            }
            return wallet.writeContract(request as never);
          },
          waitForReceipt,
        },
        [{ label: `Move ${symbol} to your wallet`, call: { to: call.to, data: call.data } }],
        report,
      ).finally(() => {
        running.current = false;
        if (mounted.current) setTick((n) => n + 1);
      });
    },
    [checkNetwork, client, json, waitForReceipt, wallet],
  );

  return {
    addresses: json ? holdingAddresses(json, moves) : null,
    error,
    unavailable,
    network: wallet.target.name,
    move,
  };
}
