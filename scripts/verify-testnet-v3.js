// @ts-check
// pnpm verify:testnet:v3: verifies every contract of F-U13's testnet v3
// deployment on Sourcify (D-256), which MonadVision reads
// (scripts/lib/sourcify.js): the two testnet tokens with their feeds, the new
// AgentNFT, the fund set, Executor v3 and its set, AccountFactoryV3 with its
// two implementations, and the AttestationVerifier. The CREATE2 deployments
// give their init code from their creation transaction; the four contracts
// made inside a constructor take theirs from forge's broadcast record of the
// same run, checked against our compiled creation code. Reads only; writes
// evidence/f-u13/testnet-verification.json.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "@alpha-agents/devenv";
import { loadRootEnv } from "./lib/config.js";
import { MONAD_DIR, ROOT } from "./lib/paths.js";
import { sourcifyMatch, verifyOnSourcify } from "./lib/sourcify.js";
import { TESTNET, assertTestnet } from "./lib/testnet.js";

loadRootEnv();
const url = process.env.MONAD_TESTNET_RPC_URL?.trim();
if (!url) {
  console.error("error: MONAD_TESTNET_RPC_URL is not set in .env");
  process.exit(1);
}
/** The deployment record to verify: evidence/f-u13's unless `--evidence <dir>` names another unit's. */
const EVIDENCE_DIR = join(
  ROOT,
  process.argv.includes("--evidence")
    ? /** @type {string} */ (process.argv[process.argv.indexOf("--evidence") + 1])
    : "evidence/f-u13",
);
const record = JSON.parse(readFileSync(join(EVIDENCE_DIR, "testnet-deployment.json"), "utf8"));

/** @param {string} id e.g. "src/fund/RouteAdapter.sol:RouteAdapter" */
function creationCode(id) {
  const [path, name] = id.split(":");
  const file = /** @type {string} */ (path).split("/").pop();
  return /** @type {string} */ (
    JSON.parse(readFileSync(join(MONAD_DIR, "out", `${file}`, `${name}.json`), "utf8")).bytecode
      .object
  );
}

/**
 * The constructor arguments of a contract another contract created, from the
 * broadcast record of the script that sent the creating transaction.
 * @param {string} script @param {string} address @param {string} id
 */
function argsFromBroadcast(script, address, id) {
  const run = JSON.parse(
    readFileSync(
      join(MONAD_DIR, "broadcast", script, String(TESTNET.chainId), "run-latest.json"),
      "utf8",
    ),
  );
  for (const t of run.transactions) {
    for (const a of t.additionalContracts ?? []) {
      if (a.address.toLowerCase() !== address.toLowerCase()) continue;
      const init = /** @type {string} */ (a.initCode);
      const code = creationCode(id);
      if (!init.toLowerCase().startsWith(code.toLowerCase()))
        throw new Error(
          `${id} at ${address}: the recorded init code does not start with our creation code`,
        );
      return {
        args: /** @type {`0x${string}`} */ (`0x${init.slice(code.length)}`),
        createdBy: /** @type {string} */ (t.contractAddress),
        hash: /** @type {string} */ (t.hash),
      };
    }
  }
  throw new Error(`${id} at ${address}: not in ${script}'s broadcast record`);
}

try {
  await assertTestnet(url);
  const txs = record.transactions;
  // A partial record (a guard stop, NFT-U2) names only what is on chain: the
  // rest is skipped here and verified when the run completes.
  const has = (/** @type {string | undefined} */ a) => typeof a === "string" && a.length === 42;
  const fromBroadcast = (
    /** @type {string} */ script,
    /** @type {string | undefined} */ address,
    /** @type {string} */ id,
  ) => (has(address) ? argsFromBroadcast(script, /** @type {string} */ (address), id) : null);
  const created = {
    executorRouteAdapter: fromBroadcast(
      "DeployExecutorV3.s.sol",
      record.executorV3?.routeAdapter,
      "src/fund/RouteAdapter.sol:RouteAdapter",
    ),
    executorRegistry: fromBroadcast(
      "DeployExecutorV3.s.sol",
      record.executorV3?.protocolRegistry,
      "src/fund/ProtocolRegistryV3.sol:ProtocolRegistryV3",
    ),
    personalAccount: fromBroadcast(
      "DeployCustodyV3.s.sol",
      record.custodyV3?.personalAccountImplementation,
      "src/fund/PersonalAccountV3.sol:PersonalAccountV3",
    ),
    vault: fromBroadcast(
      "DeployCustodyV3.s.sol",
      record.custodyV3?.vaultImplementation,
      "src/fund/StrategyVaultV3.sol:StrategyVaultV3",
    ),
  };
  for (const [what, c] of Object.entries(created))
    if (
      c &&
      !txs.some(
        (/** @type {{ hash: string }} */ t) => t.hash.toLowerCase() === c.hash.toLowerCase(),
      )
    )
      throw new Error(
        `${what}: its creating transaction ${c.hash} is not in the deployment record`,
      );

  /** @type {any[]} */
  const wanted = /** @type {any[]} */ ([
    {
      label: "TestnetToken TALPHA",
      id: "script/TestnetToken.sol:TestnetToken",
      address: record.tokens?.alpha?.token,
    },
    {
      label: "TestnetFeed TALPHA/USD",
      id: "script/TestnetFeed.sol:TestnetFeed",
      address: record.tokens?.alpha?.feed,
    },
    {
      label: "TestnetToken TBETA",
      id: "script/TestnetToken.sol:TestnetToken",
      address: record.tokens?.beta?.token,
    },
    {
      label: "TestnetFeed TBETA/USD",
      id: "script/TestnetFeed.sol:TestnetFeed",
      address: record.tokens?.beta?.feed,
    },
    { label: "AgentNFT", id: "src/AgentNFT.sol:AgentNFT", address: record.agentNft },
    {
      label: "TokenRegistry",
      id: "src/fund/TokenRegistry.sol:TokenRegistry",
      address: record.fund?.tokenRegistry,
    },
    {
      label: "ProtocolRegistryV3 (fund set)",
      id: "src/fund/ProtocolRegistryV3.sol:ProtocolRegistryV3",
      address: record.fund?.protocolRegistry,
    },
    {
      label: "OracleAdapterV3 (fund set)",
      id: "src/fund/OracleAdapterV3.sol:OracleAdapterV3",
      address: record.fund?.oracle,
    },
    {
      label: "RouteAdapter (fund set)",
      id: "src/fund/RouteAdapter.sol:RouteAdapter",
      address: record.fund?.routeAdapter,
    },
    {
      label: "ExecutorV3",
      id: "src/fund/ExecutorV3.sol:ExecutorV3",
      address: record.executorV3?.executor,
    },
    {
      label: "ExecutorSetDeployer",
      id: "script/ExecutorSetDeployer.sol:ExecutorSetDeployer",
      address: record.executorV3?.setDeployer,
    },
    {
      label: "RouteAdapter (Executor v3's)",
      id: "src/fund/RouteAdapter.sol:RouteAdapter",
      address: record.executorV3?.routeAdapter,
      args: created.executorRouteAdapter?.args,
      createdBy: created.executorRouteAdapter?.createdBy,
    },
    {
      label: "ProtocolRegistryV3 (Executor v3's)",
      id: "src/fund/ProtocolRegistryV3.sol:ProtocolRegistryV3",
      address: record.executorV3?.protocolRegistry,
      args: created.executorRegistry?.args,
      createdBy: created.executorRegistry?.createdBy,
    },
    {
      label: "OracleAdapterV3 (Executor v3's)",
      id: "src/fund/OracleAdapterV3.sol:OracleAdapterV3",
      address: record.executorV3?.oracle,
    },
    {
      label: "AccountFactoryV3",
      id: "src/fund/AccountFactoryV3.sol:AccountFactoryV3",
      address: record.custodyV3?.factory,
    },
    {
      label: "PersonalAccountV3 implementation",
      id: "src/fund/PersonalAccountV3.sol:PersonalAccountV3",
      address: record.custodyV3?.personalAccountImplementation,
      args: created.personalAccount?.args,
      createdBy: created.personalAccount?.createdBy,
    },
    {
      label: "StrategyVaultV3 implementation",
      id: "src/fund/StrategyVaultV3.sol:StrategyVaultV3",
      address: record.custodyV3?.vaultImplementation,
      args: created.vault?.args,
      createdBy: created.vault?.createdBy,
    },
    {
      label: "AttestationVerifier",
      id: "src/fund/AttestationVerifier.sol:AttestationVerifier",
      address: record.attestation?.verifier,
    },
  ]).filter((c) => has(c.address));
  // A contract Sourcify already holds (an earlier run's, or a set that did not
  // move) is not sent again: a continuation record carries only its own
  // creation transactions.
  /** @type {any[]} */
  const already = [];
  /** @type {any[]} */
  const contracts = [];
  for (const c of wanted) {
    const match = await sourcifyMatch(TESTNET.chainId, c.address);
    if (match?.match) {
      console.log(`${c.label} ${c.address}: already on Sourcify (${match.match})`);
      already.push({
        label: c.label,
        source: c.id,
        address: c.address,
        alreadyVerified: true,
        sourcify: match,
        sourcifyLink: `https://repo.sourcify.dev/${TESTNET.chainId}/${c.address}`,
        explorerLink: `${TESTNET.explorer}/address/${c.address}`,
      });
    } else contracts.push(c);
  }
  const results = [
    ...already,
    ...(await verifyOnSourcify({
      url,
      chainId: TESTNET.chainId,
      explorer: TESTNET.explorer,
      transactions: txs,
      contracts,
    })),
  ];
  const file = join(EVIDENCE_DIR, "testnet-verification.json");
  writeFileSync(
    file,
    `${JSON.stringify({ unit: "F-U13", chainId: TESTNET.chainId, verifiedAt: new Date().toISOString(), results }, null, 2)}\n`,
  );
  const failed = results.filter((r) => !r.sourcify?.match);
  console.log(
    `\n${results.length - failed.length} of ${results.length} verified on Sourcify (${already.length} already there); recorded in ${file}`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
} catch (err) {
  console.error(`error: ${redact(err instanceof Error ? err.message : String(err), [url])}`);
  process.exit(1);
}
