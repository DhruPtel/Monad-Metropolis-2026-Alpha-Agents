// @ts-check
// Deploys the fund agent's v3 set (F-U2) to the local fork beside v1 and v2:
//
//   pnpm deploy:fund      the local fork (needs pnpm dev:all for the screens)
//
// Testnet and mainnet are refused: no unit has authorized deploying the v3 set there.
import { NotLocalForkError } from "@alpha-agents/devenv";
import { loadRootEnv } from "./lib/config.js";
import { deployFundLocal } from "./lib/fund.js";

const target = process.argv[2] ?? "local";
loadRootEnv();
try {
  if (target !== "local") {
    console.error(
      `error: only the local fork is supported (got "${target}"); testnet and mainnet are refused`,
    );
    process.exit(1);
  }
  await deployFundLocal();
} catch (err) {
  if (err instanceof NotLocalForkError) {
    console.error(`error: ${err.message} Start it with pnpm dev:up.`);
    process.exit(1);
  }
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
