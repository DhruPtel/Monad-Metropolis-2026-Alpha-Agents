// @ts-check
// pnpm testnet:depositors once | watch (HOST-U1, D-383): every wallet that
// owns an agent on testnet joins the AccountFactoryV3 depositor allowlist, so
// a new wallet that minted can open a trading account within the testnet
// caps. The factory's allowlist can only be switched off through its
// timelock, so the factory's owner (the testnet deployer) adds depositors one
// by one as the indexer records their agents. Reads the agents from the
// testnet database and the allowlist from the chain; sends nothing for a
// wallet already allowed. Prints no key and no RPC URL.
import { ConfigError } from "@alpha-agents/config";
import { createDb } from "@alpha-agents/db";
import { addressEntry } from "@alpha-agents/domain";
import {
  createPublicClient,
  createWalletClient,
  fallback,
  formatEther,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadRootEnv } from "./lib/config.js";
import { TESTNET, reveal, testnetConfig } from "./lib/testnet.js";

const FACTORY_ABI = parseAbi([
  "function isAllowlisted(address) view returns (bool)",
  "function allowlistEnabled() view returns (bool)",
  "function addDepositor(address depositor)",
]);
const EVERY_MS = 30_000;
const mode = process.argv[2];
if (mode !== "once" && mode !== "watch") {
  console.error("usage: node scripts/testnet-depositors.js once | watch");
  process.exit(2);
}

loadRootEnv();
// Run beside the stack from the root .env: the testnet database is the local server's
// alpha_agents_testnet, as scripts/testnet-stack.js names it.
if (process.env.APP_ENV !== "testnet")
  process.env.DATABASE_URL = (
    process.env.DATABASE_URL ?? "postgres://alpha:alpha_local_dev_only@127.0.0.1:5432/alpha_agents"
  ).replace(/alpha_agents$/, "alpha_agents_testnet");
let config;
try {
  config = testnetConfig(["TESTNET_DEPLOYER_PRIVATE_KEY", "DATABASE_URL"]);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`error: ${err.message}`);
  process.exit(1);
}
const url = /** @type {import("@alpha-agents/config").Secret} */ (config.rpcUrl).reveal();
const deployer = privateKeyToAccount(
  /** @type {`0x${string}`} */ (reveal(config, "TESTNET_DEPLOYER_PRIVATE_KEY")),
);
const factoryEntry = addressEntry("testnet", "account_factory_v3");
if (factoryEntry.status !== "verified")
  throw new Error("the address book has no testnet AccountFactoryV3");
const factory = getAddress(factoryEntry.address);
const chain = {
  id: TESTNET.chainId,
  name: TESTNET.chainId === 10143 ? "Monad Testnet" : "testnet",
  nativeCurrency:
    TESTNET.chainId === 10143
      ? { name: "MON", symbol: "MON", decimals: 18 }
      : { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [] } },
};
// Both providers with retries: the testnet primary answers 429 under the stack's load (L-258).
// CO-U1: the secondary is a Monad provider, so only Monad testnet uses it; on an L2 a fallback
// to it sent the add to the wrong chain, where it never mined.
const secondary =
  TESTNET.chainId !== 10143
    ? null
    : /** @type {import("@alpha-agents/config").Secret | undefined} */ ((
        config.values.MONAD_RPC_URL_SECONDARY ?? config.values.MONAD_TESTNET_RPC_URL_SECONDARY
      )?.reveal() ?? null);
const transport = fallback(
  [url, ...(secondary ? [secondary] : [])].map((u) => http(u, { retryCount: 4, retryDelay: 500 })),
);
const client = createPublicClient({ chain, transport });
const wallet = createWalletClient({ account: deployer, chain, transport });
const db = createDb(
  /** @type {import("@alpha-agents/config").Secret} */ (config.values.DATABASE_URL).reveal(),
  { max: 1 },
);
const say = (/** @type {string} */ line) =>
  console.log(`${new Date().toISOString()} depositors: ${line}`);

/** @returns {Promise<`0x${string}`[]>} every owner of an agent on testnet, as the indexer records them */
async function owners() {
  const rows = await db
    .selectFrom("indexer.agents")
    .select("owner")
    .where("chain_id", "=", TESTNET.chainId)
    .distinct()
    .execute();
  return rows.map((r) => getAddress(/** @type {string} */ (r.owner)));
}

async function pass() {
  const enabled = await client.readContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: "allowlistEnabled",
  });
  if (!enabled) {
    say("the factory's allowlist is off; nothing to add");
    return 0;
  }
  let added = 0;
  for (const owner of await owners()) {
    const allowed = await client.readContract({
      address: factory,
      abi: FACTORY_ABI,
      functionName: "isAllowlisted",
      args: [owner],
    });
    if (allowed) continue;
    // 2026-10-14: Monad charges the whole gas limit, so name a short balance plainly instead of
    // the provider's "Missing or invalid parameters".
    const [gas, price, balance] = await Promise.all([
      client.estimateContractGas({
        account: deployer,
        address: factory,
        abi: FACTORY_ABI,
        functionName: "addDepositor",
        args: [owner],
      }),
      client.getGasPrice(),
      client.getBalance({ address: deployer.address }),
    ]);
    if (balance < gas * price) {
      say(
        `${owner} waits: the deployer ${deployer.address} holds ${formatEther(balance)} MON and one add costs ${formatEther(gas * price)} MON`,
      );
      break;
    }
    const hash = await wallet.writeContract({
      address: factory,
      abi: FACTORY_ABI,
      functionName: "addDepositor",
      args: [owner],
    });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
    say(`${owner} added as a depositor: ${hash} ${receipt.status} (gas ${receipt.gasUsed})`);
    added += 1;
  }
  return added;
}

const chainId = await client.getChainId();
if (chainId !== TESTNET.chainId)
  throw new Error(`the providers serve chain ${chainId}, not testnet`);
say(
  `factory ${factory}, owner ${deployer.address}; ${mode === "watch" ? `every ${EVERY_MS / 1000} s` : "one pass"}`,
);
for (;;) {
  try {
    const n = await pass();
    if (mode === "once") {
      say(`${n} depositor${n === 1 ? "" : "s"} added`);
      break;
    }
  } catch (err) {
    say(`pass failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    if (mode === "once") process.exit(1);
  }
  await new Promise((r) => setTimeout(r, EVERY_MS));
}
await db.destroy();
