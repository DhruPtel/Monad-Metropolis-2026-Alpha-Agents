import { describe, expect, it } from "vitest";
import type { VaultJson } from "@/api/client";
import {
  depositRoom,
  minAssetsOut,
  minSharesOut,
  previewInKind,
  previewShares,
  previewUsdc,
  topUpWarning,
  usdcAvailable,
  vaultDepositBlock,
  vaultWithdrawBlock,
} from "./vault-v3";

const E18 = 10n ** 18n;
const NOW = 1_791_374_400;
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";
const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const OWNER = "0x683eE842A16f85e69883F433745263BFe8D55f76";

function vault(
  over: {
    state?: Partial<NonNullable<VaultJson["state"]>> | null;
    viewer?: Partial<NonNullable<VaultJson["viewer"]>> | null;
    factory?: Partial<VaultJson["factory"]>;
    peg?: Partial<VaultJson["usdcPeg"]>;
  } = {},
): VaultJson {
  const state: NonNullable<VaultJson["state"]> = {
    leader: OWNER,
    leaderShares: (20n * E18).toString(),
    leaderStakeBps: 2_500,
    incomingLeader: "0x0000000000000000000000000000000000000000",
    incomingShares: "0",
    totalSupply: (80n * E18).toString(),
    principalUsdcE6: "80000000",
    navUsdcE6: "82000000",
    perUnitE18: "1025000000000000000",
    breaker: null,
    mode: "NORMAL",
    inHandover: false,
    depositsOpen: true,
    depositsClosed: false,
    lockupSeconds: 86_400,
    feeBps: 0,
    windDownAt: 0,
    pausedAt: 0,
    holdings: [
      {
        token: USDC,
        symbol: "USDC",
        decimals: 6,
        amountRaw: "42000000",
        freeRaw: "42000000",
        costBasisUsdcE6: "0",
        priceE18: E18.toString(),
        priceReason: "OK",
        valueUsdcE6: "42000000",
      },
      {
        token: WMON,
        symbol: "WMON",
        decimals: 18,
        amountRaw: (1_600n * E18).toString(),
        freeRaw: (1_600n * E18).toString(),
        costBasisUsdcE6: "38000000",
        priceE18: "25000000000000000",
        priceReason: "OK",
        valueUsdcE6: "40000000",
      },
    ],
    constants: {
      minLockupSeconds: 86_400,
      maxLockupSeconds: 604_800,
      leaderMinBps: 500,
      spreadBps: 50,
      handoverPeriodSeconds: 259_200,
    },
    ...(over.state ?? {}),
  };
  const viewer: NonNullable<VaultJson["viewer"]> = {
    address: ALICE,
    isOwner: false,
    isLeader: false,
    allowlisted: true,
    mayDeposit: true,
    usdcWalletE6: "120000000",
    shares: (30n * E18).toString(),
    freeShares: "0",
    lockedShares: (30n * E18).toString(),
    unlockAt: NOW + 3_600,
    valueUsdcE6: "30592500",
    maxDepositUsdcE6: "300000000",
    inKind: [
      { token: USDC, symbol: "USDC", decimals: 6, amountRaw: "15750000" },
      { token: WMON, symbol: "WMON", decimals: 18, amountRaw: (600n * E18).toString() },
    ],
    claimables: [],
    entryPriceE18: E18.toString(),
    ...(over.viewer ?? {}),
  };
  return {
    custody: "v3",
    chainId: 143143,
    block: "1",
    timestamp: NOW,
    agentId: "7",
    owner: OWNER,
    contracts: {
      agentNft: OWNER,
      accountFactory: OWNER,
      oracle: OWNER,
      usdc: USDC,
      wmon: WMON,
      executor: OWNER,
    },
    vault: over.state === null ? null : "0x00000000000000000000000000000000000a0170",
    predictedVault: "0x00000000000000000000000000000000000a0170",
    factory: {
      vaultCapUsdcE6: "500000000",
      platformCapUsdcE6: "2000000000",
      platformTotalUsdcE6: "380000000",
      allowlistEnabled: true,
      depositsEnabled: false,
      ...(over.factory ?? {}),
    },
    usdcPeg: { priceE18: E18.toString(), updatedAt: NOW - 60, reason: "OK", ...(over.peg ?? {}) },
    state: over.state === null ? null : state,
    viewer: over.viewer === null ? null : viewer,
  };
}

describe("what blocks a vault deposit, in the contracts' order", () => {
  it("names each blocker and none when the deposit would go through", () => {
    expect(vaultDepositBlock(vault())).toBeNull();
    expect(vaultDepositBlock(vault({ state: null }))).toBe("NO_VAULT");
    expect(vaultDepositBlock(vault({ viewer: null }))).toBe("NOT_CONNECTED");
    expect(vaultDepositBlock(vault({ state: { inHandover: true, mode: "HANDOVER" } }))).toBe(
      "HANDOVER",
    );
    expect(vaultDepositBlock(vault({ state: { windDownAt: NOW } }))).toBe("WIND_DOWN");
    expect(vaultDepositBlock(vault({ state: { mode: "PAUSED" } }))).toBe("PAUSED");
    expect(vaultDepositBlock(vault({ state: { depositsClosed: true } }))).toBe("DEPOSITS_CLOSED");
    expect(vaultDepositBlock(vault({ state: { depositsOpen: false } }))).toBe("DEPOSITS_NOT_OPEN");
    expect(
      vaultDepositBlock(vault({ state: { depositsOpen: false }, viewer: { isOwner: true } })),
    ).toBeNull();
    expect(vaultDepositBlock(vault({ viewer: { allowlisted: false } }))).toBe("NOT_ALLOWLISTED");
    expect(
      vaultDepositBlock(
        vault({ viewer: { allowlisted: false }, factory: { allowlistEnabled: false } }),
      ),
    ).toBe("PUBLIC_DEPOSITS_OFF");
    expect(
      vaultDepositBlock(
        vault({
          viewer: { allowlisted: false },
          factory: { allowlistEnabled: false, depositsEnabled: true },
        }),
      ),
    ).toBeNull();
    expect(vaultDepositBlock(vault({ peg: { reason: "STALE" } }))).toBe("USDC_PRICE_UNAVAILABLE");
    expect(vaultDepositBlock(vault({ peg: { priceE18: "980000000000000000" } }))).toBe(
      "USDC_DEPEGGED",
    );
    const unpriced = vault();
    const held =
      unpriced.state?.holdings.map((h, i) =>
        i === 1 ? { ...h, valueUsdcE6: null, priceE18: null } : h,
      ) ?? [];
    expect(vaultDepositBlock(vault({ state: { holdings: held } }))).toBe("HELD_PRICE_UNAVAILABLE");
    expect(vaultDepositBlock(vault({ viewer: { maxDepositUsdcE6: "0" } }))).toBe("NO_ROOM");
  });

  it("bounds the room by the vault's answer, the vault cap and the platform cap", () => {
    expect(depositRoom(vault())).toBe(300_000_000n);
    expect(depositRoom(vault({ factory: { vaultCapUsdcE6: "100000000" } }))).toBe(20_000_000n);
    expect(depositRoom(vault({ factory: { platformTotalUsdcE6: "1990000000" } }))).toBe(
      10_000_000n,
    );
  });
});

describe("the previews and the minimums", () => {
  it("prices shares at the value plus the spread, and exactly at the virtual rate into an empty vault", () => {
    const v = vault();
    // 25 USDC into 82 USDC of value with 80 shares: about 24.27 shares, less 0.5% spread.
    const shares = previewShares(v, 25_000_000n);
    expect(shares).not.toBeNull();
    expect(Number(shares) / 1e18).toBeCloseTo(24.268, 2);
    expect(minSharesOut(v, 25_000_000n)).toBe(((shares as bigint) * 9_700n) / 10_000n);
    const empty = vault({ state: { totalSupply: "0", navUsdcE6: "0" } });
    expect(previewShares(empty, 20_000_000n)).toBe(20n * E18);
    expect(minSharesOut(empty, 20_000_000n)).toBe(20n * E18);
    expect(previewShares(vault({ state: { navUsdcE6: null } }), 1n)).toBeNull();
  });

  it("scales the viewer's value and in-kind slices to the shares redeemed", () => {
    const v = vault();
    expect(previewUsdc(v, 15n * E18)).toBe(15_296_250n);
    expect(previewInKind(v, 15n * E18)).toEqual([
      { symbol: "USDC", decimals: 6, amountRaw: "7875000" },
      { symbol: "WMON", decimals: 18, amountRaw: (300n * E18).toString() },
    ]);
    expect(minAssetsOut(v, 15n * E18)).toBe((15_296_250n * 9_700n) / 10_000n);
    expect(previewUsdc(vault({ viewer: { valueUsdcE6: null } }), 1n)).toBeNull();
  });

  it("knows how much USDC the vault can pay above its floor", () => {
    expect(usdcAvailable(vault())).toBe(42_000_000n - 8_200_000n);
    expect(usdcAvailable(vault({ state: { navUsdcE6: null } }))).toBeNull();
  });

  it("warns before a top-up and not before a first deposit", () => {
    expect(topUpWarning(vault(), NOW)).toContain("locks all of them, old and new, for 1 day");
    expect(topUpWarning(vault({ viewer: { shares: "0" } }), NOW)).toBeNull();
  });
});

describe("what blocks a withdrawal", () => {
  it("is only the lock and the shares, never the mode or a price", () => {
    expect(vaultWithdrawBlock(vault(), NOW)).toContain("locked until");
    expect(
      vaultWithdrawBlock(
        vault({ viewer: { freeShares: (30n * E18).toString(), unlockAt: NOW - 1 } }),
        NOW,
      ),
    ).toBeNull();
    expect(
      vaultWithdrawBlock(
        vault({
          viewer: { freeShares: (30n * E18).toString(), unlockAt: NOW - 1 },
          state: { mode: "PAUSED", navUsdcE6: null },
        }),
        NOW,
      ),
    ).toBeNull();
    expect(
      vaultWithdrawBlock(
        vault({ viewer: { shares: "0", freeShares: "0", lockedShares: "0" } }),
        NOW,
      ),
    ).toBe("You hold no shares of this vault.");
    expect(vaultWithdrawBlock(vault({ viewer: null }), NOW)).toBe(
      "Connect your wallet to withdraw.",
    );
  });
});
