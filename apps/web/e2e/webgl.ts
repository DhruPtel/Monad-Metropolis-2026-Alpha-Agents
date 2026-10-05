import type { Page } from "@playwright/test";

/**
 * Makes the page behave as a browser without WebGL: every webgl and webgl2
 * context request returns null, as it does when the GPU is blocklisted or
 * WebGL is turned off. Runs before any page script.
 */
export async function disableWebgl(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    const blocked = new Set(["webgl", "webgl2", "experimental-webgl"]);
    HTMLCanvasElement.prototype.getContext = function getContext(
      this: HTMLCanvasElement,
      type: string,
      ...rest: unknown[]
    ) {
      if (blocked.has(type)) return null;
      return (original as (...args: unknown[]) => unknown).call(this, type, ...rest);
    } as typeof original;
  });
}
