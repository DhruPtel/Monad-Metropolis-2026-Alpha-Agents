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

test("the login-unavailable state matches its screenshot", async ({ page }) => {
  await page.goto("/design");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByTestId("login-state-unavailable")).toHaveScreenshot(
    "login-unavailable.png",
  );
});

test("the wrong-chain prompt matches its screenshot", async ({ page }) => {
  await page.goto("/design");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByTestId("login-state-wrong-chain-prompt")).toHaveScreenshot(
    "login-wrong-chain-prompt.png",
  );
});

test("the header fits on one row at every desktop width, logged out and connected", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "measures desktop widths");
  const overflowing: string[] = [];
  for (const width of [1024, 1279, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const connected of [false, true]) {
      await open(page, "/design");
      if (connected) await connect(page);
      const row = await page.evaluate(() => {
        const header = document.querySelector("header.sticky > div");
        const links = [...document.querySelectorAll("nav[aria-label=Main] a")];
        const twoLines = links.filter((a) => a.getClientRects().length > 1 || a.clientHeight > 40);
        return header
          ? { overflow: header.scrollWidth - header.clientWidth, wrapped: twoLines.length }
          : null;
      });
      const state = connected ? "connected" : "logged out";
      if (!row) overflowing.push(`${width} ${state}: no header row`);
      else if (row.overflow > 0 || row.wrapped > 0)
        overflowing.push(`${width} ${state}: ${row.overflow}px over, ${row.wrapped} wrapped`);
    }
  }
  expect(overflowing).toEqual([]);
});

test.describe("network switch outcomes", () => {
  const prompt = (page: Page) => page.getByRole("alert").filter({ hasText: `Switch to ${TARGET}` });

  /** Connects, then puts the wallet on Monad Testnet, as in the owner's playtest. */
  async function onTestnet(page: Page, behavior: string) {
    await open(page);
    await connect(page);
    await page.evaluate((b) => {
      window.__mockWallet?.setSwitchBehavior(b as never);
      window.__mockWallet?.setChainId(10143);
    }, behavior);
    await expect(prompt(page)).toContainText("Your wallet is on Monad Testnet.");
  }

  for (const [behavior, phase] of [
    ["approve", `Approve the switch to ${TARGET} in your wallet.`],
    ["unknown-chain", `Approve adding ${TARGET} in your wallet.`],
  ] as const) {
    test(`switches when the wallet approves (${behavior})`, async ({ page }) => {
      await onTestnet(page, behavior);
      await prompt(page)
        .getByRole("button", { name: `Switch to ${TARGET}` })
        .click();
      // Pending in the wallet is said while it waits.
      await expect(prompt(page).getByRole("status")).toContainText(phase);
      await expect(walletButton(page)).toHaveAttribute("data-state", "connected");
      await expect(prompt(page)).toHaveCount(0);
      await expect(page.getByText(`Switched to ${TARGET}`)).toBeVisible();
    });
  }

  for (const [behavior, message] of [
    ["reject", "You declined the network switch in your wallet."],
    ["reject-add", `You declined adding ${TARGET} in your wallet.`],
    ["already-pending", "Your wallet already has a request open."],
    ["stay", "Your wallet still reports Monad Testnet."],
  ] as const) {
    test(`says why it did not switch (${behavior})`, async ({ page }) => {
      await onTestnet(page, behavior);
      const button = prompt(page).getByRole("button", { name: `Switch to ${TARGET}` });
      await button.click();
      await expect(prompt(page).getByRole("status")).toContainText(message);
      await expect(walletButton(page)).toHaveAttribute("data-state", "wrong-chain");
      await expect(button).toBeEnabled();
    });
  }

  test("the header's Switch network button runs the same switch", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "the header button is labelled on desktop");
    await onTestnet(page, "reject");
    await walletButton(page).getByRole("button", { name: "Switch network" }).click();
    await expect(prompt(page).getByRole("status")).toContainText(
      "You declined the network switch in your wallet.",
    );
  });
});
