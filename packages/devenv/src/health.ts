import { LOCAL_FORK_RPC_URL, MONAD_MAINNET_CHAIN_ID } from "@alpha-agents/config";
import { readForkConfig } from "./fork-pin.ts";
import { localPaths } from "./paths.ts";
import { run } from "./proc.ts";
import { hexToNumber, rpc } from "./rpc.ts";

/**
 * Health of the local stack, as `pnpm dev:status` and the dev console report
 * it. Every check returns data; nothing throws and nothing reads a secret.
 */
export interface ServiceHealth {
  readonly name: "postgres" | "redis" | "anvil";
  readonly up: boolean;
  readonly detail: string;
}

export interface AnvilState {
  readonly chainId: number;
  readonly blockNumber: number;
  /** Seconds, from the latest block. */
  readonly timestamp: number;
  /** The EVM family from anvil_nodeInfo; undefined if it could not be read. */
  readonly network: string | undefined;
}

export function composeArgs(composeFile: string = localPaths().composeFile): string[] {
  return ["compose", "-f", composeFile];
}

export function dockerReachable(): boolean {
  return run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 10_000 }).ok;
}

/**
 * The anvil fork's chain, block, time and network. Only the `network` field of
 * anvil_nodeInfo is read: the same response carries the fork URL, a secret.
 */
export async function anvilState(
  url: string = LOCAL_FORK_RPC_URL,
): Promise<AnvilState | undefined> {
  try {
    const chainId = hexToNumber(await rpc(url, "eth_chainId", [], 3_000));
    const block = (await rpc(url, "eth_getBlockByNumber", ["latest", false], 3_000)) as {
      number?: unknown;
      timestamp?: unknown;
    } | null;
    const info = (await rpc(url, "anvil_nodeInfo", [], 3_000).catch(() => null)) as {
      network?: unknown;
    } | null;
    return {
      chainId,
      blockNumber: hexToNumber(block?.number),
      timestamp: hexToNumber(block?.timestamp),
      network: typeof info?.network === "string" ? info.network : undefined,
    };
  } catch {
    return undefined;
  }
}

export interface StackHealth {
  readonly services: readonly ServiceHealth[];
  readonly anvil: AnvilState | undefined;
  readonly pinnedBlock: number | undefined;
  readonly healthy: boolean;
}

/** Postgres, Redis and the anvil fork, checked the same way for the CLI and the console. */
export async function stackHealth(url: string = LOCAL_FORK_RPC_URL): Promise<StackHealth> {
  const paths = localPaths();
  const services: ServiceHealth[] = [];

  if (!dockerReachable()) {
    services.push({ name: "postgres", up: false, detail: "Docker not reachable" });
    services.push({ name: "redis", up: false, detail: "Docker not reachable" });
  } else {
    const compose = composeArgs(paths.composeFile);
    const pg = run(
      "docker",
      [...compose, "exec", "-T", "postgres", "pg_isready", "-U", "alpha", "-d", "alpha_agents"],
      {
        timeoutMs: 15_000,
      },
    );
    services.push({
      name: "postgres",
      up: pg.ok,
      detail: pg.ok ? "accepting connections" : "not accepting connections",
    });
    const redis = run("docker", [...compose, "exec", "-T", "redis", "redis-cli", "ping"], {
      timeoutMs: 15_000,
    });
    const pong = redis.ok && redis.stdout.trim() === "PONG";
    services.push({ name: "redis", up: pong, detail: pong ? "PONG" : "not responding" });
  }

  let pinnedBlock: number | undefined;
  try {
    pinnedBlock = readForkConfig(paths.forkConfig).blockNumber;
  } catch {
    pinnedBlock = undefined;
  }
  const anvil = await anvilState(url);
  if (anvil === undefined) {
    services.push({ name: "anvil", up: false, detail: `no response at ${url}` });
  } else {
    const up =
      anvil.chainId === MONAD_MAINNET_CHAIN_ID &&
      anvil.network === "monad" &&
      pinnedBlock !== undefined &&
      anvil.blockNumber >= pinnedBlock;
    const atPin =
      anvil.blockNumber === pinnedBlock
        ? "at pinned block"
        : `pinned block is ${pinnedBlock ?? "unknown"}`;
    const net =
      anvil.network === "monad"
        ? "network monad"
        : `network ${anvil.network ?? "unknown"}, want monad`;
    services.push({
      name: "anvil",
      up,
      detail: `chain ID ${anvil.chainId}, ${net}, block ${anvil.blockNumber} (${atPin})`,
    });
  }

  return { services, anvil, pinnedBlock, healthy: services.every((s) => s.up) };
}
