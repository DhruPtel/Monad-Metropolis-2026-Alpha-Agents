import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { type Locator, type Page, expect, test } from "@playwright/test";
import { MOCK_WALLET_ADDRESS } from "../src/auth/mock-wallet-constants";
import { FakeApi, fundedDashboard } from "./fake-api";
import { FakeChain } from "./fake-chain";
import { FakeKeys } from "./fake-keys";

/**
 * The owner's settings page (BK-U1), at 1440px and 380px with an
 * accessibility scan on every captured state: the Dune tile without a key,
 * adding a key in the dialog (the key goes to the API once and is never shown
 * again, the input empties, the tile shows the hint), removing it, another
 * owner's wallet, and the page without a wallet.
 */
const BEE = 14;
const AGENT = 7n;
const OTHER_WALLET = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const KEY = "dune-key-not-real-abcdefghijklmnop";

const main = (page: Page) => page.getByRole("main");
const walletButton = (page: Page) => page.locator("header [data-slot=wallet-button]");

function stack(owner: string = MOCK_WALLET_ADDRESS) {
  const chain = new FakeChain();
  chain.mint(AGENT, owner as `0x${string}`, BEE);
  const api = new FakeApi(chain);
  api.dashboards.set(AGENT, fundedDashboard());
  const keys = new FakeKeys();
  api.keys.set(AGENT, keys);
  return { chain, api, keys };
}

async function open(page: Page, s: ReturnType<typeof stack>, connect = true) {
  await s.chain.install(page);
  await s.api.install(page);
  await page.goto(`/agents/${AGENT}/settings`);
  await page.evaluate(() => document.fonts.ready);
  if (!connect) return;
  await main(page).getByRole("button", { name: "Connect wallet" }).click();
  await page.mouse.move(0, 0);
  await expect(walletButton(page)).toHaveAttribute("data-state", "connected");
}

async function settle(page: Page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => document.querySelector("button:hover, a:hover") === null);
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  await page.evaluate(async () => {
    const frames = () =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    document.documentElement.style.opacity = "0.99";
    await frames();
    document.documentElement.style.opacity = "";
    await frames();
  });
}

async function capture(page: Page, target: Locator, name: string) {
  await settle(page);
  await expect(target).toHaveScreenshot(name, {
    stylePath: fileURLToPath(new URL("./portal-capture.css", import.meta.url)),
    timeout: 30_000,
  });
}

async function blockingViolations(page: Page) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

test.describe("the owner's data keys (BK-U1)", () => {
  test("adds a Dune key in the dialog: the key goes to the platform once, the input empties and the tile shows the hint alone", async ({
    page,
  }) => {
    const s = stack();
    await open(page, s);
    const root = main(page).getByTestId("settings");
    const card = root.locator('[data-testid=data-key-card][data-provider="dune"]');
    await expect(card).toHaveAttribute("data-present", "false");
    await expect(card).toContainText("No key");
    await capture(page, root, "settings-no-key.png");
    expect(await blockingViolations(page)).toEqual([]);
    await card.getByTestId("add-key").click();
    const dialog = page.getByRole("dialog", { name: "Add your Dune key" });
    await expect(dialog).toContainText("Create an API key in your Dune account settings");
    const input = dialog.getByTestId("data-key-input");
    await expect(input).toHaveAttribute("type", "password");
    await input.fill("short");
    await expect(dialog.getByTestId("data-key-form")).toContainText("too short");
    await expect(dialog.getByTestId("data-key-save")).toBeEnabled();
    await input.fill(KEY);
    await expect(dialog.getByTestId("data-key-form")).not.toContainText("too short");
    await capture(page, dialog, "settings-add-key.png");
    expect(await blockingViolations(page)).toEqual([]);
    await dialog.getByTestId("data-key-save").click();
    await expect(dialog.getByTestId("wallet-action-status")).toContainText("Saved as ••••mnop", {
      timeout: 15_000,
    });
    await expect(input).toHaveValue("");
    expect(s.keys.saved).toEqual([{ provider: "dune", key: KEY }]);
    await dialog.getByTestId("key-done").click();
    await expect(dialog).toHaveCount(0);
    await expect(card).toHaveAttribute("data-present", "true", { timeout: 15_000 });
    await expect(card.getByTestId("data-key-hint")).toHaveText("••••mnop");
    await expect(card).toContainText("2026-10-12 09:00 UTC");
    // Nothing of the key is in the page once it is saved.
    expect(await root.textContent()).not.toContain(KEY);
    expect(await root.textContent()).not.toContain("abcdefghijkl");
    await capture(page, root, "settings-with-key.png");
    expect(await blockingViolations(page)).toEqual([]);
  });

  test("removes the key with one question, and says the source is not configured from the next call", async ({
    page,
  }) => {
    const s = stack();
    s.keys.present.set("dune", { hint: "••••mnop", addedAt: "2026-10-12T09:00:00.000Z" });
    await open(page, s);
    const root = main(page).getByTestId("settings");
    const card = root.locator('[data-testid=data-key-card][data-provider="dune"]');
    await expect(card).toHaveAttribute("data-present", "true");
    await card.getByTestId("remove-key").click();
    const confirm = page.getByRole("dialog", { name: "Remove your Dune key?" });
    await expect(confirm).toContainText("Nothing of it stays");
    await capture(page, confirm, "settings-remove-key.png");
    expect(await blockingViolations(page)).toEqual([]);
    await confirm.getByTestId("confirm-remove-key").click();
    await expect(card).toHaveAttribute("data-present", "false", { timeout: 15_000 });
    await expect(root.getByTestId("wallet-action-status")).toContainText(
      "Removed. Nothing of the key stays",
    );
    expect(s.keys.removals).toEqual(["dune"]);
  });

  test("shows another owner's wallet nothing, and asks for the wallet when none is connected", async ({
    page,
  }) => {
    const s = stack(OTHER_WALLET);
    s.keys.present.set("dune", { hint: "••••mnop", addedAt: "2026-10-12T09:00:00.000Z" });
    await open(page, s);
    const root = main(page).getByTestId("settings");
    await expect(root).toContainText("Could not read the settings");
    await expect(root.getByTestId("data-key-card")).toHaveCount(0);
    expect(s.api.ownerCalls.filter((c) => c.startsWith("keys"))).toEqual([]);
    expect(await blockingViolations(page)).toEqual([]);
  });

  test("asks for the owner's wallet when none is connected, and asks the API nothing", async ({
    page,
  }) => {
    const t = stack();
    await open(page, t, false);
    await expect(main(page).getByTestId("settings")).toContainText("Connect the owner's wallet");
    expect(t.api.ownerCalls).toEqual([]);
  });
});
