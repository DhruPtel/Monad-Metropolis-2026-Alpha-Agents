import { defineConfig } from "@playwright/test";

/**
 * Two modes, both run inside the pinned Playwright image by scripts/web-e2e.js:
 * - default: screenshot and accessibility tests of every console page against
 *   a production build with no .env and no stack, so they match in CI;
 * - live (LIVE_CONSOLE_URL set): drives the running console and fork through
 *   the fork-control and test-fund flows.
 */
const live = process.env.LIVE_CONSOLE_URL;
const PORT = 3101;

export default defineConfig({
  testDir: "e2e",
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}-{projectName}{ext}",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 120_000,
  reporter: [["list"]],
  expect: {
    toHaveScreenshot: { maxDiffPixels: 0, threshold: 0, animations: "disabled", caret: "hide" },
  },
  ...(live
    ? {
        testMatch: "live.spec.ts",
        use: { baseURL: live, colorScheme: "dark" },
        projects: [
          {
            name: "live",
            use: { browserName: "chromium", viewport: { width: 1440, height: 900 } },
          },
        ],
      }
    : {
        testIgnore: "live.spec.ts",
        use: { baseURL: `http://127.0.0.1:${PORT}`, colorScheme: "dark" },
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
        webServer: {
          command: `node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port ${PORT}`,
          url: `http://127.0.0.1:${PORT}/addresses`,
          reuseExistingServer: false,
          timeout: 60_000,
        },
      }),
});
