import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CREDITS_EXHAUSTED_BODY,
  type Gate,
  GATE_HEADER,
  type GateLogEntry,
  isProviderOutOfCredit,
  modelFailure,
  stageCapReached,
  startGate,
  usageFromResponse,
} from "./gate.ts";
import { sha256Hex } from "./secrets.ts";
import type { Lease } from "./store.ts";

const lease = (leaseId: string, agentId: number): Lease => ({
  leaseId,
  chainId: 143143,
  agentId,
  runTag: "r",
  namespace: "unit",
  purpose: "noop",
  sandboxId: null,
  gateTokenHash: "",
  status: "active",
  startedAt: new Date(),
  expiresAt: new Date(Date.now() + 60_000),
  endedAt: null,
  endReason: null,
});

describe("the gate (D-203)", () => {
  const seen: IncomingHttpHeaders[] = [];
  let upstream: ReturnType<typeof createServer>;
  let gate: Gate;
  const tokens = new Map([
    [
      sha256Hex("token-agent-1-aaaaaaaaaaaaaaaaaaaaaaaa"),
      { lease: lease("L1", 1), virtualKey: "sk-agent-one", tier: "pro" },
    ],
    [
      sha256Hex("token-agent-2-bbbbbbbbbbbbbbbbbbbbbbbb"),
      { lease: lease("L2", 2), virtualKey: "sk-agent-two", tier: "base" },
    ],
    [
      sha256Hex("token-agent-3-dddddddddddddddddddddddd"),
      { lease: lease("L3", 3), virtualKey: "sk-agent-three", tier: "base", creditsExhausted: true },
    ],
  ]);

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      seen.push(req.headers);
      if (req.url === "/v1/budget") {
        // LiteLLM's refusal once a key's spend reaches its budget (H-10, P1-U6 probe).
        res.writeHead(429, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({
            error: {
              message:
                "Budget has been exceeded! Key=k (sk-...abcd) Current cost: 2.9e-05, Max budget: 1e-05",
              type: "budget_exceeded",
              code: "429",
            },
          }),
        );
      }
      if (req.url === "/v1/busy") {
        res.writeHead(429, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "rate limited", type: "rate_limit" } }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ path: req.url }));
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    gate = await startGate({
      litellmUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      probeToken: "probe-token-cccccccccccccccccccccccccc",
      resolve: async (hash) => tokens.get(hash) ?? null,
    });
  });
  afterAll(async () => {
    await gate.close();
    await new Promise((r) => upstream.close(r));
  });

  const call = (path: string, headers: Record<string, string>) =>
    fetch(`${gate.url}${path}`, { method: "POST", headers, body: "{}" });

  it("forwards a model call with the agent's own key and identity", async () => {
    const res = await call("/v1/chat/completions", {
      [GATE_HEADER]: "token-agent-1-aaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(res.status).toBe(200);
    const h = seen.at(-1) ?? {};
    expect(h.authorization).toBe("Bearer sk-agent-one");
    expect(h["x-agent-id"]).toBe("143143-1");
    expect(h["x-agent-tier"]).toBe("pro");
    expect(h[GATE_HEADER]).toBeUndefined();
    expect(gate.callsFor("L1").map((c) => [c.path, c.status])).toEqual([
      ["/v1/chat/completions", 200],
    ]);
  });

  it("drops a key, an identity or another gate header the sandbox forges", async () => {
    await call("/v1/chat/completions", {
      [GATE_HEADER]: "token-agent-2-bbbbbbbbbbbbbbbbbbbbbbbb",
      authorization: "Bearer sk-agent-one",
      "x-agent-id": "143143-1",
      "x-alpha-llm-key": "sk-agent-one",
    });
    const h = seen.at(-1) ?? {};
    expect(h.authorization).toBe("Bearer sk-agent-two");
    expect(h["x-agent-id"]).toBe("143143-2");
    expect(h["x-alpha-llm-key"]).toBeUndefined();
  });

  it("refuses a missing or unknown token, and serves nothing but /v1 and /healthz", async () => {
    const before = seen.length;
    expect((await call("/v1/chat/completions", {})).status).toBe(401);
    expect((await call("/v1/chat/completions", { [GATE_HEADER]: "forged" })).status).toBe(401);
    expect(
      (await call("/mcp", { [GATE_HEADER]: "token-agent-1-aaaaaaaaaaaaaaaaaaaaaaaa" })).status,
    ).toBe(404);
    expect(seen.length).toBe(before);
  });

  it("answers 402 insufficient_quota at zero credits without calling LiteLLM (D-209)", async () => {
    const before = seen.length;
    const res = await call("/v1/chat/completions", {
      [GATE_HEADER]: "token-agent-3-dddddddddddddddddddddddd",
    });
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual(CREDITS_EXHAUSTED_BODY);
    expect(seen.length).toBe(before);
    expect(gate.callsFor("L3").map((c) => c.status)).toEqual([402]);
  });

  it("turns LiteLLM's budget refusal into the same 402, and passes other errors on", async () => {
    const headers = { [GATE_HEADER]: "token-agent-1-aaaaaaaaaaaaaaaaaaaaaaaa" };
    const refused = await call("/v1/budget", headers);
    expect(refused.status).toBe(402);
    const body = await refused.text();
    expect(JSON.parse(body)).toEqual(CREDITS_EXHAUSTED_BODY);
    expect(body).not.toMatch(/sk-|Current cost/);
    const busy = await call("/v1/busy", headers);
    expect(busy.status).toBe(429);
    expect(await busy.json()).toMatchObject({ error: { type: "rate_limit" } });
  });

  it("lets the probe token reach /healthz and nothing else", async () => {
    const probe = { [GATE_HEADER]: "probe-token-cccccccccccccccccccccccccc" };
    expect((await fetch(`${gate.url}/healthz`, { headers: probe })).status).toBe(200);
    expect((await call("/v1/chat/completions", probe)).status).toBe(401);
  });
});

describe("naming a model failure (P3-U9)", () => {
  const entry = (status: number, reason?: GateLogEntry["reason"]): GateLogEntry => ({
    at: "2026-10-09T01:55:44.000Z",
    leaseId: "l",
    method: "POST",
    path: "/v1/chat/completions",
    status,
    ms: 300,
    ...(reason ? { reason } : {}),
  });

  it("recognizes the provider's own account running out of credit", () => {
    const anthropic =
      '{"error":{"message":"litellm.BadRequestError: AnthropicException - {\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"Your credit balance is too low to access the Anthropic API.\\"}}"}}';
    expect(isProviderOutOfCredit(400, anthropic)).toBe(true);
    expect(isProviderOutOfCredit(429, '{"error":{"code":"insufficient_quota"}}')).toBe(true);
    expect(isProviderOutOfCredit(400, '{"error":"budget_exceeded"}')).toBe(false);
    expect(isProviderOutOfCredit(200, "credit balance is too low")).toBe(false);
  });

  it("names the provider, then any refused call, and nothing when every call went through", () => {
    expect(modelFailure([entry(200), entry(400, "PROVIDER_OUT_OF_CREDIT")])).toMatch(
      /provider's account is out of credit/,
    );
    expect(modelFailure([entry(200), entry(500)])).toBe("the model gateway answered 500");
    // A 402 is the agent's own credits, reported as billing elsewhere.
    expect(modelFailure([entry(200), entry(402)])).toBeNull();
    expect(modelFailure([])).toBeNull();
  });
});

describe("the gate under a research stage (P3-U4)", () => {
  let upstream: ReturnType<typeof createServer>;
  let gate: Gate;
  const recorded: { requestId: string; stageRunId?: string; model?: string; cacheRead: number }[] =
    [];
  let used = { calls: 0, tokens: 0, chargeUsdcE6: 0n };
  const stage = () => ({
    stageRunId: "stage-run-1",
    turns: 3,
    tokens: 50_000,
    ceilingUsdcE6: 300_000n,
    used,
  });
  let n = 0;

  beforeAll(async () => {
    // LiteLLM as Hermes sees it: a streamed completion whose last chunk carries usage and cost.
    upstream = createServer((_req, res) => {
      n += 1;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "x-litellm-model-group": "research-strong",
      });
      const id = `chatcmpl-${n}`;
      res.write(`data: ${JSON.stringify({ id, choices: [{ delta: { content: "ok" } }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({
          id,
          choices: [],
          usage: {
            prompt_tokens: 6317,
            completion_tokens: 5,
            prompt_tokens_details: { cached_tokens: n > 1 ? 6308 : 0 },
            cache_read_input_tokens: n > 1 ? 6308 : 0,
            cache_creation_input_tokens: n > 1 ? 0 : 6308,
            cost: n > 1 ? 0.0006648 : 0.007919,
          },
        })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const token = sha256Hex("token-agent-9-eeeeeeeeeeeeeeeeeeeeeeee");
    gate = await startGate({
      litellmUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      probeToken: "probe-token-cccccccccccccccccccccccccc",
      resolve: async (hash) =>
        hash === token
          ? { lease: lease("L9", 9), virtualKey: "sk-agent-nine", tier: "base", stage: stage() }
          : null,
      onModelCall: async (e) => {
        // Recorded before the response ends, so the next call's cap check sees it.
        await new Promise((r) => setTimeout(r, 20));
        recorded.push({
          requestId: e.usage?.requestId ?? "",
          ...(e.stageRunId ? { stageRunId: e.stageRunId } : {}),
          ...(e.model ? { model: e.model } : {}),
          cacheRead: e.usage?.cacheReadTokens ?? 0,
        });
      },
    });
  });
  afterAll(async () => {
    await gate.close();
    await new Promise((r) => upstream.close(r));
  });

  const call = () =>
    fetch(`${gate.url}/v1/chat/completions`, {
      method: "POST",
      headers: { [GATE_HEADER]: "token-agent-9-eeeeeeeeeeeeeeeeeeeeeeee" },
      body: "{}",
    });

  it("streams the answer through and records its usage, model and stage before the response ends", async () => {
    const r = await call();
    expect(await r.text()).toContain("[DONE]");
    expect(recorded).toEqual([
      {
        requestId: "chatcmpl-1",
        stageRunId: "stage-run-1",
        model: "research-strong",
        cacheRead: 0,
      },
    ]);
    const second = await call();
    await second.text();
    expect(recorded[1]).toMatchObject({ requestId: "chatcmpl-2", cacheRead: 6308 });
    const logged = gate.callsFor("L9");
    expect(logged[1]?.usage).toMatchObject({
      inputTokens: 6317,
      outputTokens: 5,
      cacheReadTokens: 6308,
      cacheWriteTokens: 0,
      costUsd: 0.0006648,
    });
  });

  it("refuses a model call past the stage's turn, token or cost cap with a final 402", async () => {
    const before = n;
    for (const [over, reason] of [
      [{ calls: 3, tokens: 0, chargeUsdcE6: 0n }, "TURN_CAP"],
      [{ calls: 1, tokens: 50_000, chargeUsdcE6: 0n }, "TOKEN_CAP"],
      [{ calls: 1, tokens: 10, chargeUsdcE6: 300_000n }, "CEILING"],
    ] as const) {
      used = over;
      const r = await call();
      expect(r.status).toBe(402);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("stage_cap");
      expect(gate.callsFor("L9").at(-1)).toMatchObject({
        status: 402,
        reason,
        stageRunId: "stage-run-1",
      });
    }
    // None of them reached LiteLLM.
    expect(n).toBe(before);
    used = { calls: 0, tokens: 0, chargeUsdcE6: 0n };
  });
});

describe("reading a model response's usage (P3-U4)", () => {
  it("takes the last usage chunk of a stream, or a plain JSON body, and nothing from an error", () => {
    const stream = [
      `data: {"id":"chatcmpl-a","choices":[]}`,
      `data: {"id":"chatcmpl-a","usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":7},"cost":0.001}}`,
      "data: [DONE]",
    ].join("\n\n");
    expect(usageFromResponse(stream)).toEqual({
      requestId: "chatcmpl-a",
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 7,
      cacheWriteTokens: 0,
      costUsd: 0.001,
    });
    expect(
      usageFromResponse(
        JSON.stringify({ id: "chatcmpl-b", usage: { prompt_tokens: 3, completion_tokens: 1 } }),
      ),
    ).toMatchObject({ requestId: "chatcmpl-b", inputTokens: 3, costUsd: 0 });
    expect(usageFromResponse(JSON.stringify({ error: { message: "no" } }))).toBeNull();
    expect(usageFromResponse("")).toBeNull();
  });

  it("names the first cap a stage has reached", () => {
    const s = { stageRunId: "s", turns: 2, tokens: 100, ceilingUsdcE6: 10n };
    expect(stageCapReached({ ...s, used: { calls: 1, tokens: 99, chargeUsdcE6: 9n } })).toBeNull();
    expect(stageCapReached({ ...s, used: { calls: 2, tokens: 0, chargeUsdcE6: 0n } })).toBe(
      "TURN_CAP",
    );
    expect(stageCapReached({ ...s, used: { calls: 1, tokens: 100, chargeUsdcE6: 0n } })).toBe(
      "TOKEN_CAP",
    );
    expect(stageCapReached({ ...s, used: { calls: 1, tokens: 1, chargeUsdcE6: 10n } })).toBe(
      "CEILING",
    );
  });
});
