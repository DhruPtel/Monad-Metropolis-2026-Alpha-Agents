// @ts-check
// Checks every verified address book entry against the local anvil fork: the
// code size and decimals recorded in packages/domain must match what the fork
// serves at the recorded block. Read-only calls to the local fork only; our own
// contracts are checked at the latest block, after test-fork.js deploys them.
import { ADDRESS_BOOK } from "@alpha-agents/domain";
import { ANVIL_URL } from "./config.js";
import { hexToNumber, rpc } from "@alpha-agents/devenv";

const DECIMALS_SELECTOR = "0x313ce567";

/**
 * @returns {Promise<{ ok: boolean, lines: string[] }>}
 */
export async function verifyAddressBook() {
  const lines = [];
  let ok = true;
  for (const entry of ADDRESS_BOOK.local) {
    if (entry.status !== "verified") {
      lines.push(
        `SKIP  ${entry.id.padEnd(34)} unverified${entry.openQuestion ? ` (${entry.openQuestion})` : ""}`,
      );
      continue;
    }
    const { block, codeSize, decimals, deployedBy } = entry.verification;
    // Our own contracts do not exist at the pinned block; test-fork.js deploys
    // them first (deterministically), so they are checked at the latest block.
    const tag = deployedBy === undefined ? `0x${block.toString(16)}` : "latest";
    const code = /** @type {string} */ (await rpc(ANVIL_URL, "eth_getCode", [entry.address, tag]));
    const size = (code.length - 2) / 2;
    let detail = `code ${size} bytes`;
    let pass = size > 0 && size === codeSize;
    if (decimals !== undefined) {
      const raw = await rpc(ANVIL_URL, "eth_call", [
        { to: entry.address, data: DECIMALS_SELECTOR },
        tag,
      ]);
      const got = hexToNumber(raw);
      detail += `, decimals ${got}`;
      pass &&= got === decimals;
    }
    if (!pass) ok = false;
    const at = deployedBy === undefined ? `at block ${block}` : `deployed by ${deployedBy}`;
    if (!pass && deployedBy !== undefined)
      detail += ` (want ${codeSize}; update the address book if the contract changed)`;
    lines.push(`${pass ? "PASS" : "FAIL"}  ${entry.id.padEnd(34)} ${detail} ${at}`);
  }
  return { ok, lines };
}
