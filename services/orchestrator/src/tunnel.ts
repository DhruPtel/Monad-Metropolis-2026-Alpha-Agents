import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * A Cloudflare quick tunnel from a public HTTPS host to the local gate, so a
 * cloud sandbox can reach it until hosting is chosen (Q-37, D-203). The tunnel
 * has no authentication; the gate checks every request's token. Its PID goes to
 * a file named for the namespace, so the next run's startup sweep can stop a
 * tunnel this process left behind when it was killed (L-19).
 */
export interface Tunnel {
  readonly url: string;
  readonly host: string;
  readonly pid: number;
  close(): Promise<void>;
}

export const tunnelPidFile = (devDir: string, namespace: string): string =>
  join(devDir, `orchestrator-${namespace}-tunnel.pid`);

export function findCloudflared(): string {
  const candidates = [process.env.CLOUDFLARED, join(homedir(), ".local/bin/cloudflared")];
  for (const c of candidates) if (c && existsSync(c)) return c;
  const which = spawnSync("which", ["cloudflared"], { encoding: "utf8" });
  if (which.status === 0) return which.stdout.trim();
  throw new Error("cloudflared not found: install it to ~/.local/bin or set CLOUDFLARED");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isCloudflared(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("cloudflared");
  } catch {
    return false;
  }
}

/** Stops the tunnel a PID file names, if it is still a cloudflared process. */
export async function stopTunnelFromPidFile(pidFile: string): Promise<number | null> {
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  rmSync(pidFile, { force: true });
  if (!Number.isInteger(pid) || pid <= 1 || !alive(pid) || !isCloudflared(pid)) return null;
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 50 && alive(pid); i += 1) await new Promise((r) => setTimeout(r, 100));
  if (alive(pid)) process.kill(pid, "SIGKILL");
  return pid;
}

export async function startTunnel(
  binary: string,
  localUrl: string,
  pidFile: string,
  timeoutMs = 60_000,
): Promise<Tunnel> {
  mkdirSync(dirname(pidFile), { recursive: true });
  const child: ChildProcess = spawn(binary, ["tunnel", "--no-autoupdate", "--url", localUrl], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  });
  if (!child.pid) throw new Error("cloudflared did not start");
  const pid = child.pid;
  writeFileSync(pidFile, String(pid));
  const close = async () => {
    process.off("exit", onExit);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    rmSync(pidFile, { force: true });
  };
  // Covers a normal exit; a hard kill leaves the PID file for the sweep.
  const onExit = () => child.kill("SIGTERM");
  process.once("exit", onExit);
  return new Promise<Tunnel>((resolve, reject) => {
    let seen = "";
    const timer = setTimeout(() => {
      void close();
      reject(new Error(`cloudflared gave no tunnel URL within ${timeoutMs} ms`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      seen = (seen + chunk.toString()).slice(-8_000);
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(seen);
      if (match) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        // Keep draining the pipes so cloudflared never blocks on a full buffer.
        child.stdout?.resume();
        child.stderr?.resume();
        resolve({ url: match[0], host: new URL(match[0]).host, pid, close });
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      rmSync(pidFile, { force: true });
      reject(new Error(`cloudflared exited with ${code} before giving a URL`));
    });
  });
}
