// @ts-check
// node scripts/record-dev-deployment.js [--fork]: 2026-10-16, writes
// packages/domain/src/deployments/monad-dev.ts from the monad-dev deploy's record
// (evidence/dev-nadfun/deployment.json, or fork-deployment.json with --fork, read on the RPC in
// DEVFORK_RPC), with each contract's code size and hash from the chain and the stack's own USDC
// and WMON (the venue's). Prints no key and no RPC URL.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256 } from "viem";
import { loadRootEnv } from "./lib/config.js";
import { ROOT } from "./lib/paths.js";
import { testnetRpc } from "./lib/testnet.js";

loadRootEnv();
const fork = process.argv.includes("--fork");
const url = (
  fork
    ? process.env.DEVFORK_RPC
    : process.env.MONAD_TESTNET_RPC_URL_SECONDARY || process.env.MONAD_TESTNET_RPC_URL
)?.trim();
if (!url) throw new Error(fork ? "DEVFORK_RPC is not set" : "no Monad testnet RPC is set");
const d = JSON.parse(
  readFileSync(
    join(ROOT, `evidence/dev-nadfun/${fork ? "fork-deployment" : "deployment"}.json`),
    "utf8",
  ),
);
if (d.saltScope !== "co.dev")
  throw new Error(`the record's salt scope is ${d.saltScope}, not co.dev`);
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
const out = {
  chainId: d.chainId,
  block: d.startBlock,
  fork,
  contracts,
  external: { usdc: d.venue.usdc, wmon: d.venue.wmon, v2_factory: d.venue.factory },
};
writeFileSync(
  join(ROOT, "packages/domain/src/deployments/monad-dev.ts"),
  `// Written by scripts/record-dev-deployment.js (2026-10-16); do not edit by hand.\nexport const DEPLOYMENT = ${JSON.stringify(out, null, 2)} as const;\n`,
);
console.log(
  `recorded ${Object.keys(contracts).length} monad-dev contracts${fork ? " (the fork's)" : ""} from block ${d.startBlock}`,
);
