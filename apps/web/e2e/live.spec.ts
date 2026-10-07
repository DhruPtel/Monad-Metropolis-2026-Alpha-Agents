import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Page, expect, test } from "@playwright/test";
import { LOCAL_FORK_RPC_URL, localForkRpcUrl } from "@alpha-agents/config";
import { createDb } from "@alpha-agents/db";
import { rpc } from "@alpha-agents/devenv";
import { AGENT_NFT_ABI, SPECIES } from "@alpha-agents/domain";
import { bytesToHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { deployLocal } from "../../../scripts/lib/agent-nft.js";
import { impersonate, publicClient, revealLocal } from "../../../scripts/lib/agent-reveal.js";
import { MOCK_WALLET_ADDRESS } from "../src/auth/mock-wallet-constants";
import { formatCount, formatOdds, summarizeSupply } from "../src/agent/supply";
import { THREE_MARKER, scriptsLoaded } from "./bundles";
import { disableWebgl } from "./webgl";

/**
 * The end-to-end agent flow (P1-U11, P1-U4) on a test stack of its own that
 * scripts/web-e2e.js starts (D-200): an anvil fork on 8546, a throwaway
 * database, the real indexer and the control API on 4101 with the mock
 * wallet's identity, and AgentNFT deployed with the mock wallet allowlisted.
 * Pages read the index through the API; the claim comes from the API; the
 * mint goes straight to the chain. Run with `pnpm test:web:live`.
 *
 * Each test snapshots the test fork and reverts it after, so the mock wallet
 * can mint again. The indexer sees each revert as a rewind or reorg and rolls
 * its index back, which every next test relies on.
 */
const FORK = localForkRpcUrl(process.env);
// Never the playtest fork: this suite mints, reverts and reveals the only bee.
if (FORK === LOCAL_FORK_RPC_URL) {
  throw new Error("the live suite runs only on its test fork; use pnpm test:web:live");
}
const BEE = 14;
const ANT = 3;
const OTHER_WALLET = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const db = createDb(process.env.TEST_DATABASE_URL ?? "postgres://unset", { max: 1 });

let snapshot = "";
let nft = "" as `0x${string}`;

test.beforeAll(async () => {
  // Already deployed by the stack; this returns its address.
  nft = (await deployLocal({ quiet: true })) as `0x${string}`;
});

test.afterAll(async () => {
  await db.destroy();
});

test.beforeEach(async () => {
  snapshot = String(await rpc(FORK, "evm_snapshot", []));
  await impersonate(MOCK_WALLET_ADDRESS);
});

test.afterEach(async () => {
  if (snapshot) await rpc(FORK, "evm_revert", [snapshot]);
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
  // A failed load's console message has no URL; this names it.
  page.on("response", (r) => {
    if (r.status() >= 400) problems.push(`response: ${r.status()} ${r.url().slice(0, 200)}`);
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
  await expect(page.locator("header [data-slot=wallet-button]")).toHaveAttribute(
    "data-state",
    "logged-out",
  );
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

  // The switch ends the old account's session; logging in again uses the new one.
  await page.evaluate((address) => window.__mockWallet?.setAccount(address), OTHER_WALLET);
  await expect(page.locator("header [data-slot=wallet-button]")).toHaveAttribute(
    "data-state",
    "logged-out",
  );
  await expect(
    portal.getByRole("heading", { level: 1, name: `Alpha Agent #${agentId}` }),
  ).toHaveCount(0);
  await portal.getByRole("button", { name: "Connect wallet" }).click();
  await expect(portal.getByText("No agent in this wallet yet")).toBeVisible({ timeout: 30_000 });
  await expect(
    portal.getByRole("heading", { level: 1, name: `Alpha Agent #${agentId}` }),
  ).toHaveCount(0);
  await expect(portal.getByRole("complementary", { name: "Agent overview" })).not.toContainText(
    `#${agentId}`,
  );
});

/** The supply as AgentNFT answers it, read straight from the contract. */
async function contractSupply() {
  const read = (functionName: "totalMinted" | "MAX_SUPPLY") =>
    publicClient.readContract({ address: nft, abi: AGENT_NFT_ABI, functionName });
  const remaining = await Promise.all(
    SPECIES.map((s) =>
      publicClient.readContract({
        address: nft,
        abi: AGENT_NFT_ABI,
        functionName: "remainingOf",
        args: [s.index],
      }),
    ),
  );
  return summarizeSupply({
    maxSupply: Number(await read("MAX_SUPPLY")),
    totalMinted: Number(await read("totalMinted")),
    remaining: remaining.map(Number),
  });
}

test("mint from /mint through the API claim: supply and odds match the contract, then open the agent", async ({
  page,
}) => {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message.slice(0, 300)}`));
  const expected = await contractSupply();

  await page.goto("/mint");
  const mintPage = page.getByTestId("mint-page");
  const panel = page.locator("[data-slot=mint-panel]");
  const supply = mintPage.getByRole("region", { name: "Supply" });
  // The page's numbers come from the index, through the API.
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

  const claims: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/v1/mint/claim")) claims.push(r.url());
  });
  await panel.getByRole("button", { name: "Connect wallet" }).click();
  await expect(panel).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await panel.getByRole("button", { name: "Mint an agent" }).click();
  await expect(panel).toHaveAttribute("data-state", "awaiting-reveal", { timeout: 30_000 });
  expect(claims).toHaveLength(1);
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
  // The index follows the mint.
  await expect(supply.getByRole("meter", { name: "Minted" })).toHaveAttribute(
    "aria-valuetext",
    `${formatCount(expected.minted + 1)} of ${formatCount(expected.maxSupply)}`,
    { timeout: 30_000 },
  );
  const issued = await db
    .selectFrom("platform.mint_claims")
    .select("wallet")
    .where("wallet", "=", MOCK_WALLET_ADDRESS.toLowerCase())
    .execute();
  expect(issued.length).toBeGreaterThan(0);

  await revealLocal(nft, { agentId, species: ANT });
  await expect(panel).toHaveAttribute("data-state", "revealed", { timeout: 30_000 });
  await expect(panel.getByRole("status")).toContainText(`Agent #${id} is Base · Ant`);

  // Client-side navigation: the wallet stays connected, no page load.
  await panel.getByRole("link", { name: `Open agent #${id}` }).click();
  await expect(page).toHaveURL(new RegExp(`/configure\\?agent=${id}$`));
  const portal = page.getByTestId("agent-portal");
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

test("a wallet off the allowlist is told before it clicks, and the API refuses its claim", async ({
  page,
}) => {
  const wallet = MOCK_WALLET_ADDRESS.toLowerCase();
  await db.deleteFrom("platform.mint_allowlist").where("wallet", "=", wallet).execute();
  try {
    const claims: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/v1/mint/claim")) claims.push(r.url());
    });
    await page.goto("/mint");
    const panel = page.locator("[data-slot=mint-panel]");
    await panel.getByRole("button", { name: "Connect wallet" }).click();
    await expect(panel).toHaveAttribute("data-state", "not-eligible", { timeout: 30_000 });
    await expect(panel).toContainText("This wallet is not on the beta mint allowlist.");
    await expect(panel.getByRole("button", { name: /Mint/ })).toHaveCount(0);
    expect(claims).toEqual([]);

    // And the claim endpoint itself refuses, whatever a page does.
    const res = await page.request.post(`${process.env.CONTROL_API_URL}/v1/mint/claim`, {
      headers: { authorization: "Bearer mock-token-alpha-agents-mock-wallet-e2e-only" },
      data: { wallet: MOCK_WALLET_ADDRESS },
    });
    expect([res.status(), ((await res.json()) as { error: string }).error]).toEqual([
      403,
      "not_allowlisted",
    ]);
  } finally {
    await db
      .insertInto("platform.mint_allowlist")
      .values({ wallet, note: "live suite mock wallet" })
      .onConflict((oc) => oc.column("wallet").doNothing())
      .execute();
  }
});

test("the claim signer key appears in no service log and no page", async ({ page }) => {
  const key = mnemonicToAccount("test test test test test test test test test test test junk", {
    addressIndex: 1,
  }).getHdKey().privateKey;
  if (!key) throw new Error("no key");
  const hex = bytesToHex(key).slice(2);
  for (const name of ["test-control-api.log", "test-indexer.log"]) {
    const log = readFileSync(
      fileURLToPath(new URL(`../../../.dev/${name}`, import.meta.url)),
      "utf8",
    );
    expect(log.length).toBeGreaterThan(0);
    expect(log.toLowerCase()).not.toContain(hex);
  }
  await page.goto("/mint");
  expect((await page.content()).toLowerCase()).not.toContain(hex);
});
