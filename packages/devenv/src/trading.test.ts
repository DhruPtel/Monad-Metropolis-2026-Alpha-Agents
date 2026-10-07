import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { RpcError } from "./rpc.ts";
import { tradingSnapshot } from "./trading.ts";

/**
 * The Trades panel's snapshot (P2-U4): a missing agent and an unreachable
 * fork are different answers, so the panel never calls a fork that is down
 * "agent not found".
 */
let server: Server | null = null;
afterEach(async () => {
  await new Promise((r) => (server ? server.close(() => r(undefined)) : r(undefined)));
  server = null;
});

async function reverting(): Promise<string> {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id } = JSON.parse(body) as { id: number };
      res.end(
        JSON.stringify({ jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted" } }),
      );
    });
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("the trading snapshot (P2-U4)", () => {
  it("says an agent does not exist only when the contract refuses", async () => {
    await expect(tradingSnapshot(await reverting(), 99)).rejects.toThrow(
      "Agent 99 does not exist on the fork.",
    );
  });

  it("reports an unreachable fork as unreachable, not as a missing agent", async () => {
    const err = await tradingSnapshot("http://127.0.0.1:1", 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).kind).toBe("unreachable");
  });

  it("refuses an agent ID that is not one", async () => {
    await expect(tradingSnapshot("http://127.0.0.1:1", 0)).rejects.toThrow(
      "That is not an agent ID.",
    );
  });
});
