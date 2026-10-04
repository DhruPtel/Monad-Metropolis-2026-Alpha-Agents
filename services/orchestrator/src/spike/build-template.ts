/**
 * Builds the E2B sandbox template from infra/e2b/hermes.Dockerfile. Reproducible: the base image
 * is pinned by digest, uv by version and Hermes by commit, installed from its own lockfile.
 *
 *   node services/orchestrator/src/spike/build-template.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultBuildLogger, Template } from "e2b";
import { loadConfig } from "@alpha-agents/config";
import { TEMPLATE_NAME } from "./hermes-config.ts";

const ROOT = resolve(import.meta.dirname, "../../../..");

async function main() {
  const envFile = join(ROOT, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  // Validates that the key is set without ever printing it; the SDK reads E2B_API_KEY itself.
  loadConfig({ name: "E2B template build", requires: ["E2B_API_KEY"] });
  const dockerfile = readFileSync(join(ROOT, "infra/e2b/hermes.Dockerfile"), "utf8");
  const info = await Template.build(Template().fromDockerfile(dockerfile), TEMPLATE_NAME, {
    cpuCount: 2,
    memoryMB: 2048,
    onBuildLogs: defaultBuildLogger(),
  });
  console.log(`template ${TEMPLATE_NAME} built: ${JSON.stringify(info)}`);
}

await main();
