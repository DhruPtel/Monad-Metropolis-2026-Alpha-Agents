// @ts-check
// The oracle adapter on a local fork (P2-U3): read prices through it, apply a
// timelocked oracle change for a factory deployed without one, and keep the
// fork's Chainlink feeds fresh and movable through devenv's refresher
// (LocalFeed, D-237): the fork copies the feeds as they were at the pinned
// block and nothing updates them there. Local fork only: devenv refuses any
// other RPC before sending anything.
import {
  advanceTime,
  assertLocalFork,
  localFeedsInstalled,
  refreshLocalFeeds,
} from "@alpha-agents/devenv";
import { addressEntry } from "@alpha-agents/domain";
import { ORACLE_REASONS } from "@alpha-agents/policy";
import { createPublicClient, formatUnits, http, parseAbi } from "viem";
import { CUSTODY_ROLES } from "./account-factory.js";
import { send } from "./agent-reveal.js";
import { ANVIL_URL } from "./config.js";

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

/** AccountFactory.Action.SetOracle (the enum's second member). */
const SET_ORACLE = 1;

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

/**
 * Re-dates both feeds' answers to now (local fork only, through devenv's
 * refresher, D-237). Returns the answers, in the feeds' own decimals.
 */
export async function useFreshFeeds() {
  const { monUsd, usdcUsd } = FEEDS();
  const rounds = await refreshLocalFeeds(ANVIL_URL, [monUsd, usdcUsd]);
  return { monUsd: rounds[0]?.answer ?? 0n, usdcUsd: rounds[1]?.answer ?? 0n };
}

/**
 * Moves MON/USD (8 decimals) and re-dates USDC/USD, on the local fork only.
 * @param {bigint} answer
 */
export async function setMonUsd(answer) {
  const { monUsd, usdcUsd } = FEEDS();
  await refreshLocalFeeds(ANVIL_URL, [monUsd, usdcUsd], { [monUsd.toLowerCase()]: { answer } });
}

/** Makes both feeds revert, as an outage would, or brings them back. @param {boolean} down */
export async function setFeedsDown(down) {
  const { monUsd, usdcUsd } = FEEDS();
  await refreshLocalFeeds(ANVIL_URL, [monUsd, usdcUsd], {
    [monUsd.toLowerCase()]: { down },
    [usdcUsd.toLowerCase()]: { down },
  });
}

/** Whether the fork's feeds are already LocalFeed (read-only). */
export async function feedsAreSettable() {
  const { monUsd, usdcUsd } = FEEDS();
  return localFeedsInstalled(ANVIL_URL, [monUsd, usdcUsd]);
}
