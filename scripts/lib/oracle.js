// @ts-check
// The oracle adapter on a local fork (P2-U3): read prices through it, apply
// the factory's timelocked oracle proposal, and give a fork price feeds whose
// answers stay fresh and can be moved. Local fork only: every change checks
// the fork first.
//
// Why feeds need replacing on a fork: the fork copies Chainlink's feeds as
// they were at the pinned block, and nobody updates them there, so as the
// fork's clock moves on MON/USD is stale within 5 minutes and every priced
// action refuses (correctly). `useFreshFeeds` swaps each feed contract's code
// for a settable copy (the test MockFeed) that keeps the feed's address, its
// decimals and its last answer, re-dated to now. Mainnet never does this.
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { advanceTime, assertLocalFork, rpc } from "@alpha-agents/devenv";
import { addressEntry } from "@alpha-agents/domain";
import { ORACLE_REASONS } from "@alpha-agents/policy";
import { createPublicClient, formatUnits, http, parseAbi } from "viem";
import { CUSTODY_ROLES } from "./account-factory.js";
import { send } from "./agent-reveal.js";
import { ANVIL_URL } from "./config.js";
import { MONAD_DIR } from "./paths.js";

export const ADAPTER_ABI = parseAbi([
  "function price(address asset) view returns (uint256 priceE18, uint256 updatedAt, uint8 reason)",
  "function poolPrice(address asset) view returns (uint256 priceE18, uint8 reason)",
  "function poolDeviationBps(address asset) view returns (uint256 bps, uint8 reason)",
  "function usdcPeg() view returns (uint256 usdcUsdE18, uint256 updatedAt, uint8 reason)",
]);

const FACTORY_ORACLE_ABI = parseAbi([
  "function oracle() view returns (address)",
  "function pending(bytes32 id) view returns (uint64 executableAt, uint64 expiresAt)",
  "function changeId(uint8 action, bytes32 value) pure returns (bytes32)",
  "function propose(uint8 action, bytes32 value) returns (bytes32)",
  "function execute(uint8 action, bytes32 value)",
]);

const FEED_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function push(int256 answer)",
  "function setRound(uint80 roundId, int256 answer, uint256 updatedAt, uint80 answeredInRound)",
  "function setDecimals(uint8 d)",
  "function setFailure(uint8 f)",
]);

/** AccountFactory.Action.SetOracle (the enum's second member). */
const SET_ORACLE = 1;
/** MockFeed.Failure: None and RevertRound. */
const FEED_OK = 0;
const FEED_DOWN = 1;

const client = createPublicClient({ transport: http(ANVIL_URL) });
const book = (/** @type {import("@alpha-agents/domain").AddressBookId} */ id) =>
  /** @type {`0x${string}`} */ (addressEntry("local", id).address);
export const FEEDS = () => ({
  monUsd: book("chainlink_mon_usd"),
  usdcUsd: book("chainlink_usdc_usd"),
});

/** @param {number | bigint} r */
const reason = (r) => ORACLE_REASONS[Number(r)] ?? `reason ${r}`;
/** @param {bigint} e18 @param {number} digits */
const usd = (e18, digits = 7) => `$${Number(formatUnits(e18, 18)).toFixed(digits)}`;

/** The fork's latest block time. */
export async function forkTime() {
  return (await client.getBlock()).timestamp;
}

/**
 * What the adapter says now about WMON, the pool and USDC, as lines to print.
 * @param {`0x${string}`} adapter
 */
export async function describePrices(adapter) {
  const wmon = book("wmon");
  const at = { address: adapter, abi: ADAPTER_ABI };
  const [now, p, pool, dev, peg] = await Promise.all([
    forkTime(),
    client.readContract({ ...at, functionName: "price", args: [wmon] }),
    client.readContract({ ...at, functionName: "poolPrice", args: [wmon] }),
    client.readContract({ ...at, functionName: "poolDeviationBps", args: [wmon] }),
    client.readContract({ ...at, functionName: "usdcPeg" }),
  ]);
  const age = (/** @type {bigint} */ at) => (at === 0n ? "no time" : `${now - at} s old`);
  return [
    `oracle adapter ${adapter}, fork time ${now}`,
    `  MON/USD   ${p[2] === 0 ? usd(p[0]) : "no price"} (${age(p[1])}, limit under 300 s): ${reason(p[2])}`,
    `  v4 pool   ${pool[1] === 0 ? usd(pool[0]) : "no price"}: ${reason(pool[1])}`,
    `  pool vs oracle ${dev[0]} bps (limit 200): ${reason(dev[1])}${dev[1] === 0 ? ", tradable" : ", trades refused"}`,
    `  USDC/USD  ${peg[0] === 0n ? "no price" : usd(peg[0], 5)} (${age(peg[1])}, limit under 3,900 s; 1% depeg guard): ${reason(peg[2])}${peg[2] === 0 ? "" : ", deposits refused"}`,
  ];
}

/**
 * Makes `adapter` the factory's oracle through its own timelock: proposes it
 * if nobody has, moves the fork's clock to the end of the 9 days, and
 * executes. Returns false if it was already the oracle.
 * @param {`0x${string}`} factory
 * @param {`0x${string}`} adapter
 */
export async function applyOracleTimelock(factory, adapter) {
  await assertLocalFork(ANVIL_URL);
  const at = { address: factory, abi: FACTORY_ORACLE_ABI };
  const current = await client.readContract({ ...at, functionName: "oracle" });
  if (current.toLowerCase() === adapter.toLowerCase()) return false;
  const value = /** @type {`0x${string}`} */ (
    `0x${adapter.slice(2).toLowerCase().padStart(64, "0")}`
  );
  const id = await client.readContract({
    ...at,
    functionName: "changeId",
    args: [SET_ORACLE, value],
  });
  let [executableAt] = await client.readContract({ ...at, functionName: "pending", args: [id] });
  if (executableAt === 0n) {
    await send(CUSTODY_ROLES.admin, { ...at, functionName: "propose", args: [SET_ORACLE, value] });
    [executableAt] = await client.readContract({ ...at, functionName: "pending", args: [id] });
  }
  const now = await forkTime();
  if (now < executableAt) await advanceTime(Number(executableAt - now), ANVIL_URL);
  await send(CUSTODY_ROLES.admin, {
    address: factory,
    abi: FACTORY_ORACLE_ABI,
    functionName: "execute",
    args: [SET_ORACLE, value],
  });
  return true;
}

/** The settable feed's runtime code, built by forge with the tests. */
function settableFeedCode() {
  const artifact = join(MONAD_DIR, "out", "OracleMocks.sol", "MockFeed.json");
  if (!existsSync(artifact)) spawnSync("forge", ["build"], { cwd: MONAD_DIR, stdio: "ignore" });
  return /** @type {`0x${string}`} */ (
    JSON.parse(readFileSync(artifact, "utf8")).deployedBytecode.object
  );
}

/**
 * Swaps both feeds for settable copies holding their current answers, dated
 * now (see the header). Idempotent: a feed already swapped is only re-dated.
 * Returns the answers used.
 */
export async function useFreshFeeds() {
  await assertLocalFork(ANVIL_URL);
  const code = settableFeedCode();
  const now = await forkTime();
  /** @type {Record<string, bigint>} */
  const answers = {};
  for (const [name, feed] of Object.entries(FEEDS())) {
    const [decimals, round] = await Promise.all([
      client.readContract({ address: feed, abi: FEED_ABI, functionName: "decimals" }),
      client.readContract({ address: feed, abi: FEED_ABI, functionName: "latestRoundData" }),
    ]);
    const current = (await client.getCode({ address: feed })) ?? "0x";
    if (current.toLowerCase() !== code.toLowerCase()) {
      await rpc(ANVIL_URL, "anvil_setCode", [feed, code]);
      // The proxy's own storage means nothing to the copy: clear the slots it uses.
      for (let slot = 0; slot < 4; slot++)
        await rpc(ANVIL_URL, "anvil_setStorageAt", [
          feed,
          `0x${slot.toString(16)}`,
          `0x${"0".repeat(64)}`,
        ]);
      await send(CUSTODY_ROLES.admin, {
        address: feed,
        abi: FEED_ABI,
        functionName: "setFailure",
        args: [FEED_OK],
      });
      await send(CUSTODY_ROLES.admin, {
        address: feed,
        abi: FEED_ABI,
        functionName: "setDecimals",
        args: [decimals],
      });
    }
    await send(CUSTODY_ROLES.admin, {
      address: feed,
      abi: FEED_ABI,
      functionName: "setRound",
      args: [1n, round[1], now, 1n],
    });
    answers[name] = round[1];
  }
  return answers;
}

/**
 * Moves MON/USD on a fork whose feeds are settable copies, dating the new
 * answer and USDC/USD's to now.
 * @param {bigint} answer MON/USD with 8 decimals
 */
export async function setMonUsd(answer) {
  const { monUsd, usdcUsd } = FEEDS();
  const usdcRound = await client.readContract({
    address: usdcUsd,
    abi: FEED_ABI,
    functionName: "latestRoundData",
  });
  await send(CUSTODY_ROLES.admin, {
    address: monUsd,
    abi: FEED_ABI,
    functionName: "push",
    args: [answer],
  });
  await send(CUSTODY_ROLES.admin, {
    address: usdcUsd,
    abi: FEED_ABI,
    functionName: "push",
    args: [usdcRound[1]],
  });
}

/** Makes both settable feeds revert, as a feed outage would. @param {boolean} down */
export async function setFeedsDown(down) {
  for (const feed of Object.values(FEEDS()))
    await send(CUSTODY_ROLES.admin, {
      address: feed,
      abi: FEED_ABI,
      functionName: "setFailure",
      args: [down ? FEED_DOWN : FEED_OK],
    });
}

/** Whether the fork's feeds are already the settable copies. */
export async function feedsAreSettable() {
  const code = settableFeedCode();
  const current = (await client.getCode({ address: FEEDS().monUsd })) ?? "0x";
  return current.toLowerCase() === code.toLowerCase();
}
