// pnpm spike:feeds: F-U2's feed spike (BUILD_PLAN 4.0, as P2-U0 did for
// MON/USD). For every class F feed leg in packages/domain's reviewed map, read
// its recent rounds on Monad mainnet (read-only), measure the gaps between
// updates, and check the staleness bound OracleAdapterV3 will use: 300 seconds
// for MON/USD (D-151, measured by P2-U0) and the published heartbeat plus 300
// seconds for every feed that updates on its heartbeat (P2-U0's USDC/USD rule).
// A leg whose measured gaps exceed its bound fails, and its token is not seeded
// as class F. Writes evidence/f-u2/feed-spike.json. The RPC URL comes from the
// environment and is never printed.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CLASS_F_FEEDS, type FeedLeg, feedMaxAgeSeconds } from "@alpha-agents/domain";
import { createPublicClient, getAddress, http, parseAbi } from "viem";

const ROUNDS = 48;
const ROOT = resolve(import.meta.dirname, "../../..");
const urls = [process.env.MONAD_RPC_URL_SECONDARY, process.env.MONAD_RPC_URL].filter(
  (u): u is string => Boolean(u),
);
if (urls.length === 0) {
  console.error("error: set MONAD_RPC_URL (and ideally MONAD_RPC_URL_SECONDARY) in .env");
  process.exit(1);
}
const client = createPublicClient({ transport: http(urls[0], { timeout: 20_000 }) });
const FEED = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function getRoundData(uint80) view returns (uint80, int256, uint256, uint256, uint80)",
]);

interface LegResult {
  readonly description: string;
  readonly proxy: string;
  readonly heartbeatSeconds: number;
  readonly maxAgeSeconds: number;
  readonly rounds: number;
  readonly gapsSeconds: { p50: number; p90: number; max: number } | null;
  readonly ageNowSeconds: number;
  readonly passes: boolean;
  readonly note: string;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};

async function measure(leg: FeedLeg): Promise<LegResult> {
  const address = getAddress(leg.proxy);
  const [roundId, , , updatedAt] = await client.readContract({
    address,
    abi: FEED,
    functionName: "latestRoundData",
  });
  const now = Number((await client.getBlock()).timestamp);
  // A proxy's round ID is the phase in the top 16 bits and the aggregator's round below.
  const phase = roundId >> 64n;
  const base = roundId & ((1n << 64n) - 1n);
  const times: number[] = [Number(updatedAt)];
  for (let k = 1n; k < BigInt(ROUNDS) && base - k > 0n; k++) {
    try {
      const r = await client.readContract({
        address,
        abi: FEED,
        functionName: "getRoundData",
        args: [(phase << 64n) | (base - k)],
      });
      times.push(Number(r[3]));
    } catch {
      break;
    }
  }
  const gaps = times
    .slice(0, -1)
    .map((t, i) => t - (times[i + 1] ?? t))
    .filter((g) => g > 0);
  const maxAge = feedMaxAgeSeconds(leg);
  const max = gaps.length ? Math.max(...gaps) : 0;
  const passes = gaps.length > 0 && max < maxAge;
  return {
    description: leg.description,
    proxy: leg.proxy,
    heartbeatSeconds: leg.heartbeatSeconds,
    maxAgeSeconds: maxAge,
    rounds: times.length,
    gapsSeconds: gaps.length ? { p50: pct(gaps, 50), p90: pct(gaps, 90), max } : null,
    ageNowSeconds: now - Number(updatedAt),
    passes,
    note: passes
      ? `every gap in ${times.length} rounds is under the ${maxAge} s bound`
      : gaps.length === 0
        ? "too few rounds to measure"
        : `a ${max} s gap reached the ${maxAge} s bound`,
  };
}

const legs = new Map<string, FeedLeg>();
for (const f of CLASS_F_FEEDS) for (const l of f.legs) legs.set(l.proxy, l);
const results = new Map<string, LegResult>();
for (const leg of legs.values()) {
  results.set(leg.proxy, await measure(leg));
  process.stdout.write(".");
}
process.stdout.write("\n");
const tokens = CLASS_F_FEEDS.map((f) => {
  const r = f.legs.map((l) => results.get(l.proxy) as LegResult);
  return {
    symbol: f.symbol,
    address: f.address,
    kind: f.kind,
    passes: r.every((x) => x.passes),
    legs: r,
  };
});
const out = {
  at: new Date().toISOString(),
  rule: "MON/USD 300 s (D-151); every other leg its published heartbeat plus 300 s; a leg passes when every measured gap is under its bound",
  roundsPerLeg: ROUNDS,
  tokens,
};
const dir = join(ROOT, "evidence", "f-u2");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "feed-spike.json"), `${JSON.stringify(out, null, 2)}\n`);
for (const t of tokens)
  console.log(
    `${t.passes ? "PASS" : "FAIL"} ${t.symbol.padEnd(10)} ${t.legs.map((l) => `${l.description}: max gap ${l.gapsSeconds?.max ?? "?"} s of ${l.maxAgeSeconds} s`).join("; ")}`,
  );
