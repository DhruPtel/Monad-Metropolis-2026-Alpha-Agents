import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { type Locator, type Page, expect, test } from "@playwright/test";
import { MOCK_WALLET_ADDRESS } from "../src/auth/mock-wallet-constants";
import { FakeApi, fundedDashboard } from "./fake-api";
import { FakeChain } from "./fake-chain";
import { FakeHoldings } from "./fake-holdings";
import {
  ACCOUNT,
  ACCOUNT_V3,
  FakeTrading,
  olderAccountFixture,
  portfolioFixture,
  portfolioV3Fixture,
} from "./fake-trading";

/**
 * The portfolio page on the fund agent's set (A-80, after the F-U11
 * playtest) against the test build with the mock wallet, the fake API and
 * the fake chain, at 1440px and 380px: every section uses the
 * PersonalAccountV3 (opening it, deposits and withdrawals of any registered
 * token, every held token with its share, the allocation and the v3 caps),
 * the older v2 account with its one withdraw-all, the My Agents card and the
 * holdings list, each captured and scanned.
 */
const BEE = 14;
const AGENT = 7n;

const main = (page: Page) => page.getByRole("main");
const walletButton = (page: Page) => page.locator("header [data-slot=wallet-button]");
const status = (scope: Locator) => scope.getByTestId("wallet-action-status");

function stack(v3 = portfolioV3Fixture(MOCK_WALLET_ADDRESS)) {
  const chain = new FakeChain();
  chain.mint(AGENT, MOCK_WALLET_ADDRESS, BEE);
  const api = new FakeApi(chain);
  api.dashboards.set(AGENT, fundedDashboard());
  const trading = new FakeTrading(
    chain,
    MOCK_WALLET_ADDRESS,
    portfolioFixture(MOCK_WALLET_ADDRESS),
  );
  trading.portfolioV3 = v3;
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
  // A capture restores the animations it fast-forwarded, so an open dialog fades in again:
  // the scan waits for every finite animation to finish, or its text reads as too faint
  // (UI-U1); an endless one, such as a running step's pulse, is left alone.
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations().map((a) => {
        const timing = a.effect?.getTiming();
        if (!timing || timing.iterations === Number.POSITIVE_INFINITY) return undefined;
        return a.finished.catch(() => undefined);
      }),
    ),
  );
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

const sent = (chain: FakeChain) => chain.transactions.filter((t) => !t.reverted);

/** UI-U1: an open dialog hides the page from assistive technology, so it is closed before main is read. */
async function closeDialog(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

/** UI-U1: deposit and withdraw live in small dialogs; any open dialog is closed first. */
async function openDialog(page: Page, which: "deposit" | "withdraw") {
  await closeDialog(page);
  await main(page).getByTestId(`open-${which}`).click();
  const form = page.getByTestId(`${which}-form`);
  await expect(form).toBeVisible();
  return form;
}

test.describe("the portfolio on the fund agent's set (A-80)", () => {
  test("a funded account shows every held token, the allocation, the v3 caps and the forms for any token", async ({
    page,
  }) => {
    const s = stack();
    await open(page, s);
    const overview = main(page).getByTestId("portfolio-overview");
    await expect(overview).toHaveAttribute("data-custody", "v3");
    await expect(overview).toContainText("70.00");
    await expect(
      overview.getByRole("img", {
        name: "Allocation by value: USDC 42.85%, WBTC 42.85%, WMON 14.28%",
      }),
    ).toBeVisible();
    const positions = main(page).getByTestId("positions");
    await expect(positions).toHaveAttribute("data-custody", "v3");
    // UX-U1: the positions are the ledger's dense table.
    await expect(positions.getByTestId("position-row")).toHaveCount(3);
    await expect(positions.locator("[data-symbol=WBTC]")).toContainText("+2.00");
    await expect(positions.locator("[data-symbol=WMON]")).toContainText("+0.50");
    await expect(main(page).getByTestId("caps")).toContainText("40.00 of 100.00 USDC");
    await expect(main(page).getByTestId("older-account")).toHaveCount(0);
    await capture(page, main(page), "portfolio-v3-funded.png");
    expect(await blockingViolations(page)).toEqual([]);
    // UI-U1: the forms, in their dialogs, work on the v3 account.
    const deposit = await openDialog(page, "deposit");
    await expect(deposit).toHaveAttribute("data-custody", "v3");
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    await capture(page, page.getByRole("dialog"), "portfolio-v3-deposit-dialog.png");
    expect(await blockingViolations(page)).toEqual([]);
    const withdraw = await openDialog(page, "withdraw");
    await expect(withdraw).toHaveAttribute("data-custody", "v3");
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    await capture(page, page.getByRole("dialog"), "portfolio-v3-withdraw-dialog.png");
    expect(await blockingViolations(page)).toEqual([]);
  });

  test("the older account is named plainly, one action empties it into the wallet, then the owner opens the new account and deposits into it", async ({
    page,
  }) => {
    const s = stack(olderAccountFixture(MOCK_WALLET_ADDRESS));
    await open(page, s);
    const older = main(page).getByTestId("older-account");
    await expect(older).toHaveAttribute("data-state", "held");
    await expect(older).toContainText("Not traded any more");
    await expect(older.getByTestId("older-account-lines")).toContainText("100");
    const openCard = main(page).getByTestId("open-account");
    await expect(openCard).toContainText("fund agent's set");
    await expect(main(page).getByTestId("positions")).toHaveCount(0);
    await capture(page, main(page), "portfolio-v3-older.png");
    expect(await blockingViolations(page)).toEqual([]);
    // Everything in the older account to the wallet, in one transaction to the older account.
    await older.getByTestId("older-account-withdraw-all").click();
    await expect(status(older)).toHaveAttribute("data-state", "confirmed");
    await expect(older).toHaveAttribute("data-state", "empty");
    expect(s.trading.calls).toContain("withdrawAll:older");
    expect(sent(s.chain).map((t) => t.to.toLowerCase())).toEqual([ACCOUNT.toLowerCase()]);
    // Then the new account, on the v3 factory.
    await main(page).getByRole("button", { name: "Open trading account" }).click();
    await expect(main(page).getByTestId("positions")).toBeVisible();
    expect(s.trading.calls).toContain("createPersonalAccount:v3");
    expect(s.trading.portfolioV3?.account).toBe(ACCOUNT_V3);
    // And the 170 USDC now in the wallet, up to the cap: an exact approval, then the deposit.
    const deposit = await openDialog(page, "deposit");
    await deposit.getByRole("button", { name: "Max" }).click();
    await expect(deposit.getByRole("textbox")).toHaveValue("100");
    await deposit.getByRole("button", { name: "Deposit", exact: true }).click();
    await expect(status(deposit)).toHaveAttribute("data-state", "confirmed");
    expect(s.trading.calls.filter((c) => c === "approve" || c === "deposit:v3")).toEqual([
      "approve",
      "deposit:v3",
    ]);
    await closeDialog(page);
    await expect(main(page).getByTestId("positions").locator("[data-symbol=USDC]")).toContainText(
      "100.00",
    );
    await expect(main(page).getByTestId("caps")).toContainText("100.00 of 100.00 USDC");
  });

  test("deposits any registered token at its price, names every block before anything is sent, and withdraws any held token or every token at once", async ({
    page,
  }) => {
    const s = stack();
    await open(page, s);
    const deposit = await openDialog(page, "deposit");
    // WMON from the wallet: 5 WMON, valued at the oracle price against the caps.
    await deposit.getByRole("combobox").click();
    await page.getByRole("option", { name: "WMON" }).click();
    await deposit.getByRole("button", { name: "Max" }).click();
    await expect(deposit.getByRole("textbox")).toHaveValue("5");
    await deposit.getByRole("button", { name: "Deposit", exact: true }).click();
    await expect(status(deposit)).toHaveAttribute("data-state", "confirmed");
    expect(s.trading.calls.filter((c) => c === "deposit:v3")).toHaveLength(1);
    await closeDialog(page);
    await expect(main(page).getByTestId("positions").locator("[data-symbol=WMON]")).toContainText(
      "405",
    );
    // A token without a usable price cannot be picked; a cap is named with the deposit's value.
    s.trading.portfolioV3 = {
      ...(s.trading.portfolioV3 ?? portfolioV3Fixture(MOCK_WALLET_ADDRESS)),
      tokens: (s.trading.portfolioV3 ?? portfolioV3Fixture(MOCK_WALLET_ADDRESS)).tokens.map((t) =>
        t.symbol === "WBTC" ? { ...t, price: { ...t.price, reason: "STALE" } } : t,
      ),
    };
    await page.reload();
    await expect(walletButton(page)).toHaveAttribute("data-state", "connected");
    const again = await openDialog(page, "deposit");
    await again.getByRole("combobox").click();
    await expect(page.getByRole("option", { name: "WBTC" })).toHaveAttribute("data-disabled", "");
    await page.keyboard.press("Escape");
    await again.getByRole("textbox").fill("61");
    await expect(again).toContainText("This deposit would take the account past its beta cap.");
    // Withdraw all of one token, then every token in one transaction.
    const withdraw = await openDialog(page, "withdraw");
    await withdraw.getByRole("combobox").click();
    await page.getByRole("option", { name: "WBTC" }).click();
    await withdraw.getByRole("button", { name: "Withdraw all WBTC" }).click();
    await expect(status(withdraw)).toHaveAttribute("data-state", "confirmed");
    expect(s.trading.calls).toContain("withdraw:v3");
    await closeDialog(page);
    await expect(main(page).getByTestId("positions").getByTestId("position-row")).toHaveCount(2);
    await expect(main(page).getByTestId("positions").locator("[data-symbol=WBTC]")).toHaveCount(0);
    const everything = await openDialog(page, "withdraw");
    await everything.getByTestId("withdraw-everything").click();
    await expect(status(everything)).toHaveAttribute("data-state", "confirmed");
    expect(s.trading.calls).toContain("withdrawAll:v3");
    await expect(everything.getByTestId("withdraw-empty")).toBeVisible();
    await closeDialog(page);
    await expect(main(page).getByTestId("positions-table-empty")).toBeVisible();
    // Nothing went to the older account or the v2 factory.
    expect(sent(s.chain).map((t) => t.to.toLowerCase())).not.toContain(ACCOUNT.toLowerCase());
  });

  test("a wallet off the v3 allowlist is told before it opens the account", async ({ page }) => {
    const s = stack(
      portfolioV3Fixture(MOCK_WALLET_ADDRESS, {
        account: null,
        holdings: [],
        navUsdcE6: null,
        mode: null,
        allowlist: { enabled: true, listed: false },
      }),
    );
    await open(page, s);
    await expect(main(page).getByTestId("allowlist-block")).toBeVisible();
    await expect(main(page).getByRole("button", { name: "Open trading account" })).toBeDisabled();
    await capture(page, main(page), "portfolio-v3-not-allowlisted.png");
    expect(await blockingViolations(page)).toEqual([]);
    expect(sent(s.chain)).toEqual([]);
  });

  test("the card on My Agents reads the fund account, and the holdings list names the older account", async ({
    page,
  }) => {
    const s = stack();
    const holdings = new FakeHoldings(MOCK_WALLET_ADDRESS, [
      { role: "funding", address: null, balances: {} },
      { role: "token_bound", address: ACCOUNT_V3, balances: {} },
      { role: "personal_account", address: ACCOUNT_V3, balances: { USDC: 30_000_000n } },
      { role: "older_account", address: ACCOUNT, balances: { USDC: 100_000_000n } },
    ]);
    s.api.holdings.set(AGENT, holdings);
    await open(page, s, "/agents");
    const summary = page.getByTestId("trading-summary");
    await expect(summary).toContainText("70.00", { timeout: 15_000 });
    // UI-U1: the card's donut names every held token, as the portfolio does.
    await expect(
      summary.getByRole("img", { name: /USDC 42.85%, WBTC 42.85%, WMON 14.28%/ }),
    ).toBeVisible();
    await summary.getByRole("link", { name: "Open portfolio" }).click();
    await expect(main(page).getByTestId("positions")).toBeVisible();
    const older = main(page).getByTestId("holdings-panel").getByText("Older trading account");
    await expect(older).toBeVisible();
    await expect(main(page).getByTestId("holdings-panel")).toContainText(
      "Sits in the older account. Withdraw it to your wallet from the portfolio page.",
    );
  });
});
