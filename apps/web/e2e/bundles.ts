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

export interface ScriptLog {
  /** Every script loaded so far whose body has been read. */
  readonly scripts: LoadedScript[];
  /** Resolves once every script response seen so far has been read. */
  settled(): Promise<LoadedScript[]>;
}

/** Collects every script the page loads from now on. */
export function scriptsLoaded(page: Page): ScriptLog {
  const scripts: LoadedScript[] = [];
  const pending: Promise<void>[] = [];
  page.on("response", (response) => {
    if (response.request().resourceType() !== "script") return;
    pending.push(
      response.text().then(
        (body) => {
          scripts.push({ url: response.url(), body });
        },
        () => undefined,
      ),
    );
  });
  return {
    scripts,
    settled: async () => {
      await Promise.all(pending);
      return scripts;
    },
  };
}
