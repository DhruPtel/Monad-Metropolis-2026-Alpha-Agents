import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createPublicClient } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rpcTransport } from "./transport.ts";

/** A JSON-RPC server answering eth_chainId, or failing every request with `failStatus`. */
function node(chainIdHex: string, failStatus: number | null) {
  const state = { calls: 0, failStatus };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      state.calls++;
      if (state.failStatus) {
        res.writeHead(state.failStatus).end("unavailable");
        return;
      }
      const { id } = JSON.parse(body) as { id: number };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: chainIdHex }));
    });
  });
  return { server, state };
}

const listen = (s: Server) =>
  new Promise<string>((r) =>
    s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)),
  );

describe("rpcTransport failover (P2-EC)", () => {
  const primary = node("0x279f", 503);
  const secondary = node("0x279f", null);
  let a = "";
  let b = "";
  beforeAll(async () => {
    a = await listen(primary.server);
    b = await listen(secondary.server);
  });
  afterAll(() => {
    primary.server.close();
    secondary.server.close();
  });

  it("answers from the second provider while the first fails, and from the first when it is back", async () => {
    const client = createPublicClient({ transport: rpcTransport(a, b) });
    expect(await client.getChainId()).toBe(10143);
    expect(primary.state.calls).toBeGreaterThan(0);
    expect(secondary.state.calls).toBe(1);
    primary.state.failStatus = null;
    const before = secondary.state.calls;
    expect(await createPublicClient({ transport: rpcTransport(a, b) }).getChainId()).toBe(10143);
    expect(secondary.state.calls).toBe(before);
  });

  it("uses one provider alone when there is no second, or the same twice", async () => {
    primary.state.failStatus = 503;
    await expect(createPublicClient({ transport: rpcTransport(a) }).getChainId()).rejects.toThrow();
    await expect(
      createPublicClient({ transport: rpcTransport(a, a) }).getChainId(),
    ).rejects.toThrow();
  });
});
