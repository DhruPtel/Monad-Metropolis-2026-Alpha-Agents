// @ts-check
// Monad testnet for P2-EC part 1: the testnet facts, the operator's keys, a
// guarded RPC, and forge runs whose output never shows the RPC URL or a key.
// Every function refuses a chain that is not 10143 before sending anything.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadConfig, MONAD_TESTNET_CHAIN_ID } from "@alpha-agents/config";
import { redact } from "@alpha-agents/devenv";
import { privateKeyToAccount } from "viem/accounts";
import { MONAD_DIR } from "./paths.js";

/** Testnet facts re-checked at the start of P2-EC (D-248). */
export const TESTNET = {
  chainId: MONAD_TESTNET_CHAIN_ID,
  usdc: /** @type {`0x${string}`} */ ("0x534b2f3A21130d7a60830c2Df862319e593943A3"),
  wmon: /** @type {`0x${string}`} */ ("0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541"),
  entropy: /** @type {`0x${string}`} */ ("0x825c0390f379C631f3Cf11A82a37D20BddF93c07"),
  poolManager: /** @type {`0x${string}`} */ ("0x451D64ab3b650040d2aE1886602b97ed6eDc643d"),
  stateView: /** @type {`0x${string}`} */ ("0xB639209539c61BaF67AC04876315786F8D0b153c"),
  explorer: "https://testnet.monadvision.com",
};

/** The p2ec salt scope every testnet deployment uses (D-249). */
export const SALT_SCOPE = "p2ec.testnet";

/** The pool seed of D-307: 0.5 MON and 0.5 USDC in about ±1% around 1 MON = 1 USDC. */
export const SEED = {
  monWei: 500_000_000_000_000_000n,
  usdcRaw: 500_000n,
  liquidity: 95_902_508_421_861n,
  tickLower: -276_420,
  tickUpper: -276_220,
};

/** forge's gas-estimate multiplier for testnet (D-306): Monad charges the gas limit. */
export const GAS_ESTIMATE_MULTIPLIER = 110;

/**
 * Loads and checks the testnet operator configuration: the RPC and every
 * testnet key, with the key guards of D-254 (no anvil key, none equal to a
 * local key or to another role's). Throws ConfigError, which holds no value.
 * @param {readonly string[]} requires
 */
export function testnetConfig(requires) {
  return loadConfig(
    { name: "testnet operator", signs: true, requires: /** @type {any} */ (requires) },
    { ...process.env, APP_ENV: "testnet" },
  );
}

/** @param {import("@alpha-agents/config").Config} config @param {string} name */
export function reveal(config, name) {
  const value = /** @type {Record<string, unknown>} */ (config.values)[name];
  if (!value || typeof value !== "object" || !("reveal" in value)) {
    throw new ConfigError("Testnet configuration is incomplete:", [
      { variable: name, problem: "is not set" },
    ]);
  }
  return /** @type {{ reveal(): string }} */ (value).reveal();
}

/** @param {string} key */
export const addressOf = (key) => privateKeyToAccount(/** @type {`0x${string}`} */ (key)).address;

/**
 * A JSON-RPC call to the testnet RPC whose errors never carry the URL.
 * @param {string} url @param {string} method @param {unknown[]} params
 */
export async function testnetRpc(url, method, params = []) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    // No cause: a fetch error can carry the RPC URL, which is a secret.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`${method} failed: ${redact(String(err), [url])}`);
  }
  const body = /** @type {{ result?: any, error?: { message?: string } }} */ (await res.json());
  if (body.error) throw new Error(`${method}: ${redact(body.error.message ?? "error", [url])}`);
  return body.result;
}

/** Refuses anything but Monad testnet, before any transaction. @param {string} url */
export async function assertTestnet(url) {
  const chainId = Number(await testnetRpc(url, "eth_chainId"));
  if (chainId !== TESTNET.chainId) {
    throw new Error(`MONAD_TESTNET_RPC_URL serves chain ${chainId}, not ${TESTNET.chainId}`);
  }
}

/**
 * Runs a forge script against testnet and returns its output, with the RPC URL
 * and every key redacted from what is printed and returned.
 * @param {string} script e.g. "script/DeployTestnetMarket.s.sol:DeployTestnetMarket"
 * @param {{ url: string, env: Record<string, string>, secrets: string[], broadcast: boolean }} o
 */
export function forgeScript(script, o) {
  const args = ["script", script, "--rpc-url", o.url, "--slow"];
  if (o.broadcast)
    args.push("--broadcast", "--gas-estimate-multiplier", String(GAS_ESTIMATE_MULTIPLIER));
  const result = spawnSync("forge", args, {
    cwd: MONAD_DIR,
    env: { ...process.env, ...o.env, DEPLOY_SALT_SCOPE: SALT_SCOPE },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = redact(`${result.stdout ?? ""}${result.stderr ?? ""}`, [o.url, ...o.secrets]);
  for (const line of output.split("\n")) if (!/private.?key/i.test(line)) console.log(line);
  if (result.status !== 0) throw new Error(`forge script ${script} failed`);
  return output;
}

/**
 * What the chain says about one transaction: its gas limit, the receipt's gas
 * used, the fees, and the MON paid. On Monad a receipt's gasUsed is the gas
 * limit, because the limit is what is charged; forge's broadcast file can
 * hold a stale limit for a call, so both come from the chain (P2-EC).
 * @param {string} url @param {string} hash
 */
export async function chainTransaction(url, hash) {
  const tx = await testnetRpc(url, "eth_getTransactionByHash", [hash]);
  const r = await testnetRpc(url, "eth_getTransactionReceipt", [hash]);
  const block = await testnetRpc(url, "eth_getBlockByNumber", [r.blockNumber, false]);
  const gasLimit = BigInt(tx.gas);
  const gasUsed = BigInt(r.gasUsed);
  const price = BigInt(r.effectiveGasPrice);
  return {
    hash,
    from: tx.from,
    to: tx.to ?? null,
    created: r.contractAddress ?? null,
    block: Number(BigInt(r.blockNumber)),
    blockTime: Number(BigInt(block.timestamp)),
    status: r.status,
    type: tx.type,
    gasLimit: gasLimit.toString(),
    gasUsed: gasUsed.toString(),
    baseFeeWei: BigInt(block.baseFeePerGas ?? 0).toString(),
    maxFeePerGasWei: BigInt(tx.maxFeePerGas ?? tx.gasPrice).toString(),
    maxPriorityFeePerGasWei: BigInt(tx.maxPriorityFeePerGas ?? 0).toString(),
    effectiveGasPriceWei: price.toString(),
    paidWei: (gasUsed * price).toString(),
  };
}

/**
 * The transactions forge broadcast in a script's latest testnet run, labelled
 * from forge's record and measured from the chain.
 * @param {string} url
 * @param {string} scriptFile e.g. "DeployTestnetMarket.s.sol"
 */
export async function broadcastRecords(url, scriptFile) {
  const path = join(MONAD_DIR, "broadcast", scriptFile, String(TESTNET.chainId), "run-latest.json");
  if (!existsSync(path)) return [];
  const run = JSON.parse(readFileSync(path, "utf8"));
  const out = [];
  for (const t of run.transactions) {
    out.push({
      what: t.contractName ?? t.function ?? t.transactionType,
      script: scriptFile,
      ...(await chainTransaction(url, t.hash)),
    });
  }
  return out;
}

/** `label value` lines a forge script printed. @param {string} output @param {string} label */
export function logged(output, label) {
  const m = new RegExp(`${label}\\s+(0x[0-9a-fA-F]+|-?\\d+)`).exec(output);
  if (!m) throw new Error(`forge did not report ${label}`);
  return /** @type {string} */ (m[1]);
}

/** A bytes32 a forge script printed on the line after its label. @param {string} output @param {string} label */
export function loggedBytes32(output, label) {
  const m = new RegExp(`${label}\\s*\\n\\s*(0x[0-9a-fA-F]{64})`).exec(output);
  if (!m) throw new Error(`forge did not report ${label}`);
  return /** @type {string} */ (m[1]);
}
