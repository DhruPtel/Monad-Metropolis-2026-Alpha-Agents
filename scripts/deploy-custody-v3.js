// @ts-check
// Deploys AccountFactoryV3 and the PersonalAccountV3 implementation (F-U3) to
// the local fork, beside the v1 and v2 custody sets and the fund agent's v3 set:
//
//   pnpm deploy:custody-v3      the local fork (needs the v3 set: pnpm deploy:fund)
//
// Testnet and mainnet are refused: no unit has authorized deploying the custody core v3 there.
import { NotLocalForkError } from "@alpha-agents/devenv";
import { loadRootEnv } from "./lib/config.js";
import { deployCustodyV3Local } from "./lib/custody-v3.js";

const target = process.argv[2] ?? "local";
loadRootEnv();
try {
  if (target !== "local") {
    console.error(
      `error: only the local fork is supported (got "${target}"); testnet and mainnet are refused`,
    );
    process.exit(1);
  }
  await deployCustodyV3Local();
} catch (err) {
  if (err instanceof NotLocalForkError) {
    console.error(`error: ${err.message} Start it with pnpm dev:up.`);
    process.exit(1);
  }
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
