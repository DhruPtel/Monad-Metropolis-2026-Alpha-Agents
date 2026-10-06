import { timingSafeEqual } from "node:crypto";
import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
  createServer,
  request as httpRequest,
} from "node:http";
import type { AddressInfo } from "node:net";
import { sha256Hex } from "./secrets.ts";
import type { Lease } from "./store.ts";

/**
 * The gate (D-203): the only thing a sandbox can reach, through the tunnel.
 * E2B's egress proxy adds one header outside the sandbox, the lease's gate
 * token. The gate looks the token up (active, unexpired lease only), then
 * forwards `/v1/*` to LiteLLM with the agent's own virtual key as the bearer and
 * the agent's ID and tier as headers it sets itself. The virtual key never
 * leaves this process for E2B or the sandbox. Every `x-alpha-*` and
 * authorization header from the sandbox is dropped, so a sandbox cannot choose
 * whose key is used. The log holds method, path, status and duration only.
 */
export const GATE_HEADER = "x-alpha-gate";

export interface GateLogEntry {
  readonly at: string;
  readonly leaseId: string | null;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly ms: number;
}

export interface GateCredentials {
  readonly lease: Lease;
  readonly virtualKey: string;
  readonly tier: string;
}

export interface GateOptions {
  readonly litellmUrl: string;
  /** Resolves a token hash to its lease and the agent's key, or null. */
  readonly resolve: (tokenHash: string) => Promise<GateCredentials | null>;
  /** A per-process token that may only call /healthz, for the host's own tunnel check. */
  readonly probeToken: string;
}

export interface Gate {
  readonly url: string;
  readonly port: number;
  readonly log: readonly GateLogEntry[];
  /** Model calls the gate forwarded for one lease, by status. */
  callsFor(leaseId: string): GateLogEntry[];
  close(): Promise<void>;
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function forwardHeaders(
  headers: IncomingHttpHeaders,
  target: URL,
  creds: GateCredentials,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (name === "host" || name === "authorization" || name.startsWith("x-alpha-")) continue;
    if (name.startsWith("x-agent-")) continue;
    if (name === "connection" || name === "keep-alive" || name === "transfer-encoding") continue;
    out[name] = value;
  }
  out.host = target.host;
  out.authorization = `Bearer ${creds.virtualKey}`;
  out["x-agent-id"] = `${creds.lease.chainId}-${creds.lease.agentId}`;
  out["x-agent-tier"] = creds.tier;
  return out;
}

export async function startGate(options: GateOptions, port = 0): Promise<Gate> {
  const log: GateLogEntry[] = [];
  const litellm = new URL(options.litellmUrl);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    const path = new URL(req.url ?? "/", "http://gate").pathname;
    let leaseId: string | null = null;
    const record = (status: number) => {
      log.push({
        at: new Date(started).toISOString(),
        leaseId,
        method: req.method ?? "GET",
        path,
        status,
        ms: Date.now() - started,
      });
      if (log.length > 5_000) log.splice(0, log.length - 5_000);
    };
    const reply = (status: number, body: unknown) => {
      record(status);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    void (async () => {
      const token = req.headers[GATE_HEADER];
      if (typeof token !== "string" || token.length === 0)
        return reply(401, { error: "unauthorized" });
      if (path === "/healthz" && same(token, options.probeToken)) return reply(200, { ok: true });
      let creds: GateCredentials | null;
      try {
        creds = await options.resolve(sha256Hex(token));
      } catch {
        return reply(503, { error: "gate unavailable" });
      }
      if (!creds) return reply(401, { error: "unauthorized" });
      leaseId = creds.lease.leaseId;
      if (path === "/healthz") return reply(200, { ok: true });
      // Tool servers join here with P1-U7 (/mcp); until then the gate serves the model only.
      if (!path.startsWith("/v1/")) return reply(404, { error: "not found" });

      const target = new URL(req.url ?? "/", litellm);
      const proxied = httpRequest(
        target,
        { method: req.method, headers: forwardHeaders(req.headers, target, creds) },
        (up) => {
          const status = up.statusCode ?? 502;
          res.writeHead(status, up.headers);
          up.on("end", () => record(status));
          up.pipe(res);
        },
      );
      proxied.on("error", () => {
        if (!res.headersSent) reply(502, { error: "upstream unavailable" });
        else res.end();
      });
      req.pipe(proxied);
    })();
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const bound = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${bound}`,
    port: bound,
    log,
    callsFor: (leaseId) => log.filter((e) => e.leaseId === leaseId && e.path.startsWith("/v1/")),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
