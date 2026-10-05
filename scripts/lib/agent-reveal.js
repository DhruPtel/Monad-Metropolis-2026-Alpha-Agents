// @ts-check
// The dev reveal path for AgentNFT on the local fork (P1-U11, D-194): request
// a reveal from the real Pyth Entropy contract, deliver a random number by
// impersonating Entropy (its keeper does not serve the fork), and apply it.
// Used by `pnpm agent-nft:local reveal` and the web app's live end-to-end test.
// Local fork only: every call goes through the local-fork guard first. The
// real reveal keeper is P1-U5's.
import { randomBytes } from "node:crypto";
import { LOCAL_FORK_CHAIN_ID } from "@alpha-agents/config";
import { assertLocalFork, rpc } from "@alpha-agents/devenv";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbi,
} from "viem";
import { ANVIL_URL } from "./config.js";
import { ENTROPY, LOCAL_ROLES } from "./agent-nft.js";

export const ENTROPY_PROVIDER = "0x52DeaA1c84233F7bb8C8A45baeDE41091c616506";

export const REVEAL_ABI = parseAbi([
  "function requestReveal() payable returns (uint64)",
  "function reveal(uint256 maxCount) returns (uint256)",
  "function _entropyCallback(uint64 sequence, address provider, bytes32 randomNumber)",
  "function pendingReveal() view returns (uint64 sequence, uint64 requestedAt, uint16 batchLast, bool seedReady)",
  "function nextToReveal() view returns (uint16)",
  "function totalMinted() view returns (uint16)",
  "function remainingOf(uint8 species) view returns (uint256)",
  "function remainingSupply() view returns (uint256)",
  "function speciesOf(uint256 agentId) view returns (uint8)",
]);
const ENTROPY_ABI = parseAbi(["function getFeeV2() view returns (uint128)"]);

const chain = defineChain({
  id: LOCAL_FORK_CHAIN_ID,
  name: "Monad (local fork)",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_URL] } },
});
/** @type {import("viem").PublicClient} */
export const publicClient = createPublicClient({ chain, transport: http(ANVIL_URL) });

/**
 * Sends from an unlocked or impersonated address and waits for the receipt,
 * failing on a revert (L-10: poll for the receipt, never guess).
 * @param {`0x${string}`} from
 * @param {any} request
 */
export async function send(from, request) {
  const wallet = createWalletClient({ chain, transport: http(ANVIL_URL), account: from });
  const hash = await wallet.writeContract({ ...request, account: from, chain });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
  return receipt;
}

/** Makes anvil sign for an address and gives it 100 MON. @param {`0x${string}`} address */
export async function impersonate(address) {
  await rpc(ANVIL_URL, "anvil_impersonateAccount", [address]);
  await rpc(ANVIL_URL, "anvil_setBalance", [address, "0x56BC75E2D63100000"]);
}

/**
 * The species each agent of a batch would draw from a random number, exactly
 * as AgentNFT.reveal does it on the fork: seed = keccak(randomNumber, sequence,
 * block.chainid, contract), where block.chainid is the fork's 143143; for each
 * agent in order, draw = keccak(seed, id) mod remaining,
 * walking the deck's remaining counts in species order.
 * @param {{ randomNumber: `0x${string}`, sequence: bigint, nft: `0x${string}`, first: bigint, last: bigint, deck: bigint[], remaining: bigint }} args
 * @returns {Map<bigint, number>}
 */
export function simulateReveal({ randomNumber, sequence, nft, first, last, deck, remaining }) {
  const seed = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint64" }, { type: "uint256" }, { type: "address" }],
      [randomNumber, sequence, BigInt(LOCAL_FORK_CHAIN_ID), nft],
    ),
  );
  const counts = [...deck];
  let left = remaining;
  /** @type {Map<bigint, number>} */
  const out = new Map();
  for (let id = first; id <= last; id++) {
    let draw =
      BigInt(
        keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [seed, id])),
      ) % left;
    let species = 0;
    for (let s = 0; s < counts.length; s++) {
      const c = counts[s] ?? 0n;
      if (draw < c) {
        species = s + 1;
        counts[s] = c - 1n;
        break;
      }
      draw -= c;
    }
    out.set(id, species);
    left -= 1n;
  }
  return out;
}

/**
 * Requests, delivers and applies a reveal for every pending agent.
 * `want` (tests only) picks a random number under which that agent draws that
 * species, by searching numbers against `simulateReveal`; it fails if the
 * species has no slot left on this fork.
 * @param {`0x${string}`} nft
 * @param {{ agentId: bigint, species: number } | undefined} [want]
 * @returns {Promise<{ first: bigint, last: bigint, randomNumber: `0x${string}` } | null>}
 */
export async function revealLocal(nft, want) {
  await assertLocalFork(ANVIL_URL);
  const read = (/** @type {any} */ functionName, /** @type {any[]} */ args = []) =>
    publicClient.readContract(
      /** @type {any} */ ({ address: nft, abi: REVEAL_ABI, functionName, args }),
    );
  const [minted, next] = /** @type {[number, number]} */ (
    await Promise.all([read("totalMinted"), read("nextToReveal")])
  );
  let [sequence, , batchLast, seedReady] = /** @type {[bigint, bigint, number, boolean]} */ (
    await read("pendingReveal")
  );
  if (sequence === 0n) {
    if (next > minted) return null;
    const fee = await publicClient.readContract({
      address: ENTROPY.local,
      abi: ENTROPY_ABI,
      functionName: "getFeeV2",
    });
    await send(LOCAL_ROLES.admin, {
      address: nft,
      abi: REVEAL_ABI,
      functionName: "requestReveal",
      value: fee,
    });
    [sequence, , batchLast, seedReady] = /** @type {[bigint, bigint, number, boolean]} */ (
      await read("pendingReveal")
    );
  }
  const first = BigInt(next);
  const last = BigInt(batchLast);
  /** @type {`0x${string}`} */
  let randomNumber = `0x${randomBytes(32).toString("hex")}`;
  if (!seedReady) {
    if (want) {
      const deck = /** @type {bigint[]} */ (
        await Promise.all(Array.from({ length: 25 }, (_, i) => read("remainingOf", [i + 1])))
      );
      const remaining = /** @type {bigint} */ (await read("remainingSupply"));
      if ((deck[want.species - 1] ?? 0n) === 0n) {
        throw new Error(`species ${want.species} has no slot left on this fork`);
      }
      for (let tries = 0; ; tries++) {
        if (tries > 200_000) throw new Error("no random number found for the wanted species");
        const draws = simulateReveal({ randomNumber, sequence, nft, first, last, deck, remaining });
        if (draws.get(want.agentId) === want.species) break;
        randomNumber = `0x${randomBytes(32).toString("hex")}`;
      }
    }
    await impersonate(ENTROPY.local);
    await send(ENTROPY.local, {
      address: nft,
      abi: REVEAL_ABI,
      functionName: "_entropyCallback",
      args: [sequence, ENTROPY_PROVIDER, randomNumber],
    });
    await rpc(ANVIL_URL, "anvil_stopImpersonatingAccount", [ENTROPY.local]);
  }
  await send(LOCAL_ROLES.admin, {
    address: nft,
    abi: REVEAL_ABI,
    functionName: "reveal",
    args: [1000n],
  });
  return { first, last, randomNumber };
}
