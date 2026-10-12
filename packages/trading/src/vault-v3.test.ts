import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { PortfolioClientV3 } from "./portfolio-v3.ts";
import type { SnapshotRow } from "./snapshots.ts";
import {
  type VaultContractsV3,
  rpcVaultReaderV3,
  vaultPerformance,
  vaultV3Json,
} from "./vault-v3.ts";

/**
 * The vault reading (P7-U4) over a fake chain: the vault or where it will be,
 * the factory's vault cap and flags, the state (the leader's stake, the supply,
 * the value, the mode, the handover, the lockup), every held token valued as
 * the vault values it, a viewer's position (shares, the lock, the in-kind
 * slices, the claimable credit, the room to deposit, whether the factory would
 * take their deposit), and the performance from the vault's own snapshot rows.
 */
const NFT = "0x60cacA6dE327331b321E140Ae19AcbCc4188Be6E" as Hex;
const F3 = "0xC4D2e1d0056165a0A0cb94d7c6Ee89640A2Ba0fF" as Hex;
const ORACLE = "0xeeB91f3371Db0d409bbE0Ffa9ea901E09A783a43" as Hex;
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as Hex;
const WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A" as Hex;
const EXEC = "0x9C96ca817322AeE0F1a1F776149c8406F2f0a264" as Hex;
const OWNER = "0x683eE842A16f85e69883F433745263BFe8D55f76" as Hex;
const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Hex;
const VAULT = "0x00000000000000000000000000000000000a0170" as Hex;
const PERSONAL = "0x00000000000000000000000000000000000ac0f3" as Hex;
const ZERO = "0x0000000000000000000000000000000000000000" as Hex;
const E18 = 10n ** 18n;
const NOW = 1_790_000_000n;
const c: VaultContractsV3 = {
  agentNft: NFT,
  accountFactory: F3,
  oracle: ORACLE,
  usdc: USDC,
  wmon: WMON,
  executor: EXEC,
};
const lower = (a: string) => a.toLowerCase();
/** A value a test has already shown to be there. */
function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error("expected a value");
  return v;
}
const tokens = async () => [
  { symbol: "USDC", address: USDC, decimals: 6, priceClass: "F" as const },
  { symbol: "WMON", address: WMON, decimals: 18, priceClass: "F" as const },
];

function fakeChain(state: {
  vault: Hex;
  wmonReason?: number;
  depositsEnabled?: boolean;
  allowlistEnabled?: boolean;
  allowlisted?: readonly Hex[];
  shares?: bigint;
  locked?: bigint;
}): PortfolioClientV3 & { reads: string[] } {
  const reads: string[] = [];
  const shares = state.shares ?? 0n;
  return {
    reads,
    async getBlock() {
      return { number: 109_670_100n, timestamp: NOW };
    },
    async getBalance() {
      return 2n * E18;
    },
    async readContract({ address, functionName, args = [] }) {
      reads.push(functionName);
      const at = lower(address);
      if (at === lower(NFT) && functionName === "ownerOf") {
        if (args[0] === 1n) return OWNER;
        throw new Error("execution reverted: nonexistent token");
      }
      if (at === lower(F3)) {
        const f: Record<string, unknown> = {
          vaultOf: state.vault,
          predictVault: VAULT,
          vaultCap: 500_000_000n,
          platformCap: 2_000_000_000n,
          platformTotal: 380_000_000n,
          allowlistEnabled: state.allowlistEnabled ?? true,
          depositsEnabled: state.depositsEnabled ?? false,
          isAllowlisted: (state.allowlisted ?? [OWNER]).some(
            (a) => lower(a) === lower(String(args[0])),
          ),
        };
        return f[functionName];
      }
      if (at === lower(ORACLE) && functionName === "price") {
        const token = lower(String(args[0]));
        if (token === lower(USDC)) return [E18, NOW - 600n, 0];
        if (token === lower(WMON)) return [25n * 10n ** 15n, NOW - 20n, state.wmonReason ?? 0];
        throw new Error("execution reverted: UnknownAsset");
      }
      if (functionName === "balanceOf")
        return lower(String(args[0])) === lower(ALICE) ? 120_000_000n : 0n;
      if (at === lower(state.vault)) {
        const broken = (state.wmonReason ?? 0) !== 0;
        if (
          broken &&
          ["navUsdc", "breakerState", "convertToAssets", "maxDeposit"].includes(functionName)
        )
          throw new Error("execution reverted: FeedUnusable");
        const v: Record<string, unknown> = {
          leader: OWNER,
          leaderShares: 20n * E18,
          leaderStakeBps: 2_500n,
          incomingLeader: ZERO,
          incomingShares: 0n,
          totalSupply: 80n * E18,
          principal: 80_000_000n,
          navUsdc: 82_000_000n,
          breakerState: [82_000_000n, 1_025_000_000_000_000_000n, 1_025_000_000_000_000_000n, 0n],
          effectiveMode: 0,
          inHandover: false,
          depositsOpen: true,
          depositsClosed: false,
          lockup: 86_400n,
          feeBps: 0,
          windDownAt: 0n,
          pausedAt: 0n,
          holdings: [
            {
              token: USDC,
              decimals: 6,
              balance: 42_000_000n,
              free: 42_000_000n,
              costBasis: 0n,
              lastPriceE18: E18,
              lastPricedAt: NOW,
            },
            {
              token: WMON,
              decimals: 18,
              balance: 1_600n * E18,
              free: 1_600n * E18,
              costBasis: 38_000_000n,
              lastPriceE18: 25n * 10n ** 15n,
              lastPricedAt: NOW,
            },
          ],
          MIN_LOCKUP: 86_400n,
          MAX_LOCKUP: 604_800n,
          LEADER_STAKE_BPS: 500n,
          SPREAD_BPS: 50n,
          HANDOVER_PERIOD: 259_200n,
          sharesOf: shares,
          freeShares: shares - (state.locked ?? 0n),
          lockOf: [state.locked ?? 0n, state.locked ? NOW + 3_600n : 0n],
          entryPriceE18: E18,
          convertToAssets: (shares * 82_000_000n * 9_950n) / (80n * E18 * 10_000n),
          maxDeposit: 300_000_000n,
          inKindAmounts: [
            [USDC, WMON],
            [(42_000_000n * shares) / (80n * E18), (1_600n * E18 * shares) / (80n * E18)],
          ],
          claimable: lower(String(args[0])) === lower(WMON) ? 3n * E18 : 0n,
        };
        return v[functionName];
      }
      throw new Error(`unexpected read ${functionName} at ${address}`);
    },
  };
}

describe("the vault reading (P7-U4)", () => {
  it("is null for an agent that does not exist", async () => {
    const chain = fakeChain({ vault: ZERO });
    const reader = rpcVaultReaderV3("http://127.0.0.1:1", 143, c, { tokens, client: chain });
    expect(await reader.vault(9)).toBeNull();
  });

  it("names where the vault will be and the factory's rules before the owner creates it, with the viewer's standing", async () => {
    const chain = fakeChain({ vault: ZERO });
    const reader = rpcVaultReaderV3("http://127.0.0.1:1", 143, c, { tokens, client: chain });
    const r = await reader.vault(1, OWNER);
    expect(r).not.toBeNull();
    expect(r?.vault).toBeNull();
    expect(r?.predictedVault).toBe(VAULT);
    expect(r?.state).toBeNull();
    expect(r?.factory).toEqual({
      vaultCap: 500_000_000n,
      platformCap: 2_000_000_000n,
      platformTotal: 380_000_000n,
      allowlistEnabled: true,
      depositsEnabled: false,
    });
    expect(r?.viewer).toMatchObject({
      address: OWNER,
      isOwner: true,
      isLeader: false,
      allowlisted: true,
      mayDeposit: true,
      shares: 0n,
    });
    const json = vaultV3Json(must(r));
    expect(json.factory.vaultCapUsdcE6).toBe("500000000");
    expect(json.state).toBeNull();
    expect(json.viewer?.inKind).toBeNull();
  });

  it("reads the vault's state, values every held token as the vault does, and a depositor's locked position with its in-kind slices and claimable credit", async () => {
    const chain = fakeChain({
      vault: VAULT,
      allowlisted: [OWNER, ALICE],
      shares: 30n * E18,
      locked: 30n * E18,
    });
    const reader = rpcVaultReaderV3("http://127.0.0.1:1", 143, c, { tokens, client: chain });
    const r = await reader.vault(1, ALICE);
    const s = must(must(r).state);
    expect(s).toMatchObject({
      leader: OWNER,
      leaderStakeBps: 2_500n,
      totalSupply: 80n * E18,
      principal: 80_000_000n,
      navUsdc: 82_000_000n,
      perUnitE18: 1_025_000_000_000_000_000n,
      mode: "NORMAL",
      inHandover: false,
      depositsOpen: true,
      lockup: 86_400n,
      feeBps: 0,
    });
    expect(s.constants).toEqual({
      minLockup: 86_400n,
      maxLockup: 604_800n,
      leaderMinBps: 500n,
      spreadBps: 50n,
      handoverPeriod: 259_200n,
    });
    expect(s.holdings.map((h) => [h.symbol, h.valueUsdc?.toString(), h.priceReason])).toEqual([
      ["USDC", "42000000", "OK"],
      ["WMON", "40000000", "OK"],
    ]);
    const v = must(must(r).viewer);
    expect(v).toMatchObject({
      address: ALICE,
      isOwner: false,
      isLeader: false,
      allowlisted: true,
      mayDeposit: true,
      usdcWallet: 120_000_000n,
      shares: 30n * E18,
      freeShares: 0n,
      lockedShares: 30n * E18,
      unlockAt: NOW + 3_600n,
      maxDeposit: 300_000_000n,
    });
    expect(v.valueUsdc).toBe((30n * 82_000_000n * 9_950n) / (80n * 10_000n));
    expect(v.inKind?.map((a) => [a.symbol, a.amount.toString()])).toEqual([
      ["USDC", "15750000"],
      ["WMON", (600n * E18).toString()],
    ]);
    expect(v.claimables.map((a) => [a.symbol, a.amount.toString()])).toEqual([
      ["WMON", (3n * E18).toString()],
    ]);
    const json = vaultV3Json(must(r));
    expect(json.state?.holdings[1]).toMatchObject({
      symbol: "WMON",
      valueUsdcE6: "40000000",
      costBasisUsdcE6: "38000000",
    });
    expect(json.viewer?.unlockAt).toBe(Number(NOW + 3_600n));
    expect(json.viewer?.inKind?.[1]).toEqual({
      token: WMON,
      symbol: "WMON",
      decimals: 18,
      amountRaw: (600n * E18).toString(),
    });
  });

  it("leaves the value unknown while a held token's feed is unusable, and still reads the position", async () => {
    const chain = fakeChain({
      vault: VAULT,
      wmonReason: 9,
      allowlisted: [OWNER, ALICE],
      shares: 30n * E18,
    });
    const reader = rpcVaultReaderV3("http://127.0.0.1:1", 143, c, { tokens, client: chain });
    const r = await reader.vault(1, ALICE);
    expect(r?.state?.navUsdc).toBeNull();
    expect(r?.state?.perUnitE18).toBeNull();
    expect(r?.state?.holdings[1]).toMatchObject({
      symbol: "WMON",
      valueUsdc: null,
      priceReason: "STALE",
    });
    expect(r?.viewer).toMatchObject({ shares: 30n * E18, valueUsdc: null, maxDeposit: 0n });
    expect(r?.viewer?.inKind?.length).toBe(2);
  });

  it("says whether the factory would take a wallet's deposit: allowlisted, or public deposits on with the allowlist off", async () => {
    const read = async (over: Parameters<typeof fakeChain>[0], who: Hex) => {
      const reader = rpcVaultReaderV3("http://127.0.0.1:1", 143, c, {
        tokens,
        client: fakeChain(over),
      });
      return (await reader.vault(1, who))?.viewer?.mayDeposit;
    };
    expect(await read({ vault: VAULT }, ALICE)).toBe(false);
    expect(await read({ vault: VAULT, allowlistEnabled: false }, ALICE)).toBe(false);
    expect(
      await read({ vault: VAULT, allowlistEnabled: false, depositsEnabled: true }, ALICE),
    ).toBe(true);
    expect(await read({ vault: VAULT, depositsEnabled: true }, ALICE)).toBe(false);
    expect(await read({ vault: VAULT, allowlisted: [ALICE] }, ALICE)).toBe(true);
  });

  it("reads no viewer when no wallet is named", async () => {
    const chain = fakeChain({ vault: VAULT });
    const reader = rpcVaultReaderV3("http://127.0.0.1:1", 143, c, { tokens, client: chain });
    const r = await reader.vault(1);
    expect(r?.viewer).toBeNull();
    expect(chain.reads).not.toContain("sharesOf");
  });
});

describe("the vault's performance from the value snapshots", () => {
  const row = (
    minutesAgo: number,
    perUnit: bigint,
    account: Hex = VAULT,
    reason: "interval" | "trade" = "interval",
  ): SnapshotRow => ({
    agentId: 1,
    account,
    block: 1n,
    blockTime: 0n,
    valueUsdc: 80_000_000n,
    usdc: 0n,
    wmon: 0n,
    custody: "v3",
    holdings: null,
    perUnit,
    mode: "NORMAL",
    reason,
    intentId: null,
    createdAt: new Date(Date.UTC(2026, 9, 12, 12, 0) - minutesAgo * 60_000),
  });
  const now = new Date(Date.UTC(2026, 9, 12, 12, 0));

  it("keeps the vault's rows only, appends the live reading, and scores the series", () => {
    const rows = [
      row(180, E18),
      row(120, E18, PERSONAL),
      row(90, 102n * 10n ** 16n, VAULT, "trade"),
      row(30, 101n * 10n ** 16n),
    ];
    const p = vaultPerformance(
      rows,
      { vault: VAULT, state: { perUnitE18: 103n * 10n ** 16n, navUsdc: 82_000_000n } as never },
      now,
    );
    expect(p.history.points).toBe(3);
    expect(p.series.map((s) => s.perUnitE18)).toEqual([
      E18.toString(),
      (102n * 10n ** 16n).toString(),
      (101n * 10n ** 16n).toString(),
      (103n * 10n ** 16n).toString(),
    ]);
    expect(p.series[1]?.reason).toBe("trade");
    expect(p.scores.returnSinceStart).toMatchObject({ ok: true, bps: 300 });
    expect(p.scores.maxDrawdown).toMatchObject({ ok: true, bps: 98 });
  });

  it("says there is not enough data for a young vault, and has nothing without a vault", () => {
    const young = vaultPerformance(
      [row(10, E18)],
      { vault: VAULT, state: { perUnitE18: E18, navUsdc: 1n } as never },
      now,
    );
    expect(young.scores.returnSinceStart).toMatchObject({ ok: false });
    expect(young.series.length).toBe(2);
    const none = vaultPerformance([row(10, E18)], { vault: null, state: null }, now);
    expect(none).toEqual({
      series: [],
      scores: {
        returnSinceStart: { ok: false, reason: expect.any(String) },
        maxDrawdown: { ok: false, reason: expect.any(String) },
      },
      history: { points: 0, from: null, to: null },
    });
  });
});
