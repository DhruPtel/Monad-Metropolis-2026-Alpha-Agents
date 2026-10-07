import type { Page } from "@playwright/test";

/**
 * A full repaint before a capture (L-65): after state changes only parts of
 * the page were repainted, and an antialiased edge composited over a partial
 * repaint can differ by a pixel or two from run to run.
 */
export async function repaint(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const frames = () =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    document.documentElement.style.opacity = "0.99";
    await frames();
    document.documentElement.style.opacity = "";
    await frames();
  });
}
