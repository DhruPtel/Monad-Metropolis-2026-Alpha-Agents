// @ts-check
// MV-S15, the deployment state assertion (P7-U4): reads every role, delay,
// oracle, route, fee, cap and allowlist flag of a deployed v3 set and compares
// each with the intended configuration. One mismatch fails the whole check.
// Read-only. The local intent is built from the same constants the deploy
// libraries pass to the forge scripts, so the deploy and the check share one
// source (Veda's live Monad configuration drifted from its repo; FINAL_PLAN
// 4.1.13). Prints no key and no RPC URL.
import { executorV3 } from "@alpha-agents/policy";
import { createPublicClient, getAddress, http, keccak256, parseAbi, toHex } from "viem";
import {
  BETA_CAPS,
  BETA_DEPOSITS_ENABLED,
  CUSTODY_ROLES,
  LOCAL_TEST_OWNERS,
} from "./account-factory.js";
import { FUND_ROLES } from "./fund.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const DAY = 86_400n;
/** Executor v3's adapter id (D-363). */
export const ROUTER_ID = keccak256(toHex("route-adapter"));

const FACTORY_ABI = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function guardian() view returns (address)",
  "function sentinel() view returns (address)",
  "function oracle() view returns (address)",
  "function executor() view returns (address)",
  "function personalCap() view returns (uint256)",
  "function vaultCap() view returns (uint256)",
  "function platformCap() view returns (uint256)",
  "function platformTotal() view returns (uint256)",
  "function allowlistEnabled() view returns (bool)",
  "function depositsEnabled() view returns (bool)",
  "function isAllowlisted(address) view returns (bool)",
  "function RISK_TIMELOCK() view returns (uint256)",
  "function EXECUTION_WINDOW() view returns (uint256)",
  "function USDC() view returns (address)",
  "function TOKEN_REGISTRY() view returns (address)",
  "function AGENT_NFT() view returns (address)",
  "function PERSONAL_ACCOUNT_IMPLEMENTATION() view returns (address)",
  "function VAULT_IMPLEMENTATION() view returns (address)",
]);
const VAULT_IMPL_ABI = parseAbi([
  "function MIN_LOCKUP() view returns (uint64)",
  "function MAX_LOCKUP() view returns (uint64)",
  "function RISK_TIMELOCK() view returns (uint64)",
  "function HANDOVER_PERIOD() view returns (uint64)",
  "function LEADER_STAKE_BPS() view returns (uint256)",
  "function MAX_FEE_BPS() view returns (uint256)",
  "function SPREAD_BPS() view returns (uint256)",
  "function USDC_FLOOR_BPS() view returns (uint256)",
  "function MAX_HELD_TOKENS() view returns (uint256)",
  "function USDC() view returns (address)",
  "function TOKENS() view returns (address)",
  "function AGENT_NFT() view returns (address)",
]);
const PERSONAL_IMPL_ABI = parseAbi([
  "function MAX_HELD_TOKENS() view returns (uint256)",
  "function USDC() view returns (address)",
  "function TOKENS() view returns (address)",
  "function AGENT_NFT() view returns (address)",
]);
const EXECUTOR_ABI = parseAbi([
  "function owner() view returns (address)",
  "function guardian() view returns (address)",
  "function TOKENS() view returns (address)",
  "function USDC() view returns (address)",
  "function factory() view returns (address)",
  "function pools() view returns (address)",
  "function policyHash() view returns (bytes32)",
  "function paused() view returns (bool)",
  "function NO_EXPIRY() view returns (uint64)",
  "function MAX_SESSION() view returns (uint256)",
  "function MAX_HOPS() view returns (uint256)",
  "function policy() view returns ((uint16 maxTradeBps, uint16 maxAssetBps, uint16 minUsdcBps, uint16 maxSlippageBps, uint16 maxSlippageClassABps, uint16 maxClassAPositionBps, uint16 maxClassATotalBps, uint16 maxTurnoverBps, uint8 maxTradesPerWindow, uint32 windowSeconds, uint32 deadlineSeconds))",
]);
const POOLS_ABI = parseAbi([
  "function owner() view returns (address)",
  "function TOKENS() view returns (address)",
  "function USDC() view returns (address)",
  "function adapterFor(bytes32) view returns (address)",
]);
const ROUTER_ABI = parseAbi([
  "function REGISTRY() view returns (address)",
  "function EXECUTOR() view returns (address)",
  "function USDC() view returns (address)",
]);
const ORACLE_ABI = parseAbi([
  "function TOKENS() view returns (address)",
  "function POOLS() view returns (address)",
  "function USDC() view returns (address)",
]);
const TOKENS_ABI = parseAbi([
  "function owner() view returns (address)",
  "function tokenRecord(address) view returns ((uint8 lane, uint8 status, uint8 priceClass, uint16 maxPositionBps, uint64 since, bytes32 screenHash, uint64 screenedAt))",
]);

/**
 * @typedef {{ factory: `0x${string}`, executor: `0x${string}`, routeAdapter: `0x${string}`, protocolRegistry: `0x${string}`, oracle: `0x${string}`, tokenRegistry: `0x${string}`, agentNft: `0x${string}`, usdc: `0x${string}` }} SetAddresses
 */

/**
 * The intended state of the local fork's v3 set (and the beta's shape): the
 * roles, caps, allowlist and flags the deploy libraries pass, the contracts'
 * constants, and the Executor's launch policy.
 * @param {SetAddresses} a
 */
export function localIntent(a) {
  const allowlisted = Object.fromEntries(LOCAL_TEST_OWNERS.map((w) => [getAddress(w), true]));
  return {
    factory: {
      owner: CUSTODY_ROLES.admin,
      pendingOwner: ZERO,
      guardian: CUSTODY_ROLES.guardian,
      sentinel: CUSTODY_ROLES.sentinel,
      oracle: a.oracle,
      executor: a.executor,
      personalCap: BETA_CAPS.personalE6,
      vaultCap: BETA_CAPS.vaultE6,
      platformCap: BETA_CAPS.platformE6,
      allowlistEnabled: true,
      depositsEnabled: BETA_DEPOSITS_ENABLED,
      allowlisted,
      riskTimelock: 9n * DAY,
      executionWindow: 7n * DAY,
      usdc: a.usdc,
      tokenRegistry: a.tokenRegistry,
      agentNft: a.agentNft,
    },
    vaultImplementation: {
      minLockup: DAY,
      maxLockup: 7n * DAY,
      riskTimelock: 9n * DAY,
      handoverPeriod: 3n * DAY,
      leaderStakeBps: 500n,
      maxFeeBps: 2_000n,
      spreadBps: 50n,
      usdcFloorBps: 1_000n,
      maxHeldTokens: 16n,
      usdc: a.usdc,
      tokenRegistry: a.tokenRegistry,
      agentNft: a.agentNft,
    },
    personalImplementation: {
      maxHeldTokens: 16n,
      usdc: a.usdc,
      tokenRegistry: a.tokenRegistry,
      agentNft: a.agentNft,
    },
    executor: {
      owner: FUND_ROLES.admin,
      guardian: FUND_ROLES.guardian,
      tokenRegistry: a.tokenRegistry,
      usdc: a.usdc,
      factory: a.factory,
      pools: a.protocolRegistry,
      policyHash: executorV3.LAUNCH_POLICY_HASH,
      policy: executorV3.LAUNCH_POLICY,
      paused: false,
      noExpiry: 9_007_199_254_740_991n,
      maxSession: 30n * DAY,
      maxHops: 3n,
    },
    protocolRegistry: {
      owner: FUND_ROLES.admin,
      tokenRegistry: a.tokenRegistry,
      usdc: a.usdc,
      routeAdapter: a.routeAdapter,
    },
    routeAdapter: { registry: a.protocolRegistry, executor: a.executor, usdc: a.usdc },
    oracle: { tokenRegistry: a.tokenRegistry, pools: a.protocolRegistry, usdc: a.usdc },
    tokenRegistry: { owner: FUND_ROLES.admin, usdcLane: 1n },
  };
}

/**
 * Reads the deployed set's state in the intent's shape.
 * @param {string} url
 * @param {SetAddresses} a
 * @param {readonly `0x${string}`[]} allowlist the wallets whose allowlist entries to read
 */
export async function readState(url, a, allowlist) {
  const client = createPublicClient({ transport: http(url) });
  /** @param {`0x${string}`} address @param {any} abi @param {string} functionName @param {unknown[]} [args] */
  const read = (address, abi, functionName, args = []) =>
    client.readContract({ address, abi, functionName, args });
  const f = (/** @type {string} */ fn, /** @type {unknown[]} */ args = []) =>
    read(a.factory, FACTORY_ABI, fn, args);
  const personalImpl = /** @type {`0x${string}`} */ (await f("PERSONAL_ACCOUNT_IMPLEMENTATION"));
  const vaultImpl = /** @type {`0x${string}`} */ (await f("VAULT_IMPLEMENTATION"));
  const v = (/** @type {string} */ fn) => read(vaultImpl, VAULT_IMPL_ABI, fn);
  const p = (/** @type {string} */ fn) => read(personalImpl, PERSONAL_IMPL_ABI, fn);
  const e = (/** @type {string} */ fn) => read(a.executor, EXECUTOR_ABI, fn);
  const r = (/** @type {string} */ fn, /** @type {unknown[]} */ args = []) =>
    read(a.protocolRegistry, POOLS_ABI, fn, args);
  const allowlisted = Object.fromEntries(
    await Promise.all(
      allowlist.map(async (w) => [getAddress(w), await f("isAllowlisted", [getAddress(w)])]),
    ),
  );
  const policy = /** @type {Record<string, number | bigint>} */ (await e("policy"));
  const usdcRecord = /** @type {{ lane: number }} */ (
    await read(a.tokenRegistry, TOKENS_ABI, "tokenRecord", [a.usdc])
  );
  return {
    factory: {
      owner: await f("owner"),
      pendingOwner: await f("pendingOwner"),
      guardian: await f("guardian"),
      sentinel: await f("sentinel"),
      oracle: await f("oracle"),
      executor: await f("executor"),
      personalCap: await f("personalCap"),
      vaultCap: await f("vaultCap"),
      platformCap: await f("platformCap"),
      allowlistEnabled: await f("allowlistEnabled"),
      depositsEnabled: await f("depositsEnabled"),
      allowlisted,
      riskTimelock: await f("RISK_TIMELOCK"),
      executionWindow: await f("EXECUTION_WINDOW"),
      usdc: await f("USDC"),
      tokenRegistry: await f("TOKEN_REGISTRY"),
      agentNft: await f("AGENT_NFT"),
    },
    vaultImplementation: {
      minLockup: await v("MIN_LOCKUP"),
      maxLockup: await v("MAX_LOCKUP"),
      riskTimelock: await v("RISK_TIMELOCK"),
      handoverPeriod: await v("HANDOVER_PERIOD"),
      leaderStakeBps: await v("LEADER_STAKE_BPS"),
      maxFeeBps: await v("MAX_FEE_BPS"),
      spreadBps: await v("SPREAD_BPS"),
      usdcFloorBps: await v("USDC_FLOOR_BPS"),
      maxHeldTokens: await v("MAX_HELD_TOKENS"),
      usdc: await v("USDC"),
      tokenRegistry: await v("TOKENS"),
      agentNft: await v("AGENT_NFT"),
    },
    personalImplementation: {
      maxHeldTokens: await p("MAX_HELD_TOKENS"),
      usdc: await p("USDC"),
      tokenRegistry: await p("TOKENS"),
      agentNft: await p("AGENT_NFT"),
    },
    executor: {
      owner: await e("owner"),
      guardian: await e("guardian"),
      tokenRegistry: await e("TOKENS"),
      usdc: await e("USDC"),
      factory: await e("factory"),
      pools: await e("pools"),
      policyHash: await e("policyHash"),
      policy: Object.fromEntries(Object.keys(executorV3.LAUNCH_POLICY).map((k) => [k, policy[k]])),
      paused: await e("paused"),
      noExpiry: await e("NO_EXPIRY"),
      maxSession: await e("MAX_SESSION"),
      maxHops: await e("MAX_HOPS"),
    },
    protocolRegistry: {
      owner: await r("owner"),
      tokenRegistry: await r("TOKENS"),
      usdc: await r("USDC"),
      routeAdapter: await r("adapterFor", [ROUTER_ID]),
    },
    routeAdapter: {
      registry: await read(a.routeAdapter, ROUTER_ABI, "REGISTRY"),
      executor: await read(a.routeAdapter, ROUTER_ABI, "EXECUTOR"),
      usdc: await read(a.routeAdapter, ROUTER_ABI, "USDC"),
    },
    oracle: {
      tokenRegistry: await read(a.oracle, ORACLE_ABI, "TOKENS"),
      pools: await read(a.oracle, ORACLE_ABI, "POOLS"),
      usdc: await read(a.oracle, ORACLE_ABI, "USDC"),
    },
    tokenRegistry: {
      owner: await read(a.tokenRegistry, TOKENS_ABI, "owner"),
      usdcLane: BigInt(usdcRecord.lane),
    },
  };
}

/** @param {unknown} v */
function shown(v) {
  if (typeof v === "bigint" || typeof v === "number") return String(v);
  if (typeof v === "string")
    return /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : v.toLowerCase();
  if (typeof v === "boolean") return String(v);
  if (v === undefined || v === null) return "(missing)";
  return JSON.stringify(v);
}

/**
 * Every leaf of `intent` that `actual` does not match: `{ path, expected, actual }`.
 * Addresses compare without case, numbers as numbers whatever their type.
 * @param {Record<string, unknown>} intent
 * @param {Record<string, unknown> | undefined} actual
 * @param {string} [prefix]
 * @returns {{ path: string, expected: string, actual: string }[]}
 */
export function compareState(intent, actual, prefix = "") {
  /** @type {{ path: string, expected: string, actual: string }[]} */
  const out = [];
  for (const [key, want] of Object.entries(intent)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const got = actual?.[key];
    if (want !== null && typeof want === "object") {
      out.push(
        ...compareState(
          /** @type {Record<string, unknown>} */ (want),
          /** @type {Record<string, unknown> | undefined} */ (got),
          path,
        ),
      );
      continue;
    }
    if (shown(want) !== shown(got)) out.push({ path, expected: shown(want), actual: shown(got) });
  }
  return out;
}

/**
 * Reads the set and compares it with the intent: `ok` is false on any mismatch.
 * @param {string} url
 * @param {SetAddresses} addresses
 * @param {ReturnType<typeof localIntent>} [intent]
 */
export async function assertState(url, addresses, intent = localIntent(addresses)) {
  const allowlist = /** @type {`0x${string}`[]} */ (Object.keys(intent.factory.allowlisted));
  const actual = await readState(url, addresses, allowlist);
  const mismatches = compareState(intent, actual);
  const checked = countLeaves(intent);
  return { ok: mismatches.length === 0, checked, mismatches, actual };
}

/** @param {Record<string, unknown>} o */
function countLeaves(o) {
  let n = 0;
  for (const v of Object.values(o))
    n +=
      v !== null && typeof v === "object"
        ? countLeaves(/** @type {Record<string, unknown>} */ (v))
        : 1;
  return n;
}
