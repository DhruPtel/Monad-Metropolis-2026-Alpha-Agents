import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

/**
 * A retrying JSON-RPC proxy between anvil and the fork's upstream (D-220,
 * L-87, L-91). The upstream is load balanced, and some of its nodes answer a
 * block they do not keep with `null` (about half the time for a block with its
 * transactions), or with "not found"; anvil takes either as final and the
 * fork fails. The proxy retries exactly those answers, plus rate limits,
 * server errors and dropped connections, with backoff, alternating between
 * the primary and secondary upstream when there are two. Anything else passes
 * through unchanged, once. It listens on loopback only, and the upstream URL
 * appears in no error it returns.
 */
export interface UpstreamProxy {
  readonly url: string;
  /** Requests retried since the proxy started, for logs and tests. */
  readonly retries: () => number;
  stop(): Promise<void>;
}

export interface UpstreamProxyOptions {
  readonly upstreams: readonly string[];
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly fetchFn?: typeof fetch;
  /** Each retry and each slow answer, by method and reason only (never the URL). */
  readonly log?: (line: string) => void;
  /** Per-attempt timeout; the whole retry budget stays under anvil's own request timeout. */
  readonly attemptTimeoutMs?: number;
}

/**
 * Block lookups, whose null answer for a fixed block means "this node lacks
 * it". Transaction lookups are not here: anvil asks the upstream about its own
 * local transactions too, and for those null is the true answer.
 */
const LOOKUPS = new Set(["eth_getBlockByNumber", "eth_getBlockByHash", "eth_getBlockReceipts"]);
const TRANSIENT = /not found|missing|unavailable|header|timeout|rate limit|try again/i;

interface RpcMessage {
  method?: string;
  params?: unknown[];
  result?: unknown;
  error?: { message?: string };
}

/** Whether one request's answer should be asked again elsewhere. */
export function retryable(request: RpcMessage, reply: RpcMessage): boolean {
  if (reply.error) return TRANSIENT.test(reply.error.message ?? "");
  if (reply.result !== null || !request.method || !LOOKUPS.has(request.method)) return false;
  // "latest" and "pending" can be legitimately missing on a fresh node; a fixed block cannot.
  const tag = request.params?.[0];
  return !(typeof tag === "string" && (tag === "latest" || tag === "pending"));
}

export async function startUpstreamProxy(o: UpstreamProxyOptions): Promise<UpstreamProxy> {
  if (o.upstreams.length === 0) throw new Error("the upstream proxy needs an upstream");
  // At most about 35 s in all, under anvil's 45 s request timeout (raised further by the fork start).
  const attempts = o.attempts ?? 6;
  const base = o.baseDelayMs ?? 250;
  const fetchFn = o.fetchFn ?? fetch;
  let retried = 0;

  const forward = async (body: string): Promise<{ status: number; text: string }> => {
    const request = JSON.parse(body) as RpcMessage | RpcMessage[];
    const method = Array.isArray(request)
      ? `batch of ${request.length}`
      : (request.method ?? "unknown");
    const started = Date.now();
    const note = (attempt: number, reason: string) =>
      o.log?.(
        `upstream proxy: ${method} attempt ${attempt + 1} ${reason} after ${Date.now() - started} ms`,
      );
    let last = { status: 502, text: JSON.stringify({ error: "upstream unavailable" }) };
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const upstream = o.upstreams[attempt % o.upstreams.length] as string;
      if (attempt > 0) {
        retried += 1;
        await new Promise((r) => setTimeout(r, Math.min(1_500, base * 2 ** (attempt - 1))));
      }
      let res: Response;
      try {
        res = await fetchFn(upstream, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(o.attemptTimeoutMs ?? 6_000),
        });
      } catch (err) {
        note(
          attempt,
          err instanceof Error && err.name === "TimeoutError" ? "timed out" : "dropped",
        );
        continue;
      }
      const text = await res.text();
      last = { status: res.status, text };
      if (res.status === 429 || res.status >= 500) {
        note(attempt, `answered ${res.status}`);
        continue;
      }
      if (!res.ok) return last;
      let reply: RpcMessage | RpcMessage[];
      try {
        reply = JSON.parse(text) as RpcMessage | RpcMessage[];
      } catch {
        note(attempt, "answered with a body that is not JSON");
        continue;
      }
      const pairs = Array.isArray(request)
        ? request.map((q, i) => [q, (reply as RpcMessage[])[i] ?? {}] as const)
        : [[request, reply as RpcMessage] as const];
      if (!pairs.some(([q, r]) => retryable(q, r))) return last;
      note(attempt, "answered null or not found");
    }
    return last;
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void forward(Buffer.concat(chunks).toString("utf8")).then(
        ({ status, text }) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(text);
        },
        () => {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "parse error" },
            }),
          );
        },
      );
    });
  });
  // anvil's HTTP client keeps connections in a pool and reuses them after long
  // idle gaps; Node's default 5-second keep-alive closes them first, and the
  // next request on a closing socket fails as "error sending request".
  server.keepAliveTimeout = 10 * 60_000;
  server.headersTimeout = 10 * 60_000 + 1_000;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    retries: () => retried,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const PROXY_MAIN = fileURLToPath(new URL("./upstream-proxy-main.ts", import.meta.url));

/**
 * Starts the proxy in a process of its own (L-91) and resolves once it
 * listens. Its log lines go to `log`; it stops with `stop()`, on this
 * process's exit or signals, or when this process goes away (its IPC channel
 * closes).
 */
export async function startUpstreamProxyProcess(o: {
  readonly upstreams: readonly string[];
  readonly log?: (line: string) => void;
}): Promise<{ readonly url: string; stop(): Promise<void> }> {
  const child = spawn(process.execPath, [PROXY_MAIN], {
    env: { ...process.env, UPSTREAM_PROXY_URLS: JSON.stringify(o.upstreams) },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stderr?.on("data", (c: Buffer) => {
    for (const line of c.toString("utf8").split("\n").filter(Boolean)) o.log?.(line);
  });
  const kill = () => child.kill("SIGTERM");
  process.once("exit", kill);
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, kill);
  const url = await new Promise<string>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error("the upstream proxy did not start")), 15_000);
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
      const m = /PROXY_URL (\S+)/.exec(out);
      if (m?.[1]) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.once("exit", () => reject(new Error("the upstream proxy exited before it listened")));
  });
  return {
    url,
    stop: async () => {
      process.off("exit", kill);
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.off(sig, kill);
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((r) => child.once("exit", r));
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  };
}
