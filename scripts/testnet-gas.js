// @ts-check
// pnpm testnet:gas [agentId ...]: P2-EC's operator gas script (C-79). On the
// fork gas is topped up by anvil_setBalance; testnet has no such thing, so the
// deployer sends testnet MON to the reveal keeper, the TestnetFeed writer and
// each named agent's funding address (its session key, D-243), each only up to
// its target (D-307's lean budget). Sends nothing to an address already at its
// target. Prints no key and no RPC URL.
import { ConfigError } from "@alpha-agents/config";
import { redact } from "@alpha-agents/devenv";
import { createWalletClient, formatEther, hexToBytes, http, parseEther } from "viem";
import { HDKey, hdKeyToAccount, privateKeyToAccount } from "viem/accounts";
import { loadRootEnv } from "./lib/config.js";
import { TESTNET, assertTestnet, reveal, testnetConfig, testnetRpc } from "./lib/testnet.js";

/** Targets in MON: one reveal batch (0.128 fee and gas), on-demand feed re-dates, a few swaps. */
export const GAS_TARGETS = { keeper: "0.35", feedWriter: "0.15", fundingAddress: "0.5" };

const agentIds = process.argv.slice(2).map((a) => {
  if (!/^[1-9]\d{0,4}$/.test(a)) {
    console.error(`error: "${a}" is not an agent ID`);
    process.exit(2);
  }
  return Number(a);
});

loadRootEnv();
let config;
try {
  config = testnetConfig([
    "TESTNET_DEPLOYER_PRIVATE_KEY",
    "TESTNET_REVEAL_KEEPER_PRIVATE_KEY",
    "TESTNET_FEED_PRIVATE_KEY",
    "TESTNET_FUNDING_ADDRESS_SEED",
  ]);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`error: ${err.message}`);
  process.exit(1);
}
const url = /** @type {import("@alpha-agents/config").Secret} */ (config.rpcUrl).reveal();
const deployer = privateKeyToAccount(
  /** @type {`0x${string}`} */ (reveal(config, "TESTNET_DEPLOYER_PRIVATE_KEY")),
);
const root = HDKey.fromMasterSeed(
  hexToBytes(/** @type {`0x${string}`} */ (reveal(config, "TESTNET_FUNDING_ADDRESS_SEED"))),
);
/** @param {number} id the agent's funding address, as the orchestrator derives it (D-207) */
const fundingAddress = (id) => hdKeyToAccount(root, { path: `m/44'/60'/0'/0/${id}` }).address;
const keyAddress = (/** @type {string} */ name) =>
  privateKeyToAccount(/** @type {`0x${string}`} */ (reveal(config, name))).address;

const targets = [
  {
    label: "reveal keeper",
    address: keyAddress("TESTNET_REVEAL_KEEPER_PRIVATE_KEY"),
    mon: GAS_TARGETS.keeper,
  },
  {
    label: "feed writer",
    address: keyAddress("TESTNET_FEED_PRIVATE_KEY"),
    mon: GAS_TARGETS.feedWriter,
  },
  ...agentIds.map((id) => ({
    label: `agent ${id}'s funding address`,
    address: fundingAddress(id),
    mon: GAS_TARGETS.fundingAddress,
  })),
];

try {
  await assertTestnet(url);
  const chain = {
    id: TESTNET.chainId,
    name: "Monad Testnet",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [] } },
  };
  const wallet = createWalletClient({ account: deployer, chain, transport: http(url) });
  for (const t of targets) {
    const have = BigInt(await testnetRpc(url, "eth_getBalance", [t.address, "latest"]));
    const want = parseEther(t.mon);
    if (have >= want) {
      console.log(`${t.label} ${t.address}: holds ${formatEther(have)} MON, at its target`);
      continue;
    }
    const value = want - have;
    // A plain transfer: Monad charges the gas limit, so it is exactly 21,000.
    const hash = await wallet.sendTransaction({ to: t.address, value, gas: 21_000n });
    let receipt = null;
    for (let i = 0; i < 60 && !receipt; i += 1) {
      receipt = await testnetRpc(url, "eth_getTransactionReceipt", [hash]);
      if (!receipt) await new Promise((r) => setTimeout(r, 1_000));
    }
    if (!receipt || receipt.status !== "0x1")
      throw new Error(`the transfer to ${t.label} ${hash} did not succeed`);
    console.log(`${t.label} ${t.address}: sent ${formatEther(value)} MON (${hash})`);
  }
  const left = BigInt(await testnetRpc(url, "eth_getBalance", [deployer.address, "latest"]));
  console.log(`deployer ${deployer.address} holds ${formatEther(left)} MON`);
} catch (err) {
  const message = err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err);
  console.error(`error: ${redact(message, [url])}`);
  process.exit(1);
}
