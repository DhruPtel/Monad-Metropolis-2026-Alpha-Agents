import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { type Locator, type Page, expect, test } from "@playwright/test";
import { MOCK_WALLET_ADDRESS } from "../src/auth/mock-wallet-constants";
import { FUNDING_ADDRESS, FakeApi, fundedDashboard } from "./fake-api";
import { FakeChain } from "./fake-chain";

/**
 * My Agents (P1-U9, D-218) against the test build with the mock wallet and the
 * fake API, in the pinned image at 1440px and 380px: every state captured and
 * scanned, the Scan and refund flows, and that another wallet sees nothing of
 * an owner's agents. The live suite runs the page on the real stack.
 */
const ANT = 3;
const BEE = 14;
const OTHER_WALLET = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;

const main = (page: Page) => page.getByRole("main");
const walletButton = (page: Page) => page.locator("header [data-slot=wallet-button]");
const card = (page: Page, id: number) =>
  page.locator(`[data-testid=my-agent-card][data-agent-id="${id}"]`);

async function open(page: Page, chain: FakeChain, api = new FakeApi(chain)) {
  await chain.install(page);
  await api.install(page);
  await page.goto("/agents");
  await page.evaluate(() => document.fonts.ready);
  return api;
}

async function connect(page: Page) {
  await main(page).getByRole("button", { name: "Connect wallet" }).click();
  await page.mouse.move(0, 0);
  await expect(walletButton(page)).toHaveAttribute("data-state", "connected");
}

/** The same scroll, no hover, every image loaded and a full repaint (L-44, L-65), then the capture. */
async function capture(page: Page, target: Locator, name: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => document.querySelector("button:hover, a:hover") === null);
  await page.waitForFunction(() =>
    [...document.images].every((img) => img.complete && img.naturalWidth > 0),
  );
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

test.describe("every state, captured and scanned", () => {
  test("logged out, the page asks for the wallet", async ({ page }) => {
    await open(page, new FakeChain());
    await expect(main(page).getByText("Connect your wallet")).toBeVisible();
    // The nav is collapsed into a menu at 380px; the inline nav shows from 1280px.
    if (test.info().project.name === "desktop")
      await expect(page.getByRole("link", { name: "My Agents" })).toHaveAttribute(
        "aria-current",
        "page",
      );
    await capture(page, main(page), "agents-logged-out.png");
    expect(await blockingViolations(page)).toEqual([]);
  });

  test("a wallet with no agent is sent to the mint page", async ({ page }) => {
    await open(page, new FakeChain());
    await connect(page);
    await expect(main(page).getByText("No agents in this wallet yet")).toBeVisible();
    await expect(main(page).getByRole("link", { name: "Mint an agent" })).toHaveAttribute(
      "href",
      "/mint",
    );
    await capture(page, main(page), "agents-empty.png");
    expect(await blockingViolations(page)).toEqual([]);
  });

  test("an unrevealed agent waits for its reveal, with no Scan", async ({ page }) => {
    const chain = new FakeChain();
    chain.mint(7n, MOCK_WALLET_ADDRESS, 0);
    await open(page, chain);
    await connect(page);
    const c = card(page, 7);
    await expect(c.getByText("Waiting for reveal")).toBeVisible();
    await expect(c.getByTestId("unrevealed-note")).toBeVisible();
    await expect(c.getByRole("button", { name: "Run Scan now" })).toBeDisabled();
    await expect(c.getByTestId("scan-unavailable")).toContainText("revealed");
    await capture(page, main(page), "agents-unrevealed.png");
    expect(await blockingViolations(page)).toEqual([]);
  });

  test("a funded agent shows its status, funding address, QR code, credits, spend and activity", async ({
    page,
  }) => {
    const chain = new FakeChain();
    chain.mint(7n, MOCK_WALLET_ADDRESS, BEE);
    const api = new FakeApi(chain);
    api.dashboards.set(7n, fundedDashboard());
    await open(page, chain, api);
    await connect(page);
    const c = card(page, 7);
    await expect(c.getByRole("heading", { name: "Alpha Agent #7" })).toBeVisible();
    await expect(c.getByText("Pro", { exact: true })).toBeVisible();
    await expect(c.getByText("Bee", { exact: true })).toBeVisible();
    await expect(c.getByText("Ready", { exact: true })).toBeVisible();
    const fund = c.getByRole("region", { name: "Fund Alpha Agent #7" });
    await expect(fund.getByRole("img", { name: /QR code/ })).toHaveAttribute(
      "data-qr-value",
      FUNDING_ADDRESS,
    );
    await expect(fund).toContainText("4.9944");
    await expect(fund).toContainText("held");
    await expect(fund).toContainText("Trading capital arrives with the next phase");
    const spend = c.getByRole("region", { name: "Spend of Alpha Agent #7" });
    await expect(spend).toContainText("0.1716");
    await expect(spend.getByRole("listitem")).toHaveCount(4);
    await expect(spend).toContainText("Given back");
    const activity = c.getByRole("list", { name: "Activity entries of Alpha Agent #7" });
    await expect(activity.getByRole("listitem")).toHaveCount(2);
    await expect(c.getByRole("link", { name: "Configure" })).toHaveAttribute(
      "href",
      "/configure?agent=7",
    );
    await expect(c.getByTestId("scan-status")).toHaveText("Last Scan completed at 16:41 UTC.");
    await capture(page, main(page), "agents-funded.png");
    expect(await blockingViolations(page)).toEqual([]);
  });

  test("an agent with no credits says research is paused and safety keeps running", async ({
    page,
  }) => {
    const chain = new FakeChain();
    chain.mint(7n, MOCK_WALLET_ADDRESS, ANT);
    const api = new FakeApi(chain);
    api.dashboards.set(
      7n,
      fundedDashboard({
        runStatus: "restricted",
        credits: {
          fundingAddress: FUNDING_ADDRESS,
          creditsUsdcE6: "0",
          spendableUsdcE6: "0",
          heldUsdcE6: "0",
          restricted: true,
        },
      }),
    );
    await open(page, chain, api);
    await connect(page);
    const c = card(page, 7);
    await expect(c.getByText("Paused: no credits")).toBeVisible();
    await expect(c.getByTestId("restricted-note")).toContainText("Safety checks keep running");
    await expect(c.getByRole("button", { name: "Run Scan now" })).toBeDisabled();
    await expect(c.getByRole("button", { name: "Refund credits" })).toBeDisabled();
    await expect(c.getByTestId("scan-unavailable")).toContainText("at least 0.15 USDC");
    await capture(page, main(page), "agents-restricted.png");
    expect(await blockingViolations(page)).toEqual([]);
  });
});

test.describe("owner actions", () => {
  test("Run Scan shows its cost, then its result and the new activity entry", async ({ page }) => {
    const chain = new FakeChain();
    chain.mint(7n, MOCK_WALLET_ADDRESS, BEE);
    const api = new FakeApi(chain);
    api.dashboards.set(7n, fundedDashboard());
    await open(page, chain, api);
    await connect(page);
    const c = card(page, 7);
    await c.getByRole("button", { name: "Run Scan now" }).click();
    const dialog = page.getByRole("dialog", { name: "Run a Scan for Alpha Agent #7?" });
    await expect(dialog).toContainText("about 0.15 to 0.30 USDC");
    await capture(page, dialog, "agents-scan-dialog.png");
    await dialog.getByRole("button", { name: "Run Scan" }).click();
    await expect(c.getByTestId("scan-result")).toContainText("Scan requested");
    await expect(c.getByTestId("scan-status")).toHaveText("Last Scan completed at 17:02 UTC.", {
      timeout: 15_000,
    });
    await expect(c.getByRole("list", { name: "Activity entries of Alpha Agent #7" })).toContainText(
      "flagged WMON at 60% confidence",
      { timeout: 15_000 },
    );
  });

  test("a refund is confirmed against the ownership epoch and reports what came back", async ({
    page,
  }) => {
    const chain = new FakeChain();
    chain.mint(7n, MOCK_WALLET_ADDRESS, BEE);
    const api = new FakeApi(chain);
    api.dashboards.set(7n, fundedDashboard());
    await open(page, chain, api);
    await connect(page);
    const c = card(page, 7);
    await c.getByRole("button", { name: "Refund credits" }).click();
    const dialog = page.getByRole("dialog", { name: "Refund Alpha Agent #7's credits?" });
    await expect(dialog).toContainText("4.9944 USDC of credits and 2 USDC held above the cap");
    await expect(dialog).toContainText("epoch 0");
    await capture(page, dialog, "agents-refund-dialog.png");
    await dialog.getByRole("button", { name: "Refund" }).click();
    await expect(c.getByTestId("refund-result")).toHaveText(
      "Refunded 6.9944 USDC to your wallet.",
      {
        timeout: 15_000,
      },
    );
    await expect(c.getByText("Paused: no credits")).toBeVisible({ timeout: 15_000 });
  });

  test("a refused action says why", async ({ page }) => {
    const chain = new FakeChain();
    chain.mint(7n, MOCK_WALLET_ADDRESS, BEE);
    const api = new FakeApi(chain);
    // Enough on the card to offer a Scan, but the API finds too little when asked.
    api.dashboards.set(7n, fundedDashboard());
    await open(page, chain, api);
    await connect(page);
    const c = card(page, 7);
    await expect(c.getByText("Ready", { exact: true })).toBeVisible();
    const d = api.dashboards.get(7n);
    if (d?.credits) d.credits.spendableUsdcE6 = "10";
    await c.getByRole("button", { name: "Run Scan now" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Run Scan" }).click();
    await expect(c.getByTestId("scan-result")).toHaveText(
      "A Scan needs at least 0.15 USDC of credits. Add USDC to the funding address.",
    );
    await expect(c.getByTestId("scan-result")).toHaveAttribute("data-action-state", "error");
  });
});

test.describe("owner only", () => {
  test("another wallet sees none of an owner's agents, and makes no owner request", async ({
    page,
  }) => {
    const chain = new FakeChain();
    chain.mint(7n, MOCK_WALLET_ADDRESS, BEE);
    const api = new FakeApi(chain);
    api.dashboards.set(7n, fundedDashboard());
    await open(page, chain, api);
    await connect(page);
    await expect(card(page, 7)).toBeVisible();

    await page.evaluate((address) => window.__mockWallet?.setAccount(address), OTHER_WALLET);
    await expect(walletButton(page)).toHaveAttribute("data-state", "logged-out");
    await expect(card(page, 7)).toHaveCount(0);
    await connect(page);
    await expect(main(page).getByText("No agents in this wallet yet")).toBeVisible();
    await expect(card(page, 7)).toHaveCount(0);
    await expect(main(page)).not.toContainText(FUNDING_ADDRESS.slice(0, 6));
    const before = api.ownerCalls.length;
    await page.waitForTimeout(6_000);
    expect(api.ownerCalls.slice(before)).toEqual([]);
  });

  test("an agent that changes hands stops showing its owner's data", async ({ page }) => {
    const chain = new FakeChain();
    chain.mint(7n, MOCK_WALLET_ADDRESS, BEE);
    const api = new FakeApi(chain);
    api.dashboards.set(7n, fundedDashboard());
    await open(page, chain, api);
    await connect(page);
    await expect(card(page, 7).getByText("Ready", { exact: true })).toBeVisible();
    const a = chain.agents.get(7n);
    if (a) {
      a.owner = OTHER_WALLET;
      a.ownerEpoch = 1n;
    }
    await expect(card(page, 7)).toHaveCount(0, { timeout: 15_000 });
    await expect(main(page).getByText("No agents in this wallet yet")).toBeVisible();
  });
});
