import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANVIL_ACCOUNTS,
  RealWalletError,
  TEST_USDC_MINTER,
  assertImpersonable,
  sendAs,
} from "./controls.ts";

/**
 * The playtest-fork wallet guard (after the F-U11 playtest): on the playtest
 * fork's port a script may impersonate anvil's accounts, the test minter,
 * USDC's master minter and contracts, never a real wallet, whose nonce must
 * stay its own. On a test's own fork (any other port, whatever
 * LOCAL_FORK_PORT a live script sets) the guard is off, since nothing real
 * lives there. The fake anvil's port stands in for 8545 here.
 */
const OWNER = "0x683eE842A16f85e69883F433745263BFe8D55f76" as const;
const MASTER_MINTER = "0x00000000000000000000000000000000000000bb" as const;
const CONTRACT = "0x00000000000000000000000000000000000000cc" as const;
const TO = "0x00000000000000000000000000000000000000dd" as const;

let server: Server | null = null;
afterEach(async () => {
  await new Promise((r) => (server ? server.close(() => r(undefined)) : r(undefined)));
  server = null;
});

/** A fake anvil: it answers the guard's reads and records every impersonation and send. */
async function fakeAnvil(): Promise<{ url: string; port: number; sent: string[] }> {
  const sent: string[] = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body) as {
        id: number;
        method: string;
        params: unknown[];
      };
      const answer = (result: unknown) => res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      switch (method) {
        case "web3_clientVersion":
          return answer("anvil/v1.0.0");
        case "eth_chainId":
          return answer("0x22f27");
        case "eth_getCode":
          return answer(
            String(params[0]).toLowerCase() === CONTRACT.toLowerCase() ? "0x6001" : "0x",
          );
        case "eth_call":
          return answer(`0x${MASTER_MINTER.slice(2).padStart(64, "0")}`);
        case "anvil_impersonateAccount":
        case "anvil_stopImpersonatingAccount":
          sent.push(`${method} ${String(params[0]).toLowerCase()}`);
          return answer(null);
        case "eth_sendTransaction":
          sent.push(`send from ${String((params[0] as { from: string }).from).toLowerCase()}`);
          return answer("0xab");
        case "eth_getTransactionReceipt":
          return answer({ status: "0x1" });
        default:
          return answer(null);
      }
    });
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, port, sent };
}

describe("the playtest-fork wallet guard", () => {
  it("refuses a real wallet on the playtest fork, before anything is impersonated or sent", async () => {
    const { url, port, sent } = await fakeAnvil();
    await expect(assertImpersonable(url, OWNER, String(port))).rejects.toBeInstanceOf(
      RealWalletError,
    );
    await expect(assertImpersonable(url, OWNER, String(port))).rejects.toThrow(/real wallet/);
    expect(sent).toEqual([]);
  });

  it("lets anvil's accounts, the test minter, USDC's master minter and a contract send on the playtest fork", async () => {
    const { url, port } = await fakeAnvil();
    for (const from of [
      ANVIL_ACCOUNTS[6] as `0x${string}`,
      TEST_USDC_MINTER,
      MASTER_MINTER,
      CONTRACT,
    ])
      await expect(assertImpersonable(url, from, String(port))).resolves.toBeUndefined();
  });

  it("leaves a test's own fork alone: another port is never the playtest fork, whatever LOCAL_FORK_PORT says", async () => {
    const { url, port, sent } = await fakeAnvil();
    const previous = process.env.LOCAL_FORK_PORT;
    process.env.LOCAL_FORK_PORT = String(port);
    try {
      await sendAs(url, OWNER, TO, "0x");
    } finally {
      if (previous === undefined) delete process.env.LOCAL_FORK_PORT;
      else process.env.LOCAL_FORK_PORT = previous;
    }
    expect(sent.some((s) => s === `send from ${OWNER.toLowerCase()}`)).toBe(true);
  });
});
