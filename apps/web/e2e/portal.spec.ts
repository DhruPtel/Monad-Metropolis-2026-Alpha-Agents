import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";
import { MOCK_WALLET_ADDRESS } from "../src/auth/mock-wallet-constants";
import { THREE_MARKER, scriptsLoaded } from "./bundles";
import { AGENT_NFT, FakeChain } from "./fake-chain";
import { disableWebgl } from "./webgl";

/**
 * The agent portal on /configure (P1-U11), against the test build with the
 * mock wallet, in the pinned image at 1440px and 380px. The fork's RPC is
 * answered by FakeChain; the live suite runs the same flow on the real fork.
 */
const ANT = 3;
const BEE = 14;
const OTHER_WALLET = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;

const portal = (page: Page) => page.getByTestId("agent-portal");
const walletButton = (page: Page) => page.locator("header [data-slot=wallet-button]");

async function open(page: Page, chain: FakeChain, path = "/configure") {
  await chain.install(page);
  await page.goto(path);
  await page.evaluate(() => document.fonts.ready);
}

async function connect(page: Page) {
  await portal(page).getByRole("button", { name: "Connect wallet" }).click();
  // The mint button appears where the connect button was: move off it at once.
  await page.mouse.move(0, 0);
  await expect(walletButton(page)).toHaveAttribute("data-state", "connected");
}

/**
 * Captures the portal. The shell's sticky header is hidden for the capture:
 * on a narrow screen the portal is taller than the viewport, and the header
 * would otherwise sit over its top as Playwright scrolls through it. The
 * pointer is parked in a corner so no hover state shows.
 */
async function capture(page: Page, name: string) {
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => document.querySelector("button:hover, a:hover") === null);
  await expect(portal(page)).toHaveScreenshot(name, {
    stylePath: fileURLToPath(new URL("./portal-capture.css", import.meta.url)),
  });
}

/** Waits until the viewer has decided what to show and every image has loaded. */
async function settled(page: Page) {
  await expect(page.getByTestId("stage-mode")).not.toHaveAttribute("data-mode", "checking");
  await page.waitForFunction(() =>
    [...document.images].every((img) => img.complete && img.naturalWidth > 0),
  );
}

async function blockingViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

const heading = (page: Page, id: number) =>
  portal(page).getByRole("heading", { level: 1, name: `Alpha Agent #${id}` });

test.describe("screenshots and accessibility", () => {
  test("logged out, the portal asks for the wallet", async ({ page }) => {
    await open(page, new FakeChain());
    await expect(portal(page).getByText("Connect your wallet to see your agent.")).toBeVisible();
    await capture(page, "configure-logged-out.png");
    expect(await blockingViolations(page)).toEqual([]);
  });

  test("a wallet without an agent is offered the mint", async ({ page }) => {
    await open(page, new FakeChain());
    await connect(page);
    await expect(portal(page).getByText("No agent in this wallet yet")).toBeVisible();
    await settled(page);
    await capture(page, "configure-no-agent.png");
    expect(await blockingViolations(page)).toEqual([]);
  });

  test("an unrevealed agent waits for its reveal", async ({ page }) => {
    const chain = new FakeChain();
    chain.mint(7n, MOCK_WALLET_ADDRESS, 0);
    await open(page, chain);
    await connect(page);
    await expect(portal(page).getByText(/minted and waiting for its reveal/)).toBeVisible();
    await settled(page);
    await capture(page, "configure-unrevealed.png");
    expect(await blockingViolations(page)).toEqual([]);
  });

  test("a species without a model shows its 2D art, slots and card", async ({ page }) => {
    const chain = new FakeChain();
    chain.mint(7n, MOCK_WALLET_ADDRESS, ANT);
    await open(page, chain);
    await connect(page);
    await expect(heading(page, 7)).toBeVisible();
    await expect(page.getByTestId("stage-mode")).toHaveAttribute("data-mode", "2d");
    const viewer = page.getByRole("region", { name: "Agent viewer" });
    await expect(viewer.getByRole("list", { name: "Skill slots" }).getByRole("img")).toHaveCount(3);
    await settled(page);
    await capture(page, "configure-revealed-2d.png");
    expect(await blockingViolations(page)).toEqual([]);
  });

  test("without WebGL the bee shows its 2D art and says 3D is unavailable", async ({ page }) => {
    await disableWebgl(page);
    const chain = new FakeChain();
    chain.mint(7n, MOCK_WALLET_ADDRESS, BEE);
    await open(page, chain);
    await connect(page);
    await expect(page.getByTestId("stage-mode")).toHaveAttribute("data-mode", "no-webgl");
    const viewer = page.getByRole("region", { name: "Agent viewer" });
    await expect(viewer.getByText("3D unavailable: showing the 2D art")).toBeVisible();
    await expect(viewer.getByRole("img", { name: "Bee agent" })).toBeVisible();
    await expect(viewer.getByRole("list", { name: "Skill slots" }).getByRole("img")).toHaveCount(8);
    await expect(page.locator("canvas")).toHaveCount(0);
    await settled(page);
    await capture(page, "configure-no-webgl.png");
    expect(await blockingViolations(page)).toEqual([]);
  });
});

test.describe("ownership", () => {
  test("switching to an account that does not own the agent removes it", async ({ page }) => {
    const chain = new FakeChain();
    chain.mint(7n, MOCK_WALLET_ADDRESS, ANT);
    await open(page, chain);
    await connect(page);
    await expect(heading(page, 7)).toBeVisible();

    await page.evaluate((address) => window.__mockWallet?.setAccount(address), OTHER_WALLET);
    await expect(portal(page).getByText("No agent in this wallet yet")).toBeVisible();
    await expect(heading(page, 7)).toHaveCount(0);
    await expect(portal(page).getByRole("region", { name: "Slots" })).toHaveCount(0);
    await expect(portal(page)).not.toContainText("#7");
  });

  test("an agent the wallet once received but no longer owns is not shown", async ({ page }) => {
    const chain = new FakeChain();
    const agent = chain.mint(7n, MOCK_WALLET_ADDRESS, ANT);
    // Transferred away: the Transfer to the wallet is still in the logs, but
    // ownerOf now answers with the new owner, and ownerOf decides.
    agent.owner = OTHER_WALLET;
    agent.receivedBy.push(OTHER_WALLET);
    agent.ownerEpoch = 1n;
    await open(page, chain);
    await connect(page);
    await expect(portal(page).getByText("No agent in this wallet yet")).toBeVisible();
    await expect(portal(page)).not.toContainText("#7");
  });

  test("a link to someone else's agent shows no owner controls", async ({ page }) => {
    const chain = new FakeChain();
    chain.mint(7n, MOCK_WALLET_ADDRESS, ANT);
    chain.mint(8n, OTHER_WALLET, BEE);
    await open(page, chain, "/configure?agent=8");
    await connect(page);
    await expect(portal(page).getByText("Agent #8 is not in this wallet.")).toBeVisible();
    await expect(heading(page, 8)).toHaveCount(0);
    await expect(portal(page).getByRole("region", { name: "Slots" })).toHaveCount(0);
  });
});

test.describe("minting", () => {
  test("a wallet without a claim sees why it cannot mint", async ({ page }) => {
    // The pinned image has no claim signer, so the route refuses with its reason.
    await open(page, new FakeChain());
    await connect(page);
    await portal(page).getByRole("button", { name: "Mint an agent" }).click();
    await expect(portal(page).getByRole("button", { name: "Mint unavailable" })).toBeDisabled();
    await expect(portal(page).getByRole("status")).toContainText(
      "Minting is not configured: set LOCAL_CLAIM_SIGNER_PRIVATE_KEY",
    );
  });

  test("a wallet on another network is stopped before the claim (L-53)", async ({ page }) => {
    // The wallet reports the fork's chain ID, but its RPC is a different node:
    // its pinned block has another hash, and AgentNFT is not there.
    const elsewhere = new FakeChain({ head: 110_830_344n, hashSeed: "aa", agentNft: false });
    await elsewhere.install(page, "9545");
    let claimRequests = 0;
    page.on("request", (r) => {
      if (r.url().includes("/api/mint-claim")) claimRequests++;
    });
    await open(page, new FakeChain());
    await connect(page);
    await page.evaluate(() => window.__mockWallet?.setRpcUrl("http://127.0.0.1:9545"));
    await portal(page).getByRole("button", { name: "Mint an agent" }).click();
    const status = portal(page).getByRole("status");
    await expect(status).toContainText(
      "Your wallet's network uses chain ID 143143 but is a different node from the one this app reads",
    );
    await expect(status).toContainText("at block 109670000");
    await expect(status).toContainText("Nothing was sent");
    await expect(status).toContainText("RPC URL http://127.0.0.1:8545");
    expect(claimRequests).toBe(0);
  });

  test("a declined signature shows Rejected in wallet", async ({ page }) => {
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
    await open(page, new FakeChain());
    await connect(page);
    await page.evaluate(() => window.__mockWallet?.rejectNextWrite());
    await portal(page).getByRole("button", { name: "Mint an agent" }).click();
    await expect(portal(page).getByRole("status")).toContainText("Rejected in wallet");
    await expect(portal(page).getByRole("button", { name: "Mint an agent" })).toBeEnabled();
  });
});

test.describe("bundles", () => {
  test("three.js loads on no page without a model", async ({ page }) => {
    const log = scriptsLoaded(page);
    const chain = new FakeChain();
    chain.mint(7n, MOCK_WALLET_ADDRESS, ANT);
    await chain.install(page);
    // Every statically imported chunk loads before the load event; the model's
    // chunk is a dynamic import that only the 3D stage would request.
    for (const path of ["/", "/design"]) {
      await page.goto(path, { waitUntil: "load" });
    }
    await page.goto("/configure");
    await connect(page);
    await expect(page.getByTestId("stage-mode")).toHaveAttribute("data-mode", "2d");

    const scripts = await log.settled();
    expect(scripts.length).toBeGreaterThan(0);
    const withThree = scripts.filter((s) => s.body.includes(THREE_MARKER)).map((s) => s.url);
    expect(withThree).toEqual([]);
  });
});
