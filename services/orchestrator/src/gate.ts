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
 *
 * P1-U7 (D-213): `/mcp/data` and `/mcp/platform` go to the tool servers, with
 * the lease's gate token as the bearer. Each tool server resolves the agent
 * from that token itself, so the gate never vouches for an identity.
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
  /** P1-U6: the agent has no spendable credits; model calls get 402 without reaching LiteLLM. */
  readonly creditsExhausted?: boolean;
}

/**
 * The answer to a model call when credits are gone (D-209): HTTP 402 with
 * `insufficient_quota`, which the pinned Hermes classifies as billing and does
 * not retry (agent/turn_api_error.py). LiteLLM's own refusal, 429
 * `budget_exceeded` (spike H-10, which Hermes retried as a rate limit), is
 * replaced by the same answer. No "try again" wording: Hermes reads a 402 that
 * says so as a temporary limit.
 */
export const CREDITS_EXHAUSTED_BODY = {
  error: {
    message:
      "Credits exhausted: this agent has no credits left. Its owner adds USDC to its funding address.",
    type: "insufficient_quota",
    code: "insufficient_quota",
  },
};

/** LiteLLM's budget refusal, as it words it (seen in H-10 and in P1-U6's probe). */
export const isBudgetRefusal = (status: number, body: string): boolean =>
  (status === 429 || status === 400) && /budget_exceeded|budget has been exceeded/i.test(body);

export interface GateOptions {
  readonly litellmUrl: string;
  /** Resolves a token hash to its lease and the agent's key, or null. */
  readonly resolve: (tokenHash: string) => Promise<GateCredentials | null>;
  /** A per-process token that may only call /healthz, for the host's own tunnel check. */
  readonly probeToken: string;
  /** The tool servers' MCP endpoints (D-213), or none before they start. */
  readonly tools?: { readonly data: string; readonly platform: string };
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

/** The sandbox's headers minus anything that could carry or claim an identity. */
function sandboxHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (name === "host" || name === "authorization" || name.startsWith("x-alpha-")) continue;
    if (name.startsWith("x-agent-")) continue;
    if (name === "connection" || name === "keep-alive" || name === "transfer-encoding") continue;
    out[name] = value;
  }
  return out;
}

function forwardHeaders(
  headers: IncomingHttpHeaders,
  target: URL,
  creds: GateCredentials,
): Record<string, string | string[]> {
  const out = sandboxHeaders(headers);
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
      const toolServer =
        path === "/mcp/data"
          ? options.tools?.data
          : path === "/mcp/platform"
            ? options.tools?.platform
            : undefined;
      if (toolServer) {
        const target = new URL(toolServer);
        const proxied = httpRequest(
          target,
          {
            method: req.method,
            headers: {
              ...sandboxHeaders(req.headers),
              host: target.host,
              authorization: `Bearer ${token}`,
            },
          },
          (up) => {
            const status = up.statusCode ?? 502;
            res.writeHead(status, up.headers);
            up.on("end", () => record(status));
            up.pipe(res);
          },
        );
        proxied.on("error", () => {
          if (!res.headersSent) reply(502, { error: "tool server unavailable" });
          else res.end();
        });
        req.pipe(proxied);
        return;
      }
      if (!path.startsWith("/v1/")) return reply(404, { error: "not found" });
      if (creds.creditsExhausted) return reply(402, CREDITS_EXHAUSTED_BODY);

      const target = new URL(req.url ?? "/", litellm);
      const proxied = httpRequest(
        target,
        { method: req.method, headers: forwardHeaders(req.headers, target, creds) },
        (up) => {
          const status = up.statusCode ?? 502;
          if (status < 400) {
            res.writeHead(status, up.headers);
            up.on("end", () => record(status));
            up.pipe(res);
            return;
          }
          // Errors are small: read them, so a budget refusal can become a 402.
          const chunks: Buffer[] = [];
          up.on("data", (c: Buffer) => chunks.push(c));
          up.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            if (isBudgetRefusal(status, body)) return reply(402, CREDITS_EXHAUSTED_BODY);
            record(status);
            res.writeHead(status, up.headers);
            res.end(body);
          });
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
