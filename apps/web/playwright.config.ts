import { defineConfig } from "@playwright/test";
import { bytesToHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";

/**
 * Two modes:
 * - default: screenshot and accessibility tests, inside the pinned Playwright
 *   image (scripts/web-e2e.js locally, the web job in CI), so fonts and
 *   rendering match and the committed baselines compare exactly. No chain is
 *   reachable there; portal specs answer the chain's RPC themselves.
 * - live (LIVE_WEB=1, `pnpm test:web:live`): on the host, against the running
 *   local fork (L-13), the end-to-end mint, reveal and view flow.
 * Both serve the test build (.next-e2e), which has the mock wallet in place of
 * Privy; scripts/check-web-build.js builds it first.
 */
const live = process.env.LIVE_WEB === "1";
const PORT = live ? 3102 : 3100;

/**
 * Live only: AgentNFT's local claim signer is anvil account 1, from anvil's
 * public development mnemonic. Derived here at start, never written or printed.
 */
function localClaimSignerKey(): string {
  const account = mnemonicToAccount("test test test test test test test test test test test junk", {
    addressIndex: 1,
  });
  const key = account.getHdKey().privateKey;
  if (!key) throw new Error("could not derive the local claim signer");
  return bytesToHex(key);
}

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
        testMatch: "live.spec.ts",
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
        testIgnore: "live.spec.ts",
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
      ...(live ? { CLAIM_SIGNER_PRIVATE_KEY: localClaimSignerKey() } : {}),
    },
    command: `node node_modules/next/dist/bin/next start --port ${PORT} --hostname 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/design`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
