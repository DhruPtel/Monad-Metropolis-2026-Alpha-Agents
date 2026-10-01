// @ts-check
// Checks every verified address book entry against the local anvil fork: the
// code size and decimals recorded in packages/domain must match what the fork
// serves at the recorded block. Read-only calls to the local fork only.
import { ADDRESS_BOOK } from "@alpha-agents/domain";
import { ANVIL_URL } from "./config.js";
import { hexToNumber, rpc } from "./rpc.js";

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
    const { block, codeSize, decimals } = entry.verification;
    const tag = `0x${block.toString(16)}`;
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
    lines.push(`${pass ? "PASS" : "FAIL"}  ${entry.id.padEnd(34)} ${detail} at block ${block}`);
  }
  return { ok, lines };
}
