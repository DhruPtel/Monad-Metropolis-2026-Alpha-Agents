import { type Page, expect, test } from "@playwright/test";
import { LOCAL_FORK_RPC_URL, localForkRpcUrl } from "@alpha-agents/config";
import { createDb } from "@alpha-agents/db";
import { balancesOf, mintTestUsdc } from "@alpha-agents/devenv";
import { impersonate } from "../../../scripts/lib/agent-reveal.js";
import { MOCK_WALLET_ADDRESS } from "../src/auth/mock-wallet-constants";

/**
 * My Agents end to end (P1-U9), `pnpm test:web:live:agents`, on a stack of its
 * own (D-200): a fork on 8546, a throwaway database, the indexer, the control
 * API on 4101 with the mock wallet's identity, and the orchestrator in its own
 * namespace with real LiteLLM, E2B and Tavily. One owner's whole path: mint,
 * reveal by the keeper, the card, funding by a plain USDC transfer, a Scan run
 * from the page and its activity entry, a refund paid on chain, and another
 * wallet seeing none of it. Nothing here reverts the fork: the orchestrator
 * acts on what it indexes.
 */
const FORK = localForkRpcUrl(process.env);
if (FORK === LOCAL_FORK_RPC_URL) {
  throw new Error("this suite runs only on its test fork; use pnpm test:web:live:agents");
}
const API = process.env.CONTROL_API_URL ?? "http://127.0.0.1:4101";
const OTHER_WALLET = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const db = createDb(process.env.TEST_DATABASE_URL ?? "postgres://unset", { max: 1 });

test.afterAll(async () => {
  await db.destroy();
});

test.setTimeout(15 * 60_000);

/** Connects the mock wallet on /configure and mints; returns the new agent's ID. */
async function mintAgent(page: Page): Promise<bigint> {
  await impersonate(MOCK_WALLET_ADDRESS);
  await page.goto("/configure");
  const portal = page.getByTestId("agent-portal");
  await portal.getByRole("button", { name: "Connect wallet" }).click();
  await expect(portal.getByText("No agent in this wallet yet")).toBeVisible({ timeout: 30_000 });
  await portal.getByRole("button", { name: "Mint an agent" }).click();
  const status = portal.getByRole("status").filter({ hasText: /minted/ });
  await expect(status).toBeVisible({ timeout: 30_000 });
  const id = /Agent #(\d+) minted/.exec((await status.textContent()) ?? "")?.[1];
  if (!id) throw new Error("no agent ID in the mint status");
  return BigInt(id);
}

test("an owner funds an agent, runs a Scan, reads its entry and refunds it; another wallet sees nothing", async ({
  page,
}) => {
  const id = await mintAgent(page);
  const card = page.locator(`[data-testid=my-agent-card][data-agent-id="${id}"]`);

  // The keeper reveals and the orchestrator provisions with no manual step; unfunded, it is paused.
  // The login outlives the page load, as Privy's does.
  await page.goto("/agents");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText("Paused: no credits")).toBeVisible({ timeout: 120_000 });
  await expect(card.getByTestId("restricted-note")).toContainText("Safety checks keep running");

  // The funding address and its QR code are the ones the platform recorded.
  const recorded = await db
    .selectFrom("platform.funding_addresses")
    .select("address")
    .where("agent_id", "=", Number(id))
    .executeTakeFirstOrThrow();
  const qr = card.getByRole("img", { name: /QR code of .* funding address/ });
  const shown = String(await qr.getAttribute("data-qr-value"));
  expect(shown.toLowerCase()).toBe(recorded.address);

  // A plain USDC transfer to the address becomes credits, with no other step.
  await mintTestUsdc(shown, 1_000_000n, FORK);
  const fund = card.getByRole("region", { name: `Fund Alpha Agent #${id}` });
  // The credits amount is the panel's first amount; its symbol is a separate element.
  await expect(fund.locator("[data-slot=amount]").first()).toHaveText("1USDC", { timeout: 90_000 });
  await expect(card.getByText("Ready", { exact: true })).toBeVisible({ timeout: 30_000 });

  // Run a Scan from the page: the confirmation states the cost; the entry arrives when it ends.
  await card.getByRole("button", { name: "Run Scan now" }).click();
  const dialog = page.getByRole("dialog", { name: `Run a Scan for Alpha Agent #${id}?` });
  await expect(dialog).toContainText("about 0.15 to 0.30 USDC");
  await dialog.getByRole("button", { name: "Run Scan" }).click();
  await expect(card.getByTestId("scan-result")).toContainText("Scan requested");
  await expect(card.getByTestId("scan-status")).toContainText(/Last Scan (completed|stopped)/, {
    timeout: 8 * 60_000,
  });
  await expect(card.getByTestId("scan-status")).toContainText("completed");
  const entries = card.getByRole("list", { name: `Activity entries of Alpha Agent #${id}` });
  await expect(entries.getByRole("listitem")).toHaveCount(1, { timeout: 30_000 });
  const spend = card.getByRole("region", { name: `Spend of Alpha Agent #${id}` });
  await expect(spend).toContainText("web_search", { timeout: 60_000 });
  await expect(spend).toContainText("Model call", { timeout: 120_000 });
  const scan = await db
    .selectFrom("platform.agent_tasks")
    .select(["requested_by", "status"])
    .where("agent_id", "=", Number(id))
    .where("kind", "=", "scan")
    .executeTakeFirstOrThrow();
  expect(scan).toEqual({ requested_by: "owner", status: "succeeded" });

  // A refund, tied to the ownership epoch, pays the remaining credits to the owner on chain.
  const before = (await balancesOf(MOCK_WALLET_ADDRESS, FORK)).usdcE6;
  await card.getByRole("button", { name: "Refund credits" }).click();
  const confirm = page.getByRole("dialog", { name: `Refund Alpha Agent #${id}'s credits?` });
  await expect(confirm).toContainText("epoch 0");
  await confirm.getByRole("button", { name: "Refund" }).click();
  const result = card.getByTestId("refund-result");
  await expect(result).toContainText("Refunded", { timeout: 120_000 });
  const refunded = /Refunded ([\d.]+) USDC/.exec((await result.textContent()) ?? "")?.[1];
  const after = (await balancesOf(MOCK_WALLET_ADDRESS, FORK)).usdcE6;
  expect(after - before).toBeGreaterThan(0n);
  // The page truncates to four decimals (never overstating); compare in those units exactly.
  const [whole = "0", frac = ""] = String(refunded).split(".");
  expect((after - before) / 100n).toBe(BigInt(whole) * 10_000n + BigInt(frac.padEnd(4, "0")));
  await expect(card.getByText("Paused: no credits")).toBeVisible({ timeout: 60_000 });

  // No key or token reaches the page.
  expect(await page.content()).not.toMatch(/sk-[A-Za-z0-9]{12,}|tvly-/);

  // Another wallet: no card, and the owner-only summary needs the owner's session.
  // The switch ends the owner's session at once; logging in again uses the other account.
  await page.evaluate((address) => window.__mockWallet?.setAccount(address), OTHER_WALLET);
  await expect(page.locator("header [data-slot=wallet-button]")).toHaveAttribute(
    "data-state",
    "logged-out",
  );
  await expect(card).toHaveCount(0);
  await page.getByRole("main").getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByRole("main").getByText("No agents in this wallet yet")).toBeVisible({
    timeout: 30_000,
  });
  await expect(card).toHaveCount(0);
  expect((await fetch(`${API}/v1/agents/${id}/summary`)).status).toBe(401);
  expect((await fetch(`${API}/v1/agents/${id}/scan`, { method: "POST" })).status).toBe(401);
});
