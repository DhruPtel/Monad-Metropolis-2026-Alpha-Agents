import type { NextConfig } from "next";
import { devApiProxy } from "./dev-api-proxy";
import { requireControlApiUrl, walletBuildMode } from "./wallet-mode";

// The real Privy wallet, or (test builds only) the mock, into separate outputs.
const wallet = walletBuildMode(process.env);
requireControlApiUrl(process.env);

export default function config(phase: string): NextConfig {
  // UI-FAST: under `next dev` only, and only with WEB_DEV_API_PROXY=1 (dev-api-proxy.ts).
  const proxy = devApiProxy(phase, process.env);
  return {
    reactStrictMode: true,
    // Stop `next dev` writing AGENTS.md and CLAUDE.md when it detects an AI agent.
    agentRules: false,
    // Workspace packages ship TypeScript source; Next compiles them with the app.
    transpilePackages: ["@alpha-agents/ui", "@alpha-agents/domain", "@alpha-agents/config"],
    // UI-FAST: a second dev server from the same checkout (3100 beside the testnet stack's
    // 3000) needs its own build folder; only `next dev` reads WEB_DIST_DIR, never a build.
    distDir:
      phase === "phase-development-server" && process.env.WEB_DIST_DIR?.trim()
        ? process.env.WEB_DIST_DIR.trim()
        : wallet.distDir,
    // Inlined at build time: a test build points the browser at the test fork
    // and the test stack's control API (D-200); a normal build uses the defaults.
    env: {
      LOCAL_FORK_PORT: process.env.LOCAL_FORK_PORT ?? "",
      CONTROL_API_URL: process.env.CONTROL_API_URL ?? "",
      // CO-U1: which testnet a testnet build runs on (monad, base-sepolia or arbitrum-sepolia).
      TESTNET_CHAIN: process.env.TESTNET_CHAIN ?? "",
      DEV_API_PROXY_PATH: proxy.browserPath,
    },
    ...(proxy.rewrites.length > 0 ? { rewrites: async () => [...proxy.rewrites] } : {}),
    turbopack: {
      resolveAlias: {
        "#wallet-provider": wallet.providerModule,
      },
    },
  };
}
