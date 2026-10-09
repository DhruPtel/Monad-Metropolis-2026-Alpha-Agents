import { type TestFork, mintTestUsdc, startTestFork, testForkUpstream } from "@alpha-agents/devenv";
import { MONAD_BASE_TOKENS, type ScreenCheck, addressEntry } from "@alpha-agents/domain";
import { tokenFixture } from "@alpha-agents/market/testing";
import { parseGtPools, verifyPool } from "@alpha-agents/market";
import {
  type Address,
  type Hex,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  maxUint256,
  parseAbi,
  toHex,
} from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ScreenInput, runScreen } from "./screen.ts";
import { ScreenFork } from "./screen-fork.ts";
import { SCREEN_TOKEN_CODE } from "./screen-token-code.ts";
import { ForkSimulator, type RoutePool } from "./simulate.ts";

/**
 * F-U1's token screen on a fork of the latest block of its own (port 8578):
 * four test tokens are deployed, each given a real Uniswap v3 pool against
 * USDC through the real position manager, and screened through the real
 * route. The plain token passes; the taxed token, the honeypot and the
 * blacklisting owner are refused, each with its reason and evidence. A real
 * token (AUSD, through its hookless Uniswap v4 pool) passes on mainnet's
 * current state. Skips without MONAD_RPC_URL (as in CI).
 */
const PORT = 8578;
const upstream = testForkUpstream();
const SLOW = 600_000;
const DEPLOYER = "0x5c4ee10000000000000000000000000000000d01" as const;
const USDC = MONAD_BASE_TOKENS.USDC;
const SUPPLY = 10n ** 24n; // one million tokens
const NPM = getAddress(addressEntry("beta", "uniswap_v3_position_manager").address ?? "");
const NPM_ABI = parseAbi([
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)",
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
]);
const ERC20 = parseAbi(["function approve(address, uint256) returns (bool)"]);

describe.skipIf(!upstream)("the token screen on a fork of the latest block (F-U1)", () => {
  let fork: TestFork;
  let screenFork: ScreenFork;
  const pools: Record<string, RoutePool & { routable: boolean }> = {};
  const tokens: Record<string, string> = {};

  /** Deploys a test token and gives it a full-range USDC pool at 1 USDC per token. */
  async function launch(sim: ForkSimulator, name: keyof typeof SCREEN_TOKEN_CODE) {
    const client = sim.publicClient;
    const data = (SCREEN_TOKEN_CODE[name] +
      encodeAbiParameters([{ type: "uint256" }], [SUPPLY]).slice(2)) as Hex;
    await client.request({
      method: "anvil_impersonateAccount" as never,
      params: [DEPLOYER] as never,
    });
    const hash = (await client.request({
      method: "eth_sendTransaction" as never,
      params: [{ from: DEPLOYER, data, gas: toHex(5_000_000n) }] as never,
    })) as Hex;
    const receipt = await client.waitForTransactionReceipt({ hash });
    const token = (receipt.contractAddress ?? "").toLowerCase();
    expect(token).toMatch(/^0x[0-9a-f]{40}$/);
    const [token0, token1] = token < USDC ? [token, USDC] : [USDC, token];
    // 1 USDC per token: raw price token1/token0 is 1e-12 when the token is token0, else 1e12.
    const sqrtPriceX96 = token0 === token ? 2n ** 96n / 10n ** 6n : 2n ** 96n * 10n ** 6n;
    await sim.send(
      DEPLOYER,
      NPM,
      encodeFunctionData({
        abi: NPM_ABI,
        functionName: "createAndInitializePoolIfNecessary",
        args: [getAddress(token0), getAddress(token1), 3000, sqrtPriceX96],
      }),
    );
    for (const t of [token, USDC])
      await sim.send(
        DEPLOYER,
        getAddress(t),
        encodeFunctionData({ abi: ERC20, functionName: "approve", args: [NPM, maxUint256] }),
      );
    const tokenAmount = 100_000n * 10n ** 18n;
    const usdcAmount = 100_000n * 10n ** 6n;
    await sim.send(
      DEPLOYER,
      NPM,
      encodeFunctionData({
        abi: NPM_ABI,
        functionName: "mint",
        args: [
          {
            token0: getAddress(token0),
            token1: getAddress(token1),
            fee: 3000,
            tickLower: -887_220,
            tickUpper: 887_220,
            amount0Desired: token0 === token ? tokenAmount : usdcAmount,
            amount1Desired: token0 === token ? usdcAmount : tokenAmount,
            amount0Min: 0n,
            amount1Min: 0n,
            recipient: DEPLOYER,
            deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
          },
        ],
      }),
    );
    const v = await verifyPool(client, {
      dex: "uniswap_v3",
      poolId: await client.readContract({
        address: getAddress(addressEntry("beta", "uniswap_v3_factory").address ?? ""),
        abi: parseAbi(["function getPool(address, address, uint24) view returns (address)"]),
        functionName: "getPool",
        args: [getAddress(token0), getAddress(token1), 3000],
      }),
      base: token,
      quote: USDC,
    });
    if (!v) throw new Error(`the ${name} pool was not confirmed`);
    tokens[name] = token;
    // The pool's market record: deep and old enough, so only the token's own behaviour decides.
    pools[name] = {
      ...v,
      poolId: v.poolId.toLowerCase(),
      liquidityUsd: 200_000,
      createdAt: "2026-01-01T00:00:00Z",
    };
  }

  beforeAll(async () => {
    fork = await startTestFork({ port: PORT, block: "latest" });
    screenFork = new ScreenFork({
      start: async () => ({ url: fork.url, block: fork.block, stop: async () => undefined }),
      maxAgeMs: 24 * 3600_000,
    });
    // The launches stay on the fork: they run outside the screen fork's revert.
    const sim = new ForkSimulator(fork.url);
    await sim.publicClient.request({
      method: "anvil_setBalance" as never,
      params: [DEPLOYER, toHex(10n ** 22n)] as never,
    });
    await mintTestUsdc(DEPLOYER, 1_000_000n * 10n ** 6n, fork.url);
    for (const name of Object.keys(SCREEN_TOKEN_CODE) as (keyof typeof SCREEN_TOKEN_CODE)[])
      await launch(sim, name);
  }, SLOW);

  afterAll(async () => {
    await screenFork?.stop();
    await fork?.stop();
  });

  const screen = (input: ScreenInput) =>
    runScreen(input, {
      onFork: (fn) => screenFork.run(fn),
      goplus: async () => null,
      now: () => Date.now(),
    });
  const check = (checks: readonly ScreenCheck[], code: ScreenCheck["code"]) =>
    checks.find((c) => c.code === code);
  const target = (name: keyof typeof SCREEN_TOKEN_CODE, symbol: string): ScreenInput => ({
    token: { address: tokens[name] ?? "", symbol, name: symbol, decimals: 18 },
    pools: [pools[name] as RoutePool & { routable: boolean }],
    listings: [{ symbol: "USDC", name: "USDC", monadAddress: USDC, source: "reviewed" }],
  });

  it(
    "passes the plain token through a real buy, transfer and sell",
    { timeout: SLOW },
    async () => {
      const r = await screen(target("ScreenPlainToken", "SPLAIN"));
      expect(r.checks.filter((c) => c.status !== "pass").map((c) => c.code)).toEqual(["GOPLUS"]);
      expect(r.verdict).toBe("passed");
      expect(check(r.checks, "BUY")?.evidence.taxBps).toBe(0);
      // 0.3% fee each way plus a little impact.
      expect(Number(check(r.checks, "ROUND_TRIP")?.evidence.roundTripBps)).toBeLessThan(100);
      expect(r.forkBlock).toBeGreaterThan(111_000_000);
    },
  );

  it("refuses the taxed token with the tax it measured", { timeout: SLOW }, async () => {
    const r = await screen(target("ScreenTaxToken", "STAX"));
    expect(r.verdict).toBe("refused");
    expect(check(r.checks, "BUY")).toMatchObject({ status: "fail" });
    expect(Number(check(r.checks, "BUY")?.evidence.taxBps)).toBeGreaterThanOrEqual(490);
    // 5% taken, read in whole basis points.
    expect(check(r.checks, "TRANSFER")?.reason).toMatch(
      /^A transfer tax of (4\.99|5\.00)%, above the 1\.00% limit\.$/,
    );
    // A fee-on-transfer token cannot pay a v3 pool in full: its sell reverts too.
    expect(check(r.checks, "SELL")?.status).toBe("fail");
  });

  it(
    "refuses the honeypot as unsellable, with the token's own reason",
    { timeout: SLOW },
    async () => {
      const r = await screen(target("ScreenHoneypotToken", "SHONEY"));
      expect(r.verdict).toBe("refused");
      expect(check(r.checks, "BUY")?.status).toBe("pass");
      expect(check(r.checks, "TRANSFER")?.status).toBe("pass");
      expect(check(r.checks, "SELL")?.status).toBe("fail");
      expect(check(r.checks, "SELL")?.reason).toMatch(/^Unsellable: the sell reverted/);
      expect(String(check(r.checks, "SELL")?.evidence.error)).toMatch(
        /transfers are closed|STF|reverted/,
      );
    },
  );

  it("refuses the token whose live owner can blacklist holders", { timeout: SLOW }, async () => {
    const r = await screen(target("ScreenBlacklistToken", "SBLACK"));
    expect(r.verdict).toBe("refused");
    expect(check(r.checks, "SELL")?.status).toBe("pass");
    expect(check(r.checks, "OWNER_POWERS")).toMatchObject({
      status: "fail",
      reason: "A live owner can call blacklist.",
    });
    expect(check(r.checks, "OWNER_POWERS")?.evidence.owner).toBe(DEPLOYER);
  });

  it("refuses a young or thin pool on the same token", { timeout: SLOW }, async () => {
    const base = target("ScreenPlainToken", "SPLAIN");
    const young = await screen({
      ...base,
      pools: [
        {
          ...(base.pools[0] as RoutePool & { routable: boolean }),
          createdAt: new Date(Date.now() - 3_600_000).toISOString(),
        },
      ],
    });
    expect(check(young.checks, "POOL_AGE")?.reason).toBe(
      "The pool is 1 hours old, younger than 72 hours.",
    );
    const thin = await screen({
      ...base,
      pools: [{ ...(base.pools[0] as RoutePool & { routable: boolean }), liquidityUsd: 20_000 }],
    });
    expect(thin.verdict).toBe("refused");
    expect(check(thin.checks, "LIQUIDITY")?.status).toBe("fail");
  });

  it(
    "passes a real token through its real Uniswap v4 route on mainnet's current state",
    { timeout: SLOW },
    async () => {
      const ausd = "0x00000000efe302beaa2b3e6e1b18d08d69a9012a";
      const gt = parseGtPools(tokenFixture("gt-uniswap-v4-monad-volume-1.json"), {
        now: Math.floor(Date.now() / 1000),
      }).pools;
      const p = gt.find((x) => x.name.startsWith("AUSD / USDC"));
      if (!p) throw new Error("no AUSD pool in the fixture");
      const sim = new ForkSimulator(fork.url);
      const v = await verifyPool(sim.publicClient, p);
      if (!v) throw new Error("the AUSD pool was not confirmed");
      const r = await screen({
        token: { address: ausd, symbol: "AUSD", name: "AUSD", decimals: 6 },
        pools: [{ ...v, liquidityUsd: p.liquidityUsd ?? 0, createdAt: p.createdAt }],
        listings: [{ symbol: "AUSD", name: "AUSD", monadAddress: ausd, source: "reviewed" }],
      });
      expect(r.route?.pool.dex).toBe("uniswap_v4");
      expect(r.verdict).toBe("passed");
      expect(check(r.checks, "UPGRADEABLE")?.reason).toMatch(/reviewed list/);
    },
  );

  it(
    "reverts every screen's trades: the test accounts start empty each time",
    { timeout: SLOW },
    async () => {
      const holder: Address = "0x5c4ee1000000000000000000000000000000b0b2";
      const sim = new ForkSimulator(fork.url);
      expect(await sim.balanceOf(tokens.ScreenPlainToken ?? "", holder)).toBe(0n);
      expect(await sim.balanceOf(USDC, "0x5c4ee1000000000000000000000000000000b0b1")).toBe(0n);
    },
  );
});
