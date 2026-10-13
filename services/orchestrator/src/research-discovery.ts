// P-SWEEP (D-384): token discovery on another chain for research only. The
// market package reads one chain per process (MARKET_CHAIN), so this process
// runs Base's discovery (GeckoTerminal, CoinGecko and CoinMarketCap through
// M-FAST's connectors, every pool confirmed on Base mainnet through the
// read-only transport) and writes Base's tokens into this environment's token
// table under chain 8453, beside Monad mainnet's. The agent studies them;
// nothing trades on a chain where the owner has no account.
//
//   MARKET_CHAIN=base node services/orchestrator/src/research-discovery.ts [--once]
//
// Uses DATABASE_URL (the environment's), BASE_RPC_URL or Base's public
// endpoint, and COINMARKETCAP_API_KEY when set. Prints no key or URL.
if (process.env.MARKET_CHAIN !== "base") {
  console.error("research-discovery: run with MARKET_CHAIN=base");
  process.exit(2);
}
const { BASE_PUBLIC_RPC_URL } = await import("@alpha-agents/config");
const { createDb } = await import("@alpha-agents/db");
const { MARKET_CHAIN, MarketData, TokenDiscovery, readOnlyTransport } =
  await import("@alpha-agents/market");
const { createPublicClient } = await import("viem");
const { PgUsageStore } = await import("./usage-store.ts");
const { TokenRegistry } = await import("./tokens/registry.ts");
const { TokenStore } = await import("./tokens/store.ts");

const EVERY_MS = 60 * 60_000;
const once = process.argv.includes("--once");
const log = (line: string) =>
  console.log(`${new Date().toISOString()} research-discovery (${MARKET_CHAIN.name}): ${line}`);

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("research-discovery: DATABASE_URL is not set");
  process.exit(1);
}
const rpc = process.env.BASE_RPC_URL?.trim() || BASE_PUBLIC_RPC_URL;
const db = createDb(dbUrl, { max: 2 });
const cmcKey = process.env.COINMARKETCAP_API_KEY?.trim() || null;
const market = new MarketData({ usage: new PgUsageStore(db), cmcApiKey: cmcKey, mainnet: null });
const discovery = new TokenDiscovery({
  market,
  cmcApiKey: cmcKey,
  client: createPublicClient({ transport: readOnlyTransport([rpc]) }) as never,
});
const registry = new TokenRegistry({
  chainId: MARKET_CHAIN.chainId,
  store: new TokenStore(db),
  market,
  discovery,
  fork: null,
});

async function pass(): Promise<void> {
  try {
    const s = await registry.discover();
    log(
      `${s.tokens} tokens (${s.classF} class F, ${s.classA} class A), ${s.pools} pools, ${s.newPools} new`,
    );
  } catch (err) {
    log(`the pass failed: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
  }
}

log(
  `writing chain ${MARKET_CHAIN.chainId}'s tokens for research; ${once ? "one pass" : `every ${EVERY_MS / 60_000} minutes`}`,
);
await pass();
if (once) {
  await db.destroy();
  process.exit(0);
}
setInterval(() => void pass(), EVERY_MS);
