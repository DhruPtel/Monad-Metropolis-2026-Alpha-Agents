import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The gate is the only thing the sandbox can reach (through the tunnel). It is outside the
 * sandbox and authenticates every request by headers that are injected outside the sandbox
 * too, so no credential ever has to live inside it:
 *
 * - `x-alpha-gate`: the tunnel credential. Without it every request gets 401.
 * - `x-alpha-llm-key`: the agent's LiteLLM virtual key, forwarded to LiteLLM as the bearer.
 * - `x-alpha-tool-token`: the agent's tool token, forwarded to the platform tools server.
 *
 * All three are stripped before forwarding, and the log records only method, path, status and
 * duration. Routes: `/v1/*` to LiteLLM, `/mcp` to the platform tools server, `/healthz`.
 */
export const GATE_HEADER = "x-alpha-gate";
export const LLM_KEY_HEADER = "x-alpha-llm-key";
export const TOOL_TOKEN_HEADER = "x-alpha-tool-token";

export interface GateLogEntry {
  readonly at: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly upstream: "litellm" | "platform-tools" | "gate";
  readonly ms: number;
  /** For an upstream error status from LiteLLM: the error body, at most 600 characters. */
  readonly errorBody?: string;
}

export interface GateOptions {
  readonly gateSecret: string;
  readonly litellmUrl: string;
  readonly platformToolsUrl: string;
}

export interface Gate {
  readonly url: string;
  readonly port: number;
  readonly log: readonly GateLogEntry[];
  close(): Promise<void>;
}

function sameSecret(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function forwardHeaders(headers: IncomingHttpHeaders, target: URL, bearer: string) {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (name === "host" || name === "authorization" || name.startsWith("x-alpha-")) continue;
    if (name === "connection" || name === "keep-alive" || name === "transfer-encoding") continue;
    out[name] = value;
  }
  out.host = target.host;
  out.authorization = `Bearer ${bearer}`;
  return out;
}

export async function startGate(options: GateOptions, port = 0): Promise<Gate> {
  if (options.gateSecret.length < 32) throw new Error("the gate secret must be 32+ characters");
  const log: GateLogEntry[] = [];
  const litellm = new URL(options.litellmUrl);
  const tools = new URL(options.platformToolsUrl);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    const path = new URL(req.url ?? "/", "http://gate").pathname;
    const record = (status: number, upstream: GateLogEntry["upstream"], errorBody?: string) =>
      log.push({
        at: new Date(started).toISOString(),
        method: req.method ?? "GET",
        path,
        status,
        upstream,
        ms: Date.now() - started,
        ...(errorBody === undefined ? {} : { errorBody }),
      });
    const deny = (status: number) => {
      record(status, "gate");
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: status === 404 ? "not found" : "unauthorized" }));
    };

    if (!sameSecret(req.headers[GATE_HEADER], options.gateSecret)) return deny(401);
    if (path === "/healthz") {
      record(200, "gate");
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }

    let target: URL;
    let bearer: string | string[] | undefined;
    let upstream: GateLogEntry["upstream"];
    if (path.startsWith("/v1/")) {
      target = new URL(req.url ?? "/", litellm);
      bearer = req.headers[LLM_KEY_HEADER];
      upstream = "litellm";
    } else if (path === "/mcp") {
      target = new URL(tools);
      bearer = req.headers[TOOL_TOKEN_HEADER];
      upstream = "platform-tools";
    } else {
      return deny(404);
    }
    if (typeof bearer !== "string" || bearer.length === 0) return deny(401);

    const proxied = httpRequest(
      target,
      { method: req.method, headers: forwardHeaders(req.headers, target, bearer) },
      (up) => {
        const status = up.statusCode ?? 502;
        res.writeHead(status, up.headers);
        if (upstream === "litellm" && status >= 400) {
          // Keep the error body for the spike's budget-exhaustion record; stream it on unchanged.
          const chunks: Buffer[] = [];
          up.on("data", (c: Buffer) => chunks.push(c));
          up.on("end", () =>
            record(status, upstream, Buffer.concat(chunks).toString("utf8").slice(0, 600)),
          );
        } else {
          up.on("end", () => record(status, upstream));
        }
        up.pipe(res);
      },
    );
    proxied.on("error", () => {
      record(502, upstream);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upstream unavailable" }));
    });
    req.pipe(proxied);
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const bound = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${bound}`,
    port: bound,
    log,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
