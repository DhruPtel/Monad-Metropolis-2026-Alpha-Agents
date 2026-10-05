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
import { randomBytes } from "node:crypto";
import { NotLocalForkError, rpc } from "@alpha-agents/devenv";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  parseEventLogs,
} from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { ENTROPY, LOCAL_ROLES, deployLocal } from "./lib/agent-nft.js";
import { ANVIL_URL, loadRootEnv } from "./lib/config.js";

/** Anvil's default development mnemonic; account 1 is the local claim signer. */
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
const ENTROPY_PROVIDER = "0x52DeaA1c84233F7bb8C8A45baeDE41091c616506";
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
const entropyAbi = parseAbi(["function getFeeV2() view returns (uint128)"]);

const chain = defineChain({
  id: 143,
  name: "Monad (local fork)",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_URL] } },
});
const transport = http(ANVIL_URL);
const publicClient = createPublicClient({ chain, transport });

/**
 * Sends a transaction from an unlocked or impersonated address and waits for
 * the receipt, failing on a revert (L-10: poll for the receipt, never guess).
 * @param {`0x${string}`} from
 * @param {{ address: `0x${string}`, abi: typeof abi, functionName: string, args?: readonly unknown[], value?: bigint }} request
 */
async function send(from, request) {
  const wallet = createWalletClient({ chain, transport, account: from });
  // The request is built from this file's own ABI; viem's per-function
  // typing does not survive the generic parameter, so it is loosened here.
  const hash = await wallet.writeContract(
    /** @type {any} */ ({ ...request, account: from, chain }),
  );
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
  return receipt;
}

/** @param {`0x${string}`} address */
async function impersonate(address) {
  await rpc(ANVIL_URL, "anvil_impersonateAccount", [address]);
  await rpc(ANVIL_URL, "anvil_setBalance", [address, "0x56BC75E2D63100000"]); // 100 MON
}

/** @param {`0x${string}`} nft */
async function mint(nft) {
  const minter = privateKeyToAccount(generatePrivateKey()).address;
  const signer = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 1 });
  if (signer.address !== LOCAL_ROLES.claimSigner) throw new Error("unexpected local claim signer");
  const nonce = /** @type {`0x${string}`} */ (`0x${randomBytes(32).toString("hex")}`);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  // The platform API will sign these claims (P1-U4); locally anvil account 1 does.
  const signature = await signer.signTypedData({
    domain: { name: "AlphaAgents AgentNFT", version: "1", chainId: 143, verifyingContract: nft },
    types: {
      MintClaim: [
        { name: "wallet", type: "address" },
        { name: "nonce", type: "bytes32" },
        { name: "deadline", type: "uint64" },
      ],
    },
    primaryType: "MintClaim",
    message: { wallet: minter, nonce, deadline },
  });
  await impersonate(minter);
  const receipt = await send(minter, {
    address: nft,
    abi,
    functionName: "mintWithClaim",
    args: [deadline, nonce, signature],
  });
  await rpc(ANVIL_URL, "anvil_stopImpersonatingAccount", [minter]);
  const [minted] = parseEventLogs({ abi, logs: receipt.logs, eventName: "AgentMinted" });
  if (!minted) throw new Error("mint emitted no AgentMinted event");
  const id = minted.args.agentId;
  const tba = await publicClient.readContract({
    address: nft,
    abi,
    functionName: "tbaOf",
    args: [id],
  });
  console.log(`minted agent ${id} to fresh wallet ${minter}`);
  console.log(`token-bound account ${tba}`);
  console.log(`unrevealed; next: pnpm agent-nft:local reveal`);
}

/** @param {`0x${string}`} nft */
async function reveal(nft) {
  const [minted, next] = await Promise.all([
    publicClient.readContract({ address: nft, abi, functionName: "totalMinted" }),
    publicClient.readContract({ address: nft, abi, functionName: "nextToReveal" }),
  ]);
  let [sequence, , batchLast, seedReady] = await publicClient.readContract({
    address: nft,
    abi,
    functionName: "pendingReveal",
  });
  if (sequence === 0n) {
    if (next > minted) {
      console.log("nothing to reveal: every minted agent is revealed");
      return;
    }
    const fee = await publicClient.readContract({
      address: ENTROPY.local,
      abi: entropyAbi,
      functionName: "getFeeV2",
    });
    await send(LOCAL_ROLES.admin, {
      address: nft,
      abi,
      functionName: "requestReveal",
      value: fee,
    });
    [sequence, , batchLast, seedReady] = await publicClient.readContract({
      address: nft,
      abi,
      functionName: "pendingReveal",
    });
    console.log(`requested reveal ${sequence} for agents ${next} to ${batchLast} (fee ${fee} wei)`);
  }
  if (!seedReady) {
    const randomNumber = /** @type {`0x${string}`} */ (`0x${randomBytes(32).toString("hex")}`);
    await impersonate(ENTROPY.local);
    await send(ENTROPY.local, {
      address: nft,
      abi,
      functionName: "_entropyCallback",
      args: [sequence, ENTROPY_PROVIDER, randomNumber],
    });
    await rpc(ANVIL_URL, "anvil_stopImpersonatingAccount", [ENTROPY.local]);
    console.log(`delivered random number ${randomNumber} as Pyth Entropy`);
  }
  await send(LOCAL_ROLES.admin, { address: nft, abi, functionName: "reveal", args: [1000n] });
  for (let id = BigInt(next); id <= BigInt(batchLast); id++) {
    console.log(await describe(nft, id));
  }
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
