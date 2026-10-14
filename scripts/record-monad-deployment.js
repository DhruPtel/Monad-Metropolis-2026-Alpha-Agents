// @ts-check
// node scripts/record-monad-deployment.js (CO-U1): writes packages/domain/src/deployments/monad.ts
// from the clean Monad testnet redeploy's record (evidence/co-u1-monad/testnet-deployment.json,
// pnpm deploy:testnet:v3 --evidence evidence/co-u1-monad with TESTNET_SALT_SCOPE=co.testnet), with
// each contract's code size from the chain. Prints no key and no RPC URL.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "@alpha-agents/config";
import { keccak256 } from "viem";
import { loadRootEnv } from "./lib/config.js";
import { ROOT } from "./lib/paths.js";
import { TESTNET, testnetConfig, testnetRpc } from "./lib/testnet.js";

loadRootEnv();
let config;
try {
  config = testnetConfig([]);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`error: ${err.message}`);
  process.exit(1);
}
const url = /** @type {import("@alpha-agents/config").Secret} */ (config.rpcUrl).reveal();
const d = JSON.parse(
  readFileSync(join(ROOT, "evidence/co-u1-monad/testnet-deployment.json"), "utf8"),
);
if (d.saltScope !== "co.testnet")
  throw new Error(`the record's salt scope is ${d.saltScope}, not co.testnet`);
const ids = {
  agent_nft: d.agentNft,
  token_registry_v3: d.fund.tokenRegistry,
  route_adapter_v3: d.fund.routeAdapter,
  executor_v3: d.executorV3.executor,
  executor_route_adapter_v3: d.executorV3.routeAdapter,
  protocol_registry_v3: d.executorV3.protocolRegistry,
  oracle_adapter_v3: d.executorV3.oracle,
  account_factory_v3: d.custodyV3.factory,
  personal_account_v3_implementation: d.custodyV3.personalAccountImplementation,
  strategy_vault_v3_implementation: d.custodyV3.vaultImplementation,
};
/** @type {Record<string, { address: string, codeSize: number, codeHash: string }>} */
const contracts = {};
for (const [id, address] of Object.entries(ids)) {
  // The provider rate-limits at times; ask again before giving up.
  let code;
  for (let i = 0; i < 6 && typeof code !== "string"; i++) {
    code = await testnetRpc(url, "eth_getCode", [address, "latest"]).catch(() => undefined);
    if (typeof code !== "string") await new Promise((r) => setTimeout(r, 3_000 * (i + 1)));
  }
  if (typeof code !== "string") throw new Error(`no code read for ${id}`);
  const codeSize = (code.length - 2) / 2;
  if (codeSize === 0) throw new Error(`${id} at ${address} has no code`);
  contracts[id] = { address, codeSize, codeHash: keccak256(code) };
}
const out = { chainId: TESTNET.chainId, block: d.startBlock, contracts, external: {} };
writeFileSync(
  join(ROOT, "packages/domain/src/deployments/monad.ts"),
  `// Written by scripts/record-monad-deployment.js (CO-U1); do not edit by hand.\nexport const DEPLOYMENT = ${JSON.stringify(out, null, 2)} as const;\n`,
);
console.log(
  `recorded ${Object.keys(contracts).length} contracts of the clean redeploy (from block ${d.startBlock})`,
);
