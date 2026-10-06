import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CREDITS_EXHAUSTED_BODY, type Gate, GATE_HEADER, startGate } from "./gate.ts";
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
