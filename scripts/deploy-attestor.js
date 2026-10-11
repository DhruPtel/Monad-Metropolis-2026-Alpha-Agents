// @ts-check
// Deploys the class A attestation verifier (F-U12) to the local fork and sets
// it in the TokenRegistry through the registry's timelock, moving the fork's
// clock past the 9-day delay:
//
//   pnpm deploy:attestor      the local fork (needs pnpm deploy:fund first)
//
// Testnet and mainnet are refused: no unit has authorized deploying it there.
import { NotLocalForkError } from "@alpha-agents/devenv";
import { deployAttestationVerifierLocal } from "./lib/attestor.js";
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
  await deployAttestationVerifierLocal();
} catch (err) {
  if (err instanceof NotLocalForkError) {
    console.error(`error: ${err.message} Start it with pnpm dev:up.`);
    process.exit(1);
  }
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
