import { type Page, expect, test } from "@playwright/test";
import {
  dumpForkState,
  loadForkState,
  readForkConfig,
  resetToBlock,
  rpc,
} from "@alpha-agents/devenv";
import { LOCAL_FORK_RPC_URL } from "@alpha-agents/config";
import { deployLocal } from "../../../scripts/lib/agent-nft.js";
import {
  REVEAL_ABI,
  impersonate,
  publicClient,
  revealLocal,
} from "../../../scripts/lib/agent-reveal.js";
import { MOCK_WALLET_ADDRESS } from "../src/auth/mock-wallet-constants";
import { AGENT_NFT_ABI, agentNftDeployment } from "../src/agent/agent-nft";
import { formatCount, formatOdds, readSupply, summarizeSupply } from "../src/agent/supply";
import { THREE_MARKER, scriptsLoaded } from "./bundles";
import { disableWebgl } from "./webgl";

/**
 * The end-to-end agent flow on the local fork (P1-U11), with the mock wallet:
 * connect, mint through the dev claim route, reveal with the dev reveal path,
 * and view the agent in the portal. Run with `pnpm test:web:live` after
 * `pnpm dev:up`. Each test snapshots the fork first and reverts it after, so
 * the mock wallet can mint again on the next run (L-15).
 *
 * The reveal delivers a random number chosen so the agent draws a given
 * species: the bee has the only 3D model, and reveals are otherwise random.
 */
const BEE = 14;
const ANT = 3;
const OTHER_WALLET = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;

let snapshot = "";
let nft = "" as `0x${string}`;
// The fork as the suite found it, when it had to start from a fresh one.
let found = "";

/**
 * The bee is a 1-of-1 in the deck: once a playtest mints it, no bee is left
 * for the 3D tests. Then the suite saves the fork, resets it to the pin and
 * deploys fresh, and puts the saved fork back afterwards (L-58, L-60).
 */
test.beforeAll(async () => {
  const deployed = (await deployLocal({ quiet: true })) as `0x${string}`;
  const beesLeft = await publicClient.readContract({
    address: deployed,
    abi: REVEAL_ABI,
    functionName: "remainingOf",
    args: [BEE],
  });
  if (beesLeft > 0n) return;
  found = await dumpForkState();
  await resetToBlock(readForkConfig().blockNumber);
});

test.afterAll(async () => {
  if (!found) return;
  await resetToBlock(readForkConfig().blockNumber);
  await loadForkState(found);
});

test.beforeEach(async () => {
  nft = (await deployLocal({ quiet: true })) as `0x${string}`;
  snapshot = String(await rpc(LOCAL_FORK_RPC_URL, "evm_snapshot", []));
  await impersonate(MOCK_WALLET_ADDRESS);
});

test.afterEach(async () => {
  if (snapshot) await rpc(LOCAL_FORK_RPC_URL, "evm_revert", [snapshot]);
});

/** Connects the mock wallet, mints, and returns the new agent's ID. */
async function mintAgent(page: Page): Promise<bigint> {
  await page.goto("/configure");
  const portal = page.getByTestId("agent-portal");
  await portal.getByRole("button", { name: "Connect wallet" }).click();
  await expect(portal.getByText("No agent in this wallet yet")).toBeVisible({ timeout: 30_000 });
  await portal.getByRole("button", { name: "Mint an agent" }).click();
  const status = portal.getByRole("status").filter({ hasText: /minted/ });
  await expect(status).toBeVisible({ timeout: 30_000 });
  const id = /Agent #(\d+) minted/.exec((await status.textContent()) ?? "")?.[1];
  if (!id) throw new Error("no agent ID in the mint status");
  return BigInt(id);
}

test("mint, reveal as a bee, and view it in 3D with slots on its sockets", async ({ page }) => {
  const log = scriptsLoaded(page);
  // The dev overlay's issues (L-59): no console error or uncaught error while
  // the model loads, walks in and its slot markers follow their sockets.
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message.slice(0, 300)}`));
  const agentId = await mintAgent(page);
  await revealLocal(nft, { agentId, species: BEE });

  const portal = page.getByTestId("agent-portal");
  await expect(
    portal.getByRole("heading", { level: 1, name: `Alpha Agent #${agentId}` }),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("stage-mode")).toHaveAttribute("data-mode", "3d");
  const overview = portal.getByRole("complementary", { name: "Agent overview" });
  await expect(overview.getByText("Bee", { exact: true })).toBeVisible();
  await expect(overview.getByText("Pro", { exact: true })).toBeVisible();
  await expect(
    overview.getByRole("button", { name: /token-bound account of agent/i }),
  ).toBeVisible();
  await expect(page.getByTestId("agent-canvas")).toBeVisible();

  // Pro: eight slots, each riding a named socket on the model.
  const anchors = page.locator('[data-testid^="slot-anchor-"]');
  await expect(anchors).toHaveCount(8, { timeout: 30_000 });
  // The walk-in moves the model, and the slot moves with its socket. A short
  // sample of the 2.4 s walk-in is enough and keeps the 3D rendering brief.
  const first = page.getByTestId("slot-anchor-0");
  // Markers stay hidden until the scene has placed them on their sockets.
  await expect(first).toBeVisible({ timeout: 30_000 });
  const before = await first.boundingBox();
  await page.waitForTimeout(600);
  const after = await first.boundingBox();
  expect(before && after).toBeTruthy();
  const moved = Math.hypot((after?.x ?? 0) - (before?.x ?? 0), (after?.y ?? 0) - (before?.y ?? 0));
  expect(moved).toBeGreaterThan(5);

  // The positive control for the bundle test in portal.spec.ts: the model's
  // page does load three.js, and the marker finds it.
  const scripts = await log.settled();
  expect(scripts.some((s) => s.body.includes(THREE_MARKER))).toBe(true);

  // Unmounting the viewer must not throw either: an account without the agent
  // makes React remove the 3D stage in place.
  await page.evaluate((address) => window.__mockWallet?.setAccount(address), OTHER_WALLET);
  await expect(page.getByTestId("agent-canvas")).toHaveCount(0, { timeout: 30_000 });
  await page.waitForTimeout(500);
  expect(problems).toEqual([]);
});

test("a species without a model shows its 2D art with the slots on it", async ({ page }) => {
  const agentId = await mintAgent(page);
  await revealLocal(nft, { agentId, species: ANT });

  await expect(page.getByTestId("stage-mode")).toHaveAttribute("data-mode", "2d", {
    timeout: 30_000,
  });
  const viewer = page.getByRole("region", { name: "Agent viewer" });
  await expect(viewer.getByRole("img", { name: "Ant agent" })).toBeVisible();
  await expect(viewer.getByRole("list", { name: "Skill slots" }).getByRole("img")).toHaveCount(3);
  await expect(page.locator("canvas")).toHaveCount(0);
});

test("without WebGL the bee falls back to its 2D art and says 3D is unavailable", async ({
  page,
}) => {
  await disableWebgl(page);
  const agentId = await mintAgent(page);
  await revealLocal(nft, { agentId, species: BEE });

  await expect(page.getByTestId("stage-mode")).toHaveAttribute("data-mode", "no-webgl", {
    timeout: 30_000,
  });
  const viewer = page.getByRole("region", { name: "Agent viewer" });
  await expect(viewer.getByText("3D unavailable: showing the 2D art")).toBeVisible();
  await expect(viewer.getByRole("img", { name: "Bee agent" })).toBeVisible();
  await expect(viewer.getByRole("list", { name: "Skill slots" }).getByRole("img")).toHaveCount(8);
  await expect(page.locator("canvas")).toHaveCount(0);
});

test("switching to an account that does not own the agent removes it", async ({ page }) => {
  const agentId = await mintAgent(page);
  await revealLocal(nft, { agentId, species: ANT });
  const portal = page.getByTestId("agent-portal");
  await expect(
    portal.getByRole("heading", { level: 1, name: `Alpha Agent #${agentId}` }),
  ).toBeVisible({
    timeout: 30_000,
  });

  await page.evaluate((address) => window.__mockWallet?.setAccount(address), OTHER_WALLET);
  await expect(portal.getByText("No agent in this wallet yet")).toBeVisible({ timeout: 30_000 });
  await expect(
    portal.getByRole("heading", { level: 1, name: `Alpha Agent #${agentId}` }),
  ).toHaveCount(0);
  await expect(portal.getByRole("complementary", { name: "Agent overview" })).not.toContainText(
    `#${agentId}`,
  );
});

test("mint from /mint: supply and odds match the contract, then open the agent", async ({
  page,
}) => {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message.slice(0, 300)}`));
  const deployment = agentNftDeployment("local");
  if (!deployment) throw new Error("AgentNFT has no verified local address");
  expect(deployment.address.toLowerCase()).toBe(nft.toLowerCase());
  const expected = summarizeSupply(await readSupply(publicClient as never, deployment));

  await page.goto("/mint");
  const mintPage = page.getByTestId("mint-page");
  const panel = page.locator("[data-slot=mint-panel]");
  const supply = mintPage.getByRole("region", { name: "Supply" });
  await expect(supply.getByRole("meter", { name: "Minted" })).toHaveAttribute(
    "aria-valuetext",
    `${formatCount(expected.minted)} of ${formatCount(expected.maxSupply)}`,
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("tier-odds")).toHaveText(
    expected.tiers.map((t) => formatOdds(t.odds)),
  );
  for (const t of expected.tiers) {
    const name = { base: "Base", medium: "Medium", pro: "Pro" }[t.tier];
    await expect(
      mintPage.getByRole("region", { name: `${name} tier` }).getByRole("meter"),
    ).toHaveAttribute("aria-valuetext", `${formatCount(t.remaining)} of ${formatCount(t.total)}`);
  }

  await panel.getByRole("button", { name: "Connect wallet" }).click();
  await expect(panel).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await panel.getByRole("button", { name: "Mint an agent" }).click();
  await expect(panel).toHaveAttribute("data-state", "awaiting-reveal", { timeout: 30_000 });
  const status = panel.getByRole("status").filter({ hasText: /minted/ });
  const id = /Agent #(\d+) minted/.exec((await status.textContent()) ?? "")?.[1];
  if (!id) throw new Error("no agent ID in the mint status");
  const agentId = BigInt(id);
  const owner = await publicClient.readContract({
    address: nft,
    abi: AGENT_NFT_ABI,
    functionName: "ownerOf",
    args: [agentId],
  });
  expect(owner.toLowerCase()).toBe(MOCK_WALLET_ADDRESS.toLowerCase());
  // The supply follows the mint.
  await expect(supply.getByRole("meter", { name: "Minted" })).toHaveAttribute(
    "aria-valuetext",
    `${formatCount(expected.minted + 1)} of ${formatCount(expected.maxSupply)}`,
    { timeout: 30_000 },
  );

  await revealLocal(nft, { agentId, species: ANT });
  await expect(panel).toHaveAttribute("data-state", "revealed", { timeout: 30_000 });
  await expect(panel.getByRole("status")).toContainText(`Agent #${id} is Base · Ant`);

  await panel.getByRole("link", { name: `Open agent #${id}` }).click();
  await expect(page).toHaveURL(new RegExp(`/configure\\?agent=${id}$`));
  // The link loads the page afresh; the mock wallet, unlike a Privy session,
  // does not survive a page load, so it connects again.
  const portal = page.getByTestId("agent-portal");
  await portal.getByRole("button", { name: "Connect wallet" }).click();
  await expect(portal.getByRole("heading", { level: 1, name: `Alpha Agent #${id}` })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("stage-mode")).toHaveAttribute("data-mode", "2d");

  // A second visit: one per wallet, so the page shows the agent, not a mint.
  await page.goto("/mint");
  await page
    .locator("[data-slot=mint-panel]")
    .getByRole("button", { name: "Connect wallet" })
    .click();
  await expect(page.locator("[data-slot=mint-panel]")).toHaveAttribute(
    "data-state",
    "already-minted",
    { timeout: 30_000 },
  );
  expect(problems).toEqual([]);
});
