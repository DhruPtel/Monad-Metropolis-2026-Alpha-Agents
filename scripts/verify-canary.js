// @ts-check
// pnpm verify:canary: verifies every contract of the P2-EC mainnet canary on
// Sourcify (D-256, D-316: Sourcify only), which MonadVision reads
// (scripts/lib/sourcify.js). Reads only; writes evidence/p2-ec/canary-verification.json.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MONAD_MAINNET_CHAIN_ID } from "@alpha-agents/config";
import { redact } from "@alpha-agents/devenv";
import { encodeAbiParameters } from "viem";
import { CANARY_EXPLORER, assertMainnet, canaryBook } from "./lib/canary.js";
import { loadRootEnv } from "./lib/config.js";
import { ROOT } from "./lib/paths.js";
import { verifyOnSourcify } from "./lib/sourcify.js";

loadRootEnv();
const url = process.env.MONAD_RPC_URL?.trim();
if (!url) {
  console.error("error: MONAD_RPC_URL is not set in .env");
  process.exit(1);
}
const record = JSON.parse(
  readFileSync(join(ROOT, "evidence/p2-ec/canary-deployment.json"), "utf8"),
);
const c = record.custody;

try {
  await assertMainnet(url);
  const results = await verifyOnSourcify({
    url,
    chainId: MONAD_MAINNET_CHAIN_ID,
    explorer: CANARY_EXPLORER,
    transactions: record.transactions,
    contracts: [
      {
        label: "CanaryAgent",
        id: "script/CanaryAgent.sol:CanaryAgent",
        address: record.canaryAgent,
      },
      {
        label: "OracleAdapter",
        id: "src/oracle/OracleAdapter.sol:OracleAdapter",
        address: c.oracleAdapter,
      },
      { label: "Executor", id: "src/executor/Executor.sol:Executor", address: c.executor },
      {
        label: "UniswapV4MonUsdcAdapter",
        id: "src/venues/UniswapV4MonUsdcAdapter.sol:UniswapV4MonUsdcAdapter",
        address: c.venueV4,
      },
      {
        label: "UniswapV3UsdcWmonAdapter",
        id: "src/venues/UniswapV3UsdcWmonAdapter.sol:UniswapV3UsdcWmonAdapter",
        address: c.venueV3,
      },
      {
        label: "ProtocolRegistry",
        id: "src/executor/ProtocolRegistry.sol:ProtocolRegistry",
        address: c.protocolRegistry,
      },
      {
        label: "AccountFactory",
        id: "src/custody/AccountFactory.sol:AccountFactory",
        address: c.accountFactory,
      },
      {
        label: "PersonalAccount implementation",
        id: "src/custody/PersonalAccount.sol:PersonalAccount",
        address: c.personalAccountImplementation,
        // Created by AccountFactory's constructor with (CanaryAgent, USDC, WMON).
        args: encodeAbiParameters(
          [{ type: "address" }, { type: "address" }, { type: "address" }],
          [record.canaryAgent, canaryBook("usdc"), canaryBook("wmon")],
        ),
        createdBy: c.accountFactory,
      },
    ],
  });
  const file = join(ROOT, "evidence/p2-ec/canary-verification.json");
  writeFileSync(
    file,
    `${JSON.stringify({ chainId: MONAD_MAINNET_CHAIN_ID, verifiedAt: new Date().toISOString(), results }, null, 2)}\n`,
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
