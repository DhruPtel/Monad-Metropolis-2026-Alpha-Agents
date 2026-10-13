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
    distDir: wallet.distDir,
    // Inlined at build time: a test build points the browser at the test fork
    // and the test stack's control API (D-200); a normal build uses the defaults.
    env: {
      LOCAL_FORK_PORT: process.env.LOCAL_FORK_PORT ?? "",
      CONTROL_API_URL: process.env.CONTROL_API_URL ?? "",
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
