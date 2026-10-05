import { type Page, expect, test } from "@playwright/test";
import { rpc } from "@alpha-agents/devenv";
import { LOCAL_FORK_RPC_URL } from "@alpha-agents/config";
import { deployLocal } from "../../../scripts/lib/agent-nft.js";
import { impersonate, revealLocal } from "../../../scripts/lib/agent-reveal.js";
import { MOCK_WALLET_ADDRESS } from "../src/auth/mock-wallet-constants";
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
  const scripts = scriptsLoaded(page);
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
  const before = await first.boundingBox();
  await page.waitForTimeout(600);
  const after = await first.boundingBox();
  expect(before && after).toBeTruthy();
  const moved = Math.hypot((after?.x ?? 0) - (before?.x ?? 0), (after?.y ?? 0) - (before?.y ?? 0));
  expect(moved).toBeGreaterThan(5);

  // The positive control for the bundle test in portal.spec.ts: the model's
  // page does load three.js, and the marker finds it.
  expect(scripts.some((s) => s.body.includes(THREE_MARKER))).toBe(true);
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
