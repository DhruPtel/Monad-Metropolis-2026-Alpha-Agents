import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type Page, expect, test } from "@playwright/test";
import { LOCAL_FORK_RPC_URL, localForkRpcUrl } from "@alpha-agents/config";
import { createDb } from "@alpha-agents/db";
import { balancesOf, mintTestUsdc, setMonBalance } from "@alpha-agents/devenv";
import { impersonate } from "../../../scripts/lib/agent-reveal.js";
import { MOCK_WALLET_ADDRESS } from "../src/auth/mock-wallet-constants";

/**
 * The portfolio end to end (P2-U7), `pnpm test:web:live:portfolio`, on a stack
 * of its own (D-200): a fork on 8546 with AgentNFT and the trading contracts,
 * a throwaway database, the indexer, the control API on 4101 and the
 * orchestrator (keeper, provisioning, credits, the signer and the trade flow)
 * with real LiteLLM and E2B. One owner's whole path from the app with the mock
 * wallet sending real transactions: mint, the allowlist notice, the one-command
 * allowlist, open the account, deposit, arm, a real agent's proposal approved
 * and settled on the real v4 pool, a blocked trade explained, disarm, withdraw
 * everything, and another wallet seeing none of it.
 */
const FORK = localForkRpcUrl(process.env);
if (FORK === LOCAL_FORK_RPC_URL) {
  throw new Error("this suite runs only on its test fork; use pnpm test:web:live:portfolio");
}
const ORCHESTRATOR = "http://127.0.0.1:4252";
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const OTHER_WALLET = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const db = createDb(process.env.TEST_DATABASE_URL ?? "postgres://unset", { max: 1 });

test.afterAll(async () => {
  await db.destroy();
});

test.setTimeout(20 * 60_000);

const main = (page: Page) => page.getByRole("main");
const status = (page: Page, testId: string) =>
  main(page).getByTestId(testId).getByTestId("wallet-action-status");

/** Connects the mock wallet on /configure and mints; returns the new agent's ID. */
async function mintAgent(page: Page): Promise<bigint> {
  await impersonate(MOCK_WALLET_ADDRESS);
  await page.goto("/configure");
  const portal = page.getByTestId("agent-portal");
  await portal.getByRole("button", { name: "Connect wallet" }).click();
  await expect(portal.getByText("No agent in this wallet yet")).toBeVisible({ timeout: 30_000 });
  await portal.getByRole("button", { name: "Mint an agent" }).click();
  const minted = portal.getByRole("status").filter({ hasText: /minted/ });
  await expect(minted).toBeVisible({ timeout: 30_000 });
  const id = /Agent #(\d+) minted/.exec((await minted.textContent()) ?? "")?.[1];
  if (!id) throw new Error("no agent ID in the mint status");
  return BigInt(id);
}

/** The orchestrator's local-only routes, which the dev console uses; retried while a Scan holds the sandbox. */
async function orchestrator(path: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${ORCHESTRATOR}${path}`, { method: "POST" });
    const body = (await res.json()) as Record<string, unknown>;
    if (res.ok) return body;
    if (body.error !== "lease_held")
      throw new Error(`${path}: ${res.status} ${JSON.stringify(body)}`);
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`${path}: the agent's sandbox stayed busy`);
}

test("an owner opens an account, deposits, arms, sees a trade settle and one explained, disarms and withdraws; another wallet sees nothing", async ({
  page,
}) => {
  const id = await mintAgent(page);
  const card = page.locator(`[data-testid=my-agent-card][data-agent-id="${id}"]`);

  // The keeper reveals and the orchestrator provisions; credits let the agent run.
  await page.goto("/agents");
  await expect(card.getByText("Paused: no credits")).toBeVisible({ timeout: 180_000 });
  const funding = await db
    .selectFrom("platform.funding_addresses")
    .select("address")
    .where("agent_id", "=", Number(id))
    .executeTakeFirstOrThrow();
  await mintTestUsdc(funding.address, 1_000_000n, FORK);
  await expect(card.getByText("Ready", { exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(card.getByTestId("trading-summary")).toContainText("No trading account yet", {
    timeout: 30_000,
  });

  // The portfolio names the allowlist before any transaction.
  await card.getByRole("link", { name: "Set up trading" }).click();
  await expect(main(page).getByTestId("allowlist-block")).toBeVisible({ timeout: 30_000 });
  await expect(main(page).getByRole("button", { name: "Open trading account" })).toBeDisabled();

  // The one command the handoff gives the owner adds the wallet (D-231: instant).
  const allow = spawnSync("node", ["scripts/allow-depositor.js", MOCK_WALLET_ADDRESS], {
    cwd: ROOT,
    env: process.env,
    encoding: "utf8",
  });
  expect(allow.status, allow.stderr).toBe(0);
  expect(allow.stdout).toContain("can now open a trading account");

  // Test USDC in the wallet, as the console's Test funds page sends it, and MON for gas.
  await mintTestUsdc(MOCK_WALLET_ADDRESS, 20_000_000n, FORK);
  await setMonBalance(MOCK_WALLET_ADDRESS, 10n ** 19n, FORK);

  // Open the account from the wallet.
  await expect(main(page).getByTestId("allowlist-block")).toHaveCount(0, { timeout: 30_000 });
  await main(page).getByRole("button", { name: "Open trading account" }).click();
  await expect(main(page).getByTestId("positions")).toBeVisible({ timeout: 60_000 });

  // Deposit 20 USDC: an exact approval, then the deposit.
  const deposit = main(page).getByTestId("deposit-form");
  await deposit.getByLabel("Amount").fill("20");
  await deposit.getByRole("button", { name: "Deposit", exact: true }).click();
  await expect(status(page, "deposit-form")).toHaveAttribute("data-state", "confirmed", {
    timeout: 90_000,
  });
  await expect(main(page).getByTestId("positions")).toContainText("20.00", { timeout: 30_000 });

  // Arm: the grant from the wallet, then the platform records it.
  const arming = main(page).getByTestId("arming-card");
  await arming.getByRole("button", { name: "Arm", exact: true }).click();
  await expect(arming).toHaveAttribute("data-state", "awaiting_first_trade", { timeout: 90_000 });

  // A real agent's chain check proposes a small trade, which waits for the owner.
  await orchestrator(`/v1/agents/${id}/tasks/chain-check`);
  const approval = main(page).getByTestId("approval-card");
  await expect(approval).toBeVisible({ timeout: 8 * 60_000 });
  await expect(approval).toContainText("Approve the first trade to arm");
  await approval.getByRole("button", { name: "Approve and arm" }).click();
  await expect(arming).toHaveAttribute("data-state", "armed", { timeout: 60_000 });

  // It executes through the signer, the Executor and the real v4 pool, and settles.
  const settled = main(page).getByTestId("recent-trades").locator('tr[data-status="reconciled"]');
  await expect(settled).toBeVisible({ timeout: 4 * 60_000 });
  await expect(settled).toContainText("Got");
  await expect(settled).toContainText(/0x[0-9a-f]{64}/);
  await expect(main(page).getByTestId("positions")).toContainText("WMON");

  // A proposal over the trade size limit is refused at submission and explained.
  await orchestrator(`/v1/agents/${id}/test-over-limit`);
  await expect(main(page).getByTestId("why-not-traded")).toContainText(
    "larger than 10% of the account",
    { timeout: 90_000 },
  );

  // Disarm: arming ends at once, and the wallet revokes the grant on chain.
  await arming.getByRole("button", { name: "Disarm" }).click();
  await expect(arming).toHaveAttribute("data-state", "unarmed", { timeout: 90_000 });
  await expect(arming).toContainText("The owner disarmed the agent.");

  // Withdraw everything back to the wallet, each asset in turn.
  const withdraw = main(page).getByTestId("withdraw-form");
  const usdcBefore = (await balancesOf(MOCK_WALLET_ADDRESS, FORK)).usdcE6;
  await withdraw.getByRole("button", { name: "Withdraw all" }).click();
  await expect(status(page, "withdraw-form")).toHaveAttribute("data-state", "confirmed", {
    timeout: 90_000,
  });
  expect((await balancesOf(MOCK_WALLET_ADDRESS, FORK)).usdcE6).toBeGreaterThan(usdcBefore);
  await withdraw.getByRole("combobox", { name: "Asset" }).click();
  await page.getByRole("option", { name: "WMON" }).click();
  await withdraw.getByRole("button", { name: "Withdraw all" }).click();
  await expect(status(page, "withdraw-form")).toContainText("WMON", { timeout: 90_000 });
  await expect(status(page, "withdraw-form")).toHaveAttribute("data-state", "confirmed", {
    timeout: 90_000,
  });
  const holdings = main(page).getByRole("region", { name: "Holdings" });
  await expect(holdings.getByRole("row", { name: /USDC/ }).first()).toContainText("0.00", {
    timeout: 30_000,
  });
  await expect(holdings.getByRole("row", { name: /WMON/ })).toContainText(/(^|\D)0\s*WMON/);

  // No key or token reaches the page.
  expect(await page.content()).not.toMatch(/sk-[A-Za-z0-9]{12,}|tvly-/);

  // Another wallet sees none of this portfolio and cannot act on it.
  // The switch ends the owner's session at once; logging in again uses the other account.
  await page.evaluate((address) => window.__mockWallet?.setAccount(address), OTHER_WALLET);
  await expect(page.locator("header [data-slot=wallet-button]")).toHaveAttribute(
    "data-state",
    "logged-out",
  );
  await expect(main(page).getByTestId("positions")).toHaveCount(0);
  await main(page).getByRole("button", { name: "Connect wallet" }).click();
  await expect(main(page).getByText("Could not read this portfolio")).toBeVisible({
    timeout: 30_000,
  });
  await expect(main(page).getByTestId("positions")).toHaveCount(0);
  const api = process.env.CONTROL_API_URL ?? "http://127.0.0.1:4101";
  expect((await fetch(`${api}/v1/agents/${id}/portfolio`)).status).toBe(401);
  expect((await fetch(`${api}/v1/agents/${id}/disarm`, { method: "POST" })).status).toBe(401);
});
