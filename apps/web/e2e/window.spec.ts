import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { type Locator, type Page, expect, test } from "@playwright/test";
import { MOCK_WALLET_ADDRESS } from "../src/auth/mock-wallet-constants";
import { FakeApi, fundedDashboard } from "./fake-api";
import { FakeChain } from "./fake-chain";
import {
  FakeTrading,
  WINDOW_NO_ACCOUNT,
  WINDOW_WAITING,
  noAccountFixture,
  planCardFixture,
  portfolioFixture,
  SETTLED,
} from "./fake-trading";

/**
 * The portfolio window (F-U11) against the test build with the mock wallet,
 * the fake API and the fake chain, at 1440px and 380px: the makeup, the
 * chart with its markers, the scores and the $100 figure; the table twin and
 * the hover reading; every not-enough-data state; no account; the links to
 * the plan, the trades and why; that another wallet sees none of it; and
 * the ways in from My Agents and the portfolio.
 */
const BEE = 14;
const AGENT = 7n;
const OTHER_WALLET = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;

const main = (page: Page) => page.getByRole("main");
const walletButton = (page: Page) => page.locator("header [data-slot=wallet-button]");

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

async function open(page: Page, s: ReturnType<typeof stack>, path = `/agents/${AGENT}/window`) {
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

test.describe("the window, captured and scanned", () => {
  test("shows the $100 figure, the scores, the chart with its trade markers, the makeup and the allocation", async ({
    page,
  }) => {
    const s = stack();
    await open(page, s);
    const w = main(page).getByTestId("window");
    await expect(w.getByTestId("hundred-dollars")).toContainText("$104.12");
    await expect(w.getByTestId("hundred-dollars")).toContainText("$100.00");
    await expect(w.getByTestId("score-return")).toContainText("+4.12%");
    await expect(w.getByTestId("score-drawdown")).toContainText("-3.18%");
    await expect(w.getByTestId("score-winshare")).toContainText("1 of 1 closed position.");
    await expect(w.getByTestId("window-as-of")).toContainText("Read live from the chain");
    await expect(w.getByTestId("window-as-of")).toContainText("49 readings");
    const chart = w.getByTestId("performance-chart");
    await expect(chart.getByTestId("trade-mark")).toHaveCount(3);
    await expect(chart.getByRole("img", { name: /with 3 trades marked/ })).toBeVisible();
    const makeup = w.getByTestId("asset-makeup");
    await expect(makeup.getByTestId("asset-row")).toHaveCount(4);
    await expect(makeup).toContainText("Total value 104.78 USDC");
    await expect(makeup.locator("[data-symbol=WBTC]")).toContainText("+3.10");
    await expect(makeup.locator("[data-symbol=WMON]")).toContainText("-0.91");
    await expect(makeup.locator("[data-symbol=CHOG]")).toContainText("no usable price");
    await expect(
      w.getByRole("img", { name: "Allocation by value: USDC 55.73%, WBTC 32.54%, WMON 11.72%" }),
    ).toBeVisible();
    await expect(w.getByTestId("allocation-unpriced")).toContainText("CHOG");
    await capture(page, main(page), "window-funded.png");
    expect(await blockingViolations(page)).toEqual([]);
  });

  test("the table twin lists every reading with its trades, and hovering the chart shows the reading under the pointer", async ({
    page,
  }) => {
    const s = stack();
    await open(page, s);
    const chart = main(page).getByTestId("performance-chart");
    await chart.getByTestId("performance-table-toggle").click();
    const rows = chart.getByTestId("performance-table").getByRole("row");
    await expect(rows).toHaveCount(50);
    await expect(rows.nth(1)).toContainText("100.00");
    await expect(rows.nth(8)).toContainText("Bought 0.00031 WBTC");
    await expect(rows.nth(41)).toContainText("Sold 120 WMON");
    await chart.getByTestId("performance-table-toggle").click();
    await expect(chart.getByTestId("performance-table")).toHaveCount(0);
    const svg = chart.getByRole("img");
    const box = await svg.boundingBox();
    if (!box) throw new Error("no chart");
    await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2);
    const tip = chart.getByTestId("performance-tooltip");
    await expect(tip).toContainText("$100 is worth");
    await expect(tip).toContainText("Account value");
    await page.mouse.move(0, 0);
    await expect(tip).toHaveCount(0);
  });

  test("a new account says not enough data yet, and why, for every score and the chart", async ({
    page,
  }) => {
    const s = stack();
    s.trading.window = WINDOW_WAITING();
    await open(page, s);
    const w = main(page).getByTestId("window");
    await expect(w.getByTestId("hundred-dollars")).toHaveAttribute("data-state", "waiting");
    for (const id of ["score-return", "score-drawdown", "score-winshare"])
      await expect(w.getByTestId(id)).toHaveAttribute("data-state", "waiting");
    await expect(w.getByTestId("score-winshare")).toContainText("no position has been closed");
    await expect(w.getByTestId("performance-empty")).toContainText("Not enough data yet");
    await expect(w.getByTestId("window-as-of")).toContainText("From the latest snapshot");
    await expect(w.getByTestId("asset-makeup").getByTestId("asset-row")).toHaveCount(1);
    await capture(page, main(page), "window-waiting.png");
    expect(await blockingViolations(page)).toEqual([]);
  });

  test("without a trading account the window points to the portfolio", async ({ page }) => {
    const s = stack(noAccountFixture(MOCK_WALLET_ADDRESS));
    s.trading.window = WINDOW_NO_ACCOUNT();
    await open(page, s);
    await expect(main(page).getByText("No trading account yet")).toBeVisible();
    await expect(main(page).getByTestId("window")).toHaveCount(0);
    await capture(page, main(page), "window-no-account.png");
    expect(await blockingViolations(page)).toEqual([]);
    await main(page).getByRole("link", { name: "Open the portfolio" }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${AGENT}/portfolio$`));
  });
});

test.describe("reachable both ways", () => {
  test("the window's links reach the plan, the recent trades and why the agent did not trade", async ({
    page,
  }) => {
    const s = stack();
    s.trading.intents = [SETTLED];
    // The plan section exists on the portfolio page only when the API serves a plan card.
    s.trading.planCard = planCardFixture();
    await open(page, s);
    const links = main(page).getByTestId("window-links");
    await links.getByRole("link", { name: "Recent trades" }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${AGENT}/portfolio#trades$`));
    await expect(main(page).getByTestId("recent-trades")).toBeVisible();
    await expect(page.locator("#trades")).toBeInViewport();
    await page.goBack();
    await links.getByRole("link", { name: "Why the agent did not trade" }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${AGENT}/portfolio#why$`));
    await expect(main(page).getByTestId("why-not-traded")).toBeVisible();
    await page.goBack();
    await links.getByRole("link", { name: "Current plan" }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${AGENT}/portfolio#plan$`));
    await expect(main(page).getByTestId("plan-section")).toBeVisible();
  });

  test("My Agents and the portfolio both lead to the window", async ({ page }) => {
    const s = stack();
    await open(page, s, "/agents");
    await page.getByTestId("fund-panel").getByRole("link", { name: "Performance" }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${AGENT}/window$`));
    await expect(main(page).getByTestId("window")).toBeVisible();
    await main(page).getByRole("link", { name: "Portfolio", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${AGENT}/portfolio$`));
    await main(page).getByTestId("window-link").click();
    await expect(page).toHaveURL(new RegExp(`/agents/${AGENT}/window$`));
    await expect(main(page).getByTestId("window")).toBeVisible();
  });

  test("another wallet sees none of this window", async ({ page }) => {
    const s = stack(portfolioFixture(OTHER_WALLET), OTHER_WALLET);
    await open(page, s);
    await expect(main(page).getByText("Could not read this window")).toBeVisible();
    await expect(main(page).getByTestId("window")).toHaveCount(0);
    await expect(main(page).getByText("104.12")).toHaveCount(0);
    // Only session requests reached the fake, each refused: the window route was never answered.
    expect(s.api.ownerCalls.every((c) => c.startsWith("session"))).toBe(true);
  });
});
