import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { type Locator, type Page, expect, test } from "@playwright/test";
import { decodeFunctionData, getAddress, parseAbi } from "viem";
import { MOCK_WALLET_ADDRESS } from "../src/auth/mock-wallet-constants";
import { FakeApi, fundedDashboard } from "./fake-api";
import { FakeChain } from "./fake-chain";
import { FakeHoldings } from "./fake-holdings";
import { ACCOUNT, FakeTrading, portfolioFixture } from "./fake-trading";

/**
 * All holdings (D-315) on My Agents and the portfolio, against the test build
 * with the mock wallet, the fake API and the fake chain, at 1440px and 380px:
 * every address named, the MON the owner sent to the agent's own account
 * shown as unused and moved to the wallet by the owner's signed call, a
 * declined request, and nothing for another wallet.
 */
const AGENT = 7n;
const BEE = 14;
const FUNDING = "0x45BB3eC560c7A19bbedad9cB42051401Ecc30d7B" as const;
const TBA = "0x487ff500699226631e477F54eaeF41537a5eccAA" as const;
const OTHER_WALLET = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const TBA_ABI = parseAbi([
  "function execute(address to, uint256 value, bytes data, uint8 operation) payable returns (bytes)",
]);

const main = (page: Page) => page.getByRole("main");
const walletButton = (page: Page) => page.locator("header [data-slot=wallet-button]");
const panel = (page: Page) => main(page).getByTestId("holdings-panel");

/** Agent 7 with what agent 2 held on testnet: 3 MON and 5 USDC in its own account. */
function stack(owner: `0x${string}` = MOCK_WALLET_ADDRESS) {
  const chain = new FakeChain();
  chain.mint(AGENT, owner, BEE);
  const api = new FakeApi(chain);
  api.dashboards.set(AGENT, fundedDashboard());
  api.trading.set(AGENT, new FakeTrading(chain, owner, portfolioFixture(owner)));
  const holdings = new FakeHoldings(owner, [
    { role: "funding", address: FUNDING, balances: { MON: 5n * 10n ** 17n, USDC: 10_000_000n } },
    { role: "token_bound", address: TBA, balances: { MON: 3n * 10n ** 18n, USDC: 5_000_000n } },
    { role: "personal_account", address: ACCOUNT, balances: { USDC: 5_000_000n } },
  ]);
  api.holdings.set(AGENT, holdings);
  chain.onSend = (tx) => holdings.onSend(tx);
  return { chain, api, holdings };
}

async function open(page: Page, s: ReturnType<typeof stack>, path: string) {
  await s.chain.install(page);
  await s.api.install(page);
  await page.goto(path);
  await page.evaluate(() => document.fonts.ready);
  await main(page).getByRole("button", { name: "Connect wallet" }).click();
  await page.mouse.move(0, 0);
  await expect(walletButton(page)).toHaveAttribute("data-state", "connected");
}

/** No hover, every image loaded and a full repaint (L-44, L-65), then the capture. */
async function capture(page: Page, target: Locator, name: string) {
  await target.scrollIntoViewIfNeeded();
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
    .include("[data-testid=holdings-panel]")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

test("My Agents shows every address of the agent, with the MON in its own account as unused", async ({
  page,
}) => {
  const s = stack();
  await open(page, s, "/agents");
  const tba = panel(page).getByTestId("holdings-token_bound");
  await expect(tba.getByRole("heading", { name: "The agent's own account" })).toBeVisible();
  await expect(tba.getByRole("list", { name: "The agent's own account balances" })).toContainText(
    /3\s*MON/,
  );
  await expect(
    tba.getByText("Does nothing here. You can move it to your wallet.").first(),
  ).toBeVisible();
  await expect(panel(page).getByTestId("holdings-funding")).toContainText("Gas");
  await expect(panel(page).getByTestId("holdings-funding")).toContainText("Credits");
  await expect(panel(page).getByTestId("holdings-personal_account")).toContainText("Trading");
  await capture(page, panel(page), "holdings-agents.png");
  expect(await blockingViolations(page)).toEqual([]);
});

test("the portfolio shows All holdings, and the owner moves the MON to their wallet", async ({
  page,
}) => {
  const s = stack();
  await open(page, s, `/agents/${AGENT}/portfolio`);
  await expect(panel(page)).toBeVisible();
  await capture(page, panel(page), "holdings-portfolio.png");
  expect(await blockingViolations(page)).toEqual([]);
  const tba = panel(page).getByTestId("holdings-token_bound");
  await tba.getByRole("button", { name: "Move MON to my wallet" }).click();
  await expect(tba.getByTestId("wallet-action-status")).toContainText("Moved MON to your wallet.", {
    timeout: 15_000,
  });
  // The call sent was the account's execute, from the owner, paying 3 MON to the owner.
  const sent = s.chain.transactions.filter(
    (t) => !t.reverted && t.to.toLowerCase() === TBA.toLowerCase(),
  );
  expect(sent).toHaveLength(1);
  const decoded = decodeFunctionData({ abi: TBA_ABI, data: sent[0]?.data ?? "0x" });
  expect(decoded.args).toEqual([getAddress(MOCK_WALLET_ADDRESS), 3n * 10n ** 18n, "0x", 0]);
  expect(s.holdings.moved).toEqual(["token_bound MON"]);
  // The re-read no longer lists the MON; the USDC is still there to move.
  await expect(tba.getByRole("button", { name: "Move MON to my wallet" })).toHaveCount(0, {
    timeout: 20_000,
  });
  await expect(tba.getByRole("button", { name: "Move USDC to my wallet" })).toBeVisible();
});

test("a move declined in the wallet says so, sends nothing, and can be tried again", async ({
  page,
}) => {
  const s = stack();
  await open(page, s, `/agents/${AGENT}/portfolio`);
  const tba = panel(page).getByTestId("holdings-token_bound");
  await page.evaluate(() => window.__mockWallet?.rejectNextWrite());
  await tba.getByRole("button", { name: "Move USDC to my wallet" }).click();
  const line = tba.getByTestId("wallet-action-status");
  await expect(line).toHaveAttribute("data-state", "rejected");
  await expect(line).toContainText("declined");
  expect(s.chain.transactions.filter((t) => t.to.toLowerCase() === TBA.toLowerCase())).toEqual([]);
  await expect(tba.getByRole("button", { name: "Move USDC to my wallet" })).toBeEnabled();
  await capture(page, tba, "holdings-declined.png");
});

test("another wallet sees none of the agent's holdings", async ({ page }) => {
  const s = stack(OTHER_WALLET);
  await open(page, s, `/agents/${AGENT}/portfolio`);
  await expect(main(page).getByText("Could not read this portfolio")).toBeVisible({
    timeout: 15_000,
  });
  await expect(panel(page)).toHaveCount(0);
  await expect(main(page).getByText("3 MON")).toHaveCount(0);
  // No holdings were answered to another wallet.
  expect(s.api.ownerCalls.filter((c) => c.startsWith("holdings"))).toEqual([]);
});
