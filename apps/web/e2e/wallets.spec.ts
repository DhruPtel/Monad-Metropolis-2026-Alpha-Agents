import { type Page, expect, test } from "@playwright/test";
import { FakeApi } from "./fake-api";
import { FakeChain } from "./fake-chain";

/**
 * Wallet choice and account changes (wallet reliability task, D-224), against
 * the test build with both mock wallets installed at once: MetaMask and OKX
 * Wallet each announce themselves with EIP-6963, and OKX also holds
 * window.ethereum, the way the extensions behave when both are installed. Each
 * mock logs the requests it receives, so a test proves which wallet the app
 * used; the unchosen one must receive none.
 */
const OTHER_WALLET = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const SHORT_DEFAULT = "0x0000…2e01";
const SHORT_OTHER = "0x3C44…93BC";
const TARGET = "Monad (local fork)";

const walletButton = (page: Page) => page.locator("header [data-slot=wallet-button]");
const walletName = (page: Page) => walletButton(page).locator("[data-slot=wallet-name]");
const panel = (page: Page) => page.locator("[data-slot=mint-panel]");

async function open(page: Page, path = "/mint", chain = new FakeChain(), api = new FakeApi(chain)) {
  await chain.install(page);
  await api.install(page);
  await page.goto(path);
  await page.evaluate(() => document.fonts.ready);
  await expect(walletButton(page)).toHaveAttribute("data-state", "logged-out");
  return { chain, api };
}

/** Logs in with the given wallet, as choosing it in the login window does. */
async function login(page: Page, wallet: "metamask" | "okx") {
  await page.evaluate((w) => window.__mockWallet?.chooseOnConnect(w), wallet);
  await walletButton(page)
    .getByRole("button", { name: /connect/i })
    .click();
  await expect(walletButton(page)).toHaveAttribute("data-state", "connected");
}

const requestsOf = (page: Page, wallet: "metamask" | "okx") =>
  page.evaluate((w) => [...(window.__mockWallets?.[w].requests ?? [])], wallet);

test("both wallets announce themselves, and OKX holds window.ethereum", async ({ page }) => {
  await open(page, "/");
  const seen = await page.evaluate(
    () =>
      new Promise<{ names: string[]; okxIsDefault: boolean }>((resolve) => {
        const names: string[] = [];
        window.addEventListener("eip6963:announceProvider", (e) => {
          names.push((e as CustomEvent<{ info: { name: string } }>).detail.info.name);
        });
        window.dispatchEvent(new Event("eip6963:requestProvider"));
        resolve({
          names,
          okxIsDefault: window.ethereum === window.__mockWallets?.okx.provider,
        });
      }),
  );
  expect(seen.names.sort()).toEqual(["MetaMask", "OKX Wallet"]);
  expect(seen.okxIsDefault).toBe(true);
});

for (const [wallet, name] of [
  ["metamask", "MetaMask"],
  ["okx", "OKX Wallet"],
] as const) {
  test(`login with ${name} uses ${name} only, and the button names it`, async ({ page }) => {
    await open(page, "/");
    await login(page, wallet);
    await expect(walletName(page)).toHaveText(name);
    await expect(walletButton(page).getByText(SHORT_DEFAULT)).toBeVisible();
    const other = wallet === "okx" ? "metamask" : "okx";
    expect(await requestsOf(page, wallet)).toContain("eth_requestAccounts");
    expect(await requestsOf(page, other)).toEqual([]);
  });
}

test("the login outlives a reload, with the same wallet", async ({ page }) => {
  await open(page, "/");
  await login(page, "okx");
  await page.reload();
  await expect(walletButton(page)).toHaveAttribute("data-state", "connected");
  await expect(walletName(page)).toHaveText("OKX Wallet");
  expect(await requestsOf(page, "metamask")).toEqual([]);
});

test("minting goes through the chosen wallet only, even when the other holds window.ethereum", async ({
  page,
}) => {
  await open(page);
  await login(page, "metamask");
  await expect(panel(page)).toHaveAttribute("data-state", "ready");
  await panel(page).getByRole("button", { name: "Mint an agent" }).click();
  await expect(panel(page).getByRole("status")).toContainText("Agent #1 minted", {
    timeout: 15_000,
  });
  expect(await requestsOf(page, "metamask")).toContain("eth_sendTransaction");
  expect(await requestsOf(page, "okx")).toEqual([]);
});

test("minting with OKX goes through OKX", async ({ page }) => {
  await open(page);
  await login(page, "okx");
  await panel(page).getByRole("button", { name: "Mint an agent" }).click();
  await expect(panel(page).getByRole("status")).toContainText("Agent #1 minted", {
    timeout: 15_000,
  });
  expect(await requestsOf(page, "okx")).toContain("eth_sendTransaction");
  expect(await requestsOf(page, "metamask")).toEqual([]);
});

test("an account switch mid-session ends the session at once and never uses the old session", async ({
  page,
}) => {
  const { api } = await open(page);
  await login(page, "metamask");
  await expect(panel(page)).toHaveAttribute("data-state", "ready");

  await page.evaluate((a) => window.__mockWallet?.setAccount(a), OTHER_WALLET);
  await expect(walletButton(page)).toHaveAttribute("data-state", "logged-out");
  await expect(page.getByText(/MetaMask switched to 0x3C44\.\.\.93BC/)).toBeVisible();
  // The owner's bug: the mint page read the new wallet with the old session and showed "Could not read".
  await expect(panel(page)).toHaveAttribute("data-state", "logged-out");
  await expect(panel(page).getByText("Connect your wallet to mint")).toBeVisible();

  await login(page, "metamask");
  await expect(walletButton(page).getByText(SHORT_OTHER)).toBeVisible();
  await expect(panel(page)).toHaveAttribute("data-state", "ready");
  expect(api.notLinked).toEqual([]);
});

test("switching wallets: log out of MetaMask, log in with OKX on another account", async ({
  page,
}) => {
  const { api } = await open(page);
  await login(page, "metamask");
  await expect(walletName(page)).toHaveText("MetaMask");
  await walletButton(page).getByRole("button", { name: "Disconnect" }).click();
  await expect(walletButton(page)).toHaveAttribute("data-state", "logged-out");

  await page.evaluate((a) => window.__mockWallets?.okx.setAccount(a), OTHER_WALLET);
  await login(page, "okx");
  await expect(walletName(page)).toHaveText("OKX Wallet");
  await expect(walletButton(page).getByText(SHORT_OTHER)).toBeVisible();
  await expect(panel(page)).toHaveAttribute("data-state", "ready");
  expect(api.notLinked).toEqual([]);
});

test("disconnect and reconnect", async ({ page }) => {
  await open(page);
  await login(page, "okx");
  await walletButton(page).getByRole("button", { name: "Disconnect" }).click();
  await expect(walletButton(page)).toHaveAttribute("data-state", "logged-out");
  await expect(panel(page).getByText("Connect your wallet to mint")).toBeVisible();
  await login(page, "okx");
  await expect(panel(page)).toHaveAttribute("data-state", "ready");
  await expect(walletButton(page).getByText(SHORT_DEFAULT)).toBeVisible();
});

test("a wallet that is locked mid-session ends the session and says why", async ({ page }) => {
  await open(page, "/");
  await login(page, "metamask");
  await page.evaluate(() => window.__mockWallets?.metamask.lock());
  await expect(walletButton(page)).toHaveAttribute("data-state", "logged-out");
  await expect(page.getByText(/MetaMask stopped sharing an account/)).toBeVisible();
});

test("a connect that waits on the wallet says so and can be cancelled", async ({ page }) => {
  await open(page, "/");
  await page.evaluate(() => window.__mockWallet?.stallNextLogin());
  await walletButton(page)
    .getByRole("button", { name: /connect/i })
    .click();
  await expect(walletButton(page)).toHaveAttribute("data-state", "connecting");
  const notice = page.locator("[data-slot=wallet-notice]");
  await expect(notice).toContainText("Finish the login in your wallet's window.");
  await walletButton(page).getByRole("button", { name: "Cancel" }).click();
  await expect(walletButton(page)).toHaveAttribute("data-state", "logged-out");
  await expect(notice).toHaveCount(0);
  // And the next connect works.
  await login(page, "metamask");
});

test("when OKX refuses to add the local fork, the manual setup steps show", async ({ page }) => {
  await open(page, "/");
  await login(page, "okx");
  await page.evaluate(() => {
    window.__mockWallet?.setSwitchBehavior("refuse-add");
    window.__mockWallet?.setChainId(10143);
  });
  const prompt = page.getByRole("alert").filter({ hasText: `Switch to ${TARGET}` });
  await prompt.getByRole("button", { name: `Switch to ${TARGET}` }).click();
  await expect(prompt.getByRole("status")).toContainText(
    `Add it by hand in your wallet: network name ${TARGET}, RPC URL http://127.0.0.1:8545, chain ID 143143, currency MON.`,
  );
  expect(await requestsOf(page, "okx")).toContain("wallet_addEthereumChain");
  expect(await requestsOf(page, "metamask")).toEqual([]);
});
