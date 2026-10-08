import type { NextConfig } from "next";
import { requireControlApiUrl, walletBuildMode } from "./wallet-mode";

// The real Privy wallet, or (test builds only) the mock, into separate outputs.
const wallet = walletBuildMode(process.env);
requireControlApiUrl(process.env);

const config: NextConfig = {
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
  },
  turbopack: {
    resolveAlias: {
      "#wallet-provider": wallet.providerModule,
    },
  },
};

export default config;
