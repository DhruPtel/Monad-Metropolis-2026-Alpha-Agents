// @ts-check
// The P2-EC mainnet canary (part 2, D-250 to D-252, D-316): the canary's
// configuration and keys, a guarded mainnet RPC, the re-check of the mainnet
// facts the canary relies on, and its spending budget. Every function that
// precedes a transaction refuses a chain that is not 143. Nothing here prints
// a key or the RPC URL.
import { ConfigError, MONAD_MAINNET_CHAIN_ID, loadConfig } from "@alpha-agents/config";
import { UNISWAP_V4_MON_USDC_POOL, addressEntry } from "@alpha-agents/domain";
import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
  formatEther,
  parseEther,
} from "viem";
import { testnetRpc } from "./testnet.js";

/** The canary's salt scope (D-249). */
export const CANARY_SCOPE = "p2ec.canary";

/** MonadVision on mainnet: the explorer every canary link points at. */
export const CANARY_EXPLORER = "https://monadvision.com";

/** @param {string} hash */
export const txLink = (hash) => `${CANARY_EXPLORER}/tx/${hash}`;
/** @param {string} address */
export const addressLink = (address) => `${CANARY_EXPLORER}/address/${address}`;

/**
 * The canary's limits (D-252, D-258, D-316): at most 10 MON spent and 10 USDC
 * at risk across every canary key; the session key holds at most 3 MON and is
 * granted for at most 24 hours; caps of 10 USDC.
 */
export const CANARY_LIMITS = {
  spendWei: parseEther("10"),
  usdcAtRiskE6: 10_000_000n,
  sessionMaxWei: parseEther("3"),
  grantMaxSeconds: 24n * 3600n,
  capE6: 10_000_000n,
  depositE6: 5_000_000n,
  tradeE6: 450_000n,
};

/** The canary's three keys, by role. */
export const CANARY_KEY_NAMES = /** @type {const} */ ([
  "CANARY_OWNER_PRIVATE_KEY",
  "CANARY_GUARDIAN_PRIVATE_KEY",
  "CANARY_SESSION_PRIVATE_KEY",
]);

/**
 * The canary runner's configuration (D-251): APP_ENV=canary, the three canary
 * keys, and CANARY_SIGNING_ENABLED=true, which must be set by the operator for
 * this command; config refuses everything else. Throws ConfigError, which
 * holds no value.
 */
export function canaryConfig() {
  return loadConfig(
    {
      name: "canary runner",
      signs: true,
      canary: true,
      requires: [...CANARY_KEY_NAMES],
    },
    { ...process.env, APP_ENV: "canary" },
  );
}

/** @param {import("@alpha-agents/config").Config} config @param {string} name */
export function canaryReveal(config, name) {
  const value = /** @type {Record<string, unknown>} */ (config.values)[name];
  if (!value || typeof value !== "object" || !("reveal" in value)) {
    throw new ConfigError("Canary configuration is incomplete:", [
      { variable: name, problem: "is not set" },
    ]);
  }
  return /** @type {{ reveal(): string }} */ (value).reveal();
}

/** A JSON-RPC call to the mainnet RPC whose errors never carry the URL. */
export const mainnetRpc = testnetRpc;

/** Refuses anything but Monad mainnet; run before every transaction. @param {string} url */
export async function assertMainnet(url) {
  const chainId = Number(await mainnetRpc(url, "eth_chainId"));
  if (chainId !== MONAD_MAINNET_CHAIN_ID) {
    throw new Error(`MONAD_RPC_URL serves chain ${chainId}, not ${MONAD_MAINNET_CHAIN_ID}`);
  }
}

/** @param {import("@alpha-agents/domain").AddressBookId} id */
export function canaryBook(id) {
  const e = addressEntry("canary", id);
  if (e.status !== "verified" || !e.address)
    throw new Error(`${id} is not verified for the canary`);
  return /** @type {`0x${string}`} */ (e.address);
}

const READ_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function getSlot0(bytes32 poolId) view returns (uint160, int24, uint24, uint24)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
]);

/**
 * @param {string} url @param {`0x${string}`} to
 * @param {"decimals" | "latestRoundData" | "getSlot0" | "getLiquidity"} functionName
 * @param {readonly unknown[]} [args]
 */
async function read(url, to, functionName, args = []) {
  const data = encodeFunctionData({
    abi: READ_ABI,
    functionName,
    args: /** @type {any} */ (args),
  });
  const result = await mainnetRpc(url, "eth_call", [{ to, data }, "latest"]);
  return /** @type {any} */ (decodeFunctionResult({ abi: READ_ABI, functionName, data: result }));
}

/**
 * Item 1 of the unit for mainnet: every external contract the canary uses
 * still has code of the size the address book recorded, the tokens and feeds
 * their decimals, the feeds answer within their staleness bounds, and the
 * launch pool exists with liquidity. Returns what was read; throws on any
 * difference, before anything is sent.
 * @param {string} url
 */
export async function checkMainnetFacts(url) {
  const ids = /** @type {const} */ ([
    "usdc",
    "wmon",
    "chainlink_mon_usd",
    "chainlink_usdc_usd",
    "uniswap_v4_pool_manager",
    "uniswap_v4_state_view",
    "uniswap_v3_swap_router02",
    "create2_deployer",
  ]);
  const block = await mainnetRpc(url, "eth_getBlockByNumber", ["latest", false]);
  const now = Number(BigInt(block.timestamp));
  /** @type {Record<string, unknown>} */
  const facts = { block: Number(BigInt(block.number)), timestamp: now };
  const problems = [];
  for (const id of ids) {
    const e = addressEntry("canary", id);
    if (e.status !== "verified") {
      problems.push(`${id} is not verified in the address book`);
      continue;
    }
    const code = await mainnetRpc(url, "eth_getCode", [e.address, "latest"]);
    const size = (code.length - 2) / 2;
    /** @type {Record<string, unknown>} */
    const fact = { address: e.address, codeSize: size, codeHash: keccak256(code) };
    if (size !== e.verification.codeSize)
      problems.push(
        `${id}: code size ${size}, the address book recorded ${e.verification.codeSize}`,
      );
    if (e.verification.decimals !== undefined) {
      const decimals = Number(
        await read(url, /** @type {`0x${string}`} */ (e.address), "decimals"),
      );
      fact.decimals = decimals;
      if (decimals !== e.verification.decimals)
        problems.push(`${id}: ${decimals} decimals, expected ${e.verification.decimals}`);
    }
    facts[id] = fact;
  }
  // The canary's deployment bounds (D-151, D-168): MON/USD within 300 s, USDC/USD
  // within 3,900 s. The launch bound is now 7,200 s (D-317); the canary is a
  // throwaway that is not redeployed, so its recorded check keeps its own.
  for (const [id, maxAge] of /** @type {const} */ ([
    ["chainlink_mon_usd", 300],
    ["chainlink_usdc_usd", 3_900],
  ])) {
    const [, answer, , updatedAt] = await read(url, canaryBook(id), "latestRoundData");
    const age = now - Number(updatedAt);
    /** @type {any} */ (facts[id]).answer = String(answer);
    /** @type {any} */ (facts[id]).ageSeconds = age;
    if (age > maxAge) problems.push(`${id}: the answer is ${age} s old, over ${maxAge} s`);
    if (BigInt(answer) <= 0n) problems.push(`${id}: the answer is not positive`);
  }
  const stateView = canaryBook("uniswap_v4_state_view");
  const [sqrtPriceX96, tick, , lpFee] = await read(url, stateView, "getSlot0", [
    UNISWAP_V4_MON_USDC_POOL.id,
  ]);
  const liquidity = await read(url, stateView, "getLiquidity", [UNISWAP_V4_MON_USDC_POOL.id]);
  facts.pool = {
    id: UNISWAP_V4_MON_USDC_POOL.id,
    sqrtPriceX96: String(sqrtPriceX96),
    tick: Number(tick),
    lpFee: Number(lpFee),
    liquidity: String(liquidity),
  };
  if (BigInt(sqrtPriceX96) === 0n) problems.push("the launch pool is not initialized");
  if (BigInt(liquidity) === 0n) problems.push("the launch pool has no liquidity");
  if (Number(lpFee) !== UNISWAP_V4_MON_USDC_POOL.fee)
    problems.push(`the launch pool's fee is ${lpFee}, expected ${UNISWAP_V4_MON_USDC_POOL.fee}`);
  if (problems.length > 0)
    throw new Error(
      `a mainnet fact changed; stopping before anything is sent:\n- ${problems.join("\n- ")}`,
    );
  return facts;
}

/**
 * The canary's MON budget (D-316): what every canary key has spent since the
 * run's start must stay within 10 MON. Spending is the fall in the three keys'
 * MON together, so gas given from one canary key to another is not counted twice.
 * @param {string} url @param {readonly string[]} keys @param {bigint} startWei
 */
export async function spentWei(url, keys, startWei) {
  let now = 0n;
  for (const k of keys) now += BigInt(await mainnetRpc(url, "eth_getBalance", [k, "latest"]));
  return startWei - now;
}

/** @param {bigint} wei */
export const mon = (wei) => `${formatEther(wei)} MON`;
