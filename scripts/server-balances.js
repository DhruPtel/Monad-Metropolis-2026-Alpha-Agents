// @ts-check
// node scripts/server-balances.js [--json]: the testnet operator wallets' MON balances against
// their alert floors (docs/HOSTING.md). The monitor on the cloud server runs it every 15 minutes
// and alerts on any wallet marked LOW. Reads the keys from .env to derive addresses only; prints
// addresses and balances, never a key or an RPC URL.
import { ConfigError } from "@alpha-agents/config";
import { createDb, sql } from "@alpha-agents/db";
import { redact } from "@alpha-agents/devenv";
import { formatEther, getAddress, parseEther } from "viem";
import { loadRootEnv } from "./lib/config.js";
import { TESTNET, addressOf, reveal, testnetConfig, testnetRpc } from "./lib/testnet.js";

/**
 * Alert floors in MON. The keeper and the feed writer sit at about a third of their gas targets
 * (scripts/testnet-gas.js); an armed agent's session key, which the signer spends from, below one
 * v3 swap's charge with margin; the deployer, which tops the others up and adds depositors,
 * below two refills of everything.
 */
export const FLOORS = {
  deployer: "2",
  registrar: "0.1",
  attestor: "0.1",
  sentinel: "0.1",
  keeper: "0.15",
  feedWriter: "0.05",
  sessionKey: "0.3",
};

const json = process.argv.includes("--json");
loadRootEnv();
let config;
try {
  config = testnetConfig([
    "TESTNET_DEPLOYER_PRIVATE_KEY",
    "TESTNET_REVEAL_KEEPER_PRIVATE_KEY",
    "TESTNET_FEED_PRIVATE_KEY",
    "TESTNET_SCREENER_PRIVATE_KEY",
    "DATABASE_URL",
  ]);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`error: ${err.message}`);
  process.exit(1);
}
const url = /** @type {import("@alpha-agents/config").Secret} */ (config.rpcUrl).reveal();
const optional = (/** @type {string} */ name) => {
  try {
    return addressOf(reveal(config, name));
  } catch {
    return null;
  }
};

/** @type {{ label: string, address: string, floor: string }[]} */
const wallets = [
  {
    label: "deployer (refills, depositor registrar)",
    address: addressOf(reveal(config, "TESTNET_DEPLOYER_PRIVATE_KEY")),
    floor: FLOORS.deployer,
  },
  {
    label: "token registrar (screener)",
    address: addressOf(reveal(config, "TESTNET_SCREENER_PRIVATE_KEY")),
    floor: FLOORS.registrar,
  },
  {
    label: "reveal keeper",
    address: addressOf(reveal(config, "TESTNET_REVEAL_KEEPER_PRIVATE_KEY")),
    floor: FLOORS.keeper,
  },
  {
    label: "feed writer",
    address: addressOf(reveal(config, "TESTNET_FEED_PRIVATE_KEY")),
    floor: FLOORS.feedWriter,
  },
];
for (const { name, label, floor } of [
  { name: "TESTNET_ATTESTOR_PRIVATE_KEY", label: "attestor", floor: FLOORS.attestor },
  { name: "TESTNET_SENTINEL_PRIVATE_KEY", label: "sentinel", floor: FLOORS.sentinel },
]) {
  const address = optional(name);
  if (address) wallets.push({ label, address, floor });
}

// The signer sends each armed agent's swaps from its session key (D-243), so each pays gas.
const db = createDb(
  /** @type {import("@alpha-agents/config").Secret} */ (config.values.DATABASE_URL).reveal(),
  { max: 1 },
);
try {
  const { rows } = await sql`
    select distinct on (agent_id) agent_id, session_key from platform.arming
    where chain_id = ${TESTNET.chainId} order by agent_id`.execute(db);
  for (const r of /** @type {{ agent_id: number, session_key: string }[]} */ (rows))
    wallets.push({
      label: `signer: agent ${r.agent_id}'s session key`,
      address: getAddress(r.session_key),
      floor: FLOORS.sessionKey,
    });
} finally {
  await db.destroy();
}

const results = [];
try {
  for (const w of wallets) {
    const wei = BigInt(await testnetRpc(url, "eth_getBalance", [w.address, "latest"]));
    results.push({ ...w, mon: formatEther(wei), low: wei < parseEther(w.floor) });
  }
} catch (err) {
  const message = err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err);
  console.error(`error: ${redact(message, [url])}`);
  process.exit(1);
}
if (json) console.log(JSON.stringify(results));
else
  for (const r of results)
    console.log(
      `${r.low ? "LOW " : "ok  "} ${r.label} ${r.address}: ${Number(r.mon).toFixed(4)} MON (alert below ${r.floor})`,
    );
