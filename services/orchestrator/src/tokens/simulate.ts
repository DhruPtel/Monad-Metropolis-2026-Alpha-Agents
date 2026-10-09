import { MONAD_BASE_TOKENS, NATIVE_MON, addressEntry } from "@alpha-agents/domain";
import { assertLocalFork, mintTestUsdc } from "@alpha-agents/devenv";
import type { Dex } from "@alpha-agents/market";
import {
  type Address,
  type Hex,
  type PublicClient,
  BaseError,
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  maxUint160,
  maxUint256,
  parseAbi,
  toHex,
} from "viem";

/**
 * The token screen's simulation (F-U1, D-339 step 1), on a fork of the latest
 * block and nowhere else: a fresh test account buys a reference amount of the
 * token through the real route, transfers all of it to a second account, and
 * that account sells all of it back through the same route. Each step's
 * shortfall against the venue's own quote is its tax; a revert is recorded
 * with its reason. Every transaction is sent only after the fork guard
 * (anvil, 127.0.0.1, chain 143143) passes.
 *
 * Routes: Uniswap v3 through SwapRouter02, PancakeSwap v3 through its
 * SwapRouter, and hookless Uniswap v4 pools through the Universal Router with
 * Permit2, the way any wallet trades them. Quotes come from each venue's
 * quoter by `eth_call`.
 */
const book = (id: Parameters<typeof addressEntry>[1]): Address => {
  const e = addressEntry("beta", id);
  if (!e.address) throw new Error(`${id} has no mainnet address`);
  return getAddress(e.address);
};

export const ROUTERS = {
  uniswap_v3: { router: book("uniswap_v3_swap_router02"), quoter: book("uniswap_v3_quoter_v2") },
  pancakeswap_v3: {
    router: book("pancakeswap_v3_swap_router"),
    quoter: book("pancakeswap_v3_quoter_v2"),
  },
  uniswap_v4: { router: book("uniswap_universal_router"), quoter: book("uniswap_v4_quoter") },
} as const;
const PERMIT2 = book("permit2");

/** The screen's two test accounts: they exist only on the fork, and hold nothing on mainnet. */
export const SCREEN_BUYER = "0x5c4ee1000000000000000000000000000000b0b1" as const;
export const SCREEN_RECEIVER = "0x5c4ee1000000000000000000000000000000b0b2" as const;

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
]);
const WMON_ABI = parseAbi(["function deposit() payable"]);
const QUOTER_V2 = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const SWAP_ROUTER02 = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);
const PANCAKE_ROUTER = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);
const POOL_KEY = {
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
} as const;
const V4_QUOTER = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "poolKey", ...POOL_KEY },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;
const UNIVERSAL_ROUTER = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
]);
const PERMIT2_ABI = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);
/** Universal Router's V4_SWAP command and v4-periphery's actions. */
const V4_SWAP = 0x10;
const SWAP_EXACT_IN_SINGLE = 0x06;
const SETTLE_ALL = 0x0c;
const TAKE_ALL = 0x0f;

export interface RoutePool {
  readonly dex: Dex;
  readonly poolId: string;
  readonly token0: string;
  readonly token1: string;
  readonly fee: number | null;
  readonly tickSpacing: number | null;
  readonly hooks: string | null;
  readonly liquidityUsd: number;
  readonly createdAt: string | null;
}

export interface Route {
  readonly pool: RoutePool;
  readonly token: string;
  /** USDC, WMON, or native MON (v4 pools only). */
  readonly base: string;
  readonly baseSymbol: "USDC" | "WMON" | "MON";
}

export type StepResult =
  | {
      readonly ok: true;
      readonly quoted: string;
      readonly received: string;
      readonly taxBps: number;
    }
  | { readonly ok: false; readonly error: string };

export interface Simulation {
  readonly amountIn: string;
  readonly buy: StepResult;
  /** Null when the buy failed and there was nothing to transfer. */
  readonly transfer:
    | {
        readonly ok: true;
        readonly sent: string;
        readonly received: string;
        readonly taxBps: number;
      }
    | { readonly ok: false; readonly error: string }
    | null;
  readonly sell: (StepResult & { readonly leftover?: string }) | null;
  /** What the buy then sell cost, against the amount put in; null unless both ran. */
  readonly roundTripBps: number | null;
  /** Where each quote came from: the venue's quoter, or the router's own return. */
  readonly quoteSources: readonly string[];
}

const BASE_SYMBOL: Readonly<Record<string, Route["baseSymbol"]>> = {
  [MONAD_BASE_TOKENS.USDC]: "USDC",
  [MONAD_BASE_TOKENS.WMON]: "WMON",
  [NATIVE_MON]: "MON",
};

/**
 * The route the screen uses: the deepest routable pool pairing the token with
 * USDC, WMON or native MON. Null when the token has none.
 */
export function chooseRoute(
  token: string,
  pools: readonly (RoutePool & { routable: boolean })[],
): Route | null {
  const t = token.toLowerCase();
  const candidates = pools
    .filter((p) => p.routable && (p.token0 === t || p.token1 === t))
    .map((p) => ({ p, base: p.token0 === t ? p.token1 : p.token0 }))
    .filter(({ p, base }) => BASE_SYMBOL[base] && (base !== NATIVE_MON || p.dex === "uniswap_v4"))
    .sort((a, b) => b.p.liquidityUsd - a.p.liquidityUsd);
  const best = candidates[0];
  if (!best) return null;
  return {
    pool: best.p,
    token: t,
    base: best.base,
    baseSymbol: BASE_SYMBOL[best.base] as Route["baseSymbol"],
  };
}

/** A revert's own short message, without anything about the node. */
export function revertReason(err: unknown): string {
  const raw =
    err instanceof BaseError
      ? ((
          err.walk(
            (e) => e instanceof BaseError && "reason" in e && typeof e.reason === "string",
          ) as { reason?: string } | null
        )?.reason ?? err.shortMessage)
      : err instanceof Error
        ? err.message
        : "failed";
  return raw
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

const bps = (shortfall: bigint, of: bigint) =>
  of > 0n && shortfall > 0n ? Number((shortfall * 10_000n) / of) : 0;

export class ForkSimulator {
  readonly url: string;
  private readonly client: PublicClient;

  constructor(url: string) {
    this.url = url;
    this.client = createPublicClient({ transport: http(url, { timeout: 60_000 }) }) as PublicClient;
  }

  private async rpc(method: string, params: unknown[]): Promise<unknown> {
    return this.client.request({ method: method as never, params: params as never });
  }

  /** Sends one transaction as an impersonated account, and returns the gas it paid; the fork guard runs first. */
  async send(from: Address, to: Address, data: Hex, value = 0n): Promise<bigint> {
    await assertLocalFork(this.url);
    await this.rpc("anvil_impersonateAccount", [from]);
    try {
      // A revert is refused at estimation, with its reason. The estimate is padded by half:
      // under Monad's gas rules a first-touch write can need more than anvil's estimate.
      const estimate = await this.client.estimateGas({ account: from, to, data, value });
      const hash = (await this.rpc("eth_sendTransaction", [
        { from, to, data, value: toHex(value), gas: toHex((estimate * 3n) / 2n) },
      ])) as Hex;
      const receipt = await this.client.waitForTransactionReceipt({ hash, timeout: 30_000 });
      if (receipt.status !== "success") {
        // Replay as a call in the same block (same timestamp) to read the reason.
        await this.client
          .call({ account: from, to, data, value, blockNumber: receipt.blockNumber })
          .catch((err: unknown) => {
            throw new Error(revertReason(err));
          });
        throw new Error("the transaction reverted (out of gas, or with no reason)");
      }
      return receipt.gasUsed * receipt.effectiveGasPrice;
    } finally {
      await this.rpc("anvil_stopImpersonatingAccount", [from]);
    }
  }

  balanceOf(token: string, who: string): Promise<bigint> {
    if (token === NATIVE_MON) return this.client.getBalance({ address: getAddress(who) });
    return this.client.readContract({
      address: getAddress(token),
      abi: ERC20,
      functionName: "balanceOf",
      args: [getAddress(who)],
    });
  }

  async block(): Promise<{ number: bigint; timestamp: bigint }> {
    const b = await this.client.getBlock();
    return { number: b.number, timestamp: b.timestamp };
  }

  get publicClient(): PublicClient {
    return this.client;
  }

  /** Gives the buyer `amount` of the base asset, and gas money, on the fork. */
  async fund(who: Address, base: string, amount: bigint): Promise<void> {
    await assertLocalFork(this.url);
    await this.rpc("anvil_setBalance", [
      who,
      toHex(10n ** 21n + (base === NATIVE_MON ? amount : 0n)),
    ]);
    if (base === MONAD_BASE_TOKENS.USDC) await mintTestUsdc(who, amount, this.url);
    else if (base === MONAD_BASE_TOKENS.WMON) {
      await this.rpc("anvil_setBalance", [who, toHex(10n ** 21n + amount)]);
      await this.send(
        who,
        getAddress(MONAD_BASE_TOKENS.WMON),
        encodeFunctionData({ abi: WMON_ABI, functionName: "deposit" }),
        amount,
      );
    }
  }

  /** The venue's quote for an exact input, by `eth_call`. */
  async quote(
    pool: RoutePool,
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
  ): Promise<bigint> {
    if (pool.dex === "uniswap_v4") {
      const { result } = await this.client.simulateContract({
        address: ROUTERS.uniswap_v4.quoter,
        abi: V4_QUOTER,
        functionName: "quoteExactInputSingle",
        args: [
          {
            poolKey: poolKey(pool),
            zeroForOne: tokenIn === pool.token0,
            exactAmount: amountIn,
            hookData: "0x",
          },
        ],
      });
      return result[0];
    }
    const { result } = await this.client.simulateContract({
      address: ROUTERS[pool.dex].quoter,
      abi: QUOTER_V2,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: getAddress(tokenIn),
          tokenOut: getAddress(tokenOut),
          amountIn,
          fee: pool.fee ?? 0,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    return result[0];
  }

  /**
   * A quote for `who`'s swap: the venue's quoter, or, when the quoter refuses
   * (a token that blocks transfers to contracts breaks it, since the quoter is
   * the swap's recipient), the v3 router's own return for the same swap by
   * `eth_call`, after approving it. Uniswap v4's router returns nothing, so a
   * v4 quote has only the quoter.
   */
  async quoteFor(
    who: Address,
    pool: RoutePool,
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
  ): Promise<{ amount: bigint; source: "quoter" | "router" }> {
    try {
      return { amount: await this.quote(pool, tokenIn, tokenOut, amountIn), source: "quoter" };
    } catch (err) {
      if (pool.dex === "uniswap_v4") throw err;
    }
    const router = ROUTERS[pool.dex].router;
    await this.send(
      who,
      getAddress(tokenIn),
      encodeFunctionData({ abi: ERC20, functionName: "approve", args: [router, amountIn] }),
    );
    const common = {
      tokenIn: getAddress(tokenIn),
      tokenOut: getAddress(tokenOut),
      fee: pool.fee ?? 0,
      recipient: who,
      amountIn,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    };
    const { result } =
      pool.dex === "uniswap_v3"
        ? await this.client.simulateContract({
            account: who,
            address: router,
            abi: SWAP_ROUTER02,
            functionName: "exactInputSingle",
            args: [common],
          })
        : await this.client.simulateContract({
            account: who,
            address: router,
            abi: PANCAKE_ROUTER,
            functionName: "exactInputSingle",
            args: [{ ...common, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600) }],
          });
    return { amount: result, source: "router" };
  }

  /** Swaps an exact input through the pool's router, from and to `who`. */
  async swap(
    who: Address,
    pool: RoutePool,
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
  ): Promise<bigint> {
    let gas = 0n;
    // A fork's latest block can be minutes old, and the next block is stamped
    // with the wall clock: the deadline counts from whichever is later.
    const head = (await this.block()).timestamp;
    const wall = BigInt(Math.floor(Date.now() / 1000));
    const deadline = (head > wall ? head : wall) + 3600n;
    if (pool.dex === "uniswap_v4") {
      const native = tokenIn === NATIVE_MON;
      if (!native) {
        gas += await this.send(
          who,
          getAddress(tokenIn),
          encodeFunctionData({ abi: ERC20, functionName: "approve", args: [PERMIT2, maxUint256] }),
        );
        gas += await this.send(
          who,
          PERMIT2,
          encodeFunctionData({
            abi: PERMIT2_ABI,
            functionName: "approve",
            args: [getAddress(tokenIn), ROUTERS.uniswap_v4.router, maxUint160, Number(deadline)],
          }),
        );
      }
      const actions = toHex(new Uint8Array([SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]));
      const params = [
        encodeAbiParameters(
          [
            {
              type: "tuple",
              components: [
                { name: "poolKey", ...POOL_KEY },
                { name: "zeroForOne", type: "bool" },
                { name: "amountIn", type: "uint128" },
                { name: "amountOutMinimum", type: "uint128" },
                { name: "hookData", type: "bytes" },
              ],
            },
          ],
          [
            {
              poolKey: poolKey(pool),
              zeroForOne: tokenIn === pool.token0,
              amountIn,
              amountOutMinimum: 0n,
              hookData: "0x",
            },
          ],
        ),
        encodeAbiParameters(
          [{ type: "address" }, { type: "uint256" }],
          [getAddress(tokenIn), amountIn],
        ),
        encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [getAddress(tokenOut), 0n]),
      ];
      const input = encodeAbiParameters(
        [{ type: "bytes" }, { type: "bytes[]" }],
        [actions, params],
      );
      gas += await this.send(
        who,
        ROUTERS.uniswap_v4.router,
        encodeFunctionData({
          abi: UNIVERSAL_ROUTER,
          functionName: "execute",
          args: [toHex(new Uint8Array([V4_SWAP])), [input], deadline],
        }),
        native ? amountIn : 0n,
      );
      return gas;
    }
    const router = ROUTERS[pool.dex].router;
    gas += await this.send(
      who,
      getAddress(tokenIn),
      encodeFunctionData({ abi: ERC20, functionName: "approve", args: [router, amountIn] }),
    );
    const common = {
      tokenIn: getAddress(tokenIn),
      tokenOut: getAddress(tokenOut),
      fee: pool.fee ?? 0,
      recipient: who,
      amountIn,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    };
    gas += await this.send(
      who,
      router,
      pool.dex === "uniswap_v3"
        ? encodeFunctionData({
            abi: SWAP_ROUTER02,
            functionName: "exactInputSingle",
            args: [common],
          })
        : encodeFunctionData({
            abi: PANCAKE_ROUTER,
            functionName: "exactInputSingle",
            args: [{ ...common, deadline }],
          }),
    );
    return gas;
  }

  /**
   * Buy, transfer and sell through the route, measuring each step. The caller
   * snapshots and reverts the fork around it.
   */
  async roundTrip(route: Route, amountIn: bigint): Promise<Simulation> {
    const { pool, token, base } = route;
    await this.fund(SCREEN_BUYER, base, amountIn);
    await this.rpc("anvil_setBalance", [SCREEN_RECEIVER, toHex(10n ** 21n)]);

    const quoteSources: string[] = [];
    let buy: StepResult;
    let bought = 0n;
    try {
      const q = await this.quoteFor(SCREEN_BUYER, pool, base, token, amountIn);
      const quoted = q.amount;
      quoteSources.push(q.source);
      const before = await this.balanceOf(token, SCREEN_BUYER);
      await this.swap(SCREEN_BUYER, pool, base, token, amountIn);
      bought = (await this.balanceOf(token, SCREEN_BUYER)) - before;
      buy = {
        ok: true,
        quoted: quoted.toString(),
        received: bought.toString(),
        taxBps: bps(quoted - bought, quoted),
      };
    } catch (err) {
      buy = { ok: false, error: revertReason(err) };
    }
    if (!buy.ok || bought === 0n)
      return {
        amountIn: amountIn.toString(),
        buy: buy.ok ? { ok: false, error: "the buy delivered nothing" } : buy,
        transfer: null,
        sell: null,
        roundTripBps: null,
        quoteSources,
      };

    let transfer: Simulation["transfer"];
    let held = 0n;
    try {
      const before = await this.balanceOf(token, SCREEN_RECEIVER);
      await this.send(
        SCREEN_BUYER,
        getAddress(token),
        encodeFunctionData({
          abi: ERC20,
          functionName: "transfer",
          args: [SCREEN_RECEIVER, bought],
        }),
      );
      held = (await this.balanceOf(token, SCREEN_RECEIVER)) - before;
      transfer = {
        ok: true,
        sent: bought.toString(),
        received: held.toString(),
        taxBps: bps(bought - held, bought),
      };
    } catch (err) {
      transfer = { ok: false, error: revertReason(err) };
    }
    // When the transfer failed, the buyer sells what it holds instead.
    const seller = transfer.ok ? SCREEN_RECEIVER : SCREEN_BUYER;
    const amount = transfer.ok ? held : bought;
    let sell: Simulation["sell"];
    let roundTripBps: number | null = null;
    try {
      const q = await this.quoteFor(seller, pool, token, base, amount);
      const quoted = q.amount;
      quoteSources.push(q.source);
      const before = await this.balanceOf(base, seller);
      const gas = await this.swap(seller, pool, token, base, amount);
      const after = await this.balanceOf(base, seller);
      // Native MON also pays gas: the seller's gas is added back to the proceeds.
      const received = after - before + (base === NATIVE_MON ? gas : 0n);
      const leftover = await this.balanceOf(token, seller);
      sell = {
        ok: true,
        quoted: quoted.toString(),
        received: received.toString(),
        taxBps: bps(quoted - received, quoted),
        leftover: leftover.toString(),
      };
      roundTripBps = bps(amountIn - received, amountIn);
    } catch (err) {
      sell = { ok: false, error: revertReason(err) };
    }
    return { amountIn: amountIn.toString(), buy, transfer, sell, roundTripBps, quoteSources };
  }

  async snapshot(): Promise<Hex> {
    await assertLocalFork(this.url);
    return (await this.rpc("evm_snapshot", [])) as Hex;
  }

  async revert(id: Hex): Promise<void> {
    await this.rpc("evm_revert", [id]);
  }
}

function poolKey(pool: RoutePool) {
  return {
    currency0: getAddress(pool.token0),
    currency1: getAddress(pool.token1),
    fee: pool.fee ?? 0,
    tickSpacing: pool.tickSpacing ?? 0,
    hooks: getAddress(pool.hooks ?? NATIVE_MON),
  };
}
