// @ts-check
// The oracle adapter and the circuit breaker on a fork of their own (P2-U3).
// Every command starts a fresh fork of Monad at the pinned block on port 8548
// (never the playtest fork on 8545), deploys AgentNFT, the oracle adapter and
// AccountFactory there, and stops the fork when it is done (or on Ctrl-C with
// --keep).
//
//   pnpm oracle:local prices                      MON/USD, the v4 pool and USDC/USD through the adapter
//   pnpm oracle:local demo [--drops 15,25,40] [--keep]
//       the factory has its oracle from deployment (D-235); values anvil
//       account 6's PersonalAccount (30 USDC and about 40 USDC of WMON), then
//       lowers MON/USD by each drop and pokes, so the breaker trips; ends with
//       a withdrawal while every feed is down.
import { setMonBalance, startTestFork } from "@alpha-agents/devenv";

/** The demo's own port: 8545 is the playtest fork, 8546 the test fork, 8547 the P2-U0 spike. */
const ORACLE_FORK_PORT = 8548;
// Every library below reads the fork's port from here when it loads (D-200, L-100).
process.env.LOCAL_FORK_PORT = String(ORACLE_FORK_PORT);

const { loadRootEnv } = await import("./lib/config.js");
const { deployAccountFactoryLocal } = await import("./lib/account-factory.js");
const custody = await import("./lib/custody.js");
const oracle = await import("./lib/oracle.js");
const { send } = await import("./lib/agent-reveal.js");
const { addressEntry } = await import("@alpha-agents/domain");
const {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  formatUnits,
  http,
  parseAbi,
} = await import("viem");
const { ORACLE_REASONS } = await import("@alpha-agents/policy");
const { ANVIL_URL } = await import("./lib/config.js");

loadRootEnv();
const args = process.argv.slice(2);
const command = args[0] ?? "prices";
const keep = args.includes("--keep");
const dropsFlag = args.indexOf("--drops");
const drops = (dropsFlag === -1 ? "15,25,40" : (args[dropsFlag + 1] ?? ""))
  .split(",")
  .map((d) => Number(d.trim()));
if (
  !["prices", "demo"].includes(command) ||
  drops.some((d) => !Number.isInteger(d) || d < 0 || d >= 100)
) {
  console.error("usage: pnpm oracle:local prices | demo [--drops 15,25,40] [--keep]");
  process.exit(2);
}

const BREAKER_ABI = parseAbi([
  "function poke() returns (uint256 nav, uint256 perUnit, uint256 peak)",
  "function breakerState() view returns (uint256 nav, uint256 perUnit, uint256 peak, uint256 drawdownBps)",
  "function units() view returns (uint256)",
  "function mode() view returns (uint8)",
  "function deposit(address token, uint256 amount)",
  "function withdrawAll(address to)",
  "error DepositsPaused()",
  "error OracleUnavailable(address asset, uint8 reason)",
]);
const WMON_ABI = parseAbi([
  "function deposit() payable",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address who) view returns (uint256)",
]);
const MODES = ["NORMAL", "REDUCE_ONLY", "PAUSED", "HANDOVER", "WIND_DOWN"];
const client = createPublicClient({ transport: http(ANVIL_URL) });
const wmon = /** @type {`0x${string}`} */ (addressEntry("local", "wmon").address);
const usdc6 = (/** @type {bigint} */ v) => formatUnits(v, 6);

/** @param {`0x${string}`} account */
async function breakerLine(account) {
  const [nav, perUnit, peak, drawdown] = await client.readContract({
    address: account,
    abi: BREAKER_ABI,
    functionName: "breakerState",
  });
  const mode = await client.readContract({
    address: account,
    abi: BREAKER_ABI,
    functionName: "mode",
  });
  return `NAV ${usdc6(nav)} USDC, value per unit ${formatUnits(perUnit, 18)}, 7-day peak ${formatUnits(peak, 18)}, drawdown ${Number(drawdown) / 100}%, mode ${MODES[mode]}`;
}

/**
 * The contract's own error, by name, from a failed call.
 * @param {unknown} err
 */
function why(err) {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError && reverted.data) {
      const { errorName, args: errorArgs = [] } = reverted.data;
      if (errorName === "OracleUnavailable")
        return `OracleUnavailable(${errorArgs[0]}, ${ORACLE_REASONS[Number(errorArgs[1])]})`;
      return `${errorName}(${errorArgs.join(", ")})`;
    }
    return err.shortMessage;
  }
  return String(err);
}

/**
 * Simulates first, so a refusal names the contract's error, then sends.
 * @param {`0x${string}`} from
 * @param {any} request
 */
async function call(from, request) {
  await client.simulateContract({ ...request, account: from });
  return send(from, request);
}

/** @param {`0x${string}`} account @param {`0x${string}`} owner */
async function poke(account, owner) {
  const r = await call(owner, {
    address: account,
    abi: BREAKER_ABI,
    functionName: "poke",
    args: [],
  });
  return r.gasUsed;
}

async function demo(/** @type {`0x${string}`} */ factory, /** @type {`0x${string}`} */ adapter) {
  console.log("\n1. Anvil account 6 mints an agent and opens its PersonalAccount.");
  const owner = custody.testOwner(6);
  const nft = /** @type {`0x${string}`} */ (addressEntry("local", "agent_nft").address);
  const agentId = await custody.ownersAgent(nft, owner);
  const { account } = await custody.ensureAccount(factory, agentId, owner);
  console.log(`   agent #${agentId}, PersonalAccount ${account}`);

  console.log(
    "\n2. The factory has its oracle from deployment (D-235). On this fork only, LocalFeed keeps the feeds' last answers fresh (D-237).",
  );
  const answers = await oracle.useFreshFeeds();
  const base = answers.monUsd;
  for (const line of await oracle.describePrices(adapter)) console.log(`   ${line}`);

  console.log("\n3. The owner deposits 30 USDC and about 40 USDC of WMON, and pokes.");
  const usdcGas = (await custody.depositUsdc(account, owner, 30_000_000n)).gasUsed;
  // About 40 USDC of WMON at the current price.
  const wmonAmount = (40_000_000n * 10n ** 30n) / (base * 10n ** 10n);
  // The mint left the owner 100 MON for gas; wrapping needs more.
  await setMonBalance(owner, wmonAmount + 100n * 10n ** 18n, ANVIL_URL);
  await call(owner, {
    address: wmon,
    abi: WMON_ABI,
    functionName: "deposit",
    args: [],
    value: wmonAmount,
  });
  await call(owner, {
    address: wmon,
    abi: WMON_ABI,
    functionName: "approve",
    args: [account, wmonAmount],
  });
  const wmonGas = (
    await call(owner, {
      address: account,
      abi: BREAKER_ABI,
      functionName: "deposit",
      args: [wmon, wmonAmount],
    })
  ).gasUsed;
  const pokeGas = await poke(account, owner);
  console.log(`   ${account}: 30 USDC and ${formatUnits(wmonAmount, 18)} WMON`);
  console.log(`   gas used: USDC deposit ${usdcGas}, WMON deposit ${wmonGas}, poke ${pokeGas}`);
  console.log(`   ${await breakerLine(account)}`);

  console.log("\n4. MON/USD falls; anyone may poke, and the breaker only tightens.");
  for (const d of drops) {
    const answer = (base * BigInt(100 - d)) / 100n;
    await oracle.setMonUsd(answer);
    const gas = await poke(account, owner);
    console.log(
      `   MON ${d}% down ($${formatUnits(answer, 8)}): ${await breakerLine(account)} (poke gas ${gas})`,
    );
  }

  console.log("\n5. A deposit while PAUSED is refused; a withdrawal with every feed down is not.");
  try {
    await client.simulateContract({
      address: account,
      abi: BREAKER_ABI,
      functionName: "deposit",
      args: [wmon, 1n],
      account: owner,
    });
    console.log("   deposit: accepted (the account is not PAUSED)");
  } catch (err) {
    console.log(`   deposit: refused, ${why(err)}`);
  }
  await oracle.setFeedsDown(true);
  try {
    await client.readContract({ address: account, abi: BREAKER_ABI, functionName: "breakerState" });
  } catch (err) {
    console.log(`   valuation: refused, ${why(err)}`);
  }
  const out = await send(owner, {
    address: account,
    abi: BREAKER_ABI,
    functionName: "withdrawAll",
    args: [owner],
  });
  const [units, back] = await Promise.all([
    client.readContract({ address: account, abi: BREAKER_ABI, functionName: "units" }),
    client.readContract({ address: wmon, abi: WMON_ABI, functionName: "balanceOf", args: [owner] }),
  ]);
  console.log(
    `   withdrawAll: done (gas ${out.gasUsed}); the owner holds ${formatUnits(back, 18)} WMON again; units left ${units}`,
  );
}

console.log(
  `starting a fork of its own on port ${ORACLE_FORK_PORT} (the playtest fork is not touched)`,
);
const fork = await startTestFork({ port: ORACLE_FORK_PORT });
// A signal ends the process without running `finally`: stop the fork first (L-22).
const stopAndExit = async () => {
  await fork.stop();
  process.exit(130);
};
process.once("SIGINT", stopAndExit);
process.once("SIGTERM", stopAndExit);
let status = 0;
try {
  const { factory, oracle: adapter } = await deployAccountFactoryLocal({ quiet: true });
  console.log(`deployed AgentNFT, the oracle adapter ${adapter} and AccountFactory ${factory}`);
  console.log("\nPrices through the adapter at the pinned block, as the fork copied them:");
  for (const line of await oracle.describePrices(adapter)) console.log(`  ${line}`);
  if (command === "demo") await demo(factory, adapter);
  if (keep) {
    console.log(`\nThe fork stays up at ${fork.url} until Ctrl-C.`);
    // The signal handlers above stop the fork and exit.
    await new Promise(() => undefined);
  }
} catch (err) {
  status = 1;
  console.error(`error: ${why(err)}`);
} finally {
  await fork.stop();
}
process.exit(status);
