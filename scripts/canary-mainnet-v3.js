// @ts-check
// pnpm canary:mainnet:v3: F-U13's canary round trip on Monad mainnet with real
// funds (D-250 to D-252, D-258, D-316), in the canary environment
// (APP_ENV=canary) with its own database, against the v3 set that
// `pnpm deploy:canary:v3` made on P2-EC's CanaryAgent:
//
//   a. the canary owner opens the PersonalAccountV3 and deposits 4.99 USDC (exact approval)
//   b. registers the canary session key on Executor v3 for under 24 hours
//   c. buys about 0.45 USDC of WMON through packages/signer (the v3 outbox path:
//      the route's gas limit, simulation, fenced nonce, chain pin, fee caps) and
//      Executor v3's RouteAdapter on the hookless Uniswap v4 MON/USDC pool,
//      reconciled into the canary ledger and settled at the finalized tag
//   d. sells it back the same way
//   e. an oversized buy, refused in simulation with its reason, nothing signed
//   f. the guardian pauses Executor v3: a swap is refused, the owner's withdrawal works
//   g. the grant is revoked, everything is withdrawn to the canary owner, and the
//      guardian's and session key's MON is swept into the canary owner (D-316)
//
// Every transaction is checked against chain 143 and simulated before it is
// signed; the spend, the deployment's included, is held to the rerun's 10 MON
// (D-316, A-96). Anything unexpected stops the run: nothing is retried
// blindly. A rerun continues from the last finished step
// (evidence/f-u13/canary-run.json). Prints no key and no RPC URL. Needs
// Postgres (the local container).
//
//   CANARY_SIGNING_ENABLED=true pnpm canary:mainnet:v3          run (or continue) the canary
//   CANARY_SIGNING_ENABLED=true pnpm canary:mainnet:v3 --check  read everything, send nothing
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, MONAD_MAINNET_CHAIN_ID } from "@alpha-agents/config";
import { createDb, migrateToLatest, sql } from "@alpha-agents/db";
import {
  INTENT_SCHEMA_VERSION_V3,
  ROUTE_ADAPTER_ID,
  UNISWAP_V4_MON_USDC_POOL,
  executorV3SwapGasLimit,
} from "@alpha-agents/domain";
import { CanaryKeyProvider, EXECUTOR_V3_ABI, Signer, ViemChainClient } from "@alpha-agents/signer";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  defineChain,
  encodeFunctionData,
  formatEther,
  formatUnits,
  http,
  keccak256,
  parseAbi,
  parseEther,
  toBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CANARY_LIMITS,
  addressLink,
  assertMainnet,
  canaryBook,
  canaryConfig,
  canaryReveal,
  checkMainnetFacts,
  txLink,
} from "./lib/canary.js";
import {
  DEADLINE_SECONDS,
  FLOOR_SLIPPAGE_BPS,
  atOraclePrice,
  bpsFrom,
  fees,
  gasLimitFor,
  poolPriceE18,
  slippageBps,
  withinBudget,
} from "./lib/canary-run.js";
import { loadRootEnv } from "./lib/config.js";
import { ROOT } from "./lib/paths.js";
import { chainTransaction } from "./lib/testnet.js";

const LOCAL_DATABASE = "postgres://alpha:alpha_local_dev_only@127.0.0.1:5432/alpha_agents";
/** The canary's own database (D-251): its outbox and ledger rows never meet the beta's. */
const CANARY_DATABASE = "alpha_agents_canary";
const STATE_PATH = join(ROOT, "evidence/f-u13/canary-run.json");
const DEPLOYMENT_PATH = join(ROOT, "evidence/f-u13/canary-deployment.json");

/** The v3 swap's gas limit (F-U4's rule): one hop, USDC and WMON held after. */
const SWAP_GAS = executorV3SwapGasLimit(1, 2);
/**
 * MON given to the session key: the signer prices a swap at twice the base fee
 * (A-38), so two swaps at the 1.95M limit and a 100 gwei base need up to
 * 0.79 MON on hand at signing; Monad then charges the limit at the effective
 * price, about 0.2 MON each (D-252: at most 3).
 */
const SESSION_FUND_WEI = parseEther("0.9");
/** MON given to the guardian for its one pause. */
const GUARDIAN_FUND_WEI = parseEther("0.05");
/** The oversized buy: 1 USDC, over 10% of the 5 USDC account (D-258). */
const OVERSIZED_E6 = 1_000_000n;
/** The swap tried while paused. */
const PAUSED_SWAP_E6 = 100_000n;
/** The withdrawal shown to work while Executor v3 is paused. */
const PAUSED_WITHDRAW_E6 = 1_000_000n;
/**
 * The deposit: the canary owner holds 4.999499 USDC after P2-EC's round trip
 * (its two swaps cost 0.000501 USDC), so the rerun deposits 4.99 USDC, within
 * the 10 USDC cap and D-316's 10 USDC at risk; the 0.45 USDC trade stays
 * under its 10%, and the 1 USDC oversized buy stays over it.
 */
const DEPOSIT_E6 = 4_990_000n;

const check = process.argv.includes("--check");
loadRootEnv();

let config;
try {
  config = canaryConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`error: ${err.message}`);
  process.exit(1);
}
const url = /** @type {import("@alpha-agents/config").Secret} */ (config.rpcUrl).reveal();
const secondary = /** @type {import("@alpha-agents/config").Secret | undefined} */ (
  config.values.MONAD_RPC_URL_SECONDARY
)?.reveal();
const keys = {
  owner: /** @type {`0x${string}`} */ (canaryReveal(config, "CANARY_OWNER_PRIVATE_KEY")),
  guardian: /** @type {`0x${string}`} */ (canaryReveal(config, "CANARY_GUARDIAN_PRIVATE_KEY")),
  session: /** @type {`0x${string}`} */ (canaryReveal(config, "CANARY_SESSION_PRIVATE_KEY")),
};
const accounts = {
  owner: privateKeyToAccount(keys.owner),
  guardian: privateKeyToAccount(keys.guardian),
  session: privateKeyToAccount(keys.session),
};
const roles = {
  owner: accounts.owner.address,
  guardian: accounts.guardian.address,
  session: accounts.session.address,
};
/** @type {string[]} */
const SECRETS = [url, ...(secondary ? [secondary] : []), ...Object.values(keys)];
const hide = (/** @type {string} */ text) =>
  SECRETS.reduce((t, s) => t.replaceAll(s, "<redacted>"), text).replace(/https?:\/\/\S+/g, "<rpc>");

const chain = defineChain({
  id: MONAD_MAINNET_CHAIN_ID,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [url] } },
});
const client = createPublicClient({ chain, transport: http(url, { retryCount: 0 }) });

const USDC = canaryBook("usdc");
const WMON = canaryBook("wmon");
const MON_USD = canaryBook("chainlink_mon_usd");
const USDC_USD = canaryBook("chainlink_usdc_usd");
const STATE_VIEW = canaryBook("uniswap_v4_state_view");
/** The route: the hookless Uniswap v4 native MON/USDC 0.05% pool, registered under its v4 pool ID. */
const V4_POOL_ID = /** @type {`0x${string}`} */ (UNISWAP_V4_MON_USDC_POOL.id);

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);
const FACTORY = parseAbi([
  "function createPersonalAccount(uint256 agentId) returns (address)",
  "function personalAccountOf(uint256 agentId, address owner) view returns (address)",
  "function executor() view returns (address)",
  "error NotAgentOwner(address caller, address agentOwner)",
  "error AccountExists(address account)",
  "error NotAllowlisted(address depositor)",
  "error PersonalCapExceeded(uint256 principalAfter, uint256 cap)",
  "error PlatformCapExceeded(uint256 totalAfter, uint256 cap)",
]);
const ACCOUNT = parseAbi([
  "function deposit(address token, uint256 amount)",
  "function withdraw(address token, uint256 amount, address to)",
  "function withdrawAll(address to)",
  "function principal() view returns (uint256)",
  "error NotOwner(address caller)",
  "error NotDepositable(address token)",
  "error TransferNotExact(address token, uint256 received, uint256 amount)",
  "error ZeroAmount()",
  "error BadRecipient(address to)",
  "error InsufficientFree(address token, uint256 free)",
]);
const EXECUTOR = parseAbi([
  "function pauseAll()",
  "function paused() view returns (bool)",
  "function guardian() view returns (address)",
  "function pools() view returns (address)",
  "function floorFor(uint256 amountIn, uint256 pxIn, uint8 decIn, uint256 pxOut, uint8 decOut, uint256 slippageBps) pure returns (uint256)",
  "error NotAgentOwner(address caller)",
  "error BadSession()",
  "error Rejected(uint8 reason)",
]);
const ORACLE = parseAbi(["function priceE18(address token) view returns (uint256)"]);
const REGISTRY = parseAbi(["function adapterFor(bytes32 id) view returns (address)"]);
const FEED = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);
const STATE_VIEW_ABI = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160, int24, uint24, uint24)",
]);
const ALL_ERRORS = [...FACTORY, ...ACCOUNT, ...EXECUTOR, ...EXECUTOR_V3_ABI].filter(
  (x) => x.type === "error",
);

// ---- state and evidence ----

/**
 * @typedef {{
 *   runId: string, startedAt: string, startWei: string, deploymentSpentWei: string,
 *   done: string[], steps: Record<string, unknown>, transactions: any[], ended?: string,
 *   attempts?: Record<string, number>,
 * }} RunState
 */
/** @returns {RunState | null} */
function readState() {
  return existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, "utf8")) : null;
}
/** @param {RunState} s */
function saveState(s) {
  writeFileSync(STATE_PATH, `${JSON.stringify(s, null, 2)}\n`);
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const ms = (/** @type {number} */ since) => Date.now() - since;

async function balances(/** @type {`0x${string}`} */ who) {
  const [monWei, usdc, wmon] = await Promise.all([
    client.getBalance({ address: who }),
    client.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [who] }),
    client.readContract({ address: WMON, abi: ERC20, functionName: "balanceOf", args: [who] }),
  ]);
  return { monWei, usdc, wmon };
}

const showBalances = (/** @type {{ monWei: bigint, usdc: bigint, wmon: bigint }} */ b) =>
  `${formatEther(b.monWei)} MON, ${formatUnits(b.usdc, 6)} USDC, ${formatEther(b.wmon)} WMON`;

async function totalKeyWei() {
  let sum = 0n;
  for (const a of Object.values(roles)) sum += await client.getBalance({ address: a });
  return sum;
}

/** The spend so far: the v3 deployment's plus the fall in the three keys' MON since the run began (D-316). @param {RunState} s */
async function spent(s) {
  return BigInt(s.deploymentSpentWei) + (BigInt(s.startWei) - (await totalKeyWei()));
}

/** Prices and freshness at this moment: Chainlink, OracleAdapterV3 (USD per token) and the v4 pool. */
async function market(/** @type {`0x${string}`} */ oracle) {
  const block = await client.getBlock();
  const now = Number(block.timestamp);
  const [[, monAnswer, , monAt], [, usdcAnswer, , usdcAt], wmonE18, usdcE18, [sqrtPriceX96, tick]] =
    await Promise.all([
      client.readContract({ address: MON_USD, abi: FEED, functionName: "latestRoundData" }),
      client.readContract({ address: USDC_USD, abi: FEED, functionName: "latestRoundData" }),
      client.readContract({ address: oracle, abi: ORACLE, functionName: "priceE18", args: [WMON] }),
      client.readContract({ address: oracle, abi: ORACLE, functionName: "priceE18", args: [USDC] }),
      client.readContract({
        address: STATE_VIEW,
        abi: STATE_VIEW_ABI,
        functionName: "getSlot0",
        args: [V4_POOL_ID],
      }),
    ]);
  const poolE18 = poolPriceE18(sqrtPriceX96);
  // USDC per MON as the v2 canary recorded it: the oracle's USD price of WMON over its USD price of USDC.
  const oracleUsdcPerMonE18 = (wmonE18 * 10n ** 18n) / usdcE18;
  return {
    block: Number(block.number),
    blockTime: now,
    monUsd: Number(monAnswer) / 1e8,
    monUsdAgeSeconds: now - Number(monAt),
    usdcUsd: Number(usdcAnswer) / 1e8,
    usdcUsdAgeSeconds: now - Number(usdcAt),
    oracleWmonUsdE18: wmonE18.toString(),
    oracleUsdcUsdE18: usdcE18.toString(),
    oracleUsdcPerMon: Number(oracleUsdcPerMonE18) / 1e18,
    poolUsdcPerMon: Number(poolE18) / 1e18,
    poolTick: Number(tick),
    poolVsOracleBps: bpsFrom(poolE18, oracleUsdcPerMonE18),
  };
}

/** Waits for the `safe` and `finalized` tags to reach the block; times from `since`. */
async function finality(/** @type {bigint} */ block, /** @type {number} */ since) {
  /** @type {{ safeMs: number | null, finalizedMs: number | null }} */
  const out = { safeMs: null, finalizedMs: null };
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && (out.safeMs === null || out.finalizedMs === null)) {
    const [safe, fin] = await Promise.all([
      client.getBlock({ blockTag: "safe" }),
      client.getBlock({ blockTag: "finalized" }),
    ]);
    if (out.safeMs === null && safe.number >= block) out.safeMs = ms(since);
    if (out.finalizedMs === null && fin.number >= block) out.finalizedMs = ms(since);
    if (out.safeMs === null || out.finalizedMs === null) await sleep(150);
  }
  if (out.finalizedMs === null) throw new Error(`block ${block} was not finalized within 60 s`);
  return out;
}

/** A revert's name and arguments, from every ABI the canary knows. */
function revertOf(/** @type {unknown} */ err) {
  if (err instanceof BaseError) {
    const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError && r.data)
      return `${r.data.errorName}(${(r.data.args ?? []).map(String).join(", ")})`;
    const raw = /** @type {any} */ (
      err.walk((e) => typeof (/** @type {any} */ (e).data) === "string")
    );
    if (raw?.data) {
      try {
        const d = decodeErrorResult({ abi: ALL_ERRORS, data: raw.data });
        return `${d.errorName}(${(d.args ?? []).map(String).join(", ")})`;
      } catch {
        // not one of ours
      }
    }
    return err.shortMessage;
  }
  return String(err);
}

/**
 * One transaction from a canary key: chain 143 checked, simulated from the
 * sender, gas at 110% of the estimate, fees within A-38's caps, the spend
 * within the budget, then signed, sent and followed to `finalized`.
 * Anything unexpected throws, and nothing is resent.
 * @param {RunState} s
 * @param {keyof typeof accounts} role
 * @param {string} step
 * @param {{ to: `0x${string}`, data?: `0x${string}`, value?: bigint }} req
 */
async function send(s, role, step, req) {
  await assertMainnet(url);
  const from = roles[role];
  const tx = { account: from, to: req.to, data: req.data ?? "0x", value: req.value ?? 0n };
  try {
    await client.call(tx);
  } catch (err) {
    throw new Error(`${step}: the simulation reverted (${revertOf(err)}); nothing was sent`, {
      cause: err,
    });
  }
  const estimate = await client.estimateGas(tx);
  const gas = gasLimitFor(estimate);
  const block = await client.getBlock();
  const priority = await client.estimateMaxPriorityFeePerGas().catch(() => 2_000_000_000n);
  const f = fees(block.baseFeePerGas ?? 0n, priority);
  if (!f) throw new Error(`${step}: the base fee is above the 500 gwei cap; nothing was sent`);
  const spentWei = await spent(s);
  if (
    !withinBudget({
      spentWei,
      budgetWei: CANARY_LIMITS.spendWei,
      gas,
      maxFeePerGas: f.maxFeePerGas,
    })
  )
    throw new Error(
      `${step}: it could cost up to ${formatEther(gas * f.maxFeePerGas)} MON, and ${formatEther(spentWei)} of the 10 MON budget is spent; nothing was sent`,
    );
  const wallet = createWalletClient({
    account: accounts[role],
    chain,
    transport: http(url, { retryCount: 0 }),
  });
  const nonce = await client.getTransactionCount({ address: from, blockTag: "pending" });
  const sentAt = Date.now();
  const hash = await wallet.sendTransaction({
    to: req.to,
    data: req.data,
    value: req.value ?? 0n,
    gas,
    nonce,
    maxFeePerGas: f.maxFeePerGas,
    maxPriorityFeePerGas: f.maxPriorityFeePerGas,
    chain,
  });
  console.log(`   ${step}: sent ${txLink(hash)}`);
  const receipt = await client.waitForTransactionReceipt({
    hash,
    pollingInterval: 150,
    timeout: 60_000,
  });
  const receiptMs = ms(sentAt);
  if (receipt.status !== "success")
    throw new Error(`${step}: the transaction reverted on chain (${txLink(hash)}); stopping`);
  const fin = await finality(receipt.blockNumber, sentAt);
  const measured = await chainTransaction(url, hash);
  const record = {
    step,
    role,
    ...measured,
    link: txLink(hash),
    gasEstimate: estimate.toString(),
    receiptMs,
    ...fin,
  };
  s.transactions.push(record);
  saveState(s);
  console.log(
    `   ${step}: block ${measured.block}, gas limit ${measured.gasLimit}, paid ${formatEther(BigInt(measured.paidWei))} MON; receipt ${receiptMs} ms, safe ${fin.safeMs} ms, finalized ${fin.finalizedMs} ms`,
  );
  return record;
}

/** Runs a step once: a finished step is skipped on a rerun. @param {RunState} s @param {string} name @param {() => Promise<unknown>} fn */
async function step(s, name, fn) {
  if (s.done.includes(name)) {
    console.log(`${name}: done earlier`);
    return s.steps[name];
  }
  console.log(`\n${name}`);
  const result = await fn();
  s.steps[name] = result ?? null;
  s.done.push(name);
  saveState(s);
  return result;
}

async function ensureDatabase() {
  const admin = createDb(LOCAL_DATABASE, { max: 1 });
  try {
    const found = await sql`select 1 from pg_database where datname = ${CANARY_DATABASE}`.execute(
      admin,
    );
    if (found.rows.length === 0) await sql.raw(`create database ${CANARY_DATABASE}`).execute(admin);
  } finally {
    await admin.destroy();
  }
  const db = createDb(LOCAL_DATABASE.replace(/alpha_agents$/, CANARY_DATABASE), { max: 4 });
  await migrateToLatest(db);
  return db;
}

// ---- the run ----

try {
  await assertMainnet(url);
  if (!existsSync(DEPLOYMENT_PATH))
    throw new Error("no canary v3 deployment: run pnpm deploy:canary:v3 first");
  const deployment = JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8"));
  const c = {
    agent: /** @type {`0x${string}`} */ (canaryBook("agent_nft")),
    factory: canaryBook("account_factory_v3"),
    executor: canaryBook("executor_v3"),
    executorV2: canaryBook("executor"),
    oracle: canaryBook("oracle_adapter_v3"),
    registry: canaryBook("protocol_registry_v3"),
    routeAdapter: canaryBook("executor_route_adapter_v3"),
  };
  // The address book must name what was deployed, and the deployment must be ours.
  if (c.factory.toLowerCase() !== deployment.custodyV3.factory.toLowerCase())
    throw new Error(
      "the address book's canary AccountFactoryV3 differs from the deployment record",
    );
  if (c.executor.toLowerCase() !== deployment.executorV3.executor.toLowerCase())
    throw new Error("the address book's canary Executor v3 differs from the deployment record");
  const [guardianOnChain, factoryExecutor, boundPools, adapter] = await Promise.all([
    client.readContract({ address: c.executor, abi: EXECUTOR, functionName: "guardian" }),
    client.readContract({ address: c.factory, abi: FACTORY, functionName: "executor" }),
    client.readContract({ address: c.executor, abi: EXECUTOR, functionName: "pools" }),
    client.readContract({
      address: c.registry,
      abi: REGISTRY,
      functionName: "adapterFor",
      args: [ROUTE_ADAPTER_ID],
    }),
  ]);
  if (guardianOnChain.toLowerCase() !== roles.guardian.toLowerCase())
    throw new Error(
      "the canary Executor v3's guardian is not CANARY_GUARDIAN_PRIVATE_KEY's address",
    );
  if (factoryExecutor.toLowerCase() !== c.executor.toLowerCase())
    throw new Error("the canary AccountFactoryV3 does not name Executor v3 as its executor");
  if (boundPools.toLowerCase() !== c.registry.toLowerCase())
    throw new Error("Executor v3 is not bound to the canary ProtocolRegistryV3");
  if (adapter.toLowerCase() !== c.routeAdapter.toLowerCase())
    throw new Error(
      "the canary ProtocolRegistryV3 does not hold Executor v3's RouteAdapter under route-adapter",
    );

  console.log("Re-checking the mainnet facts (D-248)");
  const facts = await checkMainnetFacts(url);
  console.log(`   unchanged at block ${facts.block}`);
  for (const [role, address] of Object.entries(roles))
    console.log(`   ${role.padEnd(8)} ${address}: ${showBalances(await balances(address))}`);
  const deploymentSpent = BigInt(deployment.spentWei);
  console.log(
    `   the v3 deployment spent ${formatEther(deploymentSpent)} MON of the rerun's 10 MON budget`,
  );
  const m0 = await market(c.oracle);
  console.log(
    `   MON/USD ${m0.monUsd} (${m0.monUsdAgeSeconds} s old), USDC/USD ${m0.usdcUsd} (${m0.usdcUsdAgeSeconds} s old); pool ${m0.poolUsdcPerMon.toFixed(6)} vs oracle ${m0.oracleUsdcPerMon.toFixed(6)} USDC per MON (${m0.poolVsOracleBps} bps)`,
  );
  if (check) {
    console.log("\ncheck: nothing was sent");
    process.exit(0);
  }

  /** @type {RunState} */
  const s = readState() ?? {
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    startWei: (await totalKeyWei()).toString(),
    deploymentSpentWei: deploymentSpent.toString(),
    done: [],
    steps: {},
    transactions: [],
  };
  saveState(s);
  const db = await ensureDatabase();
  const signer = new Signer({
    db,
    environment: "canary",
    chain: new ViemChainClient({
      chainId: MONAD_MAINNET_CHAIN_ID,
      primaryUrl: url,
      ...(secondary ? { secondaryUrl: secondary } : {}),
    }),
    keys: new CanaryKeyProvider(keys.session),
    executor: c.executorV2,
    executorV3: c.executor,
    usdc: USDC,
    assets: { [USDC.toLowerCase()]: "USDC", [WMON.toLowerCase()]: "WMON" },
    secrets: [url, secondary],
    log: (line) => console.log(`   signer: ${hide(line)}`),
  });
  try {
    await signer.start();

    await step(s, "fund the session key and the guardian", async () => {
      const out = {};
      for (const [role, wei] of /** @type {const} */ ([
        ["session", SESSION_FUND_WEI],
        ["guardian", GUARDIAN_FUND_WEI],
      ])) {
        const have = await client.getBalance({ address: roles[role] });
        if (have >= wei / 2n) continue;
        if (have + wei > CANARY_LIMITS.sessionMaxWei)
          throw new Error(`${role} would hold over 3 MON`);
        /** @type {any} */ (out)[role] = (
          await send(s, "owner", `fund ${role}`, { to: roles[role], value: wei })
        ).hash;
      }
      return out;
    });

    const account = /** @type {`0x${string}`} */ (
      await step(s, "a. open the PersonalAccountV3", async () => {
        const existing = await client.readContract({
          address: c.factory,
          abi: FACTORY,
          functionName: "personalAccountOf",
          args: [1n, roles.owner],
        });
        if (existing !== "0x0000000000000000000000000000000000000000") return existing;
        await send(s, "owner", "createPersonalAccount", {
          to: c.factory,
          data: encodeFunctionData({
            abi: FACTORY,
            functionName: "createPersonalAccount",
            args: [1n],
          }),
        });
        const made = await client.readContract({
          address: c.factory,
          abi: FACTORY,
          functionName: "personalAccountOf",
          args: [1n, roles.owner],
        });
        console.log(`   account ${made} (${addressLink(made)})`);
        return made;
      })
    );

    await step(s, "a. deposit 4.99 USDC", async () => {
      const principal = await client.readContract({
        address: account,
        abi: ACCOUNT,
        functionName: "principal",
      });
      if (principal >= DEPOSIT_E6) return { principal: principal.toString() };
      const allowance = await client.readContract({
        address: USDC,
        abi: ERC20,
        functionName: "allowance",
        args: [roles.owner, account],
      });
      if (allowance < DEPOSIT_E6)
        await send(s, "owner", "approve (exact)", {
          to: USDC,
          data: encodeFunctionData({
            abi: ERC20,
            functionName: "approve",
            args: [account, DEPOSIT_E6],
          }),
        });
      await send(s, "owner", "deposit", {
        to: account,
        data: encodeFunctionData({
          abi: ACCOUNT,
          functionName: "deposit",
          args: [USDC, DEPOSIT_E6],
        }),
      });
      const b = await balances(account);
      console.log(`   account holds ${showBalances(b)}`);
      return { usdc: b.usdc.toString() };
    });

    await step(s, "b. register the session grant", async () => {
      const key = await signer.createKey(1);
      if (key.toLowerCase() !== roles.session.toLowerCase())
        throw new Error("the signer's canary key is not CANARY_SESSION_PRIVATE_KEY's address");
      const now = (await client.getBlock()).timestamp;
      // Under 24 hours (D-252), with ten minutes to spare.
      const validUntil = now + CANARY_LIMITS.grantMaxSeconds - 600n;
      await send(s, "owner", "registerSession", {
        to: c.executor,
        data: encodeFunctionData({
          abi: EXECUTOR_V3_ABI,
          functionName: "registerSession",
          args: [1n, key, validUntil],
        }),
      });
      const grant = await client.readContract({
        address: c.executor,
        abi: EXECUTOR_V3_ABI,
        functionName: "sessionOf",
        args: [1n],
      });
      if (grant.key.toLowerCase() !== key.toLowerCase())
        throw new Error("the grant does not name the session key");
      return {
        grantedTo: key,
        validUntil: Number(grant.validUntil),
        hours: Number(grant.validUntil - now) / 3600,
      };
    });

    /**
     * A v3 swap through the signer: the intent from the chain now (the floor
     * from OracleAdapterV3's two prices at the launch policy's 50 bps, the
     * route of one registered pool, no attestation for class F), the market
     * before, the outbox followed to reconciled, then the finalized tag.
     * @param {string} name @param {"buy" | "sell"} direction @param {bigint} amountIn
     */
    const swap = async (name, direction, amountIn) => {
      await assertMainnet(url);
      const before = await market(c.oracle);
      const tokenIn = direction === "buy" ? USDC : WMON;
      const tokenOut = direction === "buy" ? WMON : USDC;
      const [policyHash, configEpoch, block] = await Promise.all([
        client.readContract({
          address: c.executor,
          abi: EXECUTOR_V3_ABI,
          functionName: "policyHash",
        }),
        client.readContract({
          address: c.executor,
          abi: EXECUTOR_V3_ABI,
          functionName: "configEpochOf",
          args: [1n],
        }),
        client.getBlock(),
      ]);
      const pxIn = BigInt(direction === "buy" ? before.oracleUsdcUsdE18 : before.oracleWmonUsdE18);
      const pxOut = BigInt(direction === "buy" ? before.oracleWmonUsdE18 : before.oracleUsdcUsdE18);
      const floor = await client.readContract({
        address: c.executor,
        abi: EXECUTOR,
        functionName: "floorFor",
        args: [
          amountIn,
          pxIn,
          direction === "buy" ? 6 : 18,
          pxOut,
          direction === "buy" ? 18 : 6,
          FLOOR_SLIPPAGE_BPS,
        ],
      });
      // One action per attempt: a swap refused earlier (say on a stale feed)
      // leaves its failed outbox row, and a rerun submits a fresh intent.
      s.attempts ??= {};
      const attempt = (s.attempts[name] ?? 0) + 1;
      s.attempts[name] = attempt;
      saveState(s);
      /** @type {import("@alpha-agents/signer").SwapIntentV3Args} */
      const intent = {
        schemaVersion: INTENT_SCHEMA_VERSION_V3,
        chainId: BigInt(MONAD_MAINNET_CHAIN_ID),
        agentId: 1n,
        account,
        actionId: keccak256(toBytes(`f-u13-canary:${s.runId}:${name}:${attempt}`)),
        ownerEpoch: 0n,
        configEpoch,
        policyHash,
        adapterId: ROUTE_ADAPTER_ID,
        tokenIn,
        tokenOut,
        amountIn,
        minAmountOut: floor,
        deadline: block.timestamp + DEADLINE_SECONDS,
        route: [V4_POOL_ID],
        attestationIn: "0x",
        attestationOut: "0x",
      };
      const spentWei = await spent(s);
      if (
        !withinBudget({
          spentWei,
          budgetWei: CANARY_LIMITS.spendWei,
          gas: SWAP_GAS,
          maxFeePerGas: 500_000_000_000n,
        })
      )
        throw new Error(`${name}: a swap could exceed the 10 MON budget; nothing was sent`);
      const nonceBefore = await client.getTransactionCount({
        address: roles.session,
        blockTag: "pending",
      });
      const accepted = await signer.submitSwapV3(1, intent, SWAP_GAS, [tokenIn, tokenOut]);
      const t0 = Date.now();
      /** @type {import("@alpha-agents/signer").OutboxView | undefined} */
      let row;
      /** @type {number | null} */
      let confirmedMs = null;
      for (let i = 0; i < 400; i++) {
        await signer.tick();
        row = (await signer.outbox(1, 50)).find((r) => r.txId === accepted.txId);
        // CL-U1: a row that went from submitted to reconciled between two polls was confirmed too.
        if (
          row &&
          confirmedMs === null &&
          (row.status === "confirmed" || row.status === "reconciled")
        )
          confirmedMs = ms(t0);
        if (row && (row.status === "reconciled" || row.status === "failed" || row.reasonCode))
          break;
        await sleep(150);
      }
      if (!row) throw new Error(`${name}: the outbox lost the swap`);
      const nonceAfter = await client.getTransactionCount({
        address: roles.session,
        blockTag: "pending",
      });
      // USDC per MON, as the slippage arithmetic takes it.
      const price =
        (BigInt(before.oracleWmonUsdE18) * 10n ** 18n) / BigInt(before.oracleUsdcUsdE18);
      return { row, before, intent, t0, confirmedMs, nonceBefore, nonceAfter, price };
    };

    /** A swap that must settle: reconciled, then finalized, with its slippage and fee. @param {string} name @param {"buy" | "sell"} direction @param {bigint} amountIn */
    const settle = async (name, direction, amountIn) => {
      const r = await swap(name, direction, amountIn);
      if (r.row.status !== "reconciled" || !r.row.txHash)
        throw new Error(
          `${name}: the swap ended ${r.row.status}${r.row.reasonCode ? ` (${r.row.reasonCode}: ${hide(r.row.reason ?? "")})` : ""}; stopping, nothing is resent`,
        );
      const hash = /** @type {`0x${string}`} */ (r.row.txHash);
      const receipt = await client.getTransactionReceipt({ hash });
      const fin = await finality(receipt.blockNumber, r.t0);
      const measured = await chainTransaction(url, hash);
      const out = BigInt(r.row.amountOut ?? "0");
      const entry = r.row.ledgerEntryId ? await signer.ledgerEntry(r.row.ledgerEntryId) : null;
      const record = {
        step: name,
        role: "session (signer, Executor v3)",
        ...measured,
        link: txLink(hash),
        outbox: {
          txId: r.row.txId,
          history: r.row.history.map((h) => h.status),
          ledgerEntryId: r.row.ledgerEntryId,
        },
        ledger: entry?.lines ?? null,
        route: r.intent.route,
        gasLimitRule: SWAP_GAS.toString(),
        amountIn: amountIn.toString(),
        amountOut: out.toString(),
        minAmountOut: r.intent.minAmountOut.toString(),
        atOraclePrice: atOraclePrice(direction, amountIn, r.price).toString(),
        slippageBps: slippageBps(direction, amountIn, out, r.price),
        marketBefore: r.before,
        confirmedMs: r.confirmedMs,
        ...fin,
      };
      s.transactions.push(record);
      saveState(s);
      console.log(`   ${name}: ${txLink(hash)}`);
      console.log(
        `   ${direction === "buy" ? `${formatUnits(amountIn, 6)} USDC for ${formatEther(out)} WMON` : `${formatEther(amountIn)} WMON for ${formatUnits(out, 6)} USDC`}; floor ${direction === "buy" ? formatEther(r.intent.minAmountOut) : formatUnits(r.intent.minAmountOut, 6)}; ${record.slippageBps} bps from the Chainlink price; pool ${r.before.poolVsOracleBps} bps from the oracle`,
      );
      console.log(
        `   outbox ${record.outbox.history.join(" -> ")}; confirmed ${r.confirmedMs} ms, finalized ${fin.finalizedMs} ms; gas limit ${measured.gasLimit} (rule ${SWAP_GAS}), used ${measured.gasUsed}; paid ${formatEther(BigInt(measured.paidWei))} MON`,
      );
      return { hash, amountOut: out.toString(), slippageBps: record.slippageBps };
    };

    /** A swap that must be refused before signing, with this reason. @param {string} name @param {bigint} amountIn @param {string} reason */
    const refused = async (name, amountIn, reason) => {
      const r = await swap(name, "buy", amountIn);
      const nothingSigned =
        r.row.txHash === null && r.row.nonce === null && r.nonceAfter === r.nonceBefore;
      console.log(
        `   ${name}: ${r.row.status} ${r.row.reasonCode} (${hide(r.row.reason ?? "")}); signed: ${nothingSigned ? "nothing" : "SOMETHING"}`,
      );
      if (r.row.status !== "failed" || r.row.reasonCode !== reason || !nothingSigned)
        throw new Error(
          `${name}: expected ${reason} before signing, got ${r.row.status} ${r.row.reasonCode}; stopping`,
        );
      return {
        status: r.row.status,
        reasonCode: r.row.reasonCode,
        reason: hide(r.row.reason ?? ""),
        nothingSigned,
        sessionNonce: r.nonceAfter,
        marketBefore: r.before,
      };
    };

    await step(s, "c. buy 0.45 USDC of WMON", () => settle("buy", "buy", CANARY_LIMITS.tradeE6));
    await step(s, "d. sell the WMON back", async () => {
      const held = await client.readContract({
        address: WMON,
        abi: ERC20,
        functionName: "balanceOf",
        args: [account],
      });
      if (held === 0n) throw new Error("the account holds no WMON to sell");
      return settle("sell", "sell", held);
    });
    await step(s, "e. an oversized buy, refused before signing", () =>
      refused("oversized buy", OVERSIZED_E6, "TRADE_SIZE_EXCEEDED"),
    );
    await step(s, "f. the guardian pauses Executor v3", async () => {
      const r = await send(s, "guardian", "pauseAll", {
        to: c.executor,
        data: encodeFunctionData({ abi: EXECUTOR, functionName: "pauseAll" }),
      });
      if (
        !(await client.readContract({ address: c.executor, abi: EXECUTOR, functionName: "paused" }))
      )
        throw new Error("Executor v3 is not paused");
      return { hash: r.hash };
    });
    await step(s, "f. a swap while paused, refused", () =>
      refused("swap while paused", PAUSED_SWAP_E6, "PAUSED"),
    );
    await step(s, "f. the owner withdraws while paused", async () => {
      const r = await send(s, "owner", "withdraw 1 USDC while paused", {
        to: account,
        data: encodeFunctionData({
          abi: ACCOUNT,
          functionName: "withdraw",
          args: [USDC, PAUSED_WITHDRAW_E6, roles.owner],
        }),
      });
      return { hash: r.hash };
    });
    await step(s, "g. revoke the grant", async () => {
      const r = await send(s, "owner", "revokeSession", {
        to: c.executor,
        data: encodeFunctionData({
          abi: EXECUTOR_V3_ABI,
          functionName: "revokeSession",
          args: [1n],
        }),
      });
      return { hash: r.hash };
    });
    await step(s, "g. withdraw everything", async () => {
      const r = await send(s, "owner", "withdrawAll", {
        to: account,
        data: encodeFunctionData({
          abi: ACCOUNT,
          functionName: "withdrawAll",
          args: [roles.owner],
        }),
      });
      const b = await balances(account);
      if (b.usdc !== 0n || b.wmon !== 0n)
        throw new Error(`the account still holds ${showBalances(b)}`);
      return { hash: r.hash };
    });
    for (const role of /** @type {const} */ (["session", "guardian"])) {
      await step(s, `g. sweep the ${role} key into the canary owner`, async () => {
        const have = await client.getBalance({ address: roles[role] });
        const block = await client.getBlock();
        const f = fees(block.baseFeePerGas ?? 0n, 2_000_000_000n);
        if (!f) throw new Error("the base fee is above the cap");
        const reserve = gasLimitFor(21_000n) * f.maxFeePerGas;
        if (have <= reserve)
          return { skipped: `holds ${formatEther(have)} MON, less than its gas` };
        const r = await send(s, role, `sweep ${role}`, { to: roles.owner, value: have - reserve });
        return {
          hash: r.hash,
          left: formatEther(await client.getBalance({ address: roles[role] })),
        };
      });
    }

    const final = {};
    for (const [role, address] of Object.entries(roles)) {
      const b = await balances(address);
      /** @type {any} */ (final)[role] = {
        mon: formatEther(b.monWei),
        usdc: formatUnits(b.usdc, 6),
        wmon: formatEther(b.wmon),
      };
    }
    const accountBalances = await balances(account);
    const ending = {
      keys: final,
      account: {
        address: account,
        usdc: formatUnits(accountBalances.usdc, 6),
        wmon: formatEther(accountBalances.wmon),
      },
      spentWei: (await spent(s)).toString(),
    };
    s.steps.final = ending;
    s.ended = new Date().toISOString();
    saveState(s);
    console.log("\nFinal balances");
    for (const [role, b] of Object.entries(final))
      console.log(`   ${role.padEnd(8)} ${JSON.stringify(b)}`);
    console.log(`   account  ${JSON.stringify(ending.account)}`);
    console.log(
      `the canary rerun spent ${formatEther(await spent(s))} MON of its 10 MON budget, the v3 deployment included; recorded in ${STATE_PATH}`,
    );
  } finally {
    await db.destroy();
  }
} catch (err) {
  console.error(`error: ${hide(err instanceof Error ? err.message : String(err))}`);
  process.exit(1);
}
