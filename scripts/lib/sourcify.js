// @ts-check
// Sourcify verification of a P2-EC deployment (D-256), shared by testnet and
// the mainnet canary. For each CREATE2 deployment it takes the init code from
// the creation transaction, checks that our compiled creation code is its
// prefix (the bytes on chain are ours, BUILD_PLAN 8 lesson 8), passes the
// rest as the constructor arguments, and reads the match back from Sourcify.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "@alpha-agents/devenv";
import { getCreate2Address, keccak256, slice } from "viem";
import { MONAD_DIR } from "./paths.js";
import { testnetRpc } from "./testnet.js";

const CREATE2_FACTORY = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const SOURCIFY = "https://sourcify.dev/server";

/** @param {string} id e.g. "src/AgentNFT.sol:AgentNFT" */
function creationCode(id) {
  const [path, name] = id.split(":");
  const file = /** @type {string} */ (path).split("/").pop();
  const artifact = JSON.parse(
    readFileSync(join(MONAD_DIR, "out", `${file}`, `${name}.json`), "utf8"),
  );
  return /** @type {`0x${string}`} */ (artifact.bytecode.object);
}

/** CREATE2 creations by the deterministic factory, keyed by the address each made. @param {string} url @param {readonly { to: string | null, hash: string }[]} transactions */
async function create2Inits(url, transactions) {
  /** @type {Map<string, { hash: string, init: `0x${string}` }>} */
  const inits = new Map();
  for (const t of transactions) {
    if (t.to?.toLowerCase() !== CREATE2_FACTORY) continue;
    const tx = await testnetRpc(url, "eth_getTransactionByHash", [t.hash]);
    const input = /** @type {`0x${string}`} */ (tx.input);
    const salt = slice(input, 0, 32);
    const init = slice(input, 32);
    const address = getCreate2Address({
      from: CREATE2_FACTORY,
      salt,
      bytecodeHash: keccak256(init),
    });
    inits.set(address.toLowerCase(), { hash: t.hash, init });
  }
  return inits;
}

/** @param {number} chainId @param {string} address */
async function sourcifyMatch(chainId, address) {
  const res = await fetch(`${SOURCIFY}/v2/contract/${chainId}/${address}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return null;
  const body = /** @type {{ match?: string, creationMatch?: string, runtimeMatch?: string }} */ (
    await res.json()
  );
  return {
    match: body.match ?? null,
    creationMatch: body.creationMatch ?? null,
    runtimeMatch: body.runtimeMatch ?? null,
  };
}

/**
 * Verifies each contract and returns one result per contract. A contract made
 * by another contract's constructor (the PersonalAccount implementation) gives
 * its constructor arguments and creating contract instead of a transaction.
 * @param {{
 *   url: string,
 *   chainId: number,
 *   explorer: string,
 *   transactions: readonly { to: string | null, hash: string }[],
 *   contracts: readonly { label: string, id: string, address: string, args?: `0x${string}`, createdBy?: string }[],
 * }} o
 */
export async function verifyOnSourcify(o) {
  const inits = await create2Inits(o.url, o.transactions);
  const results = [];
  for (const c of o.contracts) {
    let args;
    let creation;
    const found = inits.get(c.address.toLowerCase());
    if (found) {
      const code = creationCode(c.id);
      if (!found.init.toLowerCase().startsWith(code.toLowerCase()))
        throw new Error(
          `${c.label}: the init code on chain does not start with our compiled creation code`,
        );
      args = `0x${found.init.slice(code.length)}`;
      creation = found.hash;
    } else if (c.args && c.createdBy) {
      args = c.args;
      creation = inits.get(c.createdBy.toLowerCase())?.hash ?? null;
    } else {
      throw new Error(`${c.label}: no creation transaction recorded`);
    }
    console.log(`\n${c.label} ${c.address}`);
    const forge = spawnSync(
      "forge",
      [
        "verify-contract",
        c.address,
        c.id,
        "--chain",
        String(o.chainId),
        "--verifier",
        "sourcify",
        "--constructor-args",
        args,
        "--watch",
      ],
      { cwd: MONAD_DIR, encoding: "utf8", env: process.env },
    );
    const out = redact(`${forge.stdout ?? ""}${forge.stderr ?? ""}`, [o.url]);
    console.log(out.trim().split("\n").slice(-4).join("\n"));
    const match = await sourcifyMatch(o.chainId, c.address);
    results.push({
      label: c.label,
      source: c.id,
      address: c.address,
      creationTransaction: creation,
      constructorArgs: args,
      forgeExitCode: forge.status,
      sourcify: match,
      sourcifyLink: `https://repo.sourcify.dev/${o.chainId}/${c.address}`,
      explorerLink: `${o.explorer}/address/${c.address}`,
    });
    console.log(
      `sourcify: ${match ? `${match.match} (creation ${match.creationMatch}, runtime ${match.runtimeMatch})` : "not found"}`,
    );
  }
  return results;
}
