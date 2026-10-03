import { existsSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";
import { assertConsoleEnvironment, repoRoot } from "@alpha-agents/devenv";

// The console reads the repository's root .env (without overriding variables
// already set) and refuses to build or start unless APP_ENV is local.
const rootEnv = join(repoRoot(), ".env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
assertConsoleEnvironment();

const config: NextConfig = {
  reactStrictMode: true,
  // Stop `next dev` writing AGENTS.md and CLAUDE.md when it detects an AI agent.
  agentRules: false,
  transpilePackages: [
    "@alpha-agents/ui",
    "@alpha-agents/devenv",
    "@alpha-agents/policy",
    "@alpha-agents/domain",
    "@alpha-agents/config",
  ],
};

export default config;
