import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * Every console page, screenshotted and scanned. These run with no stack and
 * no .env (as in CI), so the environment panel shows every service down, which
 * is deterministic; nothing on these pages depends on the time.
 */
const PAGES = [
  { path: "/", name: "environment", heading: "Environment" },
  { path: "/fork", name: "fork", heading: "Fork controls" },
  { path: "/funds", name: "funds", heading: "Test funds" },
  { path: "/addresses", name: "addresses", heading: "Address book" },
  { path: "/policy", name: "policy", heading: "Policy sandbox" },
  { path: "/agents", name: "agents", heading: "Agents" },
] as const;

for (const panel of PAGES) {
  test.describe(panel.name, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(panel.path);
      await page.evaluate(() => document.fonts.ready);
      await expect(page.getByRole("heading", { level: 1, name: panel.heading })).toBeVisible();
    });

    test("matches its baseline screenshot", async ({ page }) => {
      await expect(page).toHaveScreenshot(`${panel.name}.png`, { fullPage: true });
    });

    test("has no serious or critical accessibility violations", async ({ page }) => {
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
        .analyze();
      const blocking = results.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
      expect(blocking).toEqual([]);
    });
  });
}

test("the policy sandbox explains a trade that is too large and one with too much slippage", async ({
  page,
}) => {
  await page.goto("/policy");
  const result = page.getByTestId("sandbox-result");
  await expect(result).toContainText("passes every pre-check");
  await page.getByRole("button", { name: "Trade too large" }).click();
  await expect(result).toContainText("The trade is larger than 10% of the account's value.");
  await expect(result).toContainText("TRADE_SIZE_EXCEEDED");
  await page.getByRole("button", { name: "Too much slippage" }).click();
  await expect(result).toContainText("SLIPPAGE_TOO_HIGH");
});

test("fork actions refuse when no anvil fork answers", async ({ page }) => {
  await page.goto("/fork");
  await page.getByRole("button", { name: "Take snapshot" }).click();
  await expect(page.getByTestId("action-error")).toContainText("is not the local anvil fork");
});

/**
 * A full repaint before an element capture: after a state change only parts of
 * the page are repainted, and an antialiased corner composited over a partial
 * repaint can differ by a few pixels from run to run (L-65).
 */
async function repaint(page: import("@playwright/test").Page) {
  await page.mouse.move(0, 0);
  await page.evaluate(async () => {
    const frames = () =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    document.documentElement.style.opacity = "0.99";
    await frames();
    document.documentElement.style.opacity = "";
    await frames();
  });
}

test.describe("agents panel controls (P1-U5)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/agents");
    await page.evaluate(() => document.fonts.ready);
  });

  const row = (page: import("@playwright/test").Page, name: RegExp) =>
    page.getByRole("row").filter({ has: page.getByText(name) });

  test("shows each agent's runtime and offers the no-op task only when provisioned", async ({
    page,
  }) => {
    const bee = row(page, /^Alpha Agent #1$/);
    const unrevealed = row(page, /^Alpha Agent #2$/);
    await expect(bee.getByText("Provisioned")).toBeVisible();
    await expect(unrevealed.getByText("Not provisioned")).toBeVisible();
    await expect(bee.getByRole("button", { name: "Run no-op task" })).toBeEnabled();
    await expect(unrevealed.getByRole("button", { name: "Run no-op task" })).toBeDisabled();
    await expect(unrevealed.getByRole("button", { name: "Reset" })).toBeDisabled();
  });

  test("runs the no-op task and shows its structured result", async ({ page }) => {
    await row(page, /^Alpha Agent #1$/)
      .getByRole("button", { name: "Run no-op task" })
      .click();
    const result = page.getByTestId("task-result");
    await expect(result).toHaveAttribute("data-task-status", "queued");
    await expect(result).toHaveAttribute("data-task-status", "succeeded", { timeout: 10_000 });
    await expect(result).toContainText("NOOP_OK");
    await expect(result).toContainText("Pro, 8 slots, tier-pro@0");
    await expect(result).toContainText("2 of 2 succeeded");
    await repaint(page);
    await expect(result).toHaveScreenshot("agents-task-result.png");
  });

  test("shows funding addresses, credits, held deposits and the RESTRICTED state (P1-U6)", async ({
    page,
  }) => {
    const bee = row(page, /^Alpha Agent #1$/);
    const unrevealed = row(page, /^Alpha Agent #2$/);
    await expect(bee).toContainText("4.9944");
    await expect(bee).toContainText("held");
    await expect(bee.getByRole("button", { name: "Refund" })).toBeEnabled();
    await expect(unrevealed.getByRole("button", { name: "Refund" })).toBeDisabled();
    await expect(bee.getByRole("button", { name: "Fund 5 USDC" })).toBeEnabled();
  });

  test("refunds an agent's credits after a confirmation and says how much went back", async ({
    page,
  }) => {
    await row(page, /^Alpha Agent #1$/)
      .getByRole("button", { name: "Refund" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Refund Alpha Agent #1's credits?" });
    await expect(dialog).toContainText("to its current owner");
    await dialog.getByRole("button", { name: "Refund" }).click();
    await expect(page.getByText("Refunded 6.99 USDC to Alpha Agent #1's owner")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("shows each provisioned agent's activity, last action and tool calls (P1-U7)", async ({
    page,
  }) => {
    await expect(row(page, /^Alpha Agent #1$/)).toContainText(
      "Agent #1 searched for Monad DEX volume",
    );
    const section = page.getByTestId("agent-activity");
    const feed = section.getByRole("list", { name: "Activity of Alpha Agent #1" });
    await expect(feed.getByRole("listitem")).toHaveCount(2);
    await expect(feed).toContainText("2026-10-06 16:42 UTC");
    await expect(feed).toContainText("Template");
    const calls = section.getByRole("region", { name: "Tool calls of Alpha Agent #1" });
    await expect(calls.getByText("Answered")).toHaveCount(4);
    await expect(calls.getByText("Refused")).toHaveAttribute(
      "title",
      "Refused before it ran; not charged (PRIVATE_ADDRESS)",
    );
    await expect(calls.getByText("Failed")).toBeVisible();
    // The unrevealed agent has no runtime, so no activity card.
    await expect(section.getByText("Alpha Agent #2")).toHaveCount(0);
    await repaint(page);
    await expect(section).toHaveScreenshot("agents-activity.png");
  });

  test("runs a Scan and shows its stage record, tool calls and spend (P1-U7)", async ({ page }) => {
    const unrevealed = row(page, /^Alpha Agent #2$/);
    await expect(unrevealed.getByRole("button", { name: "Run Scan" })).toBeDisabled();
    await row(page, /^Alpha Agent #1$/)
      .getByRole("button", { name: "Run Scan" })
      .click();
    const result = page.getByTestId("task-result");
    await expect(result).toHaveAttribute("data-task-status", "succeeded", { timeout: 10_000 });
    await expect(result).toContainText("Scan, Alpha Agent #1");
    await expect(result).toContainText("Completed with complete_stage");
    await expect(result).toContainText("DONE, schema-valid");
    await expect(result).toContainText("WMON DEX_VOLUME_UP (55%)");
    await expect(result).toContainText("0.0120 USDC");
  });

  test("resets an agent after a confirmation", async ({ page }) => {
    await row(page, /^Alpha Agent #1$/)
      .getByRole("button", { name: "Reset" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Reset Alpha Agent #1?" });
    await expect(dialog).toContainText("deletes its LiteLLM key");
    await dialog.getByRole("button", { name: "Reset" }).click();
    await expect(page.getByText("Alpha Agent #1 is being reset")).toBeVisible();
  });
});

test("loads every font from its own origin", async ({ page }) => {
  const fonts: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "font") fonts.push(request.url());
  });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  const origin = new URL(page.url()).origin;
  expect(fonts.length).toBeGreaterThan(0);
  expect(fonts.filter((url) => new URL(url).origin !== origin)).toEqual([]);
});
