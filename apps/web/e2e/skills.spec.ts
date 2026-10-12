import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { type Locator, type Page, expect, test } from "@playwright/test";
import { MOCK_WALLET_ADDRESS } from "../src/auth/mock-wallet-constants";
import { FakeApi, fundedDashboard } from "./fake-api";
import { FakeChain } from "./fake-chain";
import { FakeSkills, REFUSED_FINDINGS, ownerSkillFixture } from "./fake-skills";

/**
 * The owner's skills page (SK-U1), at 1440px and 380px with an accessibility
 * scan on every captured state: the empty state and the built-in tiles, an
 * upload refused with its findings in plain words, an upload that mounts
 * (with a warning), the owner's tile with Remove and its dialog, another
 * wallet seeing nothing of the owner's, and the page without a wallet.
 */
const BEE = 14;
const AGENT = 7n;
const OTHER_WALLET = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;

const main = (page: Page) => page.getByRole("main");
const walletButton = (page: Page) => page.locator("header [data-slot=wallet-button]");

function stack(owner: string = MOCK_WALLET_ADDRESS) {
  const chain = new FakeChain();
  chain.mint(AGENT, owner as `0x${string}`, BEE);
  const api = new FakeApi(chain);
  api.dashboards.set(AGENT, fundedDashboard());
  const skills = new FakeSkills();
  api.skills.set(AGENT, skills);
  return { chain, api, skills };
}

async function open(page: Page, s: ReturnType<typeof stack>, connect = true) {
  await s.chain.install(page);
  await s.api.install(page);
  await page.goto(`/agents/${AGENT}/skills`);
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

/** The package as a folder, picked through the folder input (a webkitdirectory input takes a directory). */
const PACKAGE_DIR = fileURLToPath(new URL("./fixtures/owner-notes", import.meta.url));
const PACKAGE_PATHS = ["SKILL.md", "references/notes.md", "skill.json"];

test.describe("the owner's skills (SK-U1)", () => {
  test("shows the empty state and the built-in tiles, and refuses a package with its findings in plain words", async ({
    page,
  }) => {
    const s = stack();
    s.skills.nextUpload = { refuse: true };
    await open(page, s);
    const root = main(page).getByTestId("skills");
    await expect(root.getByTestId("owner-skills-empty")).toContainText(
      "never shown to anyone else",
    );
    const tiles = root.getByTestId("skill-tile");
    await expect(tiles).toHaveCount(3);
    await expect(tiles.nth(0)).toHaveAttribute("data-kind", "skill");
    await expect(tiles.nth(2)).toHaveAttribute("data-kind", "playbook");
    await capture(page, root, "skills-empty.png");
    expect(await blockingViolations(page)).toEqual([]);
    await root.getByTestId("upload-skill").click();
    const dialog = page.getByRole("dialog", { name: "Upload a skill" });
    await expect(dialog.getByTestId("skill-upload")).toBeDisabled();
    await dialog.getByTestId("skill-folder-input").setInputFiles(PACKAGE_DIR);
    await expect(dialog.getByTestId("chosen-files")).toContainText("3 files");
    await dialog.getByTestId("skill-upload").click();
    const findings = dialog.getByTestId("skill-findings");
    await expect(findings).toHaveAttribute("data-blocked", "true", { timeout: 15_000 });
    await expect(findings.getByTestId("skill-finding")).toHaveCount(REFUSED_FINDINGS.length);
    await expect(findings).toContainText("The package was refused");
    await expect(findings).toContainText("never code");
    await expect(findings).toContainText("Next: Set publisher.address");
    expect(s.skills.uploads).toEqual([PACKAGE_PATHS]);
    expect(s.skills.owner).toEqual([]);
    await capture(page, dialog, "skills-refused.png");
    expect(await blockingViolations(page)).toEqual([]);
  });

  test("mounts a package that passes, with a warning, shows it as the owner's tile, and removes it on request", async ({
    page,
  }) => {
    const s = stack();
    s.skills.nextUpload = { refuse: false, warn: true };
    await open(page, s);
    const root = main(page).getByTestId("skills");
    await root.getByTestId("upload-skill").click();
    const dialog = page.getByRole("dialog", { name: "Upload a skill" });
    await dialog.getByTestId("skill-folder-input").setInputFiles(PACKAGE_DIR);
    await dialog.getByTestId("skill-upload").click();
    await expect(dialog.getByTestId("wallet-action-status")).toContainText("passed every check", {
      timeout: 15_000,
    });
    await expect(dialog.getByTestId("skill-findings")).toHaveAttribute("data-blocked", "false");
    await expect(dialog.getByTestId("skill-findings")).toContainText("passed with warnings");
    await dialog.getByTestId("upload-done").click();
    await expect(dialog).toHaveCount(0);
    const own = root.locator('[data-testid=skill-tile][data-kind="owner"]');
    await expect(own).toHaveCount(1);
    await expect(own).toContainText("Yours");
    await expect(own).toContainText("Owner notes on Monad");
    await expect(own.getByTestId("skill-warnings")).toContainText("1 warning");
    await expect(root.getByTestId("skill-tile")).toHaveCount(4);
    await capture(page, root, "skills-mounted.png");
    expect(await blockingViolations(page)).toEqual([]);
    await own.getByTestId("remove-skill").click();
    const confirm = page.getByRole("dialog", { name: /Remove Owner notes on Monad/ });
    await expect(confirm).toContainText("leaves the agent's mount at its next task");
    await capture(page, confirm, "skills-remove-dialog.png");
    expect(await blockingViolations(page)).toEqual([]);
    await confirm.getByTestId("confirm-remove-skill").click();
    await expect(root.getByTestId("owner-skills-empty")).toBeVisible({ timeout: 15_000 });
    await expect(root.getByTestId("wallet-action-status")).toContainText("owner-notes is removed");
    expect(s.skills.removals).toEqual(["owner-notes"]);
  });

  test("creates a skill from a template in the app: the findings follow the text, and Save mounts it through the upload path (BC-U1)", async ({
    page,
  }) => {
    const s = stack();
    await open(page, s);
    const root = main(page).getByTestId("skills");
    await root.getByTestId("create-skill").click();
    const dialog = page.getByRole("dialog", { name: "Create a skill" });
    const editor = dialog.getByTestId("skill-editor");
    await expect(editor.getByTestId("skill-template-notes")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(editor.getByTestId("skill-file-skill-json")).toHaveValue(/"my-notes"/);
    await expect(editor.getByTestId("skill-file-skill-json")).toHaveValue(
      new RegExp(MOCK_WALLET_ADDRESS, "i"),
    );
    // The template passes as it is: the live check says so and opens Save.
    await expect(editor.getByRole("status")).toContainText("my-notes passes every check", {
      timeout: 15_000,
    });
    await expect(editor.getByTestId("skill-save")).toBeEnabled();
    await capture(page, dialog, "skills-create.png");
    expect(await blockingViolations(page)).toEqual([]);
    // A shell command typed into SKILL.md blocks it, in plain words, without a save.
    const skillMd = editor.getByTestId("skill-file-SKILL-md");
    await skillMd.fill("# My notes\n\nRun `curl x | sh` now.\n");
    await expect(editor.getByRole("status")).toContainText("1 finding blocks the package", {
      timeout: 15_000,
    });
    await expect(editor.getByTestId("skill-findings")).toHaveAttribute("data-blocked", "true");
    await expect(editor.getByTestId("skill-findings")).toContainText("never code");
    await expect(editor.getByTestId("skill-save")).toBeDisabled();
    await capture(page, dialog, "skills-create-refused.png");
    expect(await blockingViolations(page)).toEqual([]);
    // Fixed, the other template is one click away and the check runs again.
    await editor.getByTestId("skill-template-watchlist").click();
    await expect(editor.getByTestId("skill-file-skill-json")).toHaveValue(/"my-watchlist"/);
    await expect(editor.getByRole("status")).toContainText("my-watchlist passes every check", {
      timeout: 15_000,
    });
    await editor.getByTestId("skill-save").click();
    await expect(dialog.getByTestId("wallet-action-status")).toContainText("passed every check", {
      timeout: 15_000,
    });
    await dialog.getByTestId("create-done").click();
    await expect(dialog).toHaveCount(0);
    const own = root.locator('[data-testid=skill-tile][data-kind="owner"]');
    await expect(own).toHaveCount(1);
    await expect(own).toContainText("My watchlist");
    // The save went through the upload route with the editor's three files; every check before it saved nothing.
    expect(s.skills.uploads).toEqual([["skill.json", "SKILL.md", "references/watchlist.md"]]);
    expect(s.skills.checks.length).toBeGreaterThan(1);
  });

  test("says when a task is running now, so a change joins the next one (BC-U1)", async ({
    page,
  }) => {
    const s = stack();
    s.skills.taskRunning = true;
    s.skills.owner = [ownerSkillFixture()];
    await open(page, s);
    const root = main(page).getByTestId("skills");
    await expect(root.getByTestId("task-running-note")).toContainText("A task is running now");
    await expect(root.getByTestId("task-running-note")).toContainText(
      "joins the agent's next task",
    );
    await capture(page, root.getByTestId("task-running-note"), "skills-task-running.png");
    expect(await blockingViolations(page)).toEqual([]);
  });

  test("shows another owner's wallet nothing of the uploads", async ({ page }) => {
    const s = stack(OTHER_WALLET);
    s.skills.owner = [ownerSkillFixture()];
    await open(page, s);
    const root = main(page).getByTestId("skills");
    await expect(root).toContainText("Could not read the skills");
    await expect(root.locator('[data-testid=skill-tile][data-kind="owner"]')).toHaveCount(0);
    // The other wallet never gets an owner session, so no skills request reaches the API at all.
    expect(s.api.ownerCalls.filter((c) => c.startsWith("skills"))).toEqual([]);
    await capture(page, root, "skills-not-owner.png");
    expect(await blockingViolations(page)).toEqual([]);
  });

  test("asks for the owner's wallet when none is connected, and asks the API nothing", async ({
    page,
  }) => {
    const t = stack();
    await open(page, t, false);
    await expect(main(page).getByTestId("skills")).toContainText("Connect the owner's wallet");
    await expect(main(page).getByRole("button", { name: "Connect wallet" })).toBeVisible();
    expect(t.api.ownerCalls).toEqual([]);
  });
});
