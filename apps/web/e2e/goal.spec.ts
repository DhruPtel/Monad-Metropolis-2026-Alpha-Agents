import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { type Locator, type Page, expect, test } from "@playwright/test";
import { MOCK_WALLET_ADDRESS } from "../src/auth/mock-wallet-constants";
import { FakeApi, fundedDashboard } from "./fake-api";
import { FakeChain } from "./fake-chain";
import { FakeTrading, portfolioFixture } from "./fake-trading";

/**
 * The Goal page (P3-U1) against the test build with the mock wallet, the fake
 * API (answering with the real goal translator) and the fake chain, at 1440px
 * and 380px: every state captured and scanned (no goal, saved, saving,
 * refused, not owner), Light chosen by default with a month's cost per
 * intensity, stricter limits that only tighten, the move to Ready, and the
 * links from the agent's card and its portfolio.
 */
const BEE = 14;
const AGENT = 7n;
const OTHER_WALLET = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;

const main = (page: Page) => page.getByRole("main");
const walletButton = (page: Page) => page.locator("header [data-slot=wallet-button]");
const saveStatus = (page: Page) => main(page).getByTestId("goal-save-status");

function stack(owner: string = MOCK_WALLET_ADDRESS) {
  const chain = new FakeChain();
  chain.mint(AGENT, owner as `0x${string}`, BEE);
  const api = new FakeApi(chain);
  api.dashboards.set(AGENT, fundedDashboard());
  api.trading.set(
    AGENT,
    new FakeTrading(chain, MOCK_WALLET_ADDRESS, portfolioFixture(owner as `0x${string}`)),
  );
  return { chain, api };
}

async function open(page: Page, s: ReturnType<typeof stack>, path = `/agents/${AGENT}/goal`) {
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

const radio = (page: Page, group: string, name: RegExp) =>
  main(page).getByRole("radiogroup", { name: group }).getByRole("radio", { name });

/** The preview has answered for the form as it is: the plan line shows the given target. */
const previewed = (page: Page, target: string) =>
  expect(main(page).getByTestId("goal-plan-line")).toContainText(`starts at ${target}`);

test.describe("the Goal page", () => {
  test("an agent with no goal: Light by default, a month's cost per intensity, every field explained", async ({
    page,
  }) => {
    const s = stack();
    await open(page, s);
    await expect(main(page).getByTestId("goal-summary")).toHaveAttribute(
      "data-state",
      "UNCONFIGURED",
    );
    await expect(radio(page, "Research intensity", /^Light/)).toBeChecked();
    await expect(radio(page, "Aggressiveness", /^Balanced/)).toBeChecked();
    await expect(radio(page, "Plan changes", /^Ask me first/)).toBeChecked();
    await expect(radio(page, "Model tier", /^Medium/)).toBeChecked();
    await expect(radio(page, "Screened lane", /^Core lane only/)).toBeChecked();
    await expect(main(page).getByTestId("goal-brief")).toContainText("Hold large caps");
    await expect(main(page).getByTestId("goal-excluded")).toContainText("No token is excluded");
    await expect(main(page).getByTestId("goal-budget")).toHaveValue("1.00");
    const cost = main(page).getByTestId("cost-preview");
    await expect(cost.locator('tr[data-intensity="LIGHT"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect(cost.locator('tr[data-intensity="LIGHT"]')).toContainText("30.00 USDC");
    await expect(cost.locator('tr[data-intensity="STANDARD"]')).toContainText("75.00 USDC");
    await expect(cost.locator('tr[data-intensity="DEEP"]')).toContainText("180.00 USDC");
    await expect(cost).toContainText("at most 4.00 USDC");
    // Every choice and field carries a plain explanation.
    for (const group of [
      "Aggressiveness",
      "Screened lane",
      "Model tier",
      "Research intensity",
      "Plan changes",
    ])
      await expect(main(page).getByRole("radiogroup", { name: group })).toHaveAccessibleDescription(
        /\w/,
      );
    await expect(main(page).getByLabel("Largest trade (%)")).toHaveAccessibleDescription(
      /Hard limit 10%; yours can only be lower/,
    );
    await previewed(page, "20%");
    await expect(main(page).getByRole("button", { name: "Save goal" })).toBeEnabled();
    await capture(page, main(page), "goal-no-goal.png");
    expect(await blockingViolations(page)).toEqual([]);
  });

  test("saving a goal with stricter limits moves the agent to Ready", async ({ page }) => {
    const s = stack();
    await open(page, s);
    await radio(page, "Aggressiveness", /^Aggressive/).click();
    await expect(main(page).getByTestId("goal-brief")).toContainText("passes the safety check");
    await main(page).getByLabel("Largest trade (%)").fill("5");
    await main(page).getByLabel("Most trades a day (trades)").fill("6");
    await main(page).getByLabel("Most in one token (%)").fill("25");
    await previewed(page, "25%");
    const limits = main(page).getByTestId("effective-limits");
    await expect(limits.locator('tr[data-field="maxTradeBps"]')).toContainText(/10%.*5%.*5%/);
    await expect(limits.locator('tr[data-field="maxTradesPer24h"]')).toContainText(
      /20 trades.*6 trades.*6 trades/,
    );
    await main(page).getByRole("button", { name: "Save goal" }).click();
    await expect(saveStatus(page)).toHaveAttribute("data-state", "saved");
    await expect(saveStatus(page)).toContainText(
      "Goal saved. Agent #7 moved from Not configured to Ready.",
    );
    await expect(main(page).getByTestId("goal-summary")).toHaveAttribute("data-state", "READY");
    await expect(main(page).getByTestId("goal-summary")).toContainText("Goal: Aggressive");
    await expect(main(page).getByRole("button", { name: "Save changes" })).toBeDisabled();
    const saved = s.api.goals.saved.get(AGENT);
    expect(saved?.goal).toMatchObject({
      aggressiveness: "AGGRESSIVE",
      modelTier: "MEDIUM",
      stricterLimits: { maxTradeBps: 500, maxTradesPer24h: 6, maxPositionBps: 2_500 },
      research: { intensity: "LIGHT", dailyBudgetUsdcE6: "1000000" },
    });
    expect(saved?.strategyEpoch).toBe(1n);
    await capture(page, main(page), "goal-saved.png");
    expect(await blockingViolations(page)).toEqual([]);
    // A change saves under a new strategy epoch and keeps the agent Ready.
    await radio(page, "Research intensity", /^Standard/).click();
    await expect(main(page).getByTestId("goal-budget")).toHaveValue("2.50");
    await main(page).getByRole("button", { name: "Save changes" }).click();
    await expect(saveStatus(page)).toContainText("Agent #7 stays Ready");
    expect(s.api.goals.saved.get(AGENT)?.strategyEpoch).toBe(2n);
  });

  test("the month's cost follows the intensity and the daily budget", async ({ page }) => {
    const s = stack();
    await open(page, s);
    await radio(page, "Research intensity", /^Deep/).click();
    const budget = main(page).getByTestId("goal-budget");
    await expect(budget).toHaveValue("6.00");
    await budget.fill("3");
    const deep = main(page).getByTestId("cost-preview").locator('tr[data-intensity="DEEP"]');
    await expect(deep).toHaveAttribute("aria-current", "true");
    await expect(deep).toContainText("90.00 USDC");
    await radio(page, "Model tier", /^High/).click();
    await expect(main(page).getByTestId("cost-preview")).toContainText("at most 7.50 USDC");
  });

  test("a limit past the hard limit is named before saving, and the save is refused", async ({
    page,
  }) => {
    const s = stack();
    await open(page, s);
    const trade = main(page).getByLabel("Largest trade (%)");
    await trade.fill("12");
    await expect(trade).toHaveAccessibleDescription(
      "Largest trade can only tighten the hard limit of 10%; 12% would loosen it.",
    );
    await expect(trade).toHaveAttribute("aria-invalid", "true");
    await expect(
      main(page).getByTestId("effective-limits").locator('tr[data-field="maxTradeBps"]'),
    ).toContainText(/10%.*Not accepted.*10%/);
    await main(page).getByRole("button", { name: "Save goal" }).click();
    await expect(saveStatus(page)).toHaveAttribute("data-state", "refused");
    await expect(saveStatus(page).getByRole("listitem")).toContainText("12% would loosen it");
    expect(s.api.goals.saved.size).toBe(0);
    await expect(main(page).getByTestId("goal-summary")).toHaveAttribute(
      "data-state",
      "UNCONFIGURED",
    );
    await capture(page, main(page).getByTestId("goal-limits"), "goal-refused-limits.png");
    await capture(page, main(page).getByTestId("goal-save"), "goal-refused.png");
    expect(await blockingViolations(page)).toEqual([]);
  });

  test("while saving, the form is locked and says so", async ({ page }) => {
    const s = stack();
    let release: (() => void) | null = null;
    s.api.goals.hold = new Promise<void>((r) => {
      release = r;
    });
    await open(page, s);
    await main(page).getByRole("button", { name: "Save goal" }).click();
    await expect(saveStatus(page)).toHaveAttribute("data-state", "saving");
    await expect(radio(page, "Aggressiveness", /^Aggressive/)).toBeDisabled();
    await capture(page, main(page).getByTestId("goal-save"), "goal-saving.png");
    expect(await blockingViolations(page)).toEqual([]);
    (release as (() => void) | null)?.();
    await expect(saveStatus(page)).toHaveAttribute("data-state", "saved");
  });

  test("another wallet cannot read or change the goal", async ({ page }) => {
    const s = stack(OTHER_WALLET);
    await open(page, s);
    await expect(main(page).getByTestId("goal-not-owner")).toContainText(
      "This wallet does not own Agent #7",
    );
    await expect(main(page).getByRole("button", { name: /Save/ })).toHaveCount(0);
    expect(s.api.ownerCalls.filter((c) => c.startsWith("goal"))).toEqual([]);
    await capture(page, main(page), "goal-not-owner.png");
    expect(await blockingViolations(page)).toEqual([]);
  });

  test("the agent's card and its portfolio show the state and link to the Goal page", async ({
    page,
  }) => {
    const s = stack();
    await open(page, s, "/agents");
    const card = main(page).getByTestId("my-agent-card");
    await expect(card.getByTestId("goal-summary")).toHaveAttribute("data-state", "UNCONFIGURED");
    await card.getByRole("link", { name: "Set goal" }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${AGENT}/goal$`));
    await main(page).getByRole("button", { name: "Save goal" }).click();
    await expect(saveStatus(page)).toHaveAttribute("data-state", "saved");
    await main(page).getByRole("link", { name: "Portfolio" }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${AGENT}/portfolio$`));
    const summary = main(page).getByTestId("goal-summary");
    await expect(summary).toHaveAttribute("data-state", "READY");
    await expect(summary).toContainText("Band rebalancer, Balanced");
    await expect(summary.getByRole("link", { name: "Change goal" })).toHaveAttribute(
      "href",
      `/agents/${AGENT}/goal`,
    );
  });
});
