import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type AgentIdentity,
  ToolError,
  ToolErrorBody,
  errorFrom,
  identityFields,
  okResult,
} from "./conventions.ts";
import { type ToolServer, startToolServer } from "./host.ts";
import { connectClient, staticResolver, structured } from "./testing.ts";

const ALICE: AgentIdentity = { chainId: 1, agentId: 7, tier: "base", leaseId: "lease-a" };
const TOKEN = "a".repeat(43);
const servers: ToolServer[] = [];

async function start(resolve = staticResolver({ [TOKEN]: ALICE })) {
  const seen: AgentIdentity[] = [];
  const server = await startToolServer({
    name: "test",
    resolve,
    register: (mcp, identity) => {
      seen.push(identity);
      mcp.registerTool(
        "echo",
        {
          description: "echo",
          inputSchema: z.strictObject({ n: z.int().min(0).max(9) }),
          outputSchema: z.strictObject({ n: z.int(), agent: z.int() }),
        },
        ({ n }) => okResult({ n, agent: identity.agentId }),
      );
      mcp.registerTool(
        "fail",
        { description: "fail", inputSchema: z.strictObject({ typed: z.boolean() }) },
        ({ typed }) => {
          if (typed) return errorFrom(new ToolError("RATE_LIMITED", "slow down", true));
          throw new Error("database password is hunter2");
        },
      );
    },
  });
  servers.push(server);
  return { server, seen };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const rpc = (url: string, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

describe("tool server host", () => {
  it("refuses a missing, short or unknown token, and other paths", async () => {
    const { server, seen } = await start();
    expect((await rpc(server.url)).status).toBe(401);
    expect((await rpc(server.url, { authorization: "Bearer short" })).status).toBe(401);
    expect((await rpc(server.url, { authorization: `Bearer ${"b".repeat(43)}` })).status).toBe(401);
    expect((await rpc(server.url, { authorization: TOKEN })).status).toBe(401);
    expect((await rpc(server.url.replace("/mcp", "/other"))).status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it("answers 503 when identity cannot be checked", async () => {
    const { server } = await start(() => Promise.reject(new Error("db down")));
    expect((await rpc(server.url, { authorization: `Bearer ${TOKEN}` })).status).toBe(503);
  });

  it("builds the tools for the identity the token names", async () => {
    const { server, seen } = await start();
    const client = await connectClient(server.url, TOKEN);
    const result = await client.callTool({ name: "echo", arguments: { n: 3 } });
    expect(structured(result)).toEqual({ n: 3, agent: 7 });
    expect(seen.every((s) => s.agentId === 7 && s.leaseId === "lease-a")).toBe(true);
    await client.close();
  });

  it("answers bad input, a typed error and a crash in the 4.4.1 shape", async () => {
    const { server } = await start();
    const client = await connectClient(server.url, TOKEN);
    const bad = await client.callTool({ name: "echo", arguments: { n: 10 } });
    expect(bad.isError).toBe(true);
    expect(ToolErrorBody.parse(structured(bad))).toMatchObject({
      code: "INVALID_INPUT",
      retryable: false,
    });
    const typed = await client.callTool({ name: "fail", arguments: { typed: true } });
    expect(structured(typed)).toEqual({
      code: "RATE_LIMITED",
      message: "slow down",
      retryable: true,
    });
    const crash = await client.callTool({ name: "fail", arguments: { typed: false } });
    expect(structured(crash)).toMatchObject({ code: "INTERNAL", retryable: true });
    expect(JSON.stringify(crash)).not.toContain("hunter2");
    const unknown = await client.callTool({ name: "nope", arguments: {} });
    expect(structured(unknown)).toMatchObject({ code: "INVALID_INPUT" });
    await client.close();
  });
});

describe("identity field lint", () => {
  it("finds forbidden names at any depth and passes clean schemas", () => {
    expect(identityFields(z.strictObject({ query: z.string(), target: z.string() }))).toEqual([]);
    expect(
      identityFields(
        z.strictObject({
          legs: z.array(z.object({ asset: z.string(), wallet: z.string().optional() })),
          meta: z.union([z.object({ owner: z.string() }), z.object({ x: z.int() })]).optional(),
          agentId: z.int().default(1),
        }),
      ).sort(),
    ).toEqual(["agentId", "owner", "wallet"]);
  });
});
