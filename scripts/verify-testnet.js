// @ts-check
// pnpm verify:testnet: verifies every contract of P2-EC's testnet deployment
// on Sourcify (D-256), which MonadVision reads. For each CREATE2 deployment it
// takes the init code from the creation transaction, checks that our compiled
// creation code is its prefix (the bytes on chain are ours, BUILD_PLAN 8
// lesson 8), passes the rest as the constructor arguments, and reads the match
// back from Sourcify. Writes evidence/p2-ec/verification.json.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "@alpha-agents/devenv";
import { encodeAbiParameters, getCreate2Address, keccak256, slice } from "viem";
import { loadRootEnv } from "./lib/config.js";
import { MONAD_DIR, ROOT } from "./lib/paths.js";
import { TESTNET, assertTestnet, testnetRpc } from "./lib/testnet.js";

const CREATE2_FACTORY = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const SOURCIFY = "https://sourcify.dev/server";

loadRootEnv();
const url = process.env.MONAD_TESTNET_RPC_URL?.trim();
if (!url) {
  console.error("error: MONAD_TESTNET_RPC_URL is not set in .env");
  process.exit(1);
}
const rpcUrl = url;
const record = JSON.parse(readFileSync(join(ROOT, "evidence/p2-ec/deployment.json"), "utf8"));

/** Every deployed contract: its source and address. */
const contracts = [
  ["TestnetFeed MON/USD", "script/TestnetFeed.sol:TestnetFeed", record.market.monUsdFeed],
  ["TestnetFeed USDC/USD", "script/TestnetFeed.sol:TestnetFeed", record.market.usdcUsdFeed],
  ["PoolSeeder", "script/PoolSeeder.sol:PoolSeeder", record.market.seeder],
  ["AgentNFT", "src/AgentNFT.sol:AgentNFT", record.agentNft],
  ["OracleAdapter", "src/oracle/OracleAdapter.sol:OracleAdapter", record.custody.oracleAdapter],
  ["Executor", "src/executor/Executor.sol:Executor", record.custody.executor],
  [
    "UniswapV4MonUsdcAdapter",
    "src/venues/UniswapV4MonUsdcAdapter.sol:UniswapV4MonUsdcAdapter",
    record.custody.venueV4,
  ],
  [
    "ProtocolRegistry",
    "src/executor/ProtocolRegistry.sol:ProtocolRegistry",
    record.custody.protocolRegistry,
  ],
  [
    "AccountFactory",
    "src/custody/AccountFactory.sol:AccountFactory",
    record.custody.accountFactory,
  ],
  [
    "PersonalAccount implementation",
    "src/custody/PersonalAccount.sol:PersonalAccount",
    record.custody.personalAccountImplementation,
  ],
];

/** @param {string} id e.g. "src/AgentNFT.sol:AgentNFT" */
function creationCode(id) {
  const [path, name] = id.split(":");
  const file = /** @type {string} */ (path).split("/").pop();
  const artifact = JSON.parse(
    readFileSync(join(MONAD_DIR, "out", `${file}`, `${name}.json`), "utf8"),
  );
  return /** @type {`0x${string}`} */ (artifact.bytecode.object);
}

/** CREATE2 creations by the deterministic factory, keyed by the address each made. */
async function create2Inits() {
  /** @type {Map<string, { hash: string, init: `0x${string}` }>} */
  const inits = new Map();
  for (const t of record.transactions) {
    if (t.to?.toLowerCase() !== CREATE2_FACTORY) continue;
    const tx = await testnetRpc(rpcUrl, "eth_getTransactionByHash", [t.hash]);
    const input = /** @type {`0x${string}`} */ (tx.input);
    const salt = slice(input, 0, 32);
    const init = slice(input, 32);
    const address = getCreate2Address({
      from: CREATE2_FACTORY,
      salt,
      bytecodeHash: keccak256(init),
    });
    inits.set(address.toLowerCase(), { hash: t.hash, init });
  }
  return inits;
}

/** @param {string} address */
async function sourcifyMatch(address) {
  const res = await fetch(`${SOURCIFY}/v2/contract/${TESTNET.chainId}/${address}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return null;
  const body = /** @type {{ match?: string, creationMatch?: string, runtimeMatch?: string }} */ (
    await res.json()
  );
  return {
    match: body.match ?? null,
    creationMatch: body.creationMatch ?? null,
    runtimeMatch: body.runtimeMatch ?? null,
  };
}

try {
  await assertTestnet(url);
  const inits = await create2Inits();
  const results = [];
  for (const [label, id, address] of contracts) {
    let args;
    let creation = null;
    const found = inits.get(address.toLowerCase());
    if (found) {
      const code = creationCode(id);
      if (!found.init.toLowerCase().startsWith(code.toLowerCase())) {
        throw new Error(
          `${label}: the init code on chain does not start with our compiled creation code`,
        );
      }
      args = `0x${found.init.slice(code.length)}`;
      creation = found.hash;
    } else if (label === "PersonalAccount implementation") {
      // Created by AccountFactory's constructor with (AgentNFT, USDC, WMON).
      args = encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "address" }],
        [record.agentNft, TESTNET.usdc, TESTNET.wmon],
      );
      creation = inits.get(record.custody.accountFactory.toLowerCase())?.hash ?? null;
    } else {
      throw new Error(`${label}: no creation transaction recorded`);
    }
    console.log(`\n${label} ${address}`);
    const forge = spawnSync(
      "forge",
      [
        "verify-contract",
        address,
        id,
        "--chain",
        String(TESTNET.chainId),
        "--verifier",
        "sourcify",
        "--constructor-args",
        args,
        "--watch",
      ],
      { cwd: MONAD_DIR, encoding: "utf8", env: process.env },
    );
    const out = redact(`${forge.stdout ?? ""}${forge.stderr ?? ""}`, [url]);
    console.log(out.trim().split("\n").slice(-4).join("\n"));
    const match = await sourcifyMatch(address);
    results.push({
      label,
      source: id,
      address,
      creationTransaction: creation,
      constructorArgs: args,
      forgeExitCode: forge.status,
      sourcify: match,
      sourcifyLink: `https://repo.sourcify.dev/${TESTNET.chainId}/${address}`,
      explorerLink: `${TESTNET.explorer}/address/${address}`,
    });
    console.log(
      `sourcify: ${match ? `${match.match} (creation ${match.creationMatch}, runtime ${match.runtimeMatch})` : "not found"}`,
    );
  }
  const file = join(ROOT, "evidence/p2-ec/verification.json");
  writeFileSync(
    file,
    `${JSON.stringify({ chainId: TESTNET.chainId, verifiedAt: new Date().toISOString(), results }, null, 2)}\n`,
  );
  const failed = results.filter((r) => !r.sourcify?.match);
  console.log(
    `\n${results.length - failed.length} of ${results.length} verified on Sourcify; recorded in ${file}`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
} catch (err) {
  console.error(`error: ${redact(err instanceof Error ? err.message : String(err), [url])}`);
  process.exit(1);
}
