// @ts-check
// Deploys AccountFactory and the PersonalAccount implementation (P2-U1) to the
// local fork, deploying AgentNFT first if the fork has none.
//
//   pnpm deploy:account-factory      the local fork (needs pnpm dev:up)
//
// Testnet and mainnet are refused: no unit has authorized deploying custody there.
import { NotLocalForkError } from "@alpha-agents/devenv";
import { deployAccountFactoryLocal } from "./lib/account-factory.js";
import { loadRootEnv } from "./lib/config.js";

const target = process.argv[2] ?? "local";
loadRootEnv();
try {
  if (target !== "local") {
    console.error(
      `error: only the local fork is supported (got "${target}"); testnet and mainnet are refused`,
    );
    process.exit(1);
  }
  await deployAccountFactoryLocal();
} catch (err) {
  if (err instanceof NotLocalForkError) {
    console.error(`error: ${err.message} Start it with pnpm dev:up.`);
    process.exit(1);
  }
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
