import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

/**
 * Login in the app shell (P1-U2), against the test build: the mock wallet stands
 * in for Privy and MetaMask (apps/web/src/auth/mock-wallet-provider.tsx), and
 * window.__mockWallet lets a test move the wallet to another chain or fail the
 * next login. The test build targets the local fork, "Monad (local fork)".
 */
const TARGET = "Monad (local fork)";
const SHORT_ADDRESS = "0x0000…2e01";
const STATES = ["logged-out", "connecting", "wrong-chain", "connected", "error"] as const;

const walletButton = (page: Page) => page.locator("header [data-slot=wallet-button]");

async function open(page: Page, path = "/") {
  await page.goto(path);
  await page.evaluate(() => document.fonts.ready);
  await expect(walletButton(page)).toHaveAttribute("data-state", "logged-out");
}

async function connect(page: Page) {
  await walletButton(page)
    .getByRole("button", { name: /connect/i })
    .click();
  await expect(walletButton(page)).toHaveAttribute("data-state", "connected");
}

async function blockingViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

test("the test build says it uses a mock wallet", async ({ page }) => {
  await open(page);
  await expect(page.getByText("Test build: mock wallet")).toBeVisible();
  expect(await page.evaluate(() => window.__mockWallet?.marker)).toBe(
    "alpha-agents-mock-wallet-e2e-only",
  );
});

test("connect shows the address and chain, and disconnect logs out", async ({ page }, info) => {
  await open(page);
  await connect(page);
  await expect(walletButton(page).getByText(SHORT_ADDRESS)).toBeVisible();
  const chip = walletButton(page).getByText(TARGET);
  if (info.project.name === "desktop") await expect(chip).toBeVisible();
  else await expect(chip).toBeHidden();
  await expect(page.locator("header")).toHaveScreenshot("shell-connected.png");

  await walletButton(page).getByRole("button", { name: "Disconnect" }).click();
  await expect(walletButton(page)).toHaveAttribute("data-state", "logged-out");
  await expect(walletButton(page).getByText(SHORT_ADDRESS)).toHaveCount(0);
});

test("a wallet on the wrong chain is blocked until it switches", async ({ page }) => {
  await open(page);
  await connect(page);
  await page.evaluate(() => window.__mockWallet?.setChainId(1));

  const prompt = page.getByRole("alert").filter({ hasText: `Switch to ${TARGET}` });
  await expect(prompt).toContainText("Your wallet is on Ethereum.");
  await expect(walletButton(page)).toHaveAttribute("data-state", "wrong-chain");
  // The page behind the prompt is inert: its link cannot be focused or followed.
  const pageLink = page.getByRole("link", { name: "Open the design system" });
  await expect(page.locator("main [inert]")).toHaveCount(1);
  await pageLink.focus();
  await expect(pageLink).not.toBeFocused();
  expect(await blockingViolations(page)).toEqual([]);
  await expect(page).toHaveScreenshot("shell-wrong-chain.png", { fullPage: true, timeout: 30_000 });

  await prompt.getByRole("button", { name: `Switch to ${TARGET}` }).click();
  await expect(walletButton(page)).toHaveAttribute("data-state", "connected");
  await expect(prompt).toHaveCount(0);
  await expect(page.locator("main [inert]")).toHaveCount(0);
});

test("a failed login shows an error and can be retried", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__mockWallet?.failNextLogin());
  await walletButton(page)
    .getByRole("button", { name: /connect/i })
    .click();
  await expect(walletButton(page)).toHaveAttribute("data-state", "error");
  await walletButton(page)
    .getByRole("button", { name: /try again/i })
    .click();
  await expect(walletButton(page)).toHaveAttribute("data-state", "connected");
});

test("the logged-out shell has no serious accessibility violations", async ({ page }) => {
  await open(page);
  expect(await blockingViolations(page)).toEqual([]);
});

for (const state of STATES) {
  test(`the ${state} login state matches its screenshot`, async ({ page }) => {
    await page.goto("/design");
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByTestId(`login-state-${state}`)).toHaveScreenshot(`login-${state}.png`);
  });
}

test("the wrong-chain prompt matches its screenshot", async ({ page }) => {
  await page.goto("/design");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByTestId("login-state-wrong-chain-prompt")).toHaveScreenshot(
    "login-wrong-chain-prompt.png",
  );
});
