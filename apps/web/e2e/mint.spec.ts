import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { SPECIES } from "@alpha-agents/domain";
import { type Locator, type Page, expect, test } from "@playwright/test";
import { MOCK_WALLET_ADDRESS } from "../src/auth/mock-wallet-constants";
import { AGENT_NFT, FakeChain } from "./fake-chain";

/**
 * The mint page (P1-U10), against the test build with the mock wallet, in the
 * pinned image at 1440px and 380px. FakeChain answers AgentNFT's reads and
 * takes the mock wallet's mint; the live suite mints on the real fork.
 */
const ANT = 3;
const BEE = 14;

const mintPage = (page: Page) => page.getByTestId("mint-page");
const panel = (page: Page) => page.locator("[data-slot=mint-panel]");
const walletButton = (page: Page) => page.locator("header [data-slot=wallet-button]");
const tierCard = (page: Page, name: string) =>
  mintPage(page).getByRole("region", { name: `${name} tier` });

async function open(page: Page, chain: FakeChain) {
  await chain.install(page);
  await page.goto("/mint");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByTestId("tier-odds")).toHaveCount(3);
}

async function connect(page: Page) {
  await panel(page).getByRole("button", { name: "Connect wallet" }).click();
  await page.mouse.move(0, 0);
  await expect(walletButton(page)).toHaveAttribute("data-state", "connected");
}

/** A claim the claim route would sign; the fake chain does not check it. */
async function fakeClaim(page: Page) {
  await page.route("**/api/mint-claim", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        wallet: MOCK_WALLET_ADDRESS,
        nonce: `0x${"ab".repeat(32)}`,
        deadline: "4102444800",
        signature: `0x${"cd".repeat(65)}`,
        contract: AGENT_NFT,
      }),
    }),
  );
}

/** Scrolls to the top, parks the pointer, waits for no hover and every image, and captures with the header hidden. */
async function capture(page: Page, target: Locator, name: string) {
  // The same scroll offset every time: an earlier, taller state can leave the
  // page scrolled, and edges then rasterize differently (L-44).
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => document.querySelector("button:hover, a:hover") === null);
  await page.waitForFunction(() =>
    [...document.images].every((img) => img.complete && img.naturalWidth > 0),
  );
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

/** The deck with the given species drawn once each. */
function deckWithout(...drawn: number[]): number[] {
  const deck = SPECIES.map((s) => s.count);
  for (const s of drawn) deck[s - 1] = (deck[s - 1] ?? 0) - 1;
  return deck;
}

test.describe("states, screenshots and accessibility", () => {
  test("logged out: the whole page, with the tiers, asks for the wallet", async ({ page }) => {
    const chain = new FakeChain();
    chain.mint(1n, "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", BEE);
    await open(page, chain);
    await expect(panel(page)).toHaveAttribute("data-state", "logged-out");
    await expect(panel(page).getByText("Connect your wallet to mint")).toBeVisible();
    await capture(page, mintPage(page), "mint-logged-out.png");
    expect(await blockingViolations(page)).toEqual([]);
  });

  test("ready: the mint button, with the supply read from the chain", async ({ page }) => {
    const chain = new FakeChain();
    chain.mint(1n, "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", BEE);
    await open(page, chain);
    await connect(page);
    await expect(panel(page)).toHaveAttribute("data-state", "ready");
    await expect(panel(page).getByRole("button", { name: "Mint an agent" })).toBeEnabled();
    await capture(page, mintPage(page), "mint-ready.png");
    expect(await blockingViolations(page)).toEqual([]);
  });

  test("wrong network: the page is inert and the panel says to switch", async ({ page }) => {
    await open(page, new FakeChain());
    await connect(page);
    await page.evaluate(() => window.__mockWallet?.setChainId(1));
    await expect(walletButton(page)).toHaveAttribute("data-state", "wrong-chain");
    await expect(panel(page)).toHaveAttribute("data-state", "wrong-network");
    await expect(panel(page)).toContainText("Your wallet is on Ethereum.");
    await expect(panel(page).getByRole("button")).toHaveCount(0);
    await capture(page, panel(page), "mint-wrong-network.png");
    expect(await blockingViolations(page)).toEqual([]);
  });

  test("no claim available: the claim route's reason is shown", async ({ page }) => {
    // The pinned image has no claim signer, so the route refuses with its reason.
    await open(page, new FakeChain());
    await connect(page);
    await panel(page).getByRole("button", { name: "Mint an agent" }).click();
    await expect(panel(page).getByRole("button", { name: "Mint unavailable" })).toBeDisabled();
    await expect(panel(page).getByRole("status")).toContainText(
      "Minting is not configured: set LOCAL_CLAIM_SIGNER_PRIVATE_KEY",
    );
    await capture(page, panel(page), "mint-no-claim.png");
    expect(await blockingViolations(page)).toEqual([]);
  });

  test("minting, then waiting for reveal, then revealed", async ({ page }) => {
    const chain = new FakeChain();
    chain.holdReceipts = true;
    await fakeClaim(page);
    await open(page, chain);
    await connect(page);
    await panel(page).getByRole("button", { name: "Mint an agent" }).click();
    await page.mouse.move(0, 0);

    await expect(panel(page).getByRole("button", { name: "Minting" })).toBeVisible();
    await expect(panel(page).getByRole("status")).toContainText(
      "Waiting for the transaction to confirm",
    );
    await capture(page, panel(page), "mint-minting.png");
    expect(await blockingViolations(page)).toEqual([]);

    chain.holdReceipts = false;
    await expect(panel(page)).toHaveAttribute("data-state", "awaiting-reveal");
    await expect(panel(page).getByRole("status")).toContainText("Agent #1 minted");
    await expect(panel(page).getByRole("img", { name: "Unrevealed agent" })).toBeVisible();
    await expect(panel(page).getByRole("link", { name: "Open agent #1" })).toHaveAttribute(
      "href",
      "/configure?agent=1",
    );
    // The supply follows the mint: one minted, waiting for its reveal.
    const supply = mintPage(page).getByRole("region", { name: "Supply" });
    await expect(supply.getByRole("meter", { name: "Minted" })).toHaveAttribute(
      "aria-valuetext",
      "1 of 1,000",
    );
    await capture(page, panel(page), "mint-awaiting-reveal.png");
    expect(await blockingViolations(page)).toEqual([]);

    const agent = chain.agents.get(1n);
    if (!agent) throw new Error("the mint did not reach the fake chain");
    agent.species = ANT;
    await expect(panel(page)).toHaveAttribute("data-state", "revealed", { timeout: 15_000 });
    await expect(panel(page).getByRole("status")).toContainText("Agent #1 is Base · Ant");
    await expect(panel(page).getByRole("img", { name: "Ant agent" })).toBeVisible();
    await capture(page, panel(page), "mint-revealed.png");
    expect(await blockingViolations(page)).toEqual([]);
  });

  test("already minted: the wallet's agent and its link, and no mint", async ({ page }) => {
    const chain = new FakeChain();
    chain.mint(7n, MOCK_WALLET_ADDRESS, BEE);
    await open(page, chain);
    await connect(page);
    await expect(panel(page)).toHaveAttribute("data-state", "already-minted");
    await expect(panel(page).getByText("This wallet has minted its agent")).toBeVisible();
    await expect(panel(page).getByRole("img", { name: "Bee agent" })).toBeVisible();
    await expect(panel(page).getByRole("button", { name: /Mint/ })).toHaveCount(0);
    await capture(page, panel(page), "mint-already-minted.png");
    expect(await blockingViolations(page)).toEqual([]);
  });

  test("sold out: no mint, no odds, every tier sold out", async ({ page }) => {
    const chain = new FakeChain();
    chain.setSupply(
      1000,
      SPECIES.map(() => 0),
    );
    await open(page, chain);
    // Sold out, the panel offers no connect button: connect from the header.
    await expect(panel(page)).toHaveAttribute("data-state", "sold-out");
    await walletButton(page)
      .getByRole("button", { name: /Connect/ })
      .click();
    await page.mouse.move(0, 0);
    await expect(walletButton(page)).toHaveAttribute("data-state", "connected");
    await expect(panel(page)).toHaveAttribute("data-state", "sold-out");
    await expect(panel(page)).toContainText("All 1,000 agents are minted.");
    await expect(page.getByTestId("tier-odds")).toHaveText(["None left", "None left", "None left"]);
    await capture(page, mintPage(page), "mint-sold-out.png");
    expect(await blockingViolations(page)).toEqual([]);
  });
});

test.describe("supply and odds", () => {
  test("the cards show the contract's remaining counts and the odds they give", async ({
    page,
  }) => {
    const chain = new FakeChain();
    // Bee and an ant revealed, one more agent minted and waiting.
    chain.setSupply(3, deckWithout(BEE, ANT));
    await open(page, chain);
    const supply = mintPage(page).getByRole("region", { name: "Supply" });
    await expect(supply.getByRole("meter", { name: "Minted" })).toHaveAttribute(
      "aria-valuetext",
      "3 of 1,000",
    );
    await expect(supply).toContainText("Left to mint997");
    await expect(supply).toContainText("Waiting for reveal1");
    const meter = (name: string) =>
      tierCard(page, name).getByRole("meter", { name: /Remaining of/ });
    await expect(meter("Base")).toHaveAttribute("aria-valuetext", "599 of 600");
    await expect(meter("Medium")).toHaveAttribute("aria-valuetext", "300 of 300");
    await expect(meter("Pro")).toHaveAttribute("aria-valuetext", "99 of 100");
    // 599, 300 and 99 of 998 slots left.
    await expect(page.getByTestId("tier-odds")).toHaveText(["60.0%", "30.1%", "9.9%"]);

    const pro = tierCard(page, "Pro").getByRole("list", { name: "Pro species" });
    const oneOfOnes = pro.locator("li[data-one-of-one]");
    await expect(oneOfOnes).toHaveCount(4);
    await expect(oneOfOnes.filter({ hasText: /^Bee/ })).toContainText("Drawn");
    await expect(oneOfOnes.filter({ hasText: "Praying mantis" })).toContainText("Not drawn yet");
    await expect(tierCard(page, "Base")).toContainText("119 of 120 left");
  });

  test("a sold-out tier reads 0% and the others share the rest", async ({ page }) => {
    const chain = new FakeChain();
    const deck = SPECIES.map((s) => (s.tier === "pro" ? 0 : s.count));
    chain.setSupply(100, deck);
    await open(page, chain);
    await expect(tierCard(page, "Pro")).toContainText("Sold out");
    await expect(tierCard(page, "Base")).not.toContainText("Sold out");
    await expect(page.getByTestId("tier-odds")).toHaveText(["66.7%", "33.3%", "0%"]);
  });
});

test.describe("network guard", () => {
  test("a wallet on another node is stopped before the claim (L-53)", async ({ page }) => {
    const elsewhere = new FakeChain({ head: 110_830_344n, hashSeed: "aa", agentNft: false });
    await elsewhere.install(page, "9545");
    let claimRequests = 0;
    page.on("request", (r) => {
      if (r.url().includes("/api/mint-claim")) claimRequests++;
    });
    await open(page, new FakeChain());
    await connect(page);
    await page.evaluate(() => window.__mockWallet?.setRpcUrl("http://127.0.0.1:9545"));
    await panel(page).getByRole("button", { name: "Mint an agent" }).click();
    const status = panel(page).getByRole("status");
    await expect(status).toContainText("is a different node from the one this app reads");
    await expect(status).toContainText("Nothing was sent");
    expect(claimRequests).toBe(0);
  });
});

test("the nav links to the mint page", async ({ page }, info) => {
  await new FakeChain().install(page);
  await page.goto("/configure");
  if (info.project.name === "mobile") await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Mint" }).click();
  await expect(page).toHaveURL(/\/mint$/);
  await expect(page.getByRole("heading", { level: 1, name: "Mint an agent" })).toBeVisible();
});
