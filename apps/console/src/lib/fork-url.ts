import { localForkRpcUrl } from "@alpha-agents/config";

/**
 * The fork every console action reads and changes: the playtest fork, or the
 * fork LOCAL_FORK_PORT names (D-200), as the scripts choose it. devenv takes
 * this URL as a required argument (L-100), so the choice is made here, once.
 */
export function consoleForkUrl(): string {
  return localForkRpcUrl(process.env);
}
