import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CompleteStageOutput } from "./schema.ts";
import { startPlatformTools, type PlatformToolsServer } from "./server.ts";

const TOKEN = "t".repeat(40);
const servers: PlatformToolsServer[] = [];

async function start(options: Partial<Parameters<typeof startPlatformTools>[0]> = {}) {
  const server = await startPlatformTools({ token: TOKEN, ...options });
  servers.push(server);
  return server;
}

async function connect(url: string, token = TOKEN): Promise<Client> {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    // Same SDK typing gap under exactOptionalPropertyTypes as in server.ts.
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }) as Transport,
  );
  return client;
}

const validArgs = {
  stage: "SCAN",
  outcome: "DONE",
  candidates: [{ asset: "WMON", thesisCode: "MARKER_K7Q2", confidenceBps: 6000 }],
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("stub platform tools server", () => {
  it("lists complete_stage with input and output schemas", async () => {
    const server = await start();
    const client = await connect(server.url);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["complete_stage"]);
    expect(tools[0]?.outputSchema).toBeDefined();
    await client.close();
  });

  it("returns schema-valid structured output and records the stage", async () => {
    const server = await start();
    const client = await connect(server.url);
    const result = await client.callTool({ name: "complete_stage", arguments: validArgs });
    expect(result.isError).toBeFalsy();
    const output = CompleteStageOutput.parse(result.structuredContent);
    expect(output).toMatchObject({ stage: "SCAN", accepted: true, candidateCount: 1 });
    expect(server.stages).toHaveLength(1);
    expect(server.stages[0]?.input.candidates[0]?.thesisCode).toBe("MARKER_K7Q2");
    await client.close();
  });

  it("rejects invalid input: free text, unknown fields, out-of-range numbers", async () => {
    const server = await start();
    const client = await connect(server.url);
    for (const args of [
      { ...validArgs, stage: "PLAN" },
      { ...validArgs, note: "free text" },
      { ...validArgs, candidates: [{ asset: "WMON", thesisCode: "buy now!", confidenceBps: 1 }] },
      {
        ...validArgs,
        candidates: [{ asset: "WMON", thesisCode: "OK_CODE", confidenceBps: 10_001 }],
      },
    ]) {
      const result = await client.callTool({ name: "complete_stage", arguments: args });
      expect(result.isError).toBe(true);
    }
    expect(server.stages).toHaveLength(0);
    await client.close();
  });

  it("rejects output that does not match the output schema", async () => {
    const server = await start({ buildOutput: () => ({ accepted: "yes" }) });
    const client = await connect(server.url);
    const result = await client.callTool({ name: "complete_stage", arguments: validArgs });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/Output validation error/);
    await client.close();
  });

  it("refuses a request without the bearer token or with the wrong one", async () => {
    const server = await start();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const none = await fetch(server.url, { method: "POST", headers, body });
    expect(none.status).toBe(401);
    const wrong = await fetch(server.url, {
      method: "POST",
      headers: { ...headers, authorization: `Bearer ${"x".repeat(40)}` },
      body,
    });
    expect(wrong.status).toBe(401);
  });

  it("refuses a short token at startup", async () => {
    await expect(startPlatformTools({ token: "short" })).rejects.toThrow(/at least 32/);
  });
});
