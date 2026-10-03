import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // Stop `next dev` writing AGENTS.md and CLAUDE.md when it detects an AI agent.
  agentRules: false,
  // Workspace packages ship TypeScript source; Next compiles them with the app.
  transpilePackages: ["@alpha-agents/ui", "@alpha-agents/domain", "@alpha-agents/config"],
};

export default config;
