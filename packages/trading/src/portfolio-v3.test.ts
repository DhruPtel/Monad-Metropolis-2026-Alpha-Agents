import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  type PortfolioClientV3,
  type PortfolioContractsV3,
  portfolioV3Json,
  rpcPortfolioReaderV3,
} from "./portfolio-v3.ts";

/**
 * The v3 portfolio reading (after the F-U11 playtest, A-80) over a fake
 * chain: the account or where it will be, the factory's allowlist and caps,
 * every held token valued as the account values it (USDC at 1, a class F
 * token at the oracle's price, unknown while the feed is unusable), the
 * depositable tokens with the wallet's balances, and the v2 account as an
 * older account.
 */
const NFT = "0x60cacA6dE327331b321E140Ae19AcbCc4188Be6E" as Hex;
const F3 = "0x5ebF58520f9bAa847959DcF69716030a1583BCDb" as Hex;
const F2 = "0xC898A55c814a629653f6CD7aC007edd6b63ac0De" as Hex;
const ORACLE = "0xeeB91f3371Db0d409bbE0Ffa9ea901E09A783a43" as Hex;
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as Hex;
const WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A" as Hex;
const WBTC = "0x0555e30da8f98308edb960aa94c0db47230d2b9c" as Hex;
const EXEC = "0x3443dbBd29E19CF17853732C260C6abDb6dC0658" as Hex;
const OWNER = "0x683eE842A16f85e69883F433745263BFe8D55f76" as Hex;
const ACCOUNT = "0x00000000000000000000000000000000000ac0f3" as Hex;
const LEGACY = "0xF8322887Dd39EF54737b8Eb222d8F5b4D039B0e7" as Hex;
const ZERO = "0x0000000000000000000000000000000000000000" as Hex;
const E18 = 10n ** 18n;
const NOW = 1_790_000_000n;
const c: PortfolioContractsV3 = {
  agentNft: NFT,
  accountFactory: F3,
  accountFactoryV2: F2,
  oracle: ORACLE,
  usdc: USDC,
  wmon: WMON,
  executor: EXEC,
};
const lower = (a: string) => a.toLowerCase();

/** A chain as one test sets it: every read keyed by address and function. */
function fakeChain(state: {
  account: Hex;
  legacy: Hex;
  wmonReason?: number;
  holdings?: readonly {
    token: Hex;
    decimals: number;
    balance: bigint;
    free: bigint;
    costBasis: bigint;
    lastPriceE18: bigint;
    lastPricedAt: bigint;
  }[];
}): PortfolioClientV3 & { reads: string[] } {
  const reads: string[] = [];
  const holdings = state.holdings ?? [];
  return {
    reads,
    async getBlock() {
      return { number: 109_670_100n, timestamp: NOW };
    },
    async getBalance() {
      return 2n * E18;
    },
    async readContract({ address, functionName, args = [] }) {
      reads.push(`${functionName}@${lower(address).slice(0, 8)}`);
      const at = lower(address);
      if (at === lower(NFT) && functionName === "ownerOf") {
        if (args[0] === 1n) return OWNER;
        throw new Error("execution reverted: nonexistent token");
      }
      if (at === lower(F3)) {
        const f: Record<string, unknown> = {
          personalAccountOf: state.account,
          predictPersonalAccount: ACCOUNT,
          allowlistEnabled: true,
          isAllowlisted: true,
          personalCap: 100_000_000n,
          platformCap: 2_000_000_000n,
          platformTotal: 250_000_000n,
        };
        return f[functionName];
      }
      if (at === lower(F2) && functionName === "personalAccountOf") return state.legacy;
      if (at === lower(ORACLE) && functionName === "price") {
        const token = lower(String(args[0]));
        if (token === lower(USDC)) return [E18, NOW - 600n, 0];
        if (token === lower(WMON)) return [25n * 10n ** 15n, NOW - 20n, state.wmonReason ?? 0];
        if (token === lower(WBTC)) return [100_000n * E18, NOW - 30n, 0];
        throw new Error("execution reverted: UnknownAsset");
      }
      if (functionName === "balanceOf") {
        const who = lower(String(args[0]));
        if (who === lower(OWNER)) {
          if (at === lower(USDC)) return 370_000_000n;
          if (at === lower(WMON)) return 5n * E18;
          return 0n;
        }
        return 0n;
      }
      if (at === lower(state.account)) {
        // The views that value the account revert while a held token's feed is unusable.
        if (
          functionName === "navUsdc" &&
          holdings.some((h) => h.token === WMON && (state.wmonReason ?? 0) !== 0)
        )
          throw new Error("execution reverted: FeedUnusable");
        const a: Record<string, unknown> = {
          principal: 90_000_000n,
          mode: 0,
          depositsClosed: false,
          holdings,
          navUsdc: 101_250_000n,
          breakerState: [101_250_000n, 1_012_500_000_000_000_000n, 1_012_500_000_000_000_000n, 0n],
          peakPerUnit7d: 1_012_500_000_000_000_000n,
          claimable: lower(String(args[0])) === lower(WMON) ? 3n * E18 : 0n,
        };
        return a[functionName];
      }
      if (at === lower(state.legacy)) {
        const l: Record<string, unknown> = {
          freeBalance: lower(String(args[0])) === lower(USDC) ? 100_000_000n : 0n,
          claimable: 0n,
          mode: 0,
        };
        return l[functionName];
      }
      throw new Error(`unexpected read ${functionName} at ${address}`);
    },
  };
}

const tokens = async () => [
  { symbol: "USDC", address: USDC, decimals: 6, priceClass: "F" as const },
  { symbol: "WMON", address: WMON, decimals: 18, priceClass: "F" as const },
  { symbol: "WBTC", address: WBTC, decimals: 8, priceClass: "F" as const },
];

describe("the v3 portfolio reading (after the F-U11 playtest)", () => {
  it("reads an agent with no account yet: where it will be, the allowlist, the caps, the depositable tokens and the older account", async () => {
    const client = fakeChain({ account: ZERO, legacy: LEGACY });
    const r = await rpcPortfolioReaderV3("http://unused", 143143, c, { tokens, client }).portfolio(
      1,
    );
    expect(r).not.toBeNull();
    const j = portfolioV3Json(r as NonNullable<typeof r>);
    expect(j).toMatchObject({
      custody: "v3",
      block: "109670100",
      timestamp: Number(NOW),
      owner: OWNER,
      account: null,
      predictedAccount: ACCOUNT,
      allowlist: { enabled: true, listed: true },
      caps: {
        personalUsdcE6: "100000000",
        platformUsdcE6: "2000000000",
        platformTotalUsdcE6: "250000000",
        principalUsdcE6: "0",
      },
      mode: null,
      navUsdcE6: null,
      breaker: null,
      holdings: [],
      usdcPeg: { reason: "OK" },
      wallet: { monWei: (2n * E18).toString() },
      legacy: {
        account: LEGACY,
        usdcE6: "100000000",
        wmonWei: "0",
        claimable: { usdcE6: "0", wmonWei: "0" },
        mode: "NORMAL",
      },
    });
    expect(j.tokens.map((t) => [t.symbol, t.walletRaw, t.price.reason])).toEqual([
      ["USDC", "370000000", "OK"],
      ["WMON", (5n * E18).toString(), "OK"],
      ["WBTC", "0", "OK"],
    ]);
    // Nothing of the account is read when there is none.
    expect(client.reads.some((x) => x.startsWith("holdings@"))).toBe(false);
  });

  it("values every held token as the account does, keeps what is held back for a claim, and reads no older account when there is none", async () => {
    const client = fakeChain({
      account: ACCOUNT,
      legacy: ZERO,
      holdings: [
        {
          token: USDC,
          decimals: 6,
          balance: 60_000_000n,
          free: 60_000_000n,
          costBasis: 0n,
          lastPriceE18: 0n,
          lastPricedAt: 0n,
        },
        {
          token: WMON,
          decimals: 18,
          balance: 400n * E18,
          free: 397n * E18,
          costBasis: 9_500_000n,
          lastPriceE18: 0n,
          lastPricedAt: 0n,
        },
        {
          token: WBTC,
          decimals: 8,
          balance: 30_000n,
          free: 30_000n,
          costBasis: 28_000_000n,
          lastPriceE18: 0n,
          lastPricedAt: 0n,
        },
      ],
    });
    const r = await rpcPortfolioReaderV3("http://unused", 143143, c, { tokens, client }).portfolio(
      1,
    );
    const j = portfolioV3Json(r as NonNullable<typeof r>);
    expect(j).toMatchObject({
      account: ACCOUNT,
      caps: { principalUsdcE6: "90000000" },
      mode: "NORMAL",
      navUsdcE6: "101250000",
      breaker: { navUsdcE6: "101250000", drawdownBps: 0 },
      peak7dE18: "1012500000000000000",
      legacy: null,
    });
    expect(
      j.holdings.map((h) => [
        h.symbol,
        h.amountRaw,
        h.valueUsdcE6,
        h.costBasisUsdcE6,
        h.claimableRaw,
      ]),
    ).toEqual([
      ["USDC", "60000000", "60000000", "0", "0"],
      ["WMON", (400n * E18).toString(), "10000000", "9500000", (3n * E18).toString()],
      ["WBTC", "30000", "30000000", "28000000", "0"],
    ]);
  });

  it("marks a held token unpriced while its feed is unusable, and the account's value with it", async () => {
    const client = fakeChain({
      account: ACCOUNT,
      legacy: ZERO,
      wmonReason: 9,
      holdings: [
        {
          token: WMON,
          decimals: 18,
          balance: 400n * E18,
          free: 400n * E18,
          costBasis: 9_500_000n,
          lastPriceE18: 0n,
          lastPricedAt: 0n,
        },
      ],
    });
    const r = await rpcPortfolioReaderV3("http://unused", 143143, c, { tokens, client }).portfolio(
      1,
    );
    const j = portfolioV3Json(r as NonNullable<typeof r>);
    expect(j.holdings[0]).toMatchObject({
      symbol: "WMON",
      priceE18: null,
      priceReason: "STALE",
      valueUsdcE6: null,
    });
    expect(j.navUsdcE6).toBeNull();
    expect(j.tokens.find((t) => t.symbol === "WMON")?.price.reason).toBe("STALE");
  });

  it("is null for an agent that does not exist", async () => {
    const client = fakeChain({ account: ZERO, legacy: ZERO });
    expect(
      await rpcPortfolioReaderV3("http://unused", 143143, c, { tokens, client }).portfolio(9),
    ).toBeNull();
  });
});
