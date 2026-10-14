// @ts-check
// pnpm mint:copy <base-sepolia | arbitrum-sepolia> <agentId> [...] (CO-U1): the platform's copy
// of a Monad agent on an L2 testnet. Reads the agent's owner, tier and species from Monad
// testnet's AgentNFT, then mints the AgentCopyNFT with the same id to that owner (or moves an
// existing copy to the Monad owner when the agent changed hands). Sends nothing for a copy that
// already matches. The deployer is the copy NFT's minter. Prints no key and no RPC URL.
//
//   pnpm mint:copy base-sepolia 4
const [chainKey, ...ids] = process.argv.slice(2);
if ((chainKey !== "base-sepolia" && chainKey !== "arbitrum-sepolia") || ids.length === 0) {
  console.error("usage: pnpm mint:copy base-sepolia | arbitrum-sepolia <agentId> [...]");
  process.exit(2);
}
process.env.TESTNET_CHAIN = chainKey;
const { ConfigError } = await import("@alpha-agents/config");
const { addressEntry } = await import("@alpha-agents/domain");
const { redact } = await import("@alpha-agents/devenv");
const { createPublicClient, createWalletClient, getAddress, http, parseAbi } = await import("viem");
const { privateKeyToAccount } = await import("viem/accounts");
const { loadRootEnv } = await import("./lib/config.js");
const { TESTNET, reveal, testnetConfig } = await import("./lib/testnet.js");

/** The clean Monad testnet AgentNFT (CO-U1), whose agents get copies; MONAD_AGENT_NFT overrides it (the Metropolis AgentNFT, 0x53704d94..., for agents minted there). */
const MONAD_AGENT_NFT = /** @type {`0x${string}`} */ (
  process.env.MONAD_AGENT_NFT?.trim() || "0xf5a2Aa3Da4f937fe46c8387266293ef9c5d25E9A"
);
const MONAD_ABI = parseAbi([
  "function ownerOf(uint256) view returns (address)",
  "function speciesOf(uint256) view returns (uint8)",
  "function tierOf(uint256) view returns (uint8)",
]);
const COPY_ABI = parseAbi([
  "function ownerOf(uint256) view returns (address)",
  "function mintCopy(address to, uint256 agentId, uint8 tier, uint8 species)",
  "function moveCopy(uint256 agentId, address to)",
]);

loadRootEnv();
let config;
try {
  config = testnetConfig(["TESTNET_DEPLOYER_PRIVATE_KEY"]);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`error: ${err.message}`);
  process.exit(1);
}
const url = /** @type {import("@alpha-agents/config").Secret} */ (config.rpcUrl).reveal();
const monadUrl = process.env.MONAD_TESTNET_RPC_URL?.trim() ?? "";
if (!monadUrl) {
  console.error("error: MONAD_TESTNET_RPC_URL is not set (the Monad agent is read there)");
  process.exit(1);
}
const copyEntry = addressEntry("testnet", "agent_nft");
if (copyEntry.status !== "verified") {
  console.error(`error: no AgentCopyNFT on ${chainKey}; run pnpm deploy:l2 ${chainKey} first`);
  process.exit(1);
}
const copyNft = getAddress(copyEntry.address);
const account = privateKeyToAccount(
  /** @type {`0x${string}`} */ (reveal(config, "TESTNET_DEPLOYER_PRIVATE_KEY")),
);
const chain = {
  id: TESTNET.chainId,
  name: chainKey,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [] } },
};
const monad = createPublicClient({ transport: http(monadUrl) });
const client = createPublicClient({ chain, transport: http(url) });
const wallet = createWalletClient({ account, chain, transport: http(url) });

try {
  for (const raw of ids) {
    if (!/^[1-9]\d{0,4}$/.test(raw)) throw new Error(`"${raw}" is not an agent ID`);
    const id = BigInt(raw);
    const at = { address: MONAD_AGENT_NFT, abi: MONAD_ABI, args: /** @type {const} */ ([id]) };
    const [owner, species, tier] = await Promise.all([
      monad.readContract({ ...at, functionName: "ownerOf" }),
      monad.readContract({ ...at, functionName: "speciesOf" }),
      monad.readContract({ ...at, functionName: "tierOf" }),
    ]);
    if (Number(species) === 0) throw new Error(`agent ${raw} is not revealed on Monad yet`);
    const current = await client
      .readContract({ address: copyNft, abi: COPY_ABI, functionName: "ownerOf", args: [id] })
      .catch(() => null);
    if (current && getAddress(current) === getAddress(owner)) {
      console.log(`agent ${raw}: the copy on ${chainKey} already belongs to ${owner}`);
      continue;
    }
    const hash = current
      ? await wallet.writeContract({
          address: copyNft,
          abi: COPY_ABI,
          functionName: "moveCopy",
          args: [id, owner],
        })
      : await wallet.writeContract({
          address: copyNft,
          abi: COPY_ABI,
          functionName: "mintCopy",
          args: [owner, id, Number(tier), Number(species)],
        });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`the copy transaction ${hash} reverted`);
    console.log(
      `agent ${raw}: ${current ? "moved" : "minted"} the copy on ${chainKey} to ${owner} (tier ${tier}, species ${species}; ${hash})`,
    );
  }
} catch (err) {
  const message = err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err);
  console.error(`error: ${redact(message, [url, monadUrl])}`);
  process.exit(1);
}
