import { spawn, type ChildProcess } from "node:child_process";

/**
 * A temporary Cloudflare quick tunnel from a public HTTPS hostname to the local gate, so the
 * cloud sandbox can reach the local gateway and tool server during the spike. The tunnel itself
 * has no authentication; the gate authenticates every request by the header E2B injects. The
 * real hosting choice (Q-37) replaces this tunnel.
 */
export interface Tunnel {
  readonly url: string;
  readonly host: string;
  close(): void;
}

export async function startTunnel(
  binary: string,
  localUrl: string,
  timeoutMs = 60_000,
): Promise<Tunnel> {
  const child: ChildProcess = spawn(binary, ["tunnel", "--no-autoupdate", "--url", localUrl], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  });
  // Covers a process.exit() before the caller holds close(), e.g. a signal mid-start.
  const killOnExit = () => child.kill("SIGTERM");
  process.once("exit", killOnExit);
  child.once("exit", () => process.off("exit", killOnExit));
  return new Promise<Tunnel>((resolve, reject) => {
    let seen = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`cloudflared gave no tunnel URL within ${timeoutMs} ms`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      seen += chunk.toString();
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(seen);
      if (match) {
        clearTimeout(timer);
        const url = match[0];
        resolve({ url, host: new URL(url).host, close: () => child.kill("SIGTERM") });
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`cloudflared exited with ${code} before giving a URL`));
    });
  });
}
