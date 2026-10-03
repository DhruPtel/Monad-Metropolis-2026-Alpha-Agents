import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { GATE_HEADER, LLM_KEY_HEADER, startGate, TOOL_TOKEN_HEADER, type Gate } from "./gate.ts";

const GATE = "g".repeat(40);
const opened: { close(): Promise<void> }[] = [];

/** An upstream that echoes the path and headers it received, or fails with a given status. */
async function echo(status = 200): Promise<string> {
  const server: Server = createServer((req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, headers: req.headers }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  opened.push({
    close: () => new Promise<void>((r) => server.close(() => r())),
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function gate(litellmStatus = 200): Promise<Gate> {
  const g = await startGate({
    gateSecret: GATE,
    litellmUrl: await echo(litellmStatus),
    platformToolsUrl: `${await echo()}/mcp`,
  });
  opened.push(g);
  return g;
}

const injected = {
  [GATE_HEADER]: GATE,
  [LLM_KEY_HEADER]: "sk-virtual-key",
  [TOOL_TOKEN_HEADER]: "tool-token",
};

afterEach(async () => {
  await Promise.all(opened.splice(0).map((s) => s.close()));
});

describe("gate", () => {
  it("refuses every request without the gate credential, or with a wrong one", async () => {
    const g = await gate();
    for (const headers of [{}, { [GATE_HEADER]: "x".repeat(40) }]) {
      for (const path of ["/healthz", "/v1/chat/completions", "/mcp"]) {
        const res = await fetch(`${g.url}${path}`, { headers });
        expect(res.status).toBe(401);
      }
    }
  });

  it("answers health with the credential and 404s unknown paths", async () => {
    const g = await gate();
    expect((await fetch(`${g.url}/healthz`, { headers: injected })).status).toBe(200);
    expect((await fetch(`${g.url}/admin`, { headers: injected })).status).toBe(404);
  });

  it("forwards /v1 to LiteLLM with the injected key as the bearer and strips gate headers", async () => {
    const g = await gate();
    const res = await fetch(`${g.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        ...injected,
        authorization: "Bearer placeholder",
        "content-type": "application/json",
      },
      body: "{}",
    });
    const body = (await res.json()) as { path: string; headers: Record<string, string> };
    expect(body.path).toBe("/v1/chat/completions");
    expect(body.headers.authorization).toBe("Bearer sk-virtual-key");
    expect(Object.keys(body.headers).filter((h) => h.startsWith("x-alpha-"))).toEqual([]);
  });

  it("forwards /mcp to the platform tools server with the tool token", async () => {
    const g = await gate();
    const res = await fetch(`${g.url}/mcp`, { method: "POST", headers: injected, body: "{}" });
    const body = (await res.json()) as { path: string; headers: Record<string, string> };
    expect(body.path).toBe("/mcp");
    expect(body.headers.authorization).toBe("Bearer tool-token");
  });

  it("refuses a route whose per-agent credential was not injected", async () => {
    const g = await gate();
    const res = await fetch(`${g.url}/v1/models`, { headers: { [GATE_HEADER]: GATE } });
    expect(res.status).toBe(401);
  });

  it("logs method, path and status only, and keeps LiteLLM error bodies", async () => {
    const g = await gate(400);
    await fetch(`${g.url}/v1/chat/completions`, { method: "POST", headers: injected, body: "{}" });
    await new Promise((r) => setTimeout(r, 20));
    const entry = g.log.at(-1);
    expect(entry).toMatchObject({ method: "POST", path: "/v1/chat/completions", status: 400 });
    expect(entry?.errorBody).toContain("/v1/chat/completions");
    const withoutBodies = g.log.map((e) => ({ ...e, errorBody: undefined }));
    expect(JSON.stringify(withoutBodies)).not.toContain(GATE);
  });
});
