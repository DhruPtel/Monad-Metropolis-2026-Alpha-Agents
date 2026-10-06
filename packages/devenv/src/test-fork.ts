import { type ChildProcess, spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  LOCAL_FORK_CHAIN_ID,
  LOCAL_FORK_RPC_URL,
  LOCAL_TEST_FORK_PORT,
} from "@alpha-agents/config";
import { readForkConfig } from "./fork-pin.ts";
import { localPaths } from "./paths.ts";
import { redact } from "./redact.ts";
import {
  FORK_START_ATTEMPTS,
  backoffMs,
  forkUpstreams,
  servesBlock,
  upstreamFor,
} from "./upstream.ts";

/**
 * A fork of its own for tests (D-200): the same fork as `pnpm dev:up` (Monad
 * mainnet at the pinned block, chain 143143, Monad's EVM) on another port, so
 * a test that needs a fresh deck, resets the chain or mints the only bee never
 * touches the playtest fork on 8545. A loaded state dump restores state but
 * not history (L-63), so the playtest fork must never be reset at all.
 *
 * Its log goes to .dev/test-fork-<port>.log with the upstream URL redacted.
 * A test fork left by a crashed run is found by its PID file and stopped
 * before a new one starts (L-19).
 */
export interface TestFork {
  readonly url: string;
  readonly port: number;
  stop(): Promise<void>;
}

export interface TestForkOptions {
  readonly port?: number;
  /** The environment holding MONAD_RPC_URL; the root .env is loaded if it is missing. */
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

/** The fork's primary upstream, from the environment or the root .env; null when neither has it. */
export function testForkUpstream(env: NodeJS.ProcessEnv = process.env): string | null {
  return forkUpstreams(env)[0] ?? null;
}

async function chainIdAt(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(2_000),
    });
    const body = (await res.json()) as { result?: string };
    return body.result ? Number(body.result) : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function exited(child: ChildProcess, ms: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Starts a test fork and waits until it answers as chain 143143. */
export async function startTestFork(options: TestForkOptions = {}): Promise<TestFork> {
  const port = options.port ?? LOCAL_TEST_FORK_PORT;
  const url = `http://127.0.0.1:${port}`;
  if (url === LOCAL_FORK_RPC_URL)
    throw new Error("a test fork never runs on the playtest fork's port, 8545");
  const upstreams = forkUpstreams(options.env);
  if (upstreams.length === 0)
    throw new Error("a test fork needs MONAD_RPC_URL (in the environment or .env)");

  const paths = localPaths();
  mkdirSync(paths.devDir, { recursive: true });
  const pidFile = join(paths.devDir, `test-fork-${port}.pid`);
  if (existsSync(pidFile)) {
    const stale = Number(readFileSync(pidFile, "utf8"));
    if (Number.isInteger(stale) && alive(stale)) process.kill(stale, "SIGTERM");
    rmSync(pidFile, { force: true });
    await new Promise((r) => setTimeout(r, 500));
  }
  if ((await chainIdAt(url)) !== null) {
    throw new Error(
      `something already answers on port ${port}; stop it before starting a test fork`,
    );
  }

  const { blockNumber } = readForkConfig(paths.forkConfig);
  const log = createWriteStream(join(paths.devDir, `test-fork-${port}.log`), { flags: "w" });
  const write = (chunk: Buffer) => log.write(redact(chunk.toString("utf8"), upstreams));
  const deadline = Date.now() + (options.timeoutMs ?? 180_000);
  const giveUp = () => {
    log.end();
    return new Error(`the test fork on port ${port} did not start; see .dev/test-fork-${port}.log`);
  };

  // The upstream sometimes answers the pinned block as missing (L-87): ask for
  // it before each attempt, back off between attempts, and alternate with the
  // secondary upstream when there is one (D-220).
  for (let attempt = 1; ; attempt++) {
    const upstream = upstreamFor(upstreams, attempt);
    const which = upstreams.indexOf(upstream) === 0 ? "primary" : "secondary";
    if (!(await servesBlock(upstream, blockNumber))) {
      log.write(`attempt ${attempt}: the ${which} upstream did not serve block ${blockNumber}\n`);
      if (attempt >= FORK_START_ATTEMPTS || Date.now() >= deadline) throw giveUp();
      await new Promise((r) => setTimeout(r, backoffMs(attempt)));
      continue;
    }
    log.write(`attempt ${attempt}: starting anvil on the ${which} upstream\n`);
    const child = spawn(
      "anvil",
      [
        "--fork-url",
        "monad",
        "--fork-block-number",
        String(blockNumber),
        "--chain-id",
        String(LOCAL_FORK_CHAIN_ID),
        "--network",
        "monad",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        cwd: paths.monadDir,
        env: { ...process.env, ...options.env, MONAD_RPC_URL: upstream },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.on("data", write);
    child.stderr?.on("data", write);
    if (child.pid) writeFileSync(pidFile, String(child.pid));

    const stop = async () => {
      process.off("exit", onExit);
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.off(sig, onSignal);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited(child, 5_000);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      rmSync(pidFile, { force: true });
    };
    // A test runner killed by a signal must not leave the fork running (L-22).
    const onExit = () => child.kill("SIGTERM");
    const onSignal = () => {
      child.kill("SIGTERM");
      rmSync(pidFile, { force: true });
    };
    process.once("exit", onExit);
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, onSignal);

    while (Date.now() < deadline && child.exitCode === null) {
      if ((await chainIdAt(url)) === LOCAL_FORK_CHAIN_ID) {
        return {
          url,
          port,
          stop: async () => {
            await stop();
            log.end();
          },
        };
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    await stop();
    if (attempt >= FORK_START_ATTEMPTS || Date.now() >= deadline) throw giveUp();
    await new Promise((r) => setTimeout(r, backoffMs(attempt)));
  }
}
