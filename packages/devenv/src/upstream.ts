import { existsSync, readFileSync } from "node:fs";
import { localPaths } from "./paths.ts";

/**
 * The fork's upstream RPCs (D-220). The provider behind MONAD_RPC_URL is load
 * balanced, and about one request in six for the pinned block reaches a node
 * that does not keep it (L-87), so a fork start asks for the block first,
 * retries with exponential backoff, and alternates with MONAD_RPC_URL_SECONDARY
 * when one is configured.
 */
export const FORK_START_ATTEMPTS = 6;

/** A value from the environment, or from the root .env when the environment lacks it. */
function fromEnv(name: string, env: NodeJS.ProcessEnv): string | null {
  const direct = env[name]?.trim();
  if (direct) return direct;
  const envFile = localPaths().env;
  if (!existsSync(envFile)) return null;
  const match = new RegExp(`^${name}=(.*)$`, "m").exec(readFileSync(envFile, "utf8"));
  const value = match?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\r$/, "");
  return value || null;
}

/** The primary upstream and, when configured, the secondary; empty when neither is set. */
export function forkUpstreams(env: NodeJS.ProcessEnv = process.env): string[] {
  const primary = fromEnv("MONAD_RPC_URL", env);
  const secondary = fromEnv("MONAD_RPC_URL_SECONDARY", env);
  return [primary, secondary].filter((u, i, all): u is string => !!u && all.indexOf(u) === i);
}

/** The upstream for an attempt (1-based): the primary first, then alternating when there are two. */
export function upstreamFor(upstreams: readonly string[], attempt: number): string {
  const u = upstreams[(attempt - 1) % upstreams.length];
  if (!u) throw new Error("no fork upstream: set MONAD_RPC_URL");
  return u;
}

/** Exponential backoff before the next attempt: 1, 2, 4, 8, then 16 seconds at most. */
export function backoffMs(attempt: number, baseMs = 1_000, capMs = 16_000): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

/** Whether the upstream serves the block now: one eth_getBlockByNumber with a hash in reply. */
export async function servesBlock(
  url: string,
  blockNumber: number,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getBlockByNumber",
        params: [`0x${blockNumber.toString(16)}`, false],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { result?: { hash?: string } | null };
    return typeof body.result?.hash === "string";
  } catch {
    return false;
  }
}
