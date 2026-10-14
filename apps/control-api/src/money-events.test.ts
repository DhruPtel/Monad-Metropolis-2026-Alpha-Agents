import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { type MoneyEventsChain, type ScannedLog, moneyEvents } from "./money-events.ts";

const NFT = "0x00000000000000000000000000000000000000a1" as Hex;
const FACTORY = "0x00000000000000000000000000000000000000f1" as Hex;
const USDC = "0x00000000000000000000000000000000000000c1" as Hex;
const OWNER = "0x00000000000000000000000000000000000a11ce" as Hex;
const PERSONAL = "0x00000000000000000000000000000000000000b1" as Hex;
const VAULT = "0x00000000000000000000000000000000000000b2" as Hex;
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

function chain(o: {
  head: bigint;
  born: Record<string, bigint>;
  logs: Record<string, ScannedLog[]>;
}) {
  const calls: { address: Hex; fromBlock: bigint; toBlock: bigint }[] = [];
  const c: MoneyEventsChain = {
    getBlockNumber: async () => o.head,
    getCode: async ({ address, blockNumber }) =>
      blockNumber >= (o.born[address.toLowerCase()] ?? o.head + 1n) ? "0x60" : undefined,
    getLogs: async (a) => {
      calls.push({ address: a.address, fromBlock: a.fromBlock, toBlock: a.toBlock });
      return (o.logs[a.address.toLowerCase()] ?? []).filter(
        (l) => l.blockNumber >= a.fromBlock && l.blockNumber <= a.toBlock,
      );
    },
    getBlockTime: async (b) => 1_790_000_000n + b,
    read: async ({ functionName }) =>
      functionName === "ownerOf"
        ? OWNER
        : functionName === "personalAccountOf"
          ? PERSONAL
          : functionName === "vaultOf"
            ? VAULT
            : "WMON",
  };
  return { c, calls, o };
}
const log = (
  eventName: string,
  block: bigint,
  args: Record<string, unknown>,
  i = 0,
): ScannedLog => ({
  eventName,
  args,
  transactionHash: tx(Number(block) * 10 + i),
  blockNumber: block,
  logIndex: i,
});

describe("deposits and withdrawals from the chain's logs (2026-10-13)", () => {
  it("lists the trading account's and the vault's, newest first, with amount, time and transaction", async () => {
    const { c } = chain({
      head: 5_000n,
      born: { [PERSONAL]: 1_200n, [VAULT]: 3_100n },
      logs: {
        [PERSONAL]: [
          log("Deposited", 1_300n, { token: USDC, amount: 5_000_000n, valueUsdc: 5_000_000n }),
          log("Withdrawn", 2_500n, { token: USDC, amount: 1_000_000n, to: OWNER }),
        ],
        [VAULT]: [
          log("Deposited", 3_200n, {
            who: OWNER,
            assets: 2_000_000n,
            shares: 2n * 10n ** 18n,
            leaderStake: true,
          }),
          log("Redeemed", 4_000n, {
            who: OWNER,
            receiver: OWNER,
            shares: 10n ** 18n,
            assets: 990_000n,
          }),
          log("RedeemedInKind", 4_500n, { who: OWNER, receiver: OWNER, shares: 5n * 10n ** 17n }),
        ],
      },
    });
    const m4 = moneyEvents(c, {
      agentNft: NFT,
      accountFactoryV3: FACTORY,
      usdc: USDC,
      chunk: 1_000,
    });
    const ev = await m4.list(4);
    expect(ev.map((e) => [e.account, e.kind, e.amount, e.symbol, e.inKind, e.leaderStake])).toEqual(
      [
        ["vault", "withdrawal", "0.5", "shares", true, false],
        ["vault", "withdrawal", "0.99", "USDC", false, false],
        ["vault", "deposit", "2", "USDC", false, true],
        ["trading", "withdrawal", "1", "USDC", false, false],
        ["trading", "deposit", "5", "USDC", false, false],
      ],
    );
    expect(await m4.created(4)).toEqual({
      trading: new Date((1_790_000_000 + 1_200) * 1000).toISOString(),
      vault: new Date((1_790_000_000 + 3_100) * 1000).toISOString(),
    });
    expect(ev[4]).toMatchObject({
      valueUsdcE6: "5000000",
      txHash: tx(13_000),
      at: new Date((1_790_000_000 + 1_300) * 1000).toISOString(),
    });
  });

  it("scans each contract from its first block in chunks the provider accepts, then only new blocks", async () => {
    const { c, calls, o } = chain({
      head: 3_500n,
      born: { [PERSONAL]: 1_200n, [VAULT]: 9_999n },
      logs: {},
    });
    const m = moneyEvents(c, {
      agentNft: NFT,
      accountFactoryV3: FACTORY,
      usdc: USDC,
      chunk: 1_000,
    });
    await m.list(4);
    const personal = calls.filter((x) => x.address === PERSONAL);
    expect(personal.map((x) => [x.fromBlock, x.toBlock])).toEqual([
      [1_200n, 2_199n],
      [2_200n, 3_199n],
      [3_200n, 3_500n],
    ]);
    o.head = 3_900n;
    calls.length = 0;
    await m.list(4);
    expect(
      calls.filter((x) => x.address === PERSONAL).map((x) => [x.fromBlock, x.toBlock]),
    ).toEqual([[3_501n, 3_900n]]);
  });
});
