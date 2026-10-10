// @ts-check
// pnpm fund:demo (F-U2): the v3 set on a fork of its own (port 8585, never the
// playtest fork). Deploys the set, lists the registry's tokens and lanes, adds
// a screened token, makes a single-hop and a two-hop swap through real pools,
// and shows a sell-only switch, then stops the fork. Nothing is sent anywhere
// but that fork.
import { mintTestUsdc, startTestFork } from "@alpha-agents/devenv";
import { LOCAL_TEST_OWNERS } from "./lib/account-factory.js";
import { loadRootEnv } from "./lib/config.js";
import { FUND_ROLES, deployFundLocal, runForge } from "./lib/fund.js";

loadRootEnv();
const PORT = 8585;
console.log(`starting a fork of its own on port ${PORT}`);
const fork = await startTestFork({ port: PORT });
let code = 0;
try {
  const set = await deployFundLocal({ url: fork.url, skipScreens: true });
  await mintTestUsdc(FUND_ROLES.admin, 1_000_000_000n, fork.url);
  // Async (L-109): this process drains the fork's log.
  const run = await runForge(
    [
      "script",
      "script/DemoFund.s.sol:DemoFund",
      "--rpc-url",
      fork.url,
      "--broadcast",
      "--unlocked",
      "--sender",
      FUND_ROLES.admin,
      "--legacy",
    ],
    {
      TOKEN_REGISTRY: set.tokenRegistry,
      PROTOCOL_REGISTRY_V3: set.protocolRegistry,
      ROUTE_ADAPTER: set.routeAdapter,
      FUND_ADMIN: FUND_ROLES.admin,
      FUND_SCREENER: FUND_ROLES.screener,
      FUND_DEMO_ACCOUNT: LOCAL_TEST_OWNERS[0] ?? FUND_ROLES.admin,
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
