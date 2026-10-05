// @ts-check
// Try AgentNFT on the local fork (P1-U3). Local fork only: it refuses any
// other RPC, and it uses anvil's public development accounts.
//
//   pnpm agent-nft:local mint      mint with a signed claim from a fresh wallet
//   pnpm agent-nft:local reveal    request a reveal, deliver a random number as
//                                  Pyth Entropy (its keeper does not serve the
//                                  fork), and apply it to the batch
//   pnpm agent-nft:local show 1    print agent 1: owner, epoch, account, tier,
//                                  species and its decoded tokenURI JSON
//
// It deploys AgentNFT first if the fork has none (pnpm deploy:agent-nft).
import { LOCAL_FORK_CHAIN_ID } from "@alpha-agents/config";
import { NotLocalForkError } from "@alpha-agents/devenv";
import { createPublicClient, defineChain, http, parseAbi } from "viem";
import { deployLocal } from "./lib/agent-nft.js";
import { mintLocal } from "./lib/agent-mint.js";
import { revealLocal } from "./lib/agent-reveal.js";
import { ANVIL_URL, loadRootEnv } from "./lib/config.js";

const TIERS = ["unrevealed", "base", "medium", "pro"];

const abi = parseAbi([
  "function mintWithClaim(uint64 deadline, bytes32 nonce, bytes signature) returns (uint256)",
  "function requestReveal() payable returns (uint64)",
  "function reveal(uint256 maxCount) returns (uint256)",
  "function _entropyCallback(uint64 sequence, address provider, bytes32 randomNumber)",
  "function pendingReveal() view returns (uint64 sequence, uint64 requestedAt, uint16 batchLast, bool seedReady)",
  "function nextToReveal() view returns (uint16)",
  "function totalMinted() view returns (uint16)",
  "function ownerOf(uint256) view returns (address)",
  "function ownerEpoch(uint256) view returns (uint64)",
  "function tbaOf(uint256) view returns (address)",
  "function tierOf(uint256) view returns (uint8)",
  "function speciesOf(uint256) view returns (uint8)",
  "function slotsOf(uint256) view returns (uint8)",
  "function speciesInfo(uint8) view returns (string name, string slug)",
  "function tokenURI(uint256) view returns (string)",
  "event AgentMinted(uint256 indexed agentId, address indexed owner, address tba)",
]);

const chain = defineChain({
  id: LOCAL_FORK_CHAIN_ID,
  name: "Monad (local fork)",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_URL] } },
});
const transport = http(ANVIL_URL);
const publicClient = createPublicClient({ chain, transport });

/** @param {`0x${string}`} nft */
async function mint(nft) {
  const { agentId: id, minter, receipt } = await mintLocal(nft);
  const tba = await publicClient.readContract({
    address: nft,
    abi,
    functionName: "tbaOf",
    args: [id],
  });
  console.log(`minted agent ${id} to fresh wallet ${minter} (gas ${receipt.gasUsed})`);
  console.log(`token-bound account ${tba}`);
  console.log(`unrevealed; next: pnpm agent-nft:local reveal`);
}

/** @param {`0x${string}`} nft */
async function reveal(nft) {
  const result = await revealLocal(nft);
  if (!result) {
    console.log("nothing to reveal: every minted agent is revealed");
    return;
  }
  console.log(`delivered random number ${result.randomNumber} as Pyth Entropy and applied it`);
  for (let id = result.first; id <= result.last; id++) console.log(await describe(nft, id));
}

/**
 * @param {`0x${string}`} nft
 * @param {bigint} id
 */
async function describe(nft, id) {
  const [tier, species] = await Promise.all([
    publicClient.readContract({ address: nft, abi, functionName: "tierOf", args: [id] }),
    publicClient.readContract({ address: nft, abi, functionName: "speciesOf", args: [id] }),
  ]);
  if (species === 0) return `agent ${id}: unrevealed`;
  const [name] = await publicClient.readContract({
    address: nft,
    abi,
    functionName: "speciesInfo",
    args: [species],
  });
  return `agent ${id}: ${TIERS[tier]} tier, ${name} (species ${species})`;
}

/**
 * @param {`0x${string}`} nft
 * @param {bigint} id
 */
async function show(nft, id) {
  const read = (/** @type {any} */ functionName) =>
    publicClient.readContract({ address: nft, abi, functionName, args: [id] });
  const [owner, epoch, tba, slots, uri] = await Promise.all([
    read("ownerOf"),
    read("ownerEpoch"),
    read("tbaOf"),
    read("slotsOf"),
    read("tokenURI"),
  ]);
  console.log(await describe(nft, id));
  console.log(`owner ${owner}, ownership epoch ${epoch}, skill slots ${slots}`);
  console.log(`token-bound account ${tba}`);
  const json = Buffer.from(String(uri).replace(/^data:application\/json;base64,/, ""), "base64");
  console.log("tokenURI JSON:");
  console.log(JSON.stringify(JSON.parse(json.toString("utf8")), null, 2));
}

loadRootEnv();
const [command, arg] = process.argv.slice(2);
try {
  const nft = /** @type {`0x${string}`} */ (await deployLocal({ quiet: true }));
  console.log(`AgentNFT ${nft} on the local fork`);
  if (command === "mint") await mint(nft);
  else if (command === "reveal") await reveal(nft);
  else if (command === "show" && arg && /^\d+$/.test(arg)) await show(nft, BigInt(arg));
  else {
    console.error("usage: pnpm agent-nft:local mint | reveal | show <agentId>");
    process.exit(1);
  }
} catch (err) {
  const prefix = err instanceof NotLocalForkError ? "" : "error: ";
  console.error(`${prefix}${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  if (err instanceof NotLocalForkError) console.error("Start the fork with pnpm dev:up.");
  process.exit(1);
}
