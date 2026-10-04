import type { NextConfig } from "next";
import { walletBuildMode } from "./wallet-mode";

// The real Privy wallet, or (test builds only) the mock, into separate outputs.
const wallet = walletBuildMode(process.env);

const config: NextConfig = {
  reactStrictMode: true,
  // Stop `next dev` writing AGENTS.md and CLAUDE.md when it detects an AI agent.
  agentRules: false,
  // Workspace packages ship TypeScript source; Next compiles them with the app.
  transpilePackages: ["@alpha-agents/ui", "@alpha-agents/domain", "@alpha-agents/config"],
  distDir: wallet.distDir,
  turbopack: { resolveAlias: { "#wallet-provider": wallet.providerModule } },
};

export default config;
