// @ts-check
// A mint on a local fork, as the platform's claim signer and a wallet would do
// it: anvil account 1 (AgentNFT's local claimSigner) signs the EIP-712 claim,
// and the minter, impersonated, sends mintWithClaim. The fork is the one
// LOCAL_FORK_PORT names (the playtest fork by default, D-200).
import { randomBytes } from "node:crypto";
import { LOCAL_FORK_CHAIN_ID } from "@alpha-agents/config";
import { rpc } from "@alpha-agents/devenv";
import { CLAIM_TYPES, claimDomain } from "@alpha-agents/domain";
import { parseAbi, parseEventLogs } from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { LOCAL_ROLES } from "./agent-nft.js";
import { impersonate, send } from "./agent-reveal.js";
import { ANVIL_URL } from "./config.js";

/** Anvil's default development mnemonic; account 1 is the local claim signer. */
export const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

const MINT_ABI = parseAbi([
  "function mintWithClaim(uint64 deadline, bytes32 nonce, bytes signature) returns (uint256)",
  "event AgentMinted(uint256 indexed agentId, address indexed owner, address tba)",
]);

/**
 * Mints one agent to `minter` (a fresh random wallet by default).
 * @param {`0x${string}`} nft
 * @param {`0x${string}`} [minter]
 */
export async function mintLocal(nft, minter = privateKeyToAccount(generatePrivateKey()).address) {
  const signer = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 1 });
  if (signer.address !== LOCAL_ROLES.claimSigner) throw new Error("unexpected local claim signer");
  const nonce = /** @type {`0x${string}`} */ (`0x${randomBytes(32).toString("hex")}`);
  // An hour from the later of the wall clock and the fork's clock: a fork whose
  // clock was moved forward (a timelock on a demo fork) is ahead of the wall clock.
  const block = /** @type {{ timestamp: string }} */ (
    await rpc(ANVIL_URL, "eth_getBlockByNumber", ["latest", false])
  );
  const now = Math.max(Math.floor(Date.now() / 1000), Number(BigInt(block.timestamp)));
  const deadline = BigInt(now + 3600);
  const signature = await signer.signTypedData({
    domain: claimDomain(LOCAL_FORK_CHAIN_ID, nft),
    types: CLAIM_TYPES,
    primaryType: "MintClaim",
    message: { wallet: minter, nonce, deadline },
  });
  await impersonate(minter);
  const receipt = await send(minter, {
    address: nft,
    abi: MINT_ABI,
    functionName: "mintWithClaim",
    args: [deadline, nonce, signature],
  });
  await rpc(ANVIL_URL, "anvil_stopImpersonatingAccount", [minter]);
  const [minted] = parseEventLogs({ abi: MINT_ABI, logs: receipt.logs, eventName: "AgentMinted" });
  if (!minted) throw new Error("mint emitted no AgentMinted event");
  return { agentId: minted.args.agentId, minter, receipt };
}
