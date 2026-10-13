// @ts-check
// M-FAST: deploys the current trading set on the Base fork (pnpm base:fork:up
// first): AgentNFT as the fork-only stand-in for the Monad identity (the
// ownership mirror is M-U1's), the fund set seeded with Base's class F tokens
// and core pools (the deploy-time screen is Monad's and is skipped on this
// throwaway fork, A-98), Executor v3 with its set, AccountFactoryV3 with both
// implementations and the binding. Every address is written to
// evidence/m-fast/base-deployment.json with its code size, and printed as the
// address book block to paste. Local fork only; the owner's playtest wallets
// are allowlisted as on the Monad fork.
//
//   pnpm base:deploy
process.env.FORK_ENV = "base";
const { mkdirSync, writeFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { createPublicClient, http } = await import("viem");
const { rpc } = await import("@alpha-agents/devenv");
const { loadRootEnv, ANVIL_URL, readBaseForkConfig } = await import("./lib/config.js");
const { ROOT } = await import("./lib/paths.js");
const { deployLocal: deployAgentNftLocal } = await import("./lib/agent-nft.js");
const { deployFundLocal } = await import("./lib/fund.js");
const { deployExecutorV3Local } = await import("./lib/executor-v3.js");

loadRootEnv();
const client = createPublicClient({ transport: http(ANVIL_URL) });
const chainId = await client.getChainId();
if (chainId !== 84538453)
  throw new Error(
    `the fork on ${ANVIL_URL} answers chain ${chainId}, not the Base fork's 84538453`,
  );
let startBlock = Number(await client.getBlockNumber());
console.log(`Base fork on ${ANVIL_URL} (chain ${chainId}) at block ${startBlock}`);
// forge reads the fork's latest block to set its environment, and the pinned Base block holds
// OP Stack deposit transactions it cannot convert; one empty block of our own clears that.
const { blockNumber: pinned } = readBaseForkConfig();
if (startBlock <= pinned) {
  await rpc(ANVIL_URL, "evm_mine", []);
  startBlock = Number(await client.getBlockNumber());
  console.log(`   mined one empty block past the pin: head ${startBlock}`);
}

console.log("\n1. AgentNFT (the fork-only ownership stand-in)");
const agentNft = await deployAgentNftLocal({ quiet: true });
console.log(`   AgentNFT ${agentNft}`);

console.log(
  "\n2. The fund set: TokenRegistry, ProtocolRegistryV3, OracleAdapterV3, RouteAdapter (screens skipped on the demo fork)",
);
const fund = await deployFundLocal({ skipScreens: true });
for (const line of fund.screens) console.log(`   ${line}`);
console.log(`   TokenRegistry ${fund.tokenRegistry} (${fund.coreTokens} core tokens)`);
console.log(`   ProtocolRegistryV3 ${fund.protocolRegistry} (${fund.corePools} core pools)`);
console.log(`   OracleAdapterV3 ${fund.oracle}`);
console.log(`   RouteAdapter ${fund.routeAdapter}`);

console.log("\n3. Executor v3 and its set, AccountFactoryV3 and the binding");
const set = await deployExecutorV3Local({ quiet: true, tokenRegistry: fund.tokenRegistry });
console.log(`   Executor v3 ${set.executor}`);
console.log(
  `   RouteAdapter ${set.routeAdapter}, ProtocolRegistryV3 ${set.protocolRegistry} (${set.corePools} core pools${set.leftOut ? `, ${set.leftOut} left out` : ""}), OracleAdapterV3 ${set.oracle}`,
);
console.log(
  `   AccountFactoryV3 ${set.factory}, PersonalAccountV3 ${set.implementation}, StrategyVaultV3 ${set.vaultImplementation}`,
);

// The custody deploy adds the owner's playtest wallets to the deposit allowlist itself (Step 0, 2026-10-12).

/** @param {string} address */
const size = async (address) => {
  const code = await client.getCode({ address: /** @type {`0x${string}`} */ (address) });
  return code ? (code.length - 2) / 2 : 0;
};
const contracts = {
  agent_nft: agentNft,
  token_registry_v3: fund.tokenRegistry,
  route_adapter_v3: fund.routeAdapter,
  executor_v3: set.executor,
  executor_route_adapter_v3: set.routeAdapter,
  protocol_registry_v3: set.protocolRegistry,
  oracle_adapter_v3: set.oracle,
  account_factory_v3: set.factory,
  personal_account_v3_implementation: set.implementation,
  strategy_vault_v3_implementation: set.vaultImplementation,
};
/** @type {Record<string, { address: string, codeSize: number }>} */
const recorded = {};
for (const [id, address] of Object.entries(contracts))
  recorded[id] = { address, codeSize: await size(address) };
const endBlock = Number(await client.getBlockNumber());
const record = {
  unit: "M-FAST",
  chainId,
  forkOf: 8453,
  label:
    "Base fork (anvil), the current trading set with AgentNFT as the fork-only ownership stand-in",
  recordedAt: new Date().toISOString(),
  startBlock,
  endBlock,
  fundSet: { ...fund, screens: undefined },
  fundSetProtocolRegistry: fund.protocolRegistry,
  fundSetOracle: fund.oracle,
  executorSet: {
    setDeployer: set.setDeployer,
    policyHash: set.policyHash,
    corePools: set.corePools,
    leftOut: set.leftOut,
  },
  contracts: recorded,
};
const dir = join(ROOT, "evidence/m-fast");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "base-deployment.json"), `${JSON.stringify(record, null, 2)}\n`);
console.log(
  `\nrecorded in evidence/m-fast/base-deployment.json (blocks ${startBlock} to ${endBlock})`,
);
console.log("\nAddress book facts (id, address, code size):");
for (const [id, r] of Object.entries(recorded))
  console.log(`  ${id.padEnd(36)} ${r.address} ${r.codeSize}`);
