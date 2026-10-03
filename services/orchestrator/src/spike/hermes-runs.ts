/**
 * A minimal client for Hermes' API server runs interface (POST /v1/runs, GET /v1/runs/{id}).
 * The HTTP call is pluggable: locally it is fetch; for a sandbox the orchestrator runs curl
 * inside the sandbox, because the API server listens on the sandbox's loopback only.
 */
export interface HttpReply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type HttpCall = (
  method: "GET" | "POST",
  url: string,
  headers: Record<string, string>,
  body?: string,
) => Promise<HttpReply>;

export const fetchCall: HttpCall = async (method, url, headers, body) => {
  const res = await fetch(url, { method, headers, ...(body === undefined ? {} : { body }) });
  return {
    status: res.status,
    headers: Object.fromEntries([...res.headers.entries()].map(([k, v]) => [k.toLowerCase(), v])),
    body: await res.text(),
  };
};

export interface RunStart {
  readonly runId: string;
  readonly replayed: boolean;
  readonly raw: unknown;
}

export interface RunState {
  readonly status: string;
  readonly failure: unknown;
  readonly raw: Record<string, unknown>;
}

const TERMINAL = new Set([
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "interrupted",
  "stopped",
  "expired",
]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HermesRuns {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly call: HttpCall;

  constructor(baseUrl: string, apiKey: string, call: HttpCall = fetchCall) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.call = call;
  }

  private auth(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}` };
  }

  async waitHealthy(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = "no response";
    while (Date.now() < deadline) {
      try {
        const reply = await this.call("GET", `${this.baseUrl}/health`, {});
        if (reply.status === 200) return;
        last = `status ${reply.status}`;
      } catch (err) {
        last = String(err);
      }
      await sleep(1000);
    }
    throw new Error(`Hermes API server not healthy within ${timeoutMs} ms (${last})`);
  }

  async start(idempotencyKey: string, input: string, sessionId: string): Promise<RunStart> {
    const reply = await this.call(
      "POST",
      `${this.baseUrl}/v1/runs`,
      { ...this.auth(), "content-type": "application/json", "idempotency-key": idempotencyKey },
      JSON.stringify({ input, session_id: sessionId }),
    );
    if (reply.status >= 300)
      throw new Error(`POST /v1/runs returned ${reply.status}: ${reply.body.slice(0, 500)}`);
    const raw = JSON.parse(reply.body) as Record<string, unknown>;
    const runId = String(raw.run_id ?? raw.id ?? "");
    if (runId === "")
      throw new Error(`POST /v1/runs returned no run id: ${reply.body.slice(0, 500)}`);
    return { runId, replayed: reply.headers["idempotency-replayed"] === "true", raw };
  }

  async get(runId: string): Promise<RunState> {
    const reply = await this.call("GET", `${this.baseUrl}/v1/runs/${runId}`, this.auth());
    if (reply.status !== 200) throw new Error(`GET /v1/runs/${runId} returned ${reply.status}`);
    const raw = JSON.parse(reply.body) as Record<string, unknown>;
    return {
      status: String(raw.status ?? "unknown"),
      failure: raw.failure_reason ?? raw.error ?? null,
      raw,
    };
  }

  async waitFinished(runId: string, timeoutMs: number): Promise<RunState> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.get(runId);
      if (TERMINAL.has(state.status)) return state;
      await sleep(1500);
    }
    throw new Error(`run ${runId} did not finish within ${timeoutMs} ms`);
  }
}
