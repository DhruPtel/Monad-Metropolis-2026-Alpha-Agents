import type { Page } from "@playwright/test";

/**
 * A string only the three.js chunk contains (WebGLRenderer sets it, and
 * minification keeps property names). three, React Three Fiber and drei are
 * built into one chunk, loaded only through next/dynamic.
 */
export const THREE_MARKER = "isWebGLRenderer";

export interface LoadedScript {
  readonly url: string;
  readonly body: string;
}

/**
 * Collects every script the page loads from now on. The array fills as
 * responses arrive; read it after the page has settled.
 */
export function scriptsLoaded(page: Page): LoadedScript[] {
  const scripts: LoadedScript[] = [];
  page.on("response", (response) => {
    if (response.request().resourceType() !== "script") return;
    response.text().then(
      (body) => scripts.push({ url: response.url(), body }),
      () => undefined,
    );
  });
  return scripts;
}
