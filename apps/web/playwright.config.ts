import { defineConfig } from "@playwright/test";

/**
 * Screenshot and accessibility tests for /design. They run inside the pinned
 * Playwright image (scripts/web-e2e.js locally, the web job in CI), so fonts and
 * rendering match and the committed baselines compare exactly. The app must be
 * built first (scripts/check-web-build.js); this serves the test build, which
 * has the mock wallet in place of Privy.
 */
const PORT = 3100;

export default defineConfig({
  testDir: "e2e",
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}-{projectName}{ext}",
  fullyParallel: false,
  forbidOnly: true,
  timeout: 120_000,
  retries: 0,
  reporter: [["list"]],
  expect: {
    toHaveScreenshot: { maxDiffPixels: 0, threshold: 0, animations: "disabled", caret: "hide" },
  },
  use: { baseURL: `http://127.0.0.1:${PORT}`, colorScheme: "dark" },
  projects: [
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { browserName: "chromium", viewport: { width: 380, height: 800 } } },
  ],
  webServer: {
    // Serves the test build (.next-e2e) with the mock wallet; see wallet-mode.ts.
    env: { ALPHA_E2E_MOCK_WALLET: "1" },
    command: `node node_modules/next/dist/bin/next start --port ${PORT} --hostname 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/design`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
