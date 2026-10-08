// @ts-check
// Adds a wallet to AccountFactory's beta deposit allowlist on the local fork
// (D-231: adding is instant), so that wallet can open a trading account and
// deposit from the app. Local fork only: it refuses any other RPC.
//
//   pnpm custody:allow 0xYourWallet
import { localForkRpcUrl } from "@alpha-agents/config";
import { NotLocalForkError, addTestDepositor } from "@alpha-agents/devenv";
import { getAddress, isAddress } from "viem";
import { loadRootEnv } from "./lib/config.js";

loadRootEnv();
const [raw] = process.argv.slice(2);
if (!raw || !isAddress(raw, { strict: false })) {
  console.error(
    "error: give the wallet address to allow, such as pnpm custody:allow 0x1234...abcd",
  );
  process.exit(1);
}
const wallet = getAddress(raw);
try {
  const added = await addTestDepositor(localForkRpcUrl(process.env), wallet);
  console.log(
    added
      ? `${wallet} can now open a trading account and deposit on the local fork`
      : `${wallet} was already allowed to deposit on the local fork`,
  );
} catch (err) {
  if (err instanceof NotLocalForkError) {
    console.error(`error: ${err.message} Start it with pnpm dev:up.`);
    process.exit(1);
  }
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
