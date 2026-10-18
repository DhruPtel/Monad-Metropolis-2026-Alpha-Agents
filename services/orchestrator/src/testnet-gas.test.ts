import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { DEPLOYER_GAS_ROOM_WEI, TOP_UP_SETTLE_BLOCKS, testnetGasTopUp } from "./testnet-gas.ts";

const DEPLOYER = "0x00000000000000000000000000000000000000d1" as Hex;
const KEY = "0x00000000000000000000000000000000000000a6" as Hex;
const MON = 10n ** 18n;

function fakeChain(o: { deployer: bigint; key: bigint; status?: "success" | "reverted" }) {
  const balances = new Map<Hex, bigint>([
    [DEPLOYER, o.deployer],
    [KEY, o.key],
  ]);
  let block = 100n;
  const sent: { to: Hex; wei: bigint }[] = [];
  const logs: string[] = [];
  const chain = {
    deployer: DEPLOYER,
    balance: async (a: Hex) => balances.get(a) ?? 0n,
    blockNumber: async () => block,
    send: async (to: Hex, wei: bigint) => {
      sent.push({ to, wei });
      balances.set(to, (balances.get(to) ?? 0n) + wei);
      return { hash: "0xabc" as Hex, status: o.status ?? "success", blockNumber: block };
    },
  };
  const topUp = testnetGasTopUp({
    chain,
    log: (l) => logs.push(l),
    pollMs: 1,
    settleTimeoutMs: 1_000,
    sleep: async () => {
      block += 1n;
    },
  });
  return { topUp, sent, logs, block: () => block };
}

describe("testnetGasTopUp", () => {
  it("sends a fifth of the ask less what the key holds, and returns once Monad's delay has passed", async () => {
    const c = fakeChain({ deployer: 10n * MON, key: MON / 10n });
    await c.topUp(KEY, 4n * MON);
    expect(c.sent).toEqual([{ to: KEY, wei: (8n * MON) / 10n - MON / 10n }]);
    expect(c.block()).toBe(100n + TOP_UP_SETTLE_BLOCKS);
    expect(c.logs[0]).toContain("topped");
  });

  it("sends nothing when the key already holds the target", async () => {
    const c = fakeChain({ deployer: 10n * MON, key: MON });
    await c.topUp(KEY, 4n * MON);
    expect(c.sent).toEqual([]);
  });

  it("refuses before sending when the deployer cannot pay the top-up and keep its gas room", async () => {
    const c = fakeChain({ deployer: (8n * MON) / 10n + DEPLOYER_GAS_ROOM_WEI - 1n, key: 0n });
    await expect(c.topUp(KEY, 4n * MON)).rejects.toThrow(/too little.*nothing was sent/);
    expect(c.sent).toEqual([]);
  });

  it("throws on a reverted top-up", async () => {
    const c = fakeChain({ deployer: 10n * MON, key: 0n, status: "reverted" });
    await expect(c.topUp(KEY, 4n * MON)).rejects.toThrow("reverted");
  });
});
