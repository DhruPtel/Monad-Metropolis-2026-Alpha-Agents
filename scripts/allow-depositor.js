// @ts-check
// Adds a wallet to the beta deposit allowlists on the local fork (D-231:
// adding is instant): the v2 AccountFactory's and, where the fund agent's set
// is deployed, AccountFactoryV3's, which the app opens accounts on (A-80). So
// that wallet can open a trading account and deposit from the app. Local
// fork only: it refuses any other RPC, and it sends as the factory's admin,
// never as the wallet.
//
//   pnpm custody:allow 0xYourWallet
import { localForkRpcUrl } from "@alpha-agents/config";
import { NotLocalForkError, addTestDepositorEverywhere } from "@alpha-agents/devenv";
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
  const added = await addTestDepositorEverywhere(localForkRpcUrl(process.env), wallet);
  const say = (added, name) =>
    added === null
      ? `${name}: not deployed on this fork`
      : added
        ? `${name}: added`
        : `${name}: already allowed`;
  console.log(
    `${wallet} on the local fork's deposit allowlists: ${say(added.v2, "AccountFactory (v2)")}; ${say(added.v3, "AccountFactoryV3")}`,
  );
} catch (err) {
  if (err instanceof NotLocalForkError) {
    console.error(`error: ${err.message} Start it with pnpm dev:up.`);
    process.exit(1);
  }
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
