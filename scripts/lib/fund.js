// @ts-check
// The fund agent's v3 set (F-U2): the TokenRegistry, ProtocolRegistryV3,
// OracleAdapterV3 and a RouteAdapter, deployed beside v1 and v2 by
// chains/monad/script/DeployFund.s.sol. Local forks only: no unit has
// authorized a testnet or mainnet deployment of the v3 set.
//
// The core lane is seeded only from tokens with a fresh passing screen: each
// candidate is re-screened through the orchestrator at deploy time (its own
// fresh screen if it has one, else a new one now), and a token that fails is
// left out, with its core pools. A demo deploy on a throwaway fork may skip
// the screens, and says so.
import { spawn } from "node:child_process";
import { assertLocalFork } from "@alpha-agents/devenv";
import {
  CLASS_F_FEEDS,
  CORE_LANE_CANDIDATES,
  CORE_POOL_CANDIDATES,
  NATIVE_MON,
  addressEntry,
  feedMaxAgeSeconds,
} from "@alpha-agents/domain";
import { CUSTODY_ROLES } from "./account-factory.js";
import { LOCAL_DEPLOY_ATTEMPTS, isTransientForkError } from "./agent-nft.js";
import { ANVIL_URL } from "./config.js";
import { MONAD_DIR } from "./paths.js";

/**
 * Runs forge without blocking this process: a test fork started here drains
 * anvil's log from this process, and a blocking spawn would stall anvil (L-109).
 * Lines that could echo a key are never printed; URLs are redacted.
 * @param {string[]} args
 * @param {Record<string, string>} env
 * @returns {Promise<{ status: number, output: string }>}
 */
export function runForge(args, env) {
  return new Promise((resolve) => {
    const child = spawn("forge", args, { cwd: MONAD_DIR, env: { ...process.env, ...env } });
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    child.on("close", (status) => resolve({ status: status ?? 1, output }));
  });
}

/** Gas price args from the fork's own latest block. @param {string} url */
async function feeArgs(url) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBlockByNumber",
      params: ["latest", false],
    }),
  });
  const block = /** @type {{ result?: { baseFeePerGas?: string } }} */ (await res.json()).result;
  const baseFee = BigInt(block?.baseFeePerGas ?? "0x0");
  return ["--legacy", "--with-gas-price", String(baseFee * 2n + 2_000_000_000n)];
}

const redact = (/** @type {string} */ s) =>
  s
    .split("\n")
    .filter((l) => !/private.?key/i.test(l))
    .join("\n")
    .replace(/https?:\/\/(?!127\.0\.0\.1)\S+/g, "[url]");

/**
 * Local roles for the v3 set: the admin and guardian are custody's (anvil 0
 * and 4); the screener is anvil account 3, the role that adds screened tokens
 * and tightens at once. The demo executor (anvil 0) is the RouteAdapter's
 * caller until F-U4 deploys the Executor-bound adapter.
 */
export const FUND_ROLES = {
  admin: CUSTODY_ROLES.admin,
  guardian: CUSTODY_ROLES.guardian,
  screener: /** @type {`0x${string}`} */ ("0x90F79bf6EB2c4f870365E785982E1f101E93b906"),
  demoExecutor: CUSTODY_ROLES.admin,
};

/** @param {import("@alpha-agents/domain").AddressBookId} id */
function verified(id) {
  const e = addressEntry("local", id);
  if (e.status !== "verified")
    throw new Error(`the address book has no verified ${id} for the local fork`);
  return e.address;
}

const orchestratorUrl = () => `http://127.0.0.1:${process.env.ORCHESTRATOR_PORT ?? "4200"}`;

/**
 * Whether a token has a fresh passing screen, asking the orchestrator to run
 * one when it has none. Returns the verdict and a line for the log.
 * @param {string} address
 * @returns {Promise<{ passed: boolean, note: string }>}
 */
async function rescreen(address) {
  const base = orchestratorUrl();
  /** @param {string} path @param {RequestInit} [init] */
  const call = async (path, init) => {
    const res = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(180_000) });
    return { status: res.status, body: /** @type {any} */ (await res.json().catch(() => ({}))) };
  };
  let t = await call(`/v1/tokens/${address}`);
  if (t.status === 404) {
    const looked = await call("/v1/tokens/lookup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address }),
    });
    if (looked.status !== 200)
      return { passed: false, note: `not found: ${looked.body.message ?? looked.status}` };
    t = await call(`/v1/tokens/${address}`);
  }
  const screen = t.body.token?.screen;
  if (screen?.fresh)
    return { passed: screen.verdict === "passed", note: `fresh screen ${screen.verdict}` };
  const s = await call(`/v1/tokens/${address}/screen`, { method: "POST" });
  if (s.status !== 200)
    return { passed: false, note: `screen failed: ${s.body.message ?? s.status}` };
  const failed = (s.body.screen?.checks ?? [])
    .filter((/** @type {any} */ c) => c.status === "fail")
    .map((/** @type {any} */ c) => c.code);
  return {
    passed: s.body.screen?.verdict === "passed",
    note: `screened now: ${s.body.screen?.verdict}${failed.length ? ` (${failed.join(", ")})` : ""}`,
  };
}

/**
 * The FUND_CONFIG the forge script reads: roles, venues, the seeds that
 * passed with each feed leg's own bound, and the core pools between them.
 * @param {readonly string[]} seeded lowercase addresses that passed
 */
export function fundConfig(seeded) {
  const set = new Set(seeded);
  const held = (/** @type {string} */ a) => (a === NATIVE_MON ? verified("wmon").toLowerCase() : a);
  const seeds = CORE_LANE_CANDIDATES.filter((c) => set.has(c.address)).map((c) => {
    const f = CLASS_F_FEEDS.find((x) => x.address === c.address);
    if (!f) throw new Error(`no reviewed feed for ${c.address}`);
    // A composite's legs are the rate and then its USD leg; the contract takes the USD leg first.
    const usd = f.legs.at(-1);
    const rate = f.legs.length === 2 ? f.legs[0] : null;
    if (!usd) throw new Error(`no USD leg for ${c.address}`);
    return {
      token: c.address,
      maxPositionBps: c.maxPositionBps,
      usdFeed: usd.proxy,
      usdDecimals: usd.decimals,
      usdMaxAge: feedMaxAgeSeconds(usd),
      rateFeed: rate?.proxy ?? NATIVE_MON,
      rateDecimals: rate?.decimals ?? 0,
      rateMaxAge: rate ? feedMaxAgeSeconds(rate) : 0,
    };
  });
  const pools = CORE_POOL_CANDIDATES.filter(
    (p) => set.has(held(p.pair[0])) && set.has(held(p.pair[1])),
  );
  return {
    admin: FUND_ROLES.admin,
    guardian: FUND_ROLES.guardian,
    screener: FUND_ROLES.screener,
    usdc: verified("usdc"),
    wmon: verified("wmon"),
    uniswapV3Factory: verified("uniswap_v3_factory"),
    pancakeswapV3Factory: verified("pancakeswap_v3_factory"),
    poolManager: verified("uniswap_v4_pool_manager"),
    stateView: verified("uniswap_v4_state_view"),
    demoExecutor: FUND_ROLES.demoExecutor,
    maxDeviationBps: 200,
    seeds,
    // The forge script's keys, in its struct's order.
    pools: pools.map((p) => ({
      venue: p.venue,
      token0: p.pair[0],
      token1: p.pair[1],
      fee: p.fee,
      tickSpacing: p.tickSpacing,
      pool: p.pool,
    })),
  };
}

/**
 * Deploys the v3 set, or finds it.
 * @param {{ url?: string, quiet?: boolean, skipScreens?: boolean }} [options]
 */
export async function deployFundLocal(options = {}) {
  const url = options.url ?? ANVIL_URL;
  await assertLocalFork(url);
  const passed = [];
  const lines = [];
  for (const c of CORE_LANE_CANDIDATES) {
    if (options.skipScreens) {
      passed.push(c.address);
      continue;
    }
    const r = await rescreen(c.address);
    lines.push(`${r.passed ? "seeded" : "left out"} ${c.address}: ${r.note}`);
    if (r.passed) passed.push(c.address);
  }
  const config = fundConfig(passed);
  const args = [
    "script",
    "script/DeployFund.s.sol:DeployFund",
    "--broadcast",
    "--rpc-url",
    url,
    "--unlocked",
    "--sender",
    FUND_ROLES.admin,
    ...(await feeArgs(url)),
  ];
  let output = "";
  for (let attempt = 1; ; attempt++) {
    const r = await runForge(args, { FUND_CONFIG: JSON.stringify(config) });
    output = r.output;
    if (r.status === 0) break;
    if (attempt < LOCAL_DEPLOY_ATTEMPTS && isTransientForkError(output)) {
      console.log(
        `forge script hit a transient fork error; retrying (${attempt + 1} of ${LOCAL_DEPLOY_ATTEMPTS})`,
      );
      continue;
    }
    console.log(redact(output));
    throw new Error("forge script failed");
  }
  /** @param {string} name */
  const found = (name) => {
    const a = new RegExp(`${name}\\s+(0x[0-9a-fA-F]{40})`).exec(output)?.[1];
    if (!a) throw new Error(`forge script did not report ${name}`);
    return /** @type {`0x${string}`} */ (a);
  };
  const result = {
    tokenRegistry: found("TOKEN_REGISTRY_ADDRESS"),
    protocolRegistry: found("PROTOCOL_REGISTRY_V3_ADDRESS"),
    oracle: found("ORACLE_ADAPTER_V3_ADDRESS"),
    routeAdapter: found("ROUTE_ADAPTER_ADDRESS"),
    coreTokens: config.seeds.length,
    corePools: config.pools.length,
    screens: lines,
  };
  if (options.quiet) return result;
  console.log("");
  for (const l of lines) console.log(l);
  if (options.skipScreens)
    console.log("screens skipped: a throwaway demo fork, seeded with every candidate");
  console.log(`TokenRegistry: ${result.tokenRegistry} (${result.coreTokens} core tokens)`);
  console.log(`ProtocolRegistryV3: ${result.protocolRegistry} (${result.corePools} core pools)`);
  console.log(`OracleAdapterV3: ${result.oracle}`);
  console.log(
    `RouteAdapter: ${result.routeAdapter} (demo executor ${FUND_ROLES.demoExecutor}; F-U4 deploys the Executor's own)`,
  );
  console.log(
    `admin ${FUND_ROLES.admin}, guardian ${FUND_ROLES.guardian}, screener ${FUND_ROLES.screener} (anvil account 3)`,
  );
  return result;
}
