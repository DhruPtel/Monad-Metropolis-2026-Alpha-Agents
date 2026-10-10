// @ts-check
// pnpm custody:v3:demo (F-U3): the custody core v3 on a fork of its own (port
// 8586, never the playtest fork). Deploys the v3 set and AccountFactoryV3,
// mints a test owner an agent, opens its PersonalAccountV3, deposits USDC,
// WMON, cbBTC and shMON (the last two bought through real pools), shows the
// cost-basis record, opts in to the screened lane and out again, and
// withdraws everything with no price, then stops the fork. Nothing is sent
// anywhere but that fork.
//
// The port is set before any library loads: every script library reads the
// fork it targets from LOCAL_FORK_PORT when it loads (D-200, L-100).
process.env.LOCAL_FORK_PORT = "8586";
const { mintTestUsdc, refreshLocalFeeds, startTestFork } = await import("@alpha-agents/devenv");
const { LOCAL_TEST_OWNERS } = await import("./lib/account-factory.js");
const { mintLocal } = await import("./lib/agent-mint.js");
const { deployLocal: deployAgentNft } = await import("./lib/agent-nft.js");
const { loadRootEnv } = await import("./lib/config.js");
const { deployCustodyV3Local } = await import("./lib/custody-v3.js");
const { FUND_ROLES, deployFundLocal, runForge } = await import("./lib/fund.js");

loadRootEnv();
const PORT = 8586;
const owner = LOCAL_TEST_OWNERS[0];
if (!owner) throw new Error("no local test owner");
console.log(`starting a fork of its own on port ${PORT}`);
const fork = await startTestFork({ port: PORT });
let code = 0;
try {
  const set = await deployFundLocal({ url: fork.url, skipScreens: true });
  const nft = /** @type {`0x${string}`} */ (await deployAgentNft({ quiet: true }));
  const custody = await deployCustodyV3Local({
    fund: { tokenRegistry: set.tokenRegistry, oracle: set.oracle },
    quiet: true,
  });
  console.log(
    `AccountFactoryV3 ${custody.factory}; PersonalAccountV3 implementation ${custody.implementation}`,
  );
  const { agentId } = await mintLocal(nft, owner);
  console.log(`minted agent ${agentId} to ${owner} (anvil account 6)`);
  // Every class F feed dated now (D-237), so deposits are priced on this fork.
  await refreshLocalFeeds(fork.url);
  await mintTestUsdc(FUND_ROLES.admin, 1_000_000_000n, fork.url);
  await mintTestUsdc(owner, 100_000_000n, fork.url);
  // Async (L-109): this process drains the fork's log.
  const run = await runForge(
    [
      "script",
      "script/DemoCustodyV3.s.sol:DemoCustodyV3",
      "--rpc-url",
      fork.url,
      "--broadcast",
      "--unlocked",
      "--sender",
      owner,
      "--legacy",
    ],
    {
      ACCOUNT_FACTORY_V3: custody.factory,
      TOKEN_REGISTRY: set.tokenRegistry,
      PROTOCOL_REGISTRY_V3: set.protocolRegistry,
      ROUTE_ADAPTER: set.routeAdapter,
      DEMO_OWNER: owner,
      DEMO_AGENT_ID: agentId.toString(),
      FUND_ADMIN: FUND_ROLES.admin,
      FUND_SCREENER: FUND_ROLES.screener,
    },
  );
  const out = run.output.replace(/https?:\/\/\S+/g, "[url]");
  const logs = out
    .split("\n")
    .filter(
      (l) =>
        /^\s{2}\S/.test(l) &&
        !/^\s+(Script|Chain|Estimated|##|SIMULATION|ONCHAIN|Transactions|Sensitive)/.test(l),
    );
  console.log(logs.map((l) => l.trim()).join("\n"));
  if (run.status !== 0) {
    console.error(out.split("\n").slice(-15).join("\n"));
    code = 1;
  }
} finally {
  await fork.stop();
}
process.exit(code);
