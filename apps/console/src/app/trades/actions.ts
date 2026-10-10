"use server";

import {
  createTestPersonalAccount,
  createTestPersonalAccountV3,
  fundTestPersonalAccount,
  fundTestPersonalAccountV3,
  registeredTokens,
  registerTestSessionGrant,
  tradingSnapshot,
  tradingSnapshotV3,
} from "@alpha-agents/devenv";
import { ASSET_DECIMALS, parseAmount } from "@alpha-agents/domain";
import { type ActionResult, attempt } from "@/lib/action-result";
import { consoleForkUrl } from "@/lib/fork-url";
import { orchestratorUrl } from "../agents/extension";
import type { LedgerEntryView, TradesView, TransactionView } from "./trades";

// P2-U4: test trading on the playtest fork. Reads run when the page loads or polls; every
// change to the fork happens only in an action the owner pressed a button for. F-U5 adds the
// fund agent's v3 set: an account of many tokens, a grant on Executor v3, and swaps of any
// registered pair along a route of registered pools.

const agent = (raw: string): number => {
  if (!/^[1-9]\d{0,4}$/.test(raw.trim())) throw new Error("That is not an agent ID.");
  return Number(raw.trim());
};

async function orchestrator(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${orchestratorUrl()}${path}`, { cache: "no-store", ...init });
  } catch {
    throw new Error("The orchestrator is not running (pnpm dev:all starts it).");
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok)
    throw new Error(
      typeof body.message === "string" ? body.message : `the orchestrator answered ${res.status}`,
    );
  return body;
}

export async function readTradesAction(agentId: string): Promise<ActionResult<TradesView>> {
  return attempt(async () => {
    const id = agent(agentId);
    const signer = await orchestrator("/v1/signer").catch(() => ({ on: false }));
    const signerOn = signer.on === true;
    let snapshot: TradesView["snapshot"] = null;
    let snapshotV3: TradesView["snapshotV3"] = null;
    let tokens: TradesView["tokens"] = [];
    let forkError: string | null = null;
    try {
      snapshot = await tradingSnapshot(consoleForkUrl(), id);
      // The v3 set may be missing on an older fork; the page then shows v2 only.
      snapshotV3 = await tradingSnapshotV3(consoleForkUrl(), id).catch(() => null);
      if (snapshotV3) tokens = await registeredTokens(consoleForkUrl()).catch(() => []);
    } catch (err) {
      const message = err instanceof Error ? err.message : "The fork could not be read.";
      if (!/does not exist/.test(message)) forkError = message;
    }
    const base = {
      snapshot,
      snapshotV3,
      tokens,
      forkError,
      custody: null as TradesView["custody"],
      executorV3: null as string | null,
    };
    if (!signerOn) return { ...base, signerOn, sessionKey: null, transactions: [], ledger: {} };
    const [key, outbox, custody] = await Promise.all([
      orchestrator(`/v1/agents/${id}/session-key`),
      orchestrator(`/v1/signer/outbox?agentId=${id}`),
      orchestrator(`/v1/agents/${id}/custody`).catch(() => ({ custody: null, executor: null })),
    ]);
    const transactions = (outbox.transactions ?? []) as TransactionView[];
    const ledger: Record<string, LedgerEntryView> = {};
    for (const t of transactions)
      if (t.ledgerEntryId)
        ledger[t.ledgerEntryId] = (await orchestrator(
          `/v1/signer/ledger/${t.ledgerEntryId}`,
        )) as unknown as LedgerEntryView;
    return {
      ...base,
      signerOn,
      custody: custody.custody === "v3" ? "v3" : custody.custody === "v2" ? "v2" : null,
      executorV3:
        custody.custody === "v3" && typeof custody.executor === "string" ? custody.executor : null,
      sessionKey: typeof key.address === "string" ? key.address : null,
      transactions,
      ledger,
    };
  });
}

/** Opens the wallet's PersonalAccount for the agent on the playtest fork. */
export async function createAccountAction(
  agentId: string,
  wallet: string,
): Promise<ActionResult<string>> {
  return attempt(() => createTestPersonalAccount(consoleForkUrl(), agent(agentId), wallet));
}

/** Mints test USDC to the wallet and deposits it in the account. */
export async function fundAccountAction(
  agentId: string,
  wallet: string,
  usdcText: string,
): Promise<ActionResult<string>> {
  return attempt(async () => {
    const amount = parseAmount(usdcText, ASSET_DECIMALS.USDC);
    if (!amount)
      throw new Error("The USDC amount must be a positive number with at most 6 decimals.");
    await fundTestPersonalAccount(consoleForkUrl(), agent(agentId), wallet, amount);
    return usdcText;
  });
}

/**
 * Creates the agent's session key in the signer (only its address comes back)
 * and registers it as the agent's grant for 30 days, as the owner, on the
 * Executor of the agent's custody set (v3 when `executor` names it).
 */
export async function registerGrantAction(
  agentId: string,
  wallet: string,
  executor: string | null = null,
): Promise<ActionResult<string>> {
  return attempt(async () => {
    const id = agent(agentId);
    const { address } = await orchestrator(`/v1/agents/${id}/session-key`, { method: "POST" });
    if (typeof address !== "string") throw new Error("The signer returned no session key.");
    await registerTestSessionGrant(
      consoleForkUrl(),
      id,
      wallet,
      address,
      30,
      ...(executor ? [executor] : []),
    );
    return address;
  });
}

/** A test swap through the signer and the Executor; breakLimit makes it break one limit on purpose. */
export async function sendTestSwapAction(
  agentId: string,
  direction: "buy" | "sell",
  amount: string,
  breakLimit: string | null,
): Promise<ActionResult<{ txId: string; status: string; reasonCode: string | null }>> {
  return attempt(async () => {
    const body = await orchestrator(`/v1/agents/${agent(agentId)}/test-swap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ direction, amount, ...(breakLimit ? { breakLimit } : {}) }),
    });
    return {
      txId: String(body.txId),
      status: String(body.status),
      reasonCode: typeof body.reasonCode === "string" ? body.reasonCode : null,
    };
  });
}

// ---- the fund agent's v3 set (F-U5) ----

/** Opens the wallet's PersonalAccountV3 for the agent, allowlisting the wallet on the v3 factory first. */
export async function createAccountV3Action(
  agentId: string,
  wallet: string,
): Promise<ActionResult<string>> {
  return attempt(() => createTestPersonalAccountV3(consoleForkUrl(), agent(agentId), wallet));
}

/**
 * Funds the v3 account with several tokens: test USDC deposited, and each
 * other token bought with test USDC through its real pools, then deposited.
 */
export async function fundAccountV3Action(
  agentId: string,
  wallet: string,
  legs: readonly { token: string; usdc: string }[],
): Promise<ActionResult<string>> {
  return attempt(async () => {
    const parsed = legs
      .filter((l) => l.usdc.trim() !== "")
      .map((l) => {
        const usdcE6 = parseAmount(l.usdc, ASSET_DECIMALS.USDC);
        if (!usdcE6)
          throw new Error("Every USDC amount must be a positive number with at most 6 decimals.");
        return { token: l.token, usdcE6 };
      });
    if (parsed.length === 0) throw new Error("Give at least one token a USDC amount.");
    const funded = await fundTestPersonalAccountV3(
      consoleForkUrl(),
      agent(agentId),
      wallet,
      parsed,
    );
    return funded.map((f) => `${f.symbol} for ${Number(f.usdcE6) / 1e6} USDC`).join(", ");
  });
}

/** A test swap of any registered pair on the v3 set, along the best route, through the signer and Executor v3. */
export async function sendTestSwapV3Action(
  agentId: string,
  sell: string,
  buy: string,
  amount: string,
): Promise<
  ActionResult<{
    txId: string;
    status: string;
    reasonCode: string | null;
    hops: number;
    blockers: string[];
  }>
> {
  return attempt(async () => {
    const body = await orchestrator(`/v1/agents/${agent(agentId)}/test-swap-v3`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sell, buy, amount }),
    });
    return {
      txId: String(body.txId),
      status: String(body.status),
      reasonCode: typeof body.reasonCode === "string" ? body.reasonCode : null,
      hops: Number(body.hops ?? 0),
      blockers: Array.isArray(body.blockers) ? body.blockers.map(String) : [],
    };
  });
}
