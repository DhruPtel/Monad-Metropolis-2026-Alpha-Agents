import { defineConfig } from "@playwright/test";

/**
 * Two modes:
 * - default: screenshot and accessibility tests, inside the pinned Playwright
 *   image (scripts/web-e2e.js locally, the web job in CI), so fonts and
 *   rendering match and the committed baselines compare exactly. No chain is
 *   reachable there; the specs answer the chain's RPC and the control API themselves.
 * - live (LIVE_WEB=1, `pnpm test:web:live`): on the host (L-13), against a
 *   test stack of its own that scripts/web-e2e.js starts (D-200): a fork on
 *   8546, a throwaway database, the indexer and the control API on 4101. The
 *   end-to-end mint through the API, reveal and view flow.
 * Both serve the test build (.next-e2e), which has the mock wallet in place of
 * Privy; scripts/check-web-build.js builds it first.
 */
const live = process.env.LIVE_WEB === "1";
/** Which live spec runs: the mint and view flow, or My Agents with the orchestrator (P1-U9). */
const liveSpec = process.env.LIVE_SPEC ?? "live.spec.ts";
const PORT = live ? 3102 : 3100;

export default defineConfig({
  testDir: "e2e",
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}-{projectName}{ext}",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  timeout: 120_000,
  retries: 0,
  reporter: [["list"]],
  expect: {
    toHaveScreenshot: { maxDiffPixels: 0, threshold: 0, animations: "disabled", caret: "hide" },
  },
  use: { baseURL: `http://127.0.0.1:${PORT}`, colorScheme: "dark" },
  ...(live
    ? {
        testMatch: liveSpec,
        projects: [
          {
            // The only suite that renders WebGL: the smallest viewport that
            // still shows the side panels (the lg breakpoint), at 1x scale.
            name: "live",
            use: {
              browserName: "chromium",
              viewport: { width: 1024, height: 640 },
              deviceScaleFactor: 1,
            },
          },
        ],
      }
    : {
        testIgnore: ["live.spec.ts", "*.live.spec.ts"],
        projects: [
          {
            name: "desktop",
            use: { browserName: "chromium", viewport: { width: 1440, height: 900 } },
          },
          {
            name: "mobile",
            use: { browserName: "chromium", viewport: { width: 380, height: 800 } },
          },
        ],
      }),
  webServer: {
    // Serves the test build (.next-e2e) with the mock wallet; see wallet-mode.ts.
    env: {
      ALPHA_E2E_MOCK_WALLET: "1",
      APP_ENV: "local",
    },
    command: `node node_modules/next/dist/bin/next start --port ${PORT} --hostname 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/design`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
