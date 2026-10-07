// @ts-check
// Try PersonalAccount on the local fork (P2-U1). Local fork only: it refuses
// any other RPC, and it acts as one of anvil's public development accounts
// (6 to 9, the local test owners on the allowlist). Deploys AgentNFT and
// AccountFactory first if the fork has none, and mints the owner an agent if
// it has none.
//
//   pnpm custody:local demo [--owner 6]         create, deposit 25 USDC, show, withdraw all, show
//   pnpm custody:local create [--owner 6]       the owner's PersonalAccount for its agent
//   pnpm custody:local deposit 25 [--owner 6]   test USDC into the account (whole USDC, up to the 100 cap)
//   pnpm custody:local withdraw [10] [--owner 6]  some USDC, or every held asset with no amount
//   pnpm custody:local show [--owner 6]
//   pnpm custody:local prices                  MON/USD, the v4 pool and USDC/USD through the oracle adapter
//   pnpm custody:local refresh-feeds           re-date the fork's Chainlink feeds to now (LocalFeed, D-237)
//
// Deposits need fresh feeds (the USDC depeg guard, P2-U3). A deployment has
// its oracle from the start (D-235); the fork's feeds are kept fresh by the
// orchestrator under pnpm dev:all, and this script re-dates them itself
// before anything priced, so it also works without dev:all.
import { NotLocalForkError } from "@alpha-agents/devenv";
import { parseUnits } from "viem";
import { loadRootEnv } from "./lib/config.js";
import { describePrices, useFreshFeeds } from "./lib/oracle.js";
import {
  custodyContracts,
  depositUsdc,
  describeAccount,
  ensureAccount,
  ownersAgent,
  testOwner,
  withdraw,
} from "./lib/custody.js";

loadRootEnv();
const args = process.argv.slice(2);
const ownerFlag = args.indexOf("--owner");
const ownerIndex = ownerFlag === -1 ? 6 : Number(args[ownerFlag + 1]);
const positional =
  ownerFlag === -1 ? args : args.filter((_, i) => i !== ownerFlag && i !== ownerFlag + 1);
const [command = "show", amountArg] = positional;

/** @param {string | undefined} raw */
const usdcAmount = (raw) => {
  if (raw === undefined || !/^\d{1,6}(\.\d{1,6})?$/.test(raw))
    throw new Error("give an amount of USDC, such as 25 or 2.5");
  return parseUnits(raw, 6);
};

try {
  if (command === "prices" || command === "refresh-feeds") {
    const { oracle } = await custodyContracts();
    if (command === "refresh-feeds") {
      await useFreshFeeds();
      console.log("the feeds hold their last answers, dated now");
    }
    for (const line of await describePrices(oracle)) console.log(line);
    process.exit(0);
  }
  const owner = testOwner(ownerIndex);
  const { nft, factory } = await custodyContracts();
  // Fresh feeds before anything priced (local fork only, D-237).
  await useFreshFeeds();
  const agentId = await ownersAgent(nft, owner);
  const { account, created } = await ensureAccount(factory, agentId, owner);
  if (created) console.log(`created PersonalAccount ${account} for agent #${agentId}`);
  const show = async () => {
    for (const line of await describeAccount(factory, account, owner)) console.log(line);
  };
  if (command === "create" || command === "show") await show();
  else if (command === "deposit") {
    const amount = usdcAmount(amountArg);
    const r = await depositUsdc(account, owner, amount);
    console.log(`deposited ${amountArg} USDC (tx ${r.transactionHash})`);
    await show();
  } else if (command === "withdraw") {
    const r = await withdraw(
      account,
      owner,
      amountArg === undefined ? null : usdcAmount(amountArg),
    );
    console.log(
      `withdrew ${amountArg === undefined ? "every held asset" : `${amountArg} USDC`} (tx ${r.transactionHash})`,
    );
    await show();
  } else if (command === "demo") {
    const r = await depositUsdc(account, owner, 25_000_000n);
    console.log(`deposited 25 USDC (tx ${r.transactionHash})`);
    await show();
    const w = await withdraw(account, owner, null);
    console.log(`withdrew every held asset (tx ${w.transactionHash})`);
    await show();
  } else {
    console.error(
      `error: unknown command "${command}"; use demo, create, deposit, withdraw, show, prices or refresh-feeds`,
    );
    process.exit(1);
  }
} catch (err) {
  if (err instanceof NotLocalForkError) {
    console.error(`error: ${err.message} Start it with pnpm dev:up.`);
    process.exit(1);
  }
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
