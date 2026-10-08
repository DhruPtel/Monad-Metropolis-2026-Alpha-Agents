import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { type Locator, type Page, expect, test } from "@playwright/test";
import { decodeFunctionData, encodeErrorResult, getAddress } from "viem";
import { ACCOUNT_ABI, ERC20_ABI, GRANT_ABI } from "../src/agent/custody";
import { MOCK_WALLET_ADDRESS } from "../src/auth/mock-wallet-constants";
import { FakeApi, fundedDashboard } from "./fake-api";
import { FakeChain } from "./fake-chain";
import {
  ACCOUNT,
  BLOCKED,
  EXECUTOR,
  FakeTrading,
  SETTLED,
  USDC,
  intentFixture,
  noAccountFixture,
  portfolioFixture,
} from "./fake-trading";

/**
 * The portfolio page (P2-U7) against the test build with the mock wallet,
 * the fake API and the fake chain, at 1440px and 380px: every state captured
 * and scanned, every deposit block named before anything is sent, a
 * withdrawal while paused, claimable credits, the arming card's lifecycle,
 * and that another wallet sees none of it. The live suite runs it on a fork.
 */
const BEE = 14;
const AGENT = 7n;
const OTHER_WALLET = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;

const main = (page: Page) => page.getByRole("main");
const walletButton = (page: Page) => page.locator("header [data-slot=wallet-button]");
const status = (scope: Locator) => scope.getByTestId("wallet-action-status");

function stack(
  portfolio = portfolioFixture(MOCK_WALLET_ADDRESS),
  owner: string = MOCK_WALLET_ADDRESS,
) {
  const chain = new FakeChain();
  chain.mint(AGENT, owner as `0x${string}`, BEE);
  const api = new FakeApi(chain);
  api.dashboards.set(AGENT, fundedDashboard());
  const trading = new FakeTrading(chain, MOCK_WALLET_ADDRESS, portfolio);
  api.trading.set(AGENT, trading);
  return { chain, api, trading };
}

async function open(page: Page, s: ReturnType<typeof stack>, path = `/agents/${AGENT}/portfolio`) {
  await s.chain.install(page);
  await s.api.install(page);
  await page.goto(path);
  await page.evaluate(() => document.fonts.ready);
  await main(page).getByRole("button", { name: "Connect wallet" }).click();
  await page.mouse.move(0, 0);
  await expect(walletButton(page)).toHaveAttribute("data-state", "connected");
}

/** The same scroll, no hover, every image loaded and a full repaint (L-44, L-65), then the capture. */
async function capture(page: Page, target: Locator, name: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => document.querySelector("button:hover, a:hover") === null);
  await page.evaluate(async () => {
    const frames = () =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    document.documentElement.style.opacity = "0.99";
    await frames();
    document.documentElement.style.opacity = "";
    await frames();
  });
  await expect(target).toHaveScreenshot(name, {
    stylePath: fileURLToPath(new URL("./portal-capture.css", import.meta.url)),
    timeout: 30_000,
  });
}

async function blockingViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

const sent = (chain: FakeChain) => chain.transactions.filter((t) => !t.reverted);

test.describe("every state, captured and scanned", () => {
  test("a wallet off the allowlist is told before it opens an account", async ({ page }) => {
    const s = stack(noAccountFixture(MOCK_WALLET_ADDRESS, false));
    await open(page, s);
    const card = main(page).getByTestId("open-account");
    await expect(card.getByTestId("allowlist-block")).toContainText(
      "not on the beta deposit allowlist",
    );
    await expect(card.getByRole("button", { name: "Open trading account" })).toBeDisabled();
    await expect(card.getByTestId("caps")).toContainText("not on the beta allowlist");
    await capture(page, main(page), "portfolio-not-allowlisted.png");
    expect(await blockingViolations(page)).toEqual([]);
    expect(s.chain.transactions).toEqual([]);
  });

  test("an allowlisted owner opens the trading account from the wallet", async ({ page }) => {
    const s = stack(noAccountFixture(MOCK_WALLET_ADDRESS));
    await open(page, s);
    const card = main(page).getByTestId("open-account");
    await capture(page, main(page), "portfolio-no-account.png");
    await card.getByRole("button", { name: "Open trading account" }).click();
    await expect(main(page).getByTestId("positions")).toBeVisible({ timeout: 15_000 });
    expect(s.trading.calls).toEqual(["createPersonalAccount"]);
    expect(await blockingViolations(page)).toEqual([]);
  });

  test("a funded account shows positions, limits, the arming card, an approval, trades and why", async ({
    page,
  }) => {
    const s = stack();
    s.trading.intents = [intentFixture(), BLOCKED, SETTLED];
    await open(page, s);
    const positions = main(page).getByTestId("positions");
    await expect(main(page).getByTestId("portfolio-overview")).toContainText("40.00");
    await expect(positions).toContainText("75.00%");
    await expect(positions).toContainText("20s old");
    await expect(main(page).getByTestId("caps")).toContainText("40.00 of 100.00 USDC");
    await expect(main(page).getByTestId("arming-card")).toHaveAttribute("data-state", "unarmed");
    const approval = main(page).getByTestId("approval-card");
    await expect(approval).toContainText("2.50");
    await expect(approval).toContainText("Monad");
    await expect(approval).toContainText("Arm the agent first");
    await expect(main(page).getByTestId("recent-trades")).toContainText("39.94");
    await expect(main(page).getByTestId("why-not-traded")).toContainText(
      "larger than 10% of the account",
    );
    await capture(page, main(page), "portfolio-funded.png");
    expect(await blockingViolations(page)).toEqual([]);
  });

  test("a paused account with no price still withdraws, and its held credits can be claimed", async ({
    page,
  }) => {
    const p = portfolioFixture(MOCK_WALLET_ADDRESS, {
      mode: "PAUSED",
      breaker: null,
      claimable: { usdcE6: "1500000", wmonWei: "0" },
    });
    const s = stack({
      ...p,
      prices: {
        ...p.prices,
        monUsd: { priceE18: "0", updatedAt: p.timestamp - 900, reason: "STALE" },
      },
    });
    await open(page, s);
    await expect(main(page).getByTestId("positions")).toContainText("Paused");
    await expect(main(page).getByTestId("deposit-block")).toContainText("paused");
    await capture(page, main(page), "portfolio-paused.png");
    expect(await blockingViolations(page)).toEqual([]);
    const withdraw = main(page).getByTestId("withdraw-form");
    await withdraw.getByRole("button", { name: "Withdraw all" }).click();
    await expect(status(withdraw)).toHaveAttribute("data-state", "confirmed", { timeout: 15_000 });
    const tx = sent(s.chain).at(-1);
    if (!tx) throw new Error("no withdrawal sent");
    const call = decodeFunctionData({ abi: ACCOUNT_ABI, data: tx.data });
    expect(call.functionName).toBe("withdraw");
    expect(call.args).toEqual([USDC, 30_000_000n, getAddress(MOCK_WALLET_ADDRESS)]);
    const claim = main(page).getByTestId("claimable");
    await claim.getByRole("button", { name: "Claim USDC" }).click();
    await expect(main(page).getByTestId("claimable")).toHaveCount(0, { timeout: 15_000 });
    expect(s.trading.calls).toEqual(["withdraw", "claim"]);
  });
});

test.describe("deposits", () => {
  test("approves exactly the amount, then deposits it", async ({ page }) => {
    const s = stack();
    await open(page, s);
    const form = main(page).getByTestId("deposit-form");
    await form.getByLabel("Amount").fill("25");
    await form.getByRole("button", { name: "Deposit", exact: true }).click();
    await expect(status(form)).toHaveAttribute("data-state", "confirmed", { timeout: 15_000 });
    await expect(status(form)).toContainText("Deposited 25 USDC");
    const [approve, deposit] = sent(s.chain);
    if (!approve || !deposit) throw new Error("expected two transactions");
    expect(decodeFunctionData({ abi: ERC20_ABI, data: approve.data }).args).toEqual([
      ACCOUNT,
      25_000_000n,
    ]);
    expect(decodeFunctionData({ abi: ACCOUNT_ABI, data: deposit.data }).args).toEqual([
      USDC,
      25_000_000n,
    ]);
    await expect(main(page).getByTestId("portfolio-overview")).toContainText("65.00");
  });

  test("names every block before anything is sent: the caps and the depeg guard", async ({
    page,
  }) => {
    const p = portfolioFixture(MOCK_WALLET_ADDRESS);
    const s = stack(p);
    await open(page, s);
    const form = main(page).getByTestId("deposit-form");
    const deposit = form.getByRole("button", { name: "Deposit", exact: true });
    await form.getByLabel("Amount").fill("61");
    await expect(form).toContainText("past its beta cap");
    await expect(deposit).toBeDisabled();
    s.trading.portfolio = { ...p, caps: { ...p.caps, platformTotalUsdcE6: "1995000000" } };
    await page.reload();
    await main(page).getByTestId("deposit-form").getByLabel("Amount").fill("6");
    await expect(main(page).getByTestId("deposit-form")).toContainText(
      "the platform past its beta cap",
    );
    s.trading.portfolio = {
      ...p,
      prices: {
        ...p.prices,
        usdcUsd: {
          priceE18: "980000000000000000",
          updatedAt: p.timestamp,
          reason: "USDC_DEPEGGED",
        },
      },
    };
    await page.reload();
    await expect(main(page).getByTestId("deposit-block")).toContainText(
      "more than 1% away from $1",
    );
    await capture(page, main(page).getByTestId("deposit-form"), "portfolio-deposit-blocked.png");
    expect(s.chain.transactions).toEqual([]);
  });

  test("a deposit declined in the wallet says so and sends nothing more", async ({ page }) => {
    const s = stack();
    await open(page, s);
    await page.evaluate(() => window.__mockWallet?.rejectNextWrite());
    const form = main(page).getByTestId("deposit-form");
    await form.getByLabel("Amount").fill("5");
    await form.getByRole("button", { name: "Deposit", exact: true }).click();
    await expect(status(form)).toHaveAttribute("data-state", "rejected");
    await expect(status(form)).toContainText("declined");
    expect(s.chain.transactions).toEqual([]);
  });
});

test.describe("arming", () => {
  test("arm, approve the first trade, renew reminder, reject, disarm", async ({ page }) => {
    const s = stack();
    s.trading.intents = [
      intentFixture(),
      intentFixture({ intentId: "intent-2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b" }),
    ];
    await open(page, s);
    const arming = main(page).getByTestId("arming-card");
    await arming.getByRole("button", { name: "Arm", exact: true }).click();
    await expect(arming).toHaveAttribute("data-state", "awaiting_first_trade", { timeout: 15_000 });
    await expect(status(arming)).toContainText("Approve the agent's first proposed trade");
    const first = main(page).locator(
      '[data-testid=approval-card][data-intent="intent-6f1c2d9e-7b1a-4c3e-9d2f-1a2b3c4d5e6f"]',
    );
    await first.getByRole("button", { name: "Approve and arm" }).click();
    await expect(arming).toHaveAttribute("data-state", "armed", { timeout: 15_000 });
    const second = main(page).getByTestId("approval-card");
    await second.getByRole("button", { name: "Reject" }).click();
    await expect(main(page).getByTestId("approval-card")).toHaveCount(0, { timeout: 15_000 });
    expect(s.trading.intents.map((i) => i.status)).toEqual(["approved", "cancelled"]);
    s.trading.arm("armed", { renewalDue: true, validUntilDate: "2026-10-09" });
    await page.reload();
    await expect(arming).toContainText("renew to keep trading");
    await expect(arming.getByRole("button", { name: "Renew" })).toBeVisible();
    await capture(page, main(page).getByTestId("arming-card"), "portfolio-armed.png");
    await arming.getByRole("button", { name: "Disarm" }).click();
    await expect(arming).toHaveAttribute("data-state", "unarmed", { timeout: 15_000 });
    await expect(arming).toContainText("The owner disarmed the agent.");
    expect(s.trading.calls).toEqual(["registerSession", "revokeSession"]);
    expect(await blockingViolations(page)).toEqual([]);
  });
});

test.describe("the overview, gas and named refusals (Phase 2 tuning)", () => {
  test("the overview shows the allocation, total, shares, mode and price at a glance", async ({
    page,
  }) => {
    const s = stack();
    await open(page, s);
    const overview = main(page).getByTestId("portfolio-overview");
    await expect(
      overview.getByRole("img", { name: "Allocation by value: USDC 75.00%, WMON 25.00%" }),
    ).toBeVisible();
    await expect(overview).toContainText("40.00");
    await expect(overview).toContainText("Fresh, 20s old");
    await expect(overview).toContainText("Normal");
    await expect(
      main(page).getByTestId("portfolio-credits").getByTestId("add-credits"),
    ).toBeVisible();
    await capture(page, overview, "portfolio-overview.png");
  });

  test("warns when the wallet's MON is too low for gas", async ({ page }) => {
    const p = portfolioFixture(MOCK_WALLET_ADDRESS);
    const s = stack({ ...p, wallet: { ...p.wallet, monWei: "1000000000000000" } });
    await open(page, s);
    const gas = main(page).getByTestId("gas-notice");
    await expect(gas).toHaveAttribute("data-low", "true");
    await expect(gas).toContainText("too little to arm, deposit or withdraw");
    await capture(page, gas, "portfolio-low-gas.png");
    expect(await blockingViolations(page)).toEqual([]);
  });

  test("a refused grant shows the Executor's named reason, and nothing is sent", async ({
    page,
  }) => {
    const s = stack();
    await open(page, s);
    s.chain.revertCall = {
      to: EXECUTOR,
      data: encodeErrorResult({ abi: GRANT_ABI, errorName: "BadSession" }),
    };
    const arming = main(page).getByTestId("arming-card");
    await arming.getByRole("button", { name: "Arm", exact: true }).click();
    await expect(status(arming)).toHaveAttribute("data-state", "failed", { timeout: 15_000 });
    await expect(status(arming)).toContainText("The Executor refused the trading permission");
    expect(s.trading.calls).toEqual([]);
  });
});

test.describe("the owner's data only", () => {
  test("another wallet sees none of this portfolio and cannot act on it", async ({ page }) => {
    const s = stack(portfolioFixture(OTHER_WALLET), OTHER_WALLET);
    await open(page, s);
    await expect(main(page).getByText("Could not read this portfolio")).toBeVisible();
    await expect(main(page).getByTestId("positions")).toHaveCount(0);
    await expect(main(page).getByText("40.00")).toHaveCount(0);
    // Only session requests reached the fake, each refused: no trading route was answered.
    expect(s.api.ownerCalls.every((c) => c.startsWith("session"))).toBe(true);
  });

  test("the card on My Agents shows the trading account's value and links to the portfolio", async ({
    page,
  }) => {
    const s = stack();
    await open(page, s, "/agents");
    const summary = page.getByTestId("trading-summary");
    await expect(summary).toContainText("40.00", { timeout: 15_000 });
    // The compact trading summary: value, allocation and mode (Phase 2 tuning).
    await expect(summary.getByRole("img", { name: /USDC 75.00%, WMON 25.00%/ })).toBeVisible();
    await expect(summary).toContainText("Normal");
    await capture(page, summary, "agents-trading-summary.png");
    await summary.getByRole("link", { name: "Open portfolio" }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${AGENT}/portfolio$`));
    await expect(main(page).getByTestId("positions")).toBeVisible();
  });
});
