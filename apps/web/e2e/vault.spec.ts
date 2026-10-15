import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { type Locator, type Page, expect, test } from "@playwright/test";
import { MOCK_WALLET_ADDRESS } from "../src/auth/mock-wallet-constants";
import { FAKE_USDC, FakeApi, fundedDashboard } from "./fake-api";
import { FakeChain } from "./fake-chain";
import { NOW } from "./fake-trading";
import { FakeVault, type FakeVaultState, VAULT, noVaultFixture, vaultFixture } from "./fake-vault";

/**
 * The vault page (P7-U4) against the test build with the mock wallet, the fake
 * API and the fake chain, at 1440px and 380px: the owner creates the vault,
 * stakes and opens deposits; a depositor sees the vault and their locked
 * position, is warned before a top-up, deposits (an exact approval, then the
 * deposit), and once the lock has passed redeems in kind or in USDC, pointed to
 * the in-kind path when the vault's USDC cannot cover it; a wallet off the
 * allowlist is refused before anything is sent; a visitor who is not the owner
 * funds the agent's credits; the handover and the no-wallet states; every state
 * captured and scanned.
 */
const BEE = 14;
const AGENT = 7n;
const OWNER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const E18 = 10n ** 18n;

const main = (page: Page) => page.getByRole("main");
const walletButton = (page: Page) => page.locator("header [data-slot=wallet-button]");
const status = (scope: Locator) => scope.getByTestId("wallet-action-status");
const dialog = (page: Page) => page.getByRole("dialog");

function stack(state: FakeVaultState) {
  const chain = new FakeChain();
  chain.mint(AGENT, state.owner, BEE);
  chain.setBalance(FAKE_USDC, MOCK_WALLET_ADDRESS, 120_000_000n);
  const api = new FakeApi(chain);
  api.dashboards.set(AGENT, fundedDashboard());
  const vault = new FakeVault(chain, state);
  api.vaults.set(AGENT, vault);
  return { chain, api, vault };
}

/** A depositor's vault: the mock wallet is allowlisted and holds 30 shares, locked for an hour more. */
function depositorVault(over: Partial<FakeVaultState> = {}) {
  const s = vaultFixture(OWNER, over);
  s.allowlisted.add(MOCK_WALLET_ADDRESS.toLowerCase());
  if (!s.positions.has(MOCK_WALLET_ADDRESS.toLowerCase()))
    s.positions.set(MOCK_WALLET_ADDRESS.toLowerCase(), {
      shares: 30n * E18,
      unlockAt: NOW + 3_600,
    });
  return s;
}

/** UX-U1: opens a tab of the vault's left panel (about, agent, yours). */
async function tab(page: Page, id: "about" | "agent" | "yours") {
  await main(page).getByTestId("vault-about").getByTestId(`tab-${id}`).click();
}

async function open(page: Page, s: ReturnType<typeof stack>, connect = true) {
  await s.chain.install(page);
  await s.api.install(page);
  await page.goto(`/agents/${AGENT}/vault`);
  await page.evaluate(() => document.fonts.ready);
  if (!connect) return;
  // The connect prompt and the position sit in "Your performance" once a vault exists.
  await expect(
    main(page).getByTestId("vault-about").or(main(page).getByTestId("vault-create")),
  ).toBeVisible();
  if ((await main(page).getByTestId("vault-about").count()) > 0) await tab(page, "yours");
  await main(page).getByRole("button", { name: "Connect wallet" }).click();
  await page.mouse.move(0, 0);
  await expect(walletButton(page)).toHaveAttribute("data-state", "connected");
  // The connected read remounts the panel on its first tab; the position is under "yours".
  if ((await main(page).getByTestId("vault-about").count()) > 0) {
    await tab(page, "yours");
    await expect(main(page).getByTestId("vault-position")).toBeVisible();
  }
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
  // A dialog fades in; a scan during the fade reads its text through the fade's opacity (L-228).
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
  );
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

const sent = (chain: FakeChain) => chain.transactions.filter((t) => !t.reverted);

test.describe("the vault page (P7-U4)", () => {
  test("the owner creates the vault, stakes, and opens deposits", async ({ page }) => {
    const s = stack(noVaultFixture(MOCK_WALLET_ADDRESS));
    await open(page, s);
    const create = main(page).getByTestId("vault-create");
    await expect(create).toHaveAttribute("data-role", "owner");
    await expect(create).toContainText("at most 500.00 USDC during the beta");
    await expect(main(page).getByTestId("vault-fund")).toHaveCount(0);
    await capture(page, main(page), "vault-create.png");
    expect(await blockingViolations(page)).toEqual([]);
    await create.getByTestId("vault-create-submit").click();
    // The vault exists: the page turns into the vault's, the panel says deposits are not open yet
    // and the owner stakes first; the creation's status lands on the position card.
    const panel = main(page).getByTestId("vault-panel");
    await expect(panel.getByTestId("vault-deposits")).toContainText("Not open yet");
    expect(s.vault.calls).toEqual(["createVault"]);
    await tab(page, "yours");
    const position = main(page).getByTestId("vault-position");
    await expect(position).toHaveAttribute("data-state", "none");
    await expect(status(position)).toHaveAttribute("data-state", "confirmed");
    await expect(status(position)).toContainText("The vault is created");
    await main(page).getByTestId("vault-open-deposit").click();
    const d = dialog(page);
    await expect(d.getByRole("heading", { name: "Stake in the vault" })).toBeVisible();
    await expect(d.getByTestId("vault-top-up-warning")).toHaveCount(0);
    await d.getByLabel("Amount in USDC").fill("20");
    await expect(d.getByText(/you would receive about/)).toContainText("20 shares");
    await d.getByTestId("vault-deposit-submit").click();
    await expect(status(d)).toHaveAttribute("data-state", "confirmed");
    expect(s.vault.calls.slice(1)).toEqual([
      `approve vault 20000000`,
      `deposit 20000000 min ${(20n * E18).toString()}`,
    ]);
    await page.keyboard.press("Escape");
    await expect(main(page).getByTestId("vault-position")).toHaveAttribute("data-state", "locked");
    await expect(main(page).getByTestId("vault-position")).toContainText(
      "Leader: your deposits are the stake",
    );
    const tools = main(page).getByTestId("vault-leader-tools");
    await tools.getByTestId("vault-toggle-deposits").click();
    await expect(status(tools)).toHaveAttribute("data-state", "confirmed");
    await tab(page, "about");
    await expect(panel.getByTestId("vault-deposits")).toContainText(
      "Open to allowlisted wallets (beta)",
    );
    expect(s.vault.calls.at(-1)).toBe("setDepositsOpen true");
  });

  test("a depositor sees the vault, their locked position, the holdings and the performance, and is warned before a top-up", async ({
    page,
  }) => {
    const s = stack(depositorVault());
    await open(page, s);
    await tab(page, "about");
    const panel = main(page).getByTestId("vault-panel");
    await expect(panel).toHaveAttribute("data-mode", "NORMAL");
    await expect(panel.getByTestId("vault-lockup")).toContainText("1 day");
    await expect(panel.getByTestId("vault-leader-stake")).toContainText(
      "25% of the vault (at least 5% required)",
    );
    await expect(panel.getByTestId("vault-cap")).toContainText("420.00 of 500.00 USDC");
    await expect(panel).toContainText("Unaudited beta");
    await tab(page, "yours");
    const position = main(page).getByTestId("vault-position");
    await expect(position).toHaveAttribute("data-state", "locked");
    await expect(position.getByTestId("vault-lock")).toContainText("Locked until");
    await expect(position.getByTestId("vault-in-kind")).toContainText("WMON");
    await expect(main(page).getByTestId("position-row")).toHaveCount(3);
    await tab(page, "agent");
    await expect(main(page).getByTestId("vault-score-return")).toHaveAttribute(
      "data-state",
      "ready",
    );
    await expect(main(page).getByTestId("vault-fund")).toBeVisible();
    await expect(main(page).getByTestId("vault-leader-tools")).toHaveCount(0);
    await capture(page, main(page), "vault-depositor.png");
    expect(await blockingViolations(page)).toEqual([]);
    await tab(page, "yours");
    await expect(main(page).getByTestId("vault-open-withdraw")).toBeEnabled();
    await main(page).getByTestId("vault-open-deposit").click();
    const d = dialog(page);
    await expect(d.getByTestId("vault-top-up-warning")).toContainText(
      "locks all of them, old and new, for 1 day",
    );
    await d.getByLabel("Amount in USDC").fill("25");
    await expect(d.getByText(/you would receive about/)).toBeVisible();
    await capture(page, d, "vault-deposit-dialog.png");
    expect(await blockingViolations(page)).toEqual([]);
    await d.getByTestId("vault-deposit-submit").click();
    await expect(status(d)).toHaveAttribute("data-state", "confirmed");
    expect(s.vault.calls[0]).toBe("approve vault 25000000");
    expect(s.vault.calls[1]).toMatch(/^deposit 25000000 min \d+$/);
    expect(sent(s.chain).map((t) => t.to.toLowerCase())).toEqual([
      FAKE_USDC.toLowerCase(),
      VAULT.toLowerCase(),
    ]);
  });

  test("after the lock a depositor redeems in kind, and the USDC path points to the in-kind one when the vault's USDC cannot cover it", async ({
    page,
  }) => {
    const s = stack(
      depositorVault({
        usdc: 12_000_000n,
        positions: new Map([
          [OWNER.toLowerCase(), { shares: 20n * E18, unlockAt: NOW - 3_600 }],
          [MOCK_WALLET_ADDRESS.toLowerCase(), { shares: 30n * E18, unlockAt: NOW - 60 }],
        ]),
      }),
    );
    await open(page, s);
    const position = main(page).getByTestId("vault-position");
    await expect(position).toHaveAttribute("data-state", "free");
    await expect(position.getByTestId("vault-lock")).toContainText("Free to withdraw");
    await main(page).getByTestId("vault-open-withdraw").click();
    const d = dialog(page);
    await d.getByRole("button", { name: "All" }).click();
    await expect(d.getByText(/Redeem in kind instead/)).toBeVisible();
    await expect(d.getByTestId("vault-withdraw-submit")).toBeDisabled();
    await d.getByRole("radio", { name: /In kind/ }).click();
    await expect(d.getByTestId("vault-withdraw-form")).toHaveAttribute("data-method", "in_kind");
    await expect(d.getByTestId("vault-withdraw-preview")).toContainText("WMON");
    await capture(page, d, "vault-withdraw-dialog.png");
    expect(await blockingViolations(page)).toEqual([]);
    await d.getByTestId("vault-withdraw-submit").click();
    await expect(status(d)).toHaveAttribute("data-state", "confirmed");
    expect(s.vault.calls).toEqual([`redeemInKind ${(30n * E18).toString()}`]);
    await page.keyboard.press("Escape");
    await expect(main(page).getByTestId("vault-position")).toHaveAttribute("data-state", "none");
    await expect(main(page).getByTestId("vault-open-withdraw")).toBeDisabled();
  });

  test("a USDC exit pays from the vault's USDC when it can", async ({ page }) => {
    const s = stack(
      depositorVault({
        positions: new Map([
          [OWNER.toLowerCase(), { shares: 20n * E18, unlockAt: NOW - 3_600 }],
          [MOCK_WALLET_ADDRESS.toLowerCase(), { shares: 30n * E18, unlockAt: NOW - 60 }],
        ]),
      }),
    );
    await open(page, s);
    await main(page).getByTestId("vault-open-withdraw").click();
    const d = dialog(page);
    await d.getByLabel("Shares to redeem").fill("10");
    await expect(d.getByTestId("vault-withdraw-preview")).toContainText("USDC");
    await d.getByTestId("vault-withdraw-submit").click();
    await expect(status(d)).toHaveAttribute("data-state", "confirmed");
    expect(s.vault.calls[0]).toMatch(new RegExp(`^redeem ${(10n * E18).toString()} min \\d+$`));
  });

  test("a wallet off the allowlist is told before anything is sent", async ({ page }) => {
    const state = vaultFixture(OWNER);
    const s = stack(state);
    await open(page, s);
    await expect(main(page).getByTestId("vault-position")).toHaveAttribute("data-state", "none");
    await main(page).getByTestId("vault-open-deposit").click();
    const d = dialog(page);
    // UI-U1: plain words, what it means and what to do.
    await expect(d.getByTestId("vault-deposit-block")).toContainText(
      "Enabling deposits for your wallet, about a minute.",
    );
    await expect(d.getByTestId("vault-deposit-submit")).toBeDisabled();
    await capture(page, d, "vault-deposit-blocked.png");
    expect(await blockingViolations(page)).toEqual([]);
    expect(sent(s.chain)).toEqual([]);
  });

  test("someone who is not the owner funds the agent's credits, named as a contribution", async ({
    page,
  }) => {
    const s = stack(depositorVault());
    await open(page, s);
    const fund = main(page).getByTestId("fund-agent");
    await expect(fund).toContainText("contribution to Agent #7's credits");
    await expect(fund).toContainText("not a deposit into the vault and buys no shares");
    await fund.getByLabel("Amount in USDC").fill("8");
    await expect(fund).toContainText("8.00 would be credited");
    await fund.getByTestId("fund-agent-submit").click();
    await expect(status(fund)).toHaveAttribute("data-state", "confirmed");
    expect(s.api.contributions).toEqual([
      { agentId: AGENT, from: MOCK_WALLET_ADDRESS.toLowerCase(), amount: 8_000_000n },
    ]);
    await expect(main(page).getByTestId("vault-owner-credits-note")).toHaveCount(0);
  });

  test("during a handover the vault takes no deposits and says so; everyone may still leave", async ({
    page,
  }) => {
    const s = stack(depositorVault({ mode: "HANDOVER", inHandover: true, leaderShares: 0n }));
    await open(page, s);
    await tab(page, "about");
    const panel = main(page).getByTestId("vault-panel");
    await expect(panel).toHaveAttribute("data-mode", "HANDOVER");
    await expect(panel.getByTestId("vault-notice-handover")).toContainText(
      "Everyone may withdraw at any time",
    );
    await expect(panel.getByTestId("vault-deposits")).toContainText("Closed during the handover");
    await capture(page, main(page), "vault-handover.png");
    expect(await blockingViolations(page)).toEqual([]);
    await tab(page, "yours");
    await main(page).getByTestId("vault-open-deposit").click();
    await expect(dialog(page).getByTestId("vault-deposit-block")).toContainText(
      "The agent changed hands",
    );
    await expect(dialog(page).getByTestId("vault-deposit-submit")).toBeDisabled();
  });

  test("without a wallet the vault is still readable, and the position asks to connect", async ({
    page,
  }) => {
    const s = stack(vaultFixture(OWNER));
    await open(page, s, false);
    await expect(main(page).getByTestId("vault-panel")).toBeVisible();
    await expect(main(page).getByTestId("vault-panel").getByTestId("vault-value")).toContainText(
      "82.00",
    );
    await tab(page, "yours");
    await expect(
      main(page).getByText("Connect to see your own position and to deposit or withdraw."),
    ).toBeVisible();
    await expect(main(page).getByTestId("vault-fund")).toHaveCount(0);
    await capture(page, main(page), "vault-visitor.png");
    expect(await blockingViolations(page)).toEqual([]);
  });
});
