import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

async function openDesign(page: Page) {
  await page.goto("/design");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByRole("heading", { level: 1, name: "Design system" })).toBeVisible();
}

test("the design page matches its baseline screenshot", async ({ page }) => {
  await openDesign(page);
  // A full-page capture of this long page can take over the 5-second default under load.
  await expect(page).toHaveScreenshot("design.png", { fullPage: true, timeout: 30_000 });
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

/** True when two boxes overlap by more than a hairline. */
function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) {
  const x = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const y = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return x > 0.5 && y > 0.5;
}

test("slot markers on the species art never cover its label or note", async ({ page }) => {
  await openDesign(page);
  const arts = page.getByTestId("species-art").locator("[data-slot=species-art]");
  const count = await arts.count();
  expect(count).toBeGreaterThan(0);
  const covered: string[] = [];
  for (let i = 0; i < count; i++) {
    const art = arts.nth(i);
    const texts = art.getByText(/ · |Art coming soon|Unrevealed/);
    const slots = art.locator("[data-slot=slot-hex]");
    for (let t = 0; t < (await texts.count()); t++) {
      const text = texts.nth(t);
      const textBox = await text.boundingBox();
      if (!textBox) continue;
      for (let s = 0; s < (await slots.count()); s++) {
        const slotBox = await slots.nth(s).boundingBox();
        if (slotBox && overlaps(textBox, slotBox)) {
          covered.push(`art ${i + 1}: slot ${s + 1} covers "${await text.textContent()}"`);
        }
      }
    }
  }
  expect(covered).toEqual([]);
});
