// @ts-check
// Deploys Executor v3 and its set (F-U4) to the local fork, beside the F-U2 and
// F-U3 sets: the Executor, its registered RouteAdapter and ProtocolRegistryV3,
// an OracleAdapterV3 over it, AccountFactoryV3 again with the Executor given,
// and the binding:
//
//   pnpm deploy:executor-v3      the local fork (needs pnpm deploy:fund first)
//
// Testnet and mainnet are refused: no unit has authorized deploying Executor v3 there.
import { NotLocalForkError } from "@alpha-agents/devenv";
import { loadRootEnv } from "./lib/config.js";
import { deployExecutorV3Local } from "./lib/executor-v3.js";

const target = process.argv[2] ?? "local";
loadRootEnv();
try {
  if (target !== "local") {
    console.error(
      `error: only the local fork is supported (got "${target}"); testnet and mainnet are refused`,
    );
    process.exit(1);
  }
  await deployExecutorV3Local();
} catch (err) {
  if (err instanceof NotLocalForkError) {
    console.error(`error: ${err.message} Start it with pnpm dev:up.`);
    process.exit(1);
  }
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
