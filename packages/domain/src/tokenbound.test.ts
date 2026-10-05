import { TokenboundClient } from "@tokenbound/sdk";
import { LOCAL_FORK_CHAIN_ID, LOCAL_FORK_RPC_URL } from "@alpha-agents/config";
import {
  type Address,
  createPublicClient,
  defineChain,
  getAddress,
  http,
  isAddressEqual,
  parseAbi,
} from "viem";
import { describe, expect, it } from "vitest";
import { addressEntry, signingAddress, tokenboundAccountAddress } from "./index.ts";

// The local fork: Monad mainnet's state as chain 143143 (D-195). Agents
// minted there are bound to 143143, the block.chainid AgentNFT sees.
const monad = defineChain({
  id: LOCAL_FORK_CHAIN_ID,
  name: "Monad (local fork)",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [LOCAL_FORK_RPC_URL] } },
});
const registry = signingAddress("local", "erc6551_registry");
const proxy = signingAddress("local", "tokenbound_account_proxy");
const agentNft = getAddress(addressEntry("local", "agent_nft").address ?? "0x");
const tokenIds = [1n, 2n, 7n, 999n, 1000n];

const ours = (tokenContract: Address, tokenId: bigint) =>
  tokenboundAccountAddress({
    registry,
    implementation: proxy,
    chainId: LOCAL_FORK_CHAIN_ID,
    tokenContract,
    tokenId,
  });

describe("token-bound account address (ERC-6551, Tokenbound v3)", () => {
  it("matches @tokenbound/sdk for the local AgentNFT and another collection", () => {
    // The SDK has no Monad entry; a viem chain object makes it work (notes/tokenbound.md 2.6).
    const sdk = new TokenboundClient({ chain: monad, implementationAddress: proxy });
    for (const tokenContract of [
      agentNft,
      getAddress("0x00000000000000000000000000000000000c0ffe"),
    ]) {
      for (const tokenId of tokenIds) {
        const fromSdk = sdk.getAccount({ tokenContract, tokenId: tokenId.toString() });
        expect(
          isAddressEqual(ours(tokenContract, tokenId), fromSdk),
          `${tokenContract} #${tokenId}`,
        ).toBe(true);
      }
    }
  });

  it("changes with the implementation argument, chain and token", () => {
    const base = ours(agentNft, 1n);
    expect(ours(agentNft, 2n)).not.toBe(base);
    expect(
      tokenboundAccountAddress({
        registry,
        implementation: signingAddress("local", "tokenbound_account_v3_upgradable"),
        chainId: LOCAL_FORK_CHAIN_ID,
        tokenContract: agentNft,
        tokenId: 1n,
      }),
    ).not.toBe(base);
    expect(
      tokenboundAccountAddress({
        registry,
        implementation: proxy,
        chainId: 10143,
        tokenContract: agentNft,
        tokenId: 1n,
      }),
    ).not.toBe(base);
  });
});

/** Skips cleanly when no local fork answers, as in CI. */
async function forkUp(): Promise<boolean> {
  try {
    const res = await fetch(LOCAL_FORK_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(2_000),
    });
    const result = ((await res.json()) as { result?: string }).result;
    return result !== undefined && Number.parseInt(result, 16) === LOCAL_FORK_CHAIN_ID;
  } catch {
    return false;
  }
}

describe.skipIf(!(await forkUp()))(
  "against the canonical registry on the local fork",
  { timeout: 60_000 },
  () => {
    it("equals registry.account() for the local AgentNFT", async () => {
      const client = createPublicClient({ chain: monad, transport: http(LOCAL_FORK_RPC_URL) });
      const abi = parseAbi([
        "function account(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) view returns (address)",
      ]);
      for (const tokenId of tokenIds) {
        const onchain = await client.readContract({
          address: registry,
          abi,
          functionName: "account",
          args: [proxy, `0x${"00".repeat(32)}`, BigInt(LOCAL_FORK_CHAIN_ID), agentNft, tokenId],
        });
        expect(isAddressEqual(onchain, ours(agentNft, tokenId))).toBe(true);
      }
    });
  },
);
