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
  /**
   * P3-U9: why the model provider refused, when the platform can tell. Only
   * `PROVIDER_OUT_OF_CREDIT` so far: the platform's own provider account is
   * empty, which no agent's credits can fix.
   */
  readonly reason?: "PROVIDER_OUT_OF_CREDIT" | StageCapReason;
  /** P3-U4: the cycle's stage run the call was made under, when there is one. */
  readonly stageRunId?: string;
  /** P3-U4: the model alias LiteLLM served (its model group), from the response. */
  readonly model?: string;
  /** P3-U4: the call's usage as LiteLLM's response reported it. */
  readonly usage?: ModelUsage;
}

/** Why the gate refused a model call under a stage: the stage reached one of its caps (P3-U4). */
export type StageCapReason = "TURN_CAP" | "TOKEN_CAP" | "CEILING";

/** One model call's usage as LiteLLM reports it in the response (P3-U4). */
export interface ModelUsage {
  /** LiteLLM's request ID, the same as its spend log's. */
  readonly requestId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** LiteLLM's cost of the call in USD. */
  readonly costUsd: number;
}

/**
 * The stage a lease is running and what it has used so far (P3-U4), from the
 * platform's records: the gate refuses a model call once the stage has made
 * its turns, used its tokens, or reached its ceiling.
 */
export interface GateStage {
  readonly stageRunId: string;
  readonly turns: number;
  readonly tokens: number;
  readonly ceilingUsdcE6: bigint;
  readonly used: {
    readonly calls: number;
    readonly tokens: number;
    /** The stage's charge so far: its paid tools plus its model calls at cost plus the markup. */
    readonly chargeUsdcE6: bigint;
  };
}

/** The cap a stage has reached, or null; pure, so the rule is tested alone. */
export function stageCapReached(stage: GateStage): StageCapReason | null {
  if (stage.used.calls >= stage.turns) return "TURN_CAP";
  if (stage.used.tokens >= stage.tokens) return "TOKEN_CAP";
  if (stage.ceilingUsdcE6 > 0n && stage.used.chargeUsdcE6 >= stage.ceilingUsdcE6) return "CEILING";
  return null;
}

/**
 * The answer to a model call past a stage's cap: a 402, which the pinned
 * Hermes treats as final and does not retry, so the run ends; the orchestrator
 * reads the reason from the gate's record and ends the stage as capped.
 */
export const stageCapBody = (reason: StageCapReason) => ({
  error: {
    message: `This research stage has reached its ${
      reason === "TURN_CAP" ? "turn" : reason === "TOKEN_CAP" ? "token" : "cost"
    } cap. The stage is over.`,
    type: "insufficient_quota",
    code: "stage_cap",
  },
});

/**
 * Reads a model response's usage: the last SSE chunk that carries `usage`
 * (Hermes streams with include_usage) or a plain JSON body. Null when there is
 * none, for example a refused call.
 */
export function usageFromResponse(body: string): ModelUsage | null {
  const objects: Record<string, unknown>[] = [];
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      objects.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      return null;
    }
  } else {
    for (const line of body.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "" || data === "[DONE]") continue;
      try {
        objects.push(JSON.parse(data) as Record<string, unknown>);
      } catch {
        // a partial or non-JSON line carries nothing we need
      }
    }
  }
  const id = objects.find((o) => typeof o.id === "string")?.id;
  const withUsage = objects.filter((o) => typeof o.usage === "object" && o.usage !== null).at(-1);
  if (typeof id !== "string" || !withUsage) return null;
  const u = withUsage.usage as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  return {
    requestId: id,
    inputTokens: n(u.prompt_tokens),
    outputTokens: n(u.completion_tokens),
    cacheReadTokens: n(u.cache_read_input_tokens) || n(details.cached_tokens),
    cacheWriteTokens: n(u.cache_creation_input_tokens) || n(details.cache_write_tokens),
    costUsd: n(u.cost),
  };
}

export interface GateCredentials {
  readonly lease: Lease;
  readonly virtualKey: string;
  readonly tier: string;
  /** P1-U6: the agent has no spendable credits; model calls get 402 without reaching LiteLLM. */
  readonly creditsExhausted?: boolean;
  /** P3-U4: the cycle stage the lease is running, with its caps and use so far. */
  readonly stage?: GateStage | null;
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
/** The platform's provider account is out of credit (Anthropic's wording, and OpenAI-style quota errors). */
export const isProviderOutOfCredit = (status: number, body: string): boolean =>
  status >= 400 &&
  /credit balance is too low|insufficient_quota|exceeded your current quota/i.test(body);

/**
 * The model failure a task should name, from the gate's calls for its lease:
 * the provider out of credit (a platform problem), or a refused call's status.
 * Null when every model call went through. Credit refusals (402) are the
 * agent's own billing and handled apart.
 */
export function modelFailure(calls: readonly GateLogEntry[]): string | null {
  if (calls.some((c) => c.reason === "PROVIDER_OUT_OF_CREDIT"))
    return "the model provider's account is out of credit (a platform problem, not the agent's credits)";
  const bad = calls.find((c) => c.status >= 400 && c.status !== 402);
  return bad ? `the model gateway answered ${bad.status}` : null;
}

export const isBudgetRefusal = (status: number, body: string): boolean =>
  (status === 429 || status === 400) && /budget_exceeded|budget has been exceeded/i.test(body);

export interface GateOptions {
  readonly litellmUrl: string;
  /** Resolves a token hash to its lease and the agent's key, or null. */
  readonly resolve: (tokenHash: string) => Promise<GateCredentials | null>;
  /** A per-process token that may only call /healthz, for the host's own tunnel check. */
  readonly probeToken: string;
  /** The tool servers' MCP endpoints (D-213), or none before they start. */
  readonly tools?: { readonly data: string; readonly platform: string; readonly chain?: string };
  /**
   * P3-U4: called with every forwarded model call's record and usage before
   * its response ends, so the next call's cap check sees it.
   */
  readonly onModelCall?: (entry: GateLogEntry & { readonly lease: Lease }) => Promise<void>;
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
    let stageRunId: string | null = null;
    const record = (
      status: number,
      reason?: GateLogEntry["reason"],
      extra: Pick<GateLogEntry, "model" | "usage"> = {},
    ): GateLogEntry => {
      const entry: GateLogEntry = {
        at: new Date(started).toISOString(),
        leaseId,
        method: req.method ?? "GET",
        path,
        status,
        ms: Date.now() - started,
        ...(reason ? { reason } : {}),
        ...(stageRunId ? { stageRunId } : {}),
        ...extra,
      };
      log.push(entry);
      if (log.length > 5_000) log.splice(0, log.length - 5_000);
      return entry;
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
            : path === "/mcp/chain"
              ? options.tools?.chain
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
      const stage = creds.stage ?? null;
      stageRunId = stage?.stageRunId ?? null;
      if (stage && req.method === "POST") {
        const cap = stageCapReached(stage);
        if (cap) {
          record(402, cap);
          res.writeHead(402, { "content-type": "application/json" });
          res.end(JSON.stringify(stageCapBody(cap)));
          return;
        }
      }
      const lease = creds.lease;

      const target = new URL(req.url ?? "/", litellm);
      const proxied = httpRequest(
        target,
        { method: req.method, headers: forwardHeaders(req.headers, target, creds) },
        (up) => {
          const status = up.statusCode ?? 502;
          if (status < 400) {
            res.writeHead(status, up.headers);
            // Streamed through as it arrives; the usage is read from the copy at the end.
            const chunks: Buffer[] = [];
            up.on("data", (c: Buffer) => {
              chunks.push(c);
              res.write(c);
            });
            up.on("end", () => {
              const group = up.headers["x-litellm-model-group"];
              const usage =
                req.method === "POST"
                  ? usageFromResponse(Buffer.concat(chunks).toString("utf8"))
                  : null;
              const entry = record(status, undefined, {
                ...(typeof group === "string" ? { model: group } : {}),
                ...(usage ? { usage } : {}),
              });
              const done =
                usage && options.onModelCall ? options.onModelCall({ ...entry, lease }) : null;
              void Promise.resolve(done)
                .catch(() => undefined)
                .finally(() => res.end());
            });
            return;
          }
          // Errors are small: read them, so a budget refusal can become a 402.
          const chunks: Buffer[] = [];
          up.on("data", (c: Buffer) => chunks.push(c));
          up.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            if (isBudgetRefusal(status, body)) return reply(402, CREDITS_EXHAUSTED_BODY);
            record(
              status,
              isProviderOutOfCredit(status, body) ? "PROVIDER_OUT_OF_CREDIT" : undefined,
            );
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
