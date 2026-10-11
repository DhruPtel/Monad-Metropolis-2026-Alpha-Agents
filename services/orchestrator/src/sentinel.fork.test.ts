import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import {
  type TestFork,
  createTestPersonalAccountV3,
  fundTestPersonalAccountV3,
  moveLocalFeed,
  refreshLocalFeeds,
  sendAs,
  startTestFork,
  testForkUpstream,
} from "@alpha-agents/devenv";
import { ViemChainReaderV3, contractsForV3 } from "@alpha-agents/chain-tools";
import { addressEntry } from "@alpha-agents/domain";
import { GoalStore, PlanStore, TradeStore } from "@alpha-agents/trading";
import { type Hex, createPublicClient, encodeFunctionData, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_RULES, Sentinel, SentinelStore } from "./sentinel.ts";
import { localSentinelKey, viemSentinelChain } from "./sentinel-chain.ts";
import { type SentinelWiring, sentinelDeps } from "./sentinel-wiring.ts";
import { CHAIN, indexAgent } from "./testing.ts";

/**
 * The Risk Sentinel's drills on a fork of its own (P4-U2, port 8563), with
 * the fund agent's set and the real sentinel key (anvil account 5, the
 * factory's sentinel): a 12% fall of MON sets the account reduce-only
 * (the breaker, on the sentinel's poke, and the sentinel's record), a 22%
 * fall pauses it, the owner's withdrawal still works in both, the sentinel
 * key cannot unpause, and a stalled MON feed makes the agent an incident.
 * Skips without MONAD_RPC_URL or Postgres (as in CI).
 */
const PORT = 8563;
const upstream = testForkUpstream();
const dbUp = await databaseAvailable();
const SLOW = 600_000;
const book = (id: Parameters<typeof addressEntry>[1]) => {
  const a = addressEntry("local", id).address;
  if (!a) throw new Error(`no ${id} in the local address book`);
  return a as Hex;
};
const ACCOUNT_ABI = parseAbi([
  "function mode() view returns (uint8)",
  "function withdraw(address token, uint256 amount, address to)",
  "function unpause()",
  "function breakerState() view returns (uint256 nav, uint256 perUnit, uint256 peak, uint256 drawdownBps)",
]);
const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const MODES = ["NORMAL", "REDUCE_ONLY", "PAUSED", "HANDOVER", "WIND_DOWN"] as const;

describe.skipIf(upstream === null || !dbUp)(
  "the sentinel's drills on a fork",
  { timeout: SLOW },
  () => {
    let fork: TestFork;
    let t: TestDatabase;
    let agentId: number;
    let owner: Hex;
    let account: Hex;
    let readerV3: ViemChainReaderV3;
    let store: SentinelStore;
    let sentinel: Sentinel;
    const previousPort = process.env.LOCAL_FORK_PORT;
    const client = () => createPublicClient({ transport: http(fork.url) });
    const monFeed = () => book("chainlink_mon_usd");
    const modeOf = async () =>
      MODES[
        await client().readContract({ address: account, abi: ACCOUNT_ABI, functionName: "mode" })
      ];
    const ref = () => ({ chainId: CHAIN, agentId });

    beforeAll(async () => {
      process.env.LOCAL_FORK_PORT = String(PORT);
      fork = await startTestFork({ port: PORT });
      t = await createTestDatabase("sentinel_fork");
      const { deployAccountFactoryLocal } = await import("../../../scripts/lib/account-factory.js");
      const { deployFundLocal } = await import("../../../scripts/lib/fund.js");
      const { deployExecutorV3Local } = await import("../../../scripts/lib/executor-v3.js");
      const custody = await import("../../../scripts/lib/custody.js");
      await deployAccountFactoryLocal({ quiet: true });
      const fund = await deployFundLocal({ quiet: true, skipScreens: true });
      await deployExecutorV3Local({ quiet: true, tokenRegistry: fund.tokenRegistry });
      await refreshLocalFeeds(fork.url);
      owner = custody.testOwner(7) as Hex;
      agentId = Number(await custody.ownersAgent(book("agent_nft"), owner));
      account = (await createTestPersonalAccountV3(fork.url, agentId, owner)) as Hex;
      // 60 USDC of WMON and 40 USDC: a fall of MON moves the account's value with it.
      await fundTestPersonalAccountV3(fork.url, agentId, owner, [
        { token: book("usdc"), usdcE6: 40_000_000n },
        { token: book("wmon"), usdcE6: 60_000_000n },
      ]);
      const c3 = contractsForV3("local");
      if (!c3.ok) throw new Error(`the local v3 set is missing ${c3.missing.join(", ")}`);
      readerV3 = new ViemChainReaderV3({
        chainId: CHAIN,
        rpcUrl: fork.url,
        contracts: c3.contracts,
        cacheMs: 0,
      });
      await indexAgent(t.db, agentId, null, owner);
      await t.db
        .insertInto("platform.agent_states")
        .values({ chain_id: CHAIN, agent_id: agentId, state: "RUNNING" })
        .onConflict((oc) => oc.columns(["chain_id", "agent_id"]).doUpdateSet({ state: "RUNNING" }))
        .execute();
      store = new SentinelStore(t.db);
      const wiring: SentinelWiring = {
        chainId: CHAIN,
        db: t.db,
        store,
        rules: { ...DEFAULT_RULES, chainMaxAgeSeconds: null },
        chain: viemSentinelChain({
          rpcUrl: fork.url,
          chainId: CHAIN,
          privateKey: localSentinelKey(),
        }),
        readerV3,
        registry: null,
        credits: null,
        goals: new GoalStore(t.db),
        plans: new PlanStore(t.db),
        trades: new TradeStore(t.db),
        fundingAddressOf: null,
        gas: null,
        signerAlive: () => null,
        log: () => undefined,
      };
      sentinel = new Sentinel({ ...sentinelDeps(wiring), agents: async () => [agentId] });
    }, SLOW);

    afterAll(async () => {
      if (previousPort === undefined) delete process.env.LOCAL_FORK_PORT;
      else process.env.LOCAL_FORK_PORT = previousPort;
      await t?.drop();
      await fork?.stop();
    });

    it("the sentinel key is the factory's sentinel, and a first pass with nothing wrong records nothing", async () => {
      const factorySentinel = await client().readContract({
        address: book("account_factory_v3"),
        abi: parseAbi(["function sentinel() view returns (address)"]),
        functionName: "sentinel",
      });
      expect(factorySentinel.toLowerCase()).toBe(
        privateKeyToAccount(localSentinelKey()).address.toLowerCase(),
      );
      expect(await modeOf()).toBe("NORMAL");
      expect(await sentinel.tick()).toEqual([]);
      expect(await store.actions(ref())).toEqual([]);
    });

    it("a 12% fall of MON: the poke trips the breaker to reduce-only and the sentinel records the drawdown; the owner still withdraws", async () => {
      await moveLocalFeed(fork.url, monFeed(), -2_500);
      const actions = await sentinel.tick();
      expect(actions.map((a) => `${a.code}:${a.action}`)).toEqual(["DRAWDOWN_12:REDUCE_ONLY"]);
      expect(await modeOf()).toBe("REDUCE_ONLY");
      const [, , , drawdown] = await client().readContract({
        address: account,
        abi: ACCOUNT_ABI,
        functionName: "breakerState",
      });
      expect(Number(drawdown)).toBeGreaterThanOrEqual(1_200);
      expect((await store.actions(ref()))[0]).toMatchObject({
        code: "DRAWDOWN_12",
        status: "done",
      });
      // Exits stay open: the owner withdraws 10 USDC to their wallet.
      const before = await client().readContract({
        address: book("usdc"),
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [owner],
      });
      await sendAs(
        fork.url,
        owner,
        account,
        encodeFunctionData({
          abi: ACCOUNT_ABI,
          functionName: "withdraw",
          args: [book("usdc"), 10_000_000n, owner],
        }),
      );
      const after = await client().readContract({
        address: book("usdc"),
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [owner],
      });
      expect(after - before).toBe(10_000_000n);
    });

    it("a 22% fall pauses the account, withdrawals still work, and the sentinel key cannot unpause", async () => {
      await moveLocalFeed(fork.url, monFeed(), -2_500);
      const actions = await sentinel.tick();
      expect(actions.map((a) => `${a.code}:${a.action}`)).toEqual([
        "DRAWDOWN_22:PAUSE",
        "DRAWDOWN_12:NOTE",
      ]);
      expect(await modeOf()).toBe("PAUSED");
      const before = await client().readContract({
        address: book("usdc"),
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [owner],
      });
      await sendAs(
        fork.url,
        owner,
        account,
        encodeFunctionData({
          abi: ACCOUNT_ABI,
          functionName: "withdraw",
          args: [book("usdc"), 5_000_000n, owner],
        }),
      );
      const after = await client().readContract({
        address: book("usdc"),
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [owner],
      });
      expect(after - before).toBe(5_000_000n);
      // The sentinel key may not unpause: the core refuses it before any gas is spent.
      await expect(
        client().simulateContract({
          address: account,
          abi: ACCOUNT_ABI,
          functionName: "unpause",
          account: privateKeyToAccount(localSentinelKey()),
        }),
      ).rejects.toThrow();
      expect(await modeOf()).toBe("PAUSED");
    });

    it("a stalled MON feed: the poke reverts, the stale-feed breach is recorded and the agent is an incident; restored, the condition clears and the mode stays", async () => {
      await refreshLocalFeeds(fork.url, [monFeed()], { [monFeed().toLowerCase()]: { down: true } });
      const actions = await sentinel.tick();
      expect(actions.map((a) => `${a.code}:${a.action}`)).toEqual([
        "STALE_FEED:REDUCE_ONLY",
        "DRAWDOWN_22:NOTE",
        "STATE:INCIDENT",
      ]);
      // Newest first: the state, the drawdown's note (unseen while the feed is down), the skipped tightening.
      expect((await store.actions(ref()))[2]).toMatchObject({
        code: "STALE_FEED",
        status: "skipped",
      });
      const state = await t.db
        .selectFrom("platform.agent_states")
        .select("state")
        .where("agent_id", "=", agentId)
        .executeTakeFirstOrThrow();
      expect(state.state).toBe("INCIDENT");
      await refreshLocalFeeds(fork.url, [monFeed()], {
        [monFeed().toLowerCase()]: { down: false },
      });
      const cleared = await sentinel.tick();
      // The drawdown is seen again (already answered by the pause) and the stale feed is noted as cleared.
      expect(cleared.map((a) => `${a.code}:${a.action}`)).toEqual([
        "DRAWDOWN_22:PAUSE",
        "STALE_FEED:NOTE",
      ]);
      expect(await modeOf()).toBe("PAUSED");
    });
  },
);
