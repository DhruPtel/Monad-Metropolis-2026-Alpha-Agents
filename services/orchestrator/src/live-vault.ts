/**
 * P7-U4's live run on a fork of its own (port 8569), `pnpm test:vault:live`:
 * the v3 set deployed fresh and asserted against the intended configuration
 * (MV-S15), the owner creates the agent's vault through AccountFactoryV3,
 * stakes and opens deposits, two wallets deposit, the agent's trade pipeline
 * (the policy mirror, the real signer, Executor v3, the registered pools)
 * trades for the vault under the no-expiry grant, the platform records value
 * snapshots before and after, the API's vault reader shows every position and
 * the performance series, one depositor redeems in kind and the other
 * withdraws USDC after the lockup. No model is called: the trade is proposed
 * as propose_swap would store it and approved by the owner, so the run spends
 * nothing (A-89). Prints no key and no RPC URL; writes evidence/p7-u4/live-<tag>.json.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ViemChainReader,
  ViemChainReaderV3,
  contractsFor,
  contractsForV3,
  resolveToken,
} from "@alpha-agents/chain-tools";
import type { Db } from "@alpha-agents/db";
import { type TestDatabase, createTestDatabase } from "@alpha-agents/db/testing";
import {
  type TestFork,
  advanceTime,
  createTestVault,
  depositTestVault,
  refreshLocalFeeds,
  registerTestVaultGrant,
  sendAs,
  setMonBalance,
  setTestVaultDepositsOpen,
  startTestFork,
} from "@alpha-agents/devenv";
import { addressEntry } from "@alpha-agents/domain";
import { ERC20_ABI, LocalKeyProvider, Signer, ViemChainClient } from "@alpha-agents/signer";
import {
  SnapshotStore,
  TradeStore,
  VAULT_GRANT_NO_EXPIRY,
  approveByOwner,
  confirmArming,
  rpcVaultReaderV3,
  vaultPerformance,
} from "@alpha-agents/trading";
import {
  type Hex,
  bytesToHex,
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  isAddressEqual,
  parseAbi,
} from "viem";
import { TradeFlow, swapGasCost } from "./trade-flow.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const UNIT = "P7-U4";
const PORT = 8569;
const CHAIN = 143143;
process.loadEnvFile(join(ROOT, ".env"));
const book = (id: Parameters<typeof addressEntry>[1]) => addressEntry("local", id).address as Hex;
const VAULT_ABI = parseAbi([
  "function redeem(uint256 shares, address receiver, uint256 minAssetsOut, uint64 deadline) returns (uint256)",
  "function redeemInKind(uint256 shares, address receiver)",
  "function sharesOf(address who) view returns (uint256)",
  "function freeShares(address who) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function navUsdc() view returns (uint256)",
  "function lockup() view returns (uint64)",
  "function breakerState() view returns (uint256 nav, uint256 perUnit, uint256 peak, uint256 drawdownBps)",
  "function holdings() view returns ((address token, uint8 decimals, uint256 balance, uint256 free, uint256 costBasis, uint256 lastPriceE18, uint64 lastPricedAt)[])",
]);

const runTag = new Date().toISOString().replaceAll(":", "-");
const checks: Record<string, boolean> = {};
const report: Record<string, unknown> = {
  unit: UNIT,
  runTag,
  port: PORT,
  modelSpendUsd: 0,
  checks,
};
const step = (s: string) => console.log(`\n== ${s}`);
const check = (name: string, ok: boolean, detail = "") => {
  checks[name] = ok;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const cleanup: (() => Promise<unknown>)[] = [];

async function main(): Promise<number> {
  step(`a fork of its own on port ${PORT}`);
  process.env.LOCAL_FORK_PORT = String(PORT);
  const fork: TestFork = await startTestFork({ port: PORT });
  cleanup.push(() => fork.stop());
  const client = createPublicClient({ transport: http(fork.url) });
  report.forkBlock = fork.block;

  step("the v3 set, deployed fresh and asserted (MV-S15)");
  const { deployAccountFactoryLocal } = await import("../../../scripts/lib/account-factory.js");
  const { deployFundLocal } = await import("../../../scripts/lib/fund.js");
  const { deployExecutorV3Local } = await import("../../../scripts/lib/executor-v3.js");
  const { assertState } = await import("../../../scripts/lib/state-assert.js");
  const custody = await import("../../../scripts/lib/custody.js");
  await deployAccountFactoryLocal({ quiet: true });
  const fund = await deployFundLocal({ quiet: true, skipScreens: true });
  const set = await deployExecutorV3Local({ quiet: true, tokenRegistry: fund.tokenRegistry });
  await refreshLocalFeeds(fork.url);
  const state = await assertState(fork.url, {
    factory: set.factory,
    executor: set.executor,
    routeAdapter: set.routeAdapter,
    protocolRegistry: set.protocolRegistry,
    oracle: set.oracle,
    tokenRegistry: set.tokenRegistry,
    agentNft: book("agent_nft"),
    usdc: book("usdc"),
  });
  for (const m of state.mismatches)
    console.log(`  ${m.path}: expected ${m.expected}, found ${m.actual}`);
  check(
    "MV-S15: the deployed set matches the intended configuration",
    state.ok,
    `${state.checked} values`,
  );
  check(
    "the address book names the deployed factory",
    isAddressEqual(set.factory, book("account_factory_v3")),
  );
  report.set = {
    factory: set.factory,
    executor: set.executor,
    vaultImplementation: set.implementation,
  };

  step("a throwaway database");
  const t: TestDatabase = await createTestDatabase("vault_live");
  cleanup.push(() => t.drop());
  const db: Db = t.db;
  const trades = new TradeStore(db);
  const snapshots = new SnapshotStore(db, "local");

  step("the owner creates the vault, stakes and opens deposits; two wallets deposit");
  const owner = getAddress(custody.testOwner(6).toLowerCase()) as Hex;
  const alice = getAddress(custody.testOwner(7).toLowerCase()) as Hex;
  const bob = getAddress(custody.testOwner(8).toLowerCase()) as Hex;
  const agentId = Number(await custody.ownersAgent(book("agent_nft"), owner));
  const vault = (await createTestVault(fork.url, agentId, owner)) as Hex;
  const read = <T>(functionName: string, args: unknown[] = []) =>
    client.readContract({
      address: vault,
      abi: VAULT_ABI,
      functionName,
      args,
    } as never) as Promise<T>;
  const balance = (token: Hex, of: Hex) =>
    client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [of] });
  const stakeShares = await depositTestVault(fork.url, agentId, owner, 20_000_000n);
  await setTestVaultDepositsOpen(fork.url, agentId, owner, true);
  const aliceShares = await depositTestVault(fork.url, agentId, alice, 30_000_000n);
  const bobShares = await depositTestVault(fork.url, agentId, bob, 30_000_000n);
  check("the vault exists at the factory's address for the agent", vault !== undefined, vault);
  check(
    "the leader's stake, then two deposits of 30 USDC",
    stakeShares > 0n && aliceShares > 0n && bobShares > 0n,
  );
  check("the vault is worth the 80 USDC put in", (await read<bigint>("navUsdc")) === 80_000_000n);
  check("the lockup is a day", (await read<bigint>("lockup")) === 86_400n);
  check("a fresh deposit is locked", (await read<bigint>("freeShares", [alice])) === 0n);
  report.vault = { address: vault, agentId, owner, alice, bob };

  step("the API's vault reader, for each wallet");
  const vaultReader = rpcVaultReaderV3(
    fork.url,
    CHAIN,
    {
      agentNft: book("agent_nft"),
      accountFactory: set.factory,
      oracle: set.oracle,
      usdc: book("usdc"),
      wmon: book("wmon"),
      executor: set.executor,
    },
    {
      tokens: async () => [
        { symbol: "WMON", address: book("wmon"), decimals: 18, priceClass: "F" as const },
      ],
    },
  );
  const forAlice = await vaultReader.vault(agentId, alice);
  const forOwner = await vaultReader.vault(agentId, owner);
  // Anvil account 2: not one of the local allowlist's accounts 6 to 9.
  const stranger = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Hex;
  const forStranger = await vaultReader.vault(agentId, stranger);
  check(
    "the reader shows alice's locked shares, her value and her in-kind slice",
    !!forAlice?.viewer &&
      forAlice.viewer.shares === aliceShares &&
      forAlice.viewer.freeShares === 0n &&
      forAlice.viewer.unlockAt > 0n &&
      forAlice.viewer.inKind?.length === 1 &&
      forAlice.viewer.valueUsdc !== null,
  );
  // The stake is 20 of about 80 shares: the depositors' shares carry the spread, so the figure sits just above a quarter.
  check(
    "the reader shows the owner as the leader with a stake of about a quarter",
    !!forOwner?.viewer?.isLeader &&
      forOwner.state !== null &&
      forOwner.state.leaderStakeBps >= 2_400n &&
      forOwner.state.leaderStakeBps <= 2_600n,
    `${forOwner?.state?.leaderStakeBps ?? "?"} bps`,
  );
  check(
    "the reader says the vault cap is 500 USDC and public deposits are off",
    forOwner?.factory.vaultCap === 500_000_000n && forOwner.factory.depositsEnabled === false,
  );
  check(
    "a wallet off the allowlist may not deposit, per the reader",
    forStranger?.viewer?.mayDeposit === false,
  );

  step(
    "the agent trades for the vault through its own pipeline: the grant, the proposal, the approval, the signer, Executor v3",
  );
  const seed = bytesToHex(randomBytes(32));
  const signer = new Signer({
    db,
    environment: "local",
    chain: new ViemChainClient({ chainId: CHAIN, primaryUrl: fork.url }),
    keys: new LocalKeyProvider(seed),
    executor: book("executor"),
    executorV3: set.executor,
    assets: { [book("usdc").toLowerCase()]: "USDC", [book("wmon").toLowerCase()]: "WMON" },
    log: () => undefined,
    topUpGas: (address, wei) => setMonBalance(address, wei, fork.url),
  });
  await signer.start();
  const key = await signer.createKey(agentId);
  const c = contractsFor("local");
  if (!c.ok) throw new Error(`missing ${c.missing.join(", ")}`);
  const c3 = contractsForV3("local");
  if (!c3.ok) throw new Error(`missing ${c3.missing.join(", ")}`);
  const reader = new ViemChainReader({
    chainId: CHAIN,
    rpcUrl: fork.url,
    contracts: c.contracts,
    cacheMs: 0,
  });
  const readerV3 = new ViemChainReaderV3({
    chainId: CHAIN,
    rpcUrl: fork.url,
    contracts: c3.contracts,
    cacheMs: 0,
  });
  const observe = async (reason: "interval" | "trade", intentId: string | null = null) => {
    const a = await readerV3.agent(agentId);
    const block = await client.getBlock();
    await snapshots.record(
      CHAIN,
      {
        agentId,
        account: vault,
        block: block.number,
        timestamp: block.timestamp,
        usdc: 0n,
        wmon: 0n,
        mode: a?.mode ?? "NORMAL",
        monUsdE18: null,
        custody: "v3",
        valueUsdcE6: a?.values?.nav ?? null,
        perUnitE18: a?.breaker?.perUnit ?? null,
      },
      reason,
      intentId,
    );
  };
  await observe("interval");
  await registerTestVaultGrant(fork.url, agentId, owner, key);
  const view = await readerV3.agent(agentId);
  check(
    "the chain reader shows the vault as the agent's account under the no-expiry grant",
    view?.isVault === true && view.grant?.validUntil === VAULT_GRANT_NO_EXPIRY,
  );
  const armed = await confirmArming(trades, view, {
    chainId: CHAIN,
    agentId,
    owner,
    fundingAddress: key,
    custody: "v3",
    executor: set.executor,
  });
  check("the platform records the arming for the vault", armed.ok);
  const [m, a] = await Promise.all([readerV3.market(), readerV3.agent(agentId)]);
  if (!a?.account) throw new Error("no agent account");
  const sell = resolveToken(m, "USDC");
  const buy = resolveToken(m, "WMON");
  const amountIn = 5_000_000n;
  const quote = await readerV3.bestRoute(sell.token, buy.token, amountIn, {
    optedIn: a.screenedOptIn,
    intoUsdc: false,
    sellsScreened: false,
  });
  const intentId = `intent-${randomUUID()}`;
  await db
    .insertInto("platform.intents")
    .values({
      intent_id: intentId,
      chain_id: CHAIN,
      agent_id: agentId,
      lease_id: "live-vault",
      kind: "swap",
      account: a.account.toLowerCase(),
      custody: "v3",
      sell: sell.symbol,
      buy: buy.symbol,
      sell_token: sell.token.toLowerCase(),
      buy_token: buy.token.toLowerCase(),
      route: JSON.stringify(quote?.route.map((p) => p.poolId) ?? []),
      amount_in: amountIn.toString(),
      reason: "P7-U4 live run",
      idempotency_key: intentId,
      status: "awaiting_approval",
      reason_codes: "[]",
      checks: JSON.stringify({
        custody: "v3",
        sellDecimals: sell.decimals,
        buyDecimals: buy.decimals,
        hops: quote?.route.length ?? 0,
      }),
      owner_epoch: String(a.ownerEpoch),
      config_epoch: String(a.configEpoch),
      expires_at: new Date(Date.now() + 1_800_000),
    })
    .execute();
  const approved = await approveByOwner(trades, CHAIN, agentId, intentId);
  check("the owner approves the first trade", approved.ok);
  const flow = new TradeFlow({
    chainId: CHAIN,
    store: trades,
    reader,
    readerV3,
    signer,
    gas: {
      balance: (address) => client.getBalance({ address }),
      swapCost: async (gas) => swapGasCost((await client.getBlock()).baseFeePerGas ?? 0n, 0n, gas),
      topUp: (address: Hex, wei: bigint) => setMonBalance(address, wei, fork.url),
    },
    finalizedBlock: async () => null,
    log: () => undefined,
  });
  const usdcBefore = await balance(book("usdc"), vault);
  let settled = await trades.intent(CHAIN, agentId, intentId);
  for (let i = 0; i < 80; i++) {
    await flow.tick();
    await signer.tick();
    settled = await trades.intent(CHAIN, agentId, intentId);
    const s = settled?.status;
    if (s === "reconciled" || s === "rejected" || s === "failed" || s === "expired") break;
    await new Promise((r) => setTimeout(r, 200));
  }
  check(
    "the trade settles through Executor v3 for the vault",
    settled?.status === "reconciled",
    `status ${settled?.status ?? "none"}`,
  );
  check(
    "the vault spent 5 USDC and holds WMON",
    (await balance(book("usdc"), vault)) === usdcBefore - amountIn &&
      (await balance(book("wmon"), vault)) > 0n,
  );
  check(
    "the supply of shares did not move with the trade",
    (await read<bigint>("totalSupply")) === stakeShares + aliceShares + bobShares,
  );
  await observe("trade", intentId);
  report.trade = {
    intentId,
    status: settled?.status,
    amountOut: settled?.amountOut?.toString() ?? null,
    txHash: settled?.txHash ?? null,
  };

  step("the performance from the value snapshots");
  const rows = await snapshots.since(CHAIN, agentId, new Date(0));
  const after = await vaultReader.vault(agentId, alice);
  if (!after) throw new Error("no reading after the trade");
  const perf = vaultPerformance(rows, after, new Date());
  check(
    "two snapshot rows for the vault and the live point make the series",
    rows.length === 2 && perf.series.length === 3,
    `${perf.series.length} points`,
  );
  check(
    "the reader values the vault across USDC and WMON after the trade",
    after.state?.holdings.length === 2 && after.state.navUsdc !== null,
  );
  report.performance = {
    points: perf.series.length,
    perUnit: perf.series.map((p) => p.perUnitE18),
  };

  step("after the lockup: alice redeems in kind, bob withdraws USDC");
  await advanceTime(86_400 + 60, fork.url);
  await refreshLocalFeeds(fork.url);
  const aliceUsdcBefore = await balance(book("usdc"), alice);
  const aliceWmonBefore = await balance(book("wmon"), alice);
  const inKind = await vaultReader.vault(agentId, alice);
  check("the reader shows alice free to withdraw", inKind?.viewer?.freeShares === aliceShares);
  await sendAs(
    fork.url,
    alice,
    vault,
    encodeFunctionData({
      abi: VAULT_ABI,
      functionName: "redeemInKind",
      args: [aliceShares, alice],
    }),
  );
  const aliceUsdc = (await balance(book("usdc"), alice)) - aliceUsdcBefore;
  const aliceWmon = (await balance(book("wmon"), alice)) - aliceWmonBefore;
  check(
    "alice holds her slice of the USDC and the WMON, and no shares",
    aliceUsdc > 0n && aliceWmon > 0n && (await read<bigint>("sharesOf", [alice])) === 0n,
    `${aliceUsdc} USDC base units, ${aliceWmon} WMON wei`,
  );
  const bobBefore = await balance(book("usdc"), bob);
  const bobPreview = await vaultReader.vault(agentId, bob);
  const owed = bobPreview?.viewer?.valueUsdc ?? 0n;
  const deadline = BigInt((await client.getBlock()).timestamp) + 3_600n;
  await sendAs(
    fork.url,
    bob,
    vault,
    encodeFunctionData({
      abi: VAULT_ABI,
      functionName: "redeem",
      args: [bobShares, bob, (owed * 97n) / 100n, deadline],
    }),
  );
  const bobUsdc = (await balance(book("usdc"), bob)) - bobBefore;
  check(
    "bob is paid in USDC, within the spread of the reader's preview",
    bobUsdc > 0n &&
      bobUsdc >= (owed * 97n) / 100n &&
      (await read<bigint>("sharesOf", [bob])) === 0n,
    `${bobUsdc} USDC base units for ${owed} previewed`,
  );
  check(
    "the leader's stake stays",
    (await read<bigint>("sharesOf", [owner])) === stakeShares &&
      (await read<bigint>("totalSupply")) === stakeShares,
  );
  report.exits = {
    aliceUsdcE6: aliceUsdc.toString(),
    aliceWmonWei: aliceWmon.toString(),
    bobUsdcE6: bobUsdc.toString(),
    bobPreviewUsdcE6: owed.toString(),
  };

  const failed = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([n]) => n);
  console.log(
    `\n${failed.length === 0 ? "every check passed" : `${failed.length} check(s) failed: ${failed.join("; ")}`}`,
  );
  return failed.length === 0 ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  report.error =
    err instanceof Error ? err.message.replace(/https?:\/\/\S+/g, "[url]") : String(err);
  console.error(`error: ${String(report.error)}`);
} finally {
  for (const fn of cleanup.reverse()) await fn().catch(() => undefined);
  report.passed = code === 0;
  const text = JSON.stringify(
    report,
    (_k, v) => (typeof v === "bigint" ? String(v) : v),
    2,
  ).replace(/https?:\/\/(?!127\.0\.0\.1)\S+/g, "[url]");
  const dir = join(ROOT, `evidence/${UNIT.toLowerCase()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `live-${runTag}.json`), `${text}\n`);
  console.log(`\nreport: evidence/${UNIT.toLowerCase()}/live-${runTag}.json`);
}
process.exit(code);
