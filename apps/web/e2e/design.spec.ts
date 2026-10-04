import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

async function openDesign(page: Page) {
  await page.goto("/design");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByRole("heading", { level: 1, name: "Design system" })).toBeVisible();
}

test("the design page matches its baseline screenshot", async ({ page }) => {
  await openDesign(page);
  await expect(page).toHaveScreenshot("design.png", { fullPage: true });
});

test("the design page has no serious or critical accessibility violations", async ({ page }) => {
  await openDesign(page);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  const summary = blocking.map(
    (v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
  );
  expect(summary).toEqual([]);
});

test("the navigation collapses into a menu on narrow screens", async ({ page }, testInfo) => {
  await openDesign(page);
  const menu = page.getByRole("button", { name: "Open menu" });
  if (testInfo.project.name === "desktop") {
    await expect(menu).toBeHidden();
    await expect(
      page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Gallery" }),
    ).toBeVisible();
    return;
  }
  await expect(page.getByRole("link", { name: "Gallery" })).toBeHidden();
  await menu.click();
  await expect(page.getByRole("button", { name: "Close menu" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.locator("#mobile-nav").getByRole("link", { name: "Gallery" })).toBeVisible();
});

test("loads every font from its own origin", async ({ page }) => {
  const fonts: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "font") fonts.push(request.url());
  });
  await openDesign(page);
  const origin = new URL(page.url()).origin;
  expect(fonts.length).toBeGreaterThan(0);
  expect(fonts.filter((url) => new URL(url).origin !== origin)).toEqual([]);
});
