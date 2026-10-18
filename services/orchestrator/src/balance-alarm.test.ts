import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { BalanceAlarm, DEPLOYER_FLOOR_WEI, KEEPER_FLOOR_WEI } from "./balance-alarm.ts";

const DEPLOYER = "0x00000000000000000000000000000000000000d1" as Hex;
const KEEPER = "0x00000000000000000000000000000000000000e1" as Hex;
const MON = 10n ** 18n;

function alarm(o: { fail?: boolean } = {}) {
  const balances = new Map<Hex, bigint>([
    [DEPLOYER, 3n * MON],
    [KEEPER, MON],
  ]);
  let now = 0;
  const posts: { title: string; body: string; priority: string }[] = [];
  const a = new BalanceAlarm({
    watched: [
      { label: "deployer", address: DEPLOYER, floorWei: DEPLOYER_FLOOR_WEI },
      { label: "reveal keeper", address: KEEPER, floorWei: KEEPER_FLOOR_WEI },
    ],
    balance: async (x) => balances.get(x) ?? 0n,
    notify: async (title, body, priority) => {
      if (o.fail) throw new Error("ntfy answered 500");
      posts.push({ title, body, priority });
    },
    chainLabel: "Monad testnet",
    repeatMs: 3_600_000,
    now: () => now,
    log: () => undefined,
  });
  return {
    a,
    posts,
    set: (x: Hex, v: bigint) => balances.set(x, v),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("BalanceAlarm", () => {
  it("alerts once when the deployer drops below 2 MON or the keeper below 0.5, repeats after the interval, and reports the refill", async () => {
    const t = alarm();
    expect(await t.a.check()).toEqual([]);
    t.set(DEPLOYER, MON);
    t.set(KEEPER, (3n * MON) / 10n);
    await t.a.check();
    expect(t.posts.map((p) => [p.title, p.priority])).toEqual([
      ["Vivarium: deployer low on MON", "high"],
      ["Vivarium: reveal keeper low on MON", "high"],
    ]);
    expect(t.posts[0]?.body).toContain("holds 1.000 MON, below its 2.000 MON floor");
    expect(t.posts[1]?.body).toContain("holds 0.300 MON, below its 0.500 MON floor");
    t.advance(60_000);
    await t.a.check();
    expect(t.posts).toHaveLength(2);
    t.advance(3_600_000);
    await t.a.check();
    expect(t.posts).toHaveLength(4);
    t.set(DEPLOYER, 5n * MON);
    await t.a.check();
    expect(t.posts.at(-1)).toMatchObject({
      title: "Vivarium: deployer refilled",
      priority: "default",
    });
    await t.a.check();
    expect(t.posts).toHaveLength(5);
  });

  it("tries again on the next check when ntfy cannot be reached", async () => {
    const t = alarm({ fail: true });
    t.set(DEPLOYER, 0n);
    expect(await t.a.check()).toEqual([]);
    expect(await t.a.check()).toEqual([]);
  });
});
