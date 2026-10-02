import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";

/**
 * The owner's checks, against the running stack (pnpm dev:all), driven through
 * the real UI. Run with: pnpm test:console:live
 */
/**
 * A fresh address per run: USDC is minted on top of the existing balance, so a
 * fixed address already holds the previous run's USDC on a fork that keeps state.
 */
const ADDRESS = `0x${randomBytes(20).toString("hex")}`;

test("the environment panel shows every service up", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("stack-health")).toHaveText("All services up");
});

test("snapshot, advance a day, revert: the block and time return", async ({ page }) => {
  await page.goto("/fork");
  const block = page.getByTestId("fork-block");
  const time = page.getByTestId("fork-time");
  const startBlock = (await block.textContent()) ?? "";
  const startTime = (await time.textContent()) ?? "";

  await page.getByRole("button", { name: "Take snapshot" }).click();
  await expect(page.getByRole("region", { name: "Snapshots" }).getByRole("table")).toBeVisible();

  await page.getByRole("button", { name: "Advance" }).click();
  await expect(time).not.toHaveText(startTime);
  await expect(block).toHaveText(String(Number(startBlock) + 1));

  await page.getByRole("button", { name: "Revert" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revert" }).click();
  await expect(block).toHaveText(startBlock);
  await expect(time).toHaveText(startTime);
});

test("give an address MON and USDC and read the balances back", async ({ page }) => {
  await page.goto("/funds");
  await page.getByLabel("Address").fill(ADDRESS);
  await page.getByLabel("MON balance").fill("42.5");
  await page.getByRole("button", { name: "Set MON" }).click();
  await expect(page.getByTestId("balances")).toContainText("42.5");
  await page.getByLabel("USDC to add").fill("1,234.56");
  await page.getByRole("button", { name: "Give USDC" }).click();
  await expect(page.getByTestId("balances")).toContainText("1,234.56");
});
