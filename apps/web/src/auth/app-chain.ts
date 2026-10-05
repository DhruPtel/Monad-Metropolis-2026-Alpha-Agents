import { type AppChain, type EnvironmentId, appChain } from "@alpha-agents/config";

/**
 * The chain this build's browser talks to. A local test build inlines
 * LOCAL_FORK_PORT (next.config.ts) to use the test fork on 8546 instead of the
 * playtest fork (D-200); every other build uses the environment's chain.
 */
export function webAppChain(environment: EnvironmentId): AppChain {
  const port = process.env.LOCAL_FORK_PORT;
  return appChain(environment, port ? `http://127.0.0.1:${port}` : undefined);
}
