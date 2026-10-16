// @ts-check
// pnpm dev:discover: 2026-10-16, the monad-dev stack's token discovery on a Uniswap v2 family
// venue (nad.fun first, packages/domain V2_VENUES). Reads every pair the venue's factory lists,
// keeps those quoting against the stack's USDC or WMON whose buy-then-sell route works at a
// small size (the pair's own quote both ways, or the v2 formula at the venue's fee), and ranks
// the tokens by the base side's depth in USDC. No safety screen and no liquidity minimum: the
// count is bounded only by the deploy's gas (each registered token costs about 0.4M gas across
// the registries, and one transaction holds at most 30M), so the top `--max` (default 50) are
// written to evidence/dev-nadfun/discovery.json for the deploy. Read-only: sends nothing, prints
// no key and no RPC URL.
//
//   pnpm dev:discover [--venue nadfun] [--max 50]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { V2_VENUES, v2AmountOut } from "@alpha-agents/domain";
import { createPublicClient, decodeAbiParameters, encodeAbiParameters, http, parseAbi } from "viem";
import { loadRootEnv } from "./lib/config.js";
import { ROOT } from "./lib/paths.js";

const arg = (/** @type {string} */ name, /** @type {string} */ fallback) =>
  process.argv.includes(name) ? (process.argv[process.argv.indexOf(name) + 1] ?? fallback) : fallback;
const venue = V2_VENUES.find((v) => v.id === arg("--venue", "nadfun"));
if (!venue) throw new Error("unknown venue");
const MAX = Number(arg("--max", "50"));
const OUT_DIR = join(ROOT, "evidence/dev-nadfun");

loadRootEnv();
const url =
  process.env.MONAD_TESTNET_RPC_URL_SECONDARY?.trim() || process.env.MONAD_TESTNET_RPC_URL?.trim();
if (!url) throw new Error("MONAD_TESTNET_RPC_URL is not set");
const client = createPublicClient({ transport: http(url, { batch: false, retryCount: 3 }) });

const FACTORY = parseAbi([
  "function allPairsLength() view returns (uint256)",
  "function allPairs(uint256) view returns (address)",
]);
const PAIR = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112, uint112, uint32)",
]);
const ERC20 = parseAbi([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const lower = (/** @type {string} */ a) => /** @type {`0x${string}`} */ (a.toLowerCase());
const usdc = lower(venue.bases.usdc);
const wmon = lower(venue.bases.wmon);

/** Many reads at once through Multicall3, failures as null. @param {any[]} calls */
async function many(calls) {
  const out = [];
  for (let i = 0; i < calls.length; i += 200) {
    const part = await client.multicall({
      contracts: calls.slice(i, i + 200),
      allowFailure: true,
      multicallAddress: "0xcA11bde05977b3631167028862bE2a173976CA11",
    });
    out.push(...part.map((r) => (r.status === "success" ? r.result : null)));
  }
  return out;
}

/** The pair's own quote, through the venue's selector, or null. */
async function pairQuote(/** @type {`0x${string}`} */ pair, /** @type {`0x${string}`} */ tokenIn, /** @type {bigint} */ amountIn) {
  if (!venue?.pairQuoteSelector) return null;
  const data = /** @type {`0x${string}`} */ (
    venue.pairQuoteSelector +
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [tokenIn, amountIn]).slice(2)
  );
  try {
    const r = await client.call({ to: pair, data });
    return r.data ? decodeAbiParameters([{ type: "uint256" }], r.data)[0] : null;
  } catch {
    return null;
  }
}

/** The pair's fee in millionths, read back from its own quote at a size its rounding ignores. */
function feeFrom(/** @type {bigint} */ amountIn, /** @type {bigint} */ out, /** @type {bigint} */ rIn, /** @type {bigint} */ rOut) {
  if (out <= 0n || out >= rOut) return null;
  // out = a' rOut / (rIn + a'), a' = amountIn (1 - fee): a' = out rIn / (rOut - out).
  const effective = (out * rIn) / (rOut - out);
  const ppm = Number(1_000_000n - (effective * 1_000_000n) / amountIn);
  // Rounded up: a fee a little high only lowers the output, which the pair always accepts.
  return Math.max(1, Math.ceil(ppm / 10) * 10);
}

const n = Number(await client.readContract({ address: venue.factory, abi: FACTORY, functionName: "allPairsLength" }));
const pairs = /** @type {(`0x${string}` | null)[]} */ (
  await many(
    Array.from({ length: n }, (_, i) => ({
      address: venue.factory,
      abi: FACTORY,
      functionName: "allPairs",
      args: [BigInt(i)],
    })),
  )
);
const live = pairs.filter((p) => p !== null).map(lower);
const reads = await many(
  live.flatMap((p) => [
    { address: p, abi: PAIR, functionName: "token0" },
    { address: p, abi: PAIR, functionName: "token1" },
    { address: p, abi: PAIR, functionName: "getReserves" },
  ]),
);
/** @type {{ pair: `0x${string}`, token: `0x${string}`, base: `0x${string}`, tokenIs0: boolean, rToken: bigint, rBase: bigint }[]} */
const candidates = [];
/** @type {{ pair: `0x${string}`, r0: bigint, r1: bigint, t0: `0x${string}` } | null} */
let basePair = null;
live.forEach((p, i) => {
  const t0 = reads[3 * i] ? lower(/** @type {string} */ (reads[3 * i])) : null;
  const t1 = reads[3 * i + 1] ? lower(/** @type {string} */ (reads[3 * i + 1])) : null;
  const r = /** @type {readonly [bigint, bigint, number] | null} */ (reads[3 * i + 2]);
  if (!t0 || !t1 || !r || r[0] === 0n || r[1] === 0n) return;
  const bases = [usdc, wmon];
  if (bases.includes(t0) && bases.includes(t1)) {
    basePair = { pair: p, r0: r[0], r1: r[1], t0 };
    return;
  }
  const base = bases.includes(t0) ? t0 : bases.includes(t1) ? t1 : null;
  if (!base) return;
  const tokenIs0 = base === t1;
  candidates.push({
    pair: p,
    token: tokenIs0 ? t0 : t1,
    base,
    tokenIs0,
    rToken: tokenIs0 ? r[0] : r[1],
    rBase: tokenIs0 ? r[1] : r[0],
  });
});
if (!basePair) throw new Error("the venue has no USDC/WMON pair: the stack's WMON cannot be priced");
const bp = /** @type {{ pair: `0x${string}`, r0: bigint, r1: bigint, t0: `0x${string}` }} */ (basePair);
const [rWmonBase, rUsdcBase] = bp.t0 === wmon ? [bp.r0, bp.r1] : [bp.r1, bp.r0];
/** USDC (6 decimals) per whole WMON, as a float, for ranking only. */
const wmonUsd = Number(rUsdcBase) / 1e6 / (Number(rWmonBase) / 1e18);
const baseFee =
  feeFrom(
    10n ** 18n,
    (await pairQuote(bp.pair, wmon, 10n ** 18n)) ?? 0n,
    rWmonBase,
    rUsdcBase,
  ) ?? venue.defaultFeePpm;

const meta = await many(
  candidates.flatMap((c) => [
    { address: c.token, abi: ERC20, functionName: "symbol" },
    { address: c.token, abi: ERC20, functionName: "name" },
    { address: c.token, abi: ERC20, functionName: "decimals" },
  ]),
);
/** @type {any[]} */
const found = [];
for (const [i, c] of candidates.entries()) {
  const symbol = meta[3 * i];
  const name = meta[3 * i + 1];
  const decimals = meta[3 * i + 2];
  if (typeof symbol !== "string" || typeof decimals !== "number") continue;
  // A small buy: 0.1% of the base side, then the tokens sold back.
  const small = c.rBase / 1000n || 1n;
  const quoted = await pairQuote(c.pair, c.base, small);
  const fee = (quoted !== null ? feeFrom(small, quoted, c.rBase, c.rToken) : null) ?? venue.defaultFeePpm;
  const bought = v2AmountOut(small, c.rBase, c.rToken, fee);
  const back = v2AmountOut(bought, c.rToken - bought, c.rBase + small, fee);
  if (bought <= 0n || back <= 0n) continue;
  const baseUsd = c.base === usdc ? Number(c.rBase) / 1e6 : (Number(c.rBase) / 1e18) * wmonUsd;
  found.push({
    token: c.token,
    symbol: symbol.slice(0, 32),
    name: typeof name === "string" ? name.slice(0, 64) : symbol,
    decimals,
    pair: c.pair,
    base: c.base === usdc ? "USDC" : "WMON",
    feePpm: fee,
    depthUsd: Math.round(baseUsd * 100) / 100,
    roundTripLossPct: Math.round((1 - Number(back) / Number(small)) * 10_000) / 100,
  });
}
found.sort((a, b) => b.depthUsd - a.depthUsd);
const chosen = found.slice(0, MAX);
const record = {
  unit: "CO-U1",
  at: new Date().toISOString(),
  venue: { id: venue.id, name: venue.name, factory: venue.factory, pairs: n },
  bases: { usdc, wmon, pair: bp.pair, feePpm: baseFee, wmonUsd },
  workingRoutes: found.length,
  chosen,
  leftOut: found.slice(MAX).map((t) => ({ token: t.token, symbol: t.symbol, depthUsd: t.depthUsd })),
};
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "discovery.json"), `${JSON.stringify(record, null, 2)}\n`);
console.log(
  `${venue.name}: ${n} pairs, ${found.length} tokens with a working buy-then-sell route; the top ${chosen.length} by depth written to evidence/dev-nadfun/discovery.json (WMON ${wmonUsd.toFixed(5)} USD, base pair fee ${baseFee} ppm)`,
);
for (const t of chosen.slice(0, 15))
  console.log(
    `  ${t.symbol.padEnd(10)} ${t.base} depth $${t.depthUsd.toFixed(0).padStart(9)} fee ${(t.feePpm / 10_000).toFixed(2)}% round trip ${t.roundTripLossPct}%`,
  );
