"use server";

import {
  createTestPersonalAccount,
  fundTestPersonalAccount,
  registerTestSessionGrant,
  tradingSnapshot,
} from "@alpha-agents/devenv";
import { ASSET_DECIMALS, parseAmount } from "@alpha-agents/domain";
import { type ActionResult, attempt } from "@/lib/action-result";
import { consoleForkUrl } from "@/lib/fork-url";
import { orchestratorUrl } from "../agents/extension";
import type { LedgerEntryView, TradesView, TransactionView } from "./trades";

// P2-U4: test trading on the playtest fork. Reads run when the page loads or polls; every
// change to the fork happens only in an action the owner pressed a button for.

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
    let forkError: string | null = null;
    try {
      snapshot = await tradingSnapshot(consoleForkUrl(), id);
    } catch (err) {
      const message = err instanceof Error ? err.message : "The fork could not be read.";
      if (!/does not exist/.test(message)) forkError = message;
    }
    if (!signerOn)
      return { signerOn, snapshot, forkError, sessionKey: null, transactions: [], ledger: {} };
    const [key, outbox] = await Promise.all([
      orchestrator(`/v1/agents/${id}/session-key`),
      orchestrator(`/v1/signer/outbox?agentId=${id}`),
    ]);
    const transactions = (outbox.transactions ?? []) as TransactionView[];
    const ledger: Record<string, LedgerEntryView> = {};
    for (const t of transactions)
      if (t.ledgerEntryId)
        ledger[t.ledgerEntryId] = (await orchestrator(
          `/v1/signer/ledger/${t.ledgerEntryId}`,
        )) as unknown as LedgerEntryView;
    return {
      signerOn,
      snapshot,
      forkError,
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
 * and registers it as the agent's grant for 30 days, as the owner.
 */
export async function registerGrantAction(
  agentId: string,
  wallet: string,
): Promise<ActionResult<string>> {
  return attempt(async () => {
    const id = agent(agentId);
    const { address } = await orchestrator(`/v1/agents/${id}/session-key`, { method: "POST" });
    if (typeof address !== "string") throw new Error("The signer returned no session key.");
    await registerTestSessionGrant(consoleForkUrl(), id, wallet, address, 30);
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
