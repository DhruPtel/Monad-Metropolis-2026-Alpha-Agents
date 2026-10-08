// @ts-check
// pnpm testnet:e2e: P2-EC part 1's end-to-end run on Monad testnet with the
// throwaway test wallet (TESTNET_TEST_WALLET_PRIVATE_KEY), through the running
// testnet stack (pnpm testnet:up) exactly as the web app drives it: a Privy
// login by Sign-In with Ethereum, the control API's mint claim, owner session,
// arming, approvals and portfolio, and the wallet's own transactions. Steps:
// mint, the real Pyth Entropy reveal and provisioning; credits and a Scan;
// open the account, deposit, arm, a proposal approved and settled at the
// finalized tag; an over-limit proposal refused with its reason; disarm and
// withdraw everything. Every transaction is measured (gas limit and used, fees,
// time to receipt, safe and finalized, block time against the wall clock) and
// written to evidence/p2-ec/e2e-run.json. Prints no key, token or RPC URL.
//
//   pnpm testnet:e2e              run every step (resumes an agent the wallet owns)
//   pnpm testnet:e2e --skip-scan  resume without another Scan
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "@alpha-agents/config";
import { redact } from "@alpha-agents/devenv";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadRootEnv } from "./lib/config.js";
import { ROOT } from "./lib/paths.js";
import { TESTNET, assertTestnet, chainTransaction, reveal, testnetConfig } from "./lib/testnet.js";

const API = "http://127.0.0.1:4100";
const ORCH = "http://127.0.0.1:4200";
const DEPOSIT_USDC_E6 = 500_000n; // 0.5 USDC: trades of 0.05 USDC at the 10% limit (D-307)
const CREDITS_USDC_E6 = 1_000_000n; // 1 USDC: a Scan needs 0.15
const CREDITS_LOW_USDC_E6 = 200_000n; // top up again only below this
const skipScan = process.argv.includes("--skip-scan");

const NFT_ABI = parseAbi([
  "function mintWithClaim(uint64 deadline, bytes32 nonce, bytes signature) returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);
const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const FACTORY_ABI = parseAbi(["function createPersonalAccount(uint256 agentId) returns (address)"]);
const ACCOUNT_ABI = parseAbi([
  "function deposit(address token, uint256 amount)",
  "function withdrawAll(address to)",
]);

loadRootEnv();
let config;
try {
  config = testnetConfig(["TESTNET_TEST_WALLET_PRIVATE_KEY"]);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`error: ${err.message}`);
  process.exit(1);
}
const url = /** @type {import("@alpha-agents/config").Secret} */ (config.rpcUrl).reveal();
const account = privateKeyToAccount(
  /** @type {`0x${string}`} */ (reveal(config, "TESTNET_TEST_WALLET_PRIVATE_KEY")),
);
const chain = {
  id: TESTNET.chainId,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [] } },
};
const client = createPublicClient({ chain, transport: http(url) });
const wallet = createWalletClient({ account, chain, transport: http(url) });
const started = Date.now();
/** @type {Record<string, unknown>} */
const run = {
  wallet: account.address,
  startedAt: new Date().toISOString(),
  steps: [],
  transactions: [],
};
const secrets = [url];
/** @param {string} line */
const say = (line) =>
  console.log(
    `[${((Date.now() - started) / 1000).toFixed(0).padStart(4)} s] ${redact(line, secrets)}`,
  );
/** @param {string} name @param {Record<string, unknown>} data */
const step = (name, data = {}) => {
  /** @type {unknown[]} */ (run.steps).push({ name, at: new Date().toISOString(), ...data });
  say(`${name} ${JSON.stringify(data)}`);
};
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Polls until `read` returns something truthy, or fails after `timeoutMs`.
 * @template T @param {string} what @param {() => Promise<T>} read @param {number} timeoutMs
 * @returns {Promise<NonNullable<T>>}
 */
async function waitFor(what, read, timeoutMs, everyMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read().catch(() => null);
    if (value) return /** @type {NonNullable<T>} */ (value);
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}`);
    await sleep(everyMs);
  }
}

/** @param {string} path @param {RequestInit & { session?: string, token?: string }} init */
async function api(path, init = {}) {
  const headers = /** @type {Record<string, string>} */ ({ "content-type": "application/json" });
  if (init.session) headers["x-owner-session"] = init.session;
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const res = await fetch(`${path.startsWith("http") ? "" : API}${path}`, { ...init, headers });
  const body = await res.json().catch(() => null);
  return { status: res.status, body: /** @type {any} */ (body) };
}

/** A transaction's finality: wall-clock times to receipt, safe and finalized (A-40). */
async function track(
  /** @type {`0x${string}`} */ hash,
  /** @type {string} */ kind,
  sentAt = Date.now(),
) {
  const receipt = await client.waitForTransactionReceipt({
    hash,
    timeout: 120_000,
    pollingInterval: 250,
  });
  const receiptMs = Date.now() - sentAt;
  const at = async (/** @type {"safe" | "finalized"} */ tag) => {
    for (;;) {
      const b = await client.getBlock({ blockTag: tag });
      if (b.number >= receipt.blockNumber) return Date.now() - sentAt;
      await sleep(200);
    }
  };
  const [safeMs, finalizedMs] = await Promise.all([at("safe"), at("finalized")]);
  const measured = await chainTransaction(url, hash);
  // The receipt read again at finalized: it must not have changed or gone.
  const again = await client.getTransactionReceipt({ hash });
  const record = {
    kind,
    ...measured,
    receiptMs,
    safeMs,
    finalizedMs,
    // Wall clock at the receipt against the block's own timestamp.
    clockSkewS: Math.round((sentAt + receiptMs) / 1000) - measured.blockTime,
    receiptStable: again.blockHash === receipt.blockHash && again.status === receipt.status,
  };
  /** @type {unknown[]} */ (run.transactions).push(record);
  say(
    `${kind}: ${hash} block ${measured.block} ${receipt.status}; gas ${measured.gasUsed} of limit ${measured.gasLimit}; receipt ${receiptMs} ms, safe ${safeMs} ms, finalized ${finalizedMs} ms`,
  );
  if (receipt.status !== "success") throw new Error(`${kind} reverted (${hash})`);
  return receipt;
}

/** Sends a call from the test wallet, as the app's wallet flow does, and tracks it. */
async function send(
  /** @type {string} */ kind,
  /** @type {{ to: `0x${string}`, data: `0x${string}`, value?: bigint }} */ call,
) {
  const sentAt = Date.now();
  const hash = await wallet.sendTransaction({
    to: call.to,
    data: call.data,
    value: call.value ?? 0n,
  });
  return track(hash, kind, sentAt);
}

/** Logs in to Privy with the test wallet by Sign-In with Ethereum, as the Privy SDK does. */
async function privyLogin() {
  const appId = process.env.PRIVY_APP_ID ?? "";
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    "privy-app-id": appId,
    "privy-client": "react-auth:3.47.0",
    origin: "http://localhost:3000",
  };
  const init = await fetch("https://auth.privy.io/api/v1/siwe/init", {
    method: "POST",
    headers,
    body: JSON.stringify({ address: account.address }),
  });
  const { nonce } = /** @type {{ nonce: string }} */ (await init.json());
  const message = [
    `localhost:3000 wants you to sign in with your Ethereum account:`,
    account.address,
    "",
    "By signing, you are proving you own this wallet and logging in. This does not initiate a transaction or cost any fees.",
    "",
    "URI: http://localhost:3000",
    "Version: 1",
    `Chain ID: ${TESTNET.chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${new Date().toISOString()}`,
    "Resources:",
    "- https://privy.io",
  ].join("\n");
  const signature = await account.signMessage({ message });
  const auth = await fetch("https://auth.privy.io/api/v1/siwe/authenticate", {
    method: "POST",
    headers,
    body: JSON.stringify({
      message,
      signature,
      chainId: `eip155:${TESTNET.chainId}`,
      walletClientType: "metamask",
      connectorType: "injected",
      mode: "login-or-sign-up",
    }),
  });
  const body = /** @type {{ token?: string }} */ (await auth.json());
  if (auth.status !== 200 || !body.token) throw new Error(`Privy login answered ${auth.status}`);
  secrets.push(body.token);
  return body.token;
}

/** The testnet stack's own wallet-free helpers. @param {string} args */
function pnpmRun(args) {
  const r = spawnSync("node", args.split(" "), { cwd: ROOT, encoding: "utf8" });
  return redact(`${r.stdout ?? ""}${r.stderr ?? ""}`, secrets).trim();
}

try {
  await assertTestnet(url);
  if (
    !(await fetch(`${API}/health`)
      .then((r) => r.ok)
      .catch(() => false))
  )
    throw new Error("the testnet stack is not running; start it with pnpm testnet:up");
  const health = await api("/health");
  if (
    health.body?.environment?.chainId !== undefined &&
    health.body.environment.chainId !== TESTNET.chainId
  )
    throw new Error("the control API is not on testnet");

  // 1. Login and mint, then the real Entropy reveal and provisioning.
  const token = await privyLogin();
  step("privy login", { wallet: account.address });
  const owned = await api(`/v1/agents?owner=${account.address}`);
  let agentId = /** @type {number | null} */ (
    owned.body?.agents?.[0] ? Number(owned.body.agents[0].agentId) : null
  );
  if (agentId === null) {
    const eligible = await api(`/v1/mint/eligibility?wallet=${account.address}`, { token });
    step("mint eligibility", { status: eligible.status, reason: eligible.body?.reason });
    const claim = await api("/v1/mint/claim", {
      method: "POST",
      token,
      body: JSON.stringify({ wallet: account.address }),
    });
    if (claim.status !== 200)
      throw new Error(`mint claim refused: ${claim.status} ${claim.body?.error}`);
    const mintedAt = Date.now();
    const receipt = await send("mint", {
      to: getAddress(claim.body.contract),
      data: encodeFunctionData({
        abi: NFT_ABI,
        functionName: "mintWithClaim",
        args: [BigInt(claim.body.deadline), claim.body.nonce, claim.body.signature],
      }),
    });
    for (const log of receipt.logs) {
      try {
        const e = decodeEventLog({ abi: NFT_ABI, data: log.data, topics: log.topics });
        if (e.eventName === "Transfer") agentId = Number(e.args.tokenId);
      } catch {
        // another contract's event
      }
    }
    if (agentId === null) throw new Error("the mint receipt has no Transfer");
    await waitFor(
      "the indexer to show the agent",
      async () => (await api(`/v1/agents/${agentId}`)).status === 200,
      120_000,
      500,
    );
    step("indexed", { agentId, indexLagMs: Date.now() - mintedAt });
    run.mintBlockTimeMs = mintedAt;
  }
  run.agentId = agentId;
  const revealed = await waitFor(
    "the Pyth Entropy reveal",
    async () => {
      const a = await api(`/v1/agents/${agentId}`);
      return a.body?.agent?.species > 0 ? a.body.agent : null;
    },
    20 * 60_000,
    3_000,
  );
  const keeper = await api(`${ORCH}/v1/keeper`);
  step("revealed", { species: revealed.species, keeper: keeper.body?.recent ?? [] });
  const runtime = await waitFor(
    "provisioning",
    async () => {
      const r = await api(`${ORCH}/v1/runtimes`);
      const mine = (r.body?.runtimes ?? []).find(
        (/** @type {any} */ x) => Number(x.agentId) === agentId,
      );
      return mine?.status === "ready" ? mine : null;
    },
    10 * 60_000,
    3_000,
  );
  step("provisioned", { status: runtime.status, tier: runtime.tier });

  // 2. Owner session, credits by one USDC transfer, and a Scan.
  const sessionRes = await api(`/v1/agents/${agentId}/session`, { method: "POST", token });
  if (sessionRes.status !== 200)
    throw new Error(`owner session refused: ${sessionRes.status} ${sessionRes.body?.error}`);
  const session = /** @type {string} */ (sessionRes.body.token);
  secrets.push(session);
  const credits = (await api(`/v1/agents/${agentId}/credits`)).body;
  const funding = getAddress(credits.fundingAddress);
  if (BigInt(credits.creditsUsdcE6) < CREDITS_LOW_USDC_E6) {
    await send("credits transfer", {
      to: TESTNET.usdc,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [funding, CREDITS_USDC_E6],
      }),
    });
    const creditedAt = Date.now();
    await waitFor(
      "the credits",
      async () =>
        BigInt((await api(`/v1/agents/${agentId}/credits`)).body?.creditsUsdcE6 ?? "0") >=
        CREDITS_LOW_USDC_E6,
      180_000,
      1_000,
    );
    step("credited", { fundingAddress: funding, creditLagMs: Date.now() - creditedAt });
  }
  const scan = skipScan
    ? { status: 0, body: { error: "skipped (--skip-scan)" } }
    : await api(`/v1/agents/${agentId}/scan`, { method: "POST", session });
  step("scan requested", {
    status: scan.status,
    taskId: scan.body?.taskId,
    error: scan.body?.error,
  });
  if (scan.body?.taskId) {
    const done = await waitFor(
      "the Scan",
      async () => {
        const t = await api(`${ORCH}/v1/tasks/${scan.body.taskId}`);
        return ["succeeded", "failed"].includes(t.body?.task?.status ?? t.body?.status)
          ? t.body
          : null;
      },
      15 * 60_000,
      5_000,
    );
    step("scan finished", {
      status: done.task?.status ?? done.status,
      error: done.task?.error ?? done.error ?? null,
    });
  }

  // 3. Gas for the agent's session key (testnet has no top-up), then the account.
  step("gas for the funding address", {
    output: pnpmRun(`scripts/testnet-gas.js ${agentId}`).split("\n"),
  });
  let portfolio = (await api(`/v1/agents/${agentId}/portfolio`, { session })).body?.portfolio;
  if (!portfolio) throw new Error("the portfolio route answered nothing");
  if (!portfolio.account) {
    await send("create PersonalAccount", {
      to: getAddress(portfolio.contracts.accountFactory),
      data: encodeFunctionData({
        abi: FACTORY_ABI,
        functionName: "createPersonalAccount",
        args: [BigInt(agentId)],
      }),
    });
    portfolio = await waitFor(
      "the account",
      async () => {
        const p = (await api(`/v1/agents/${agentId}/portfolio`, { session })).body?.portfolio;
        return p?.account ? p : null;
      },
      60_000,
    );
  }
  const accountAddress = getAddress(portfolio.account);
  if (BigInt(portfolio.balances.usdcE6) < DEPOSIT_USDC_E6) {
    const fresh = await api(`/v1/agents/${agentId}/prices/fresh`, { method: "POST", session });
    step("fresh prices before the deposit", fresh.body ?? {});
    await send("approve (exact)", {
      to: TESTNET.usdc,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [accountAddress, DEPOSIT_USDC_E6],
      }),
    });
    await send("deposit", {
      to: accountAddress,
      data: encodeFunctionData({
        abi: ACCOUNT_ABI,
        functionName: "deposit",
        args: [TESTNET.usdc, DEPOSIT_USDC_E6],
      }),
    });
  }
  step("account", { account: accountAddress });

  // 4. Arm, a proposal approved by the owner, and its settlement at finalized.
  const arming = await api(`/v1/agents/${agentId}/arming`, { session });
  if (arming.body?.arming?.state === "unarmed") {
    const call = arming.body.grantCall;
    if (!call) throw new Error(`no grant call: ${JSON.stringify(arming.body).slice(0, 200)}`);
    await send("arm (registerSession)", { to: getAddress(call.to), data: call.data });
    const confirmed = await api(`/v1/agents/${agentId}/arming`, { method: "POST", session });
    step("arming recorded", { status: confirmed.status, state: confirmed.body?.arming?.state });
  }
  const intents = async () =>
    (await api(`/v1/agents/${agentId}/intents`, { session })).body?.intents ?? [];
  const before = new Set((await intents()).map((/** @type {any} */ i) => i.intentId));
  step("propose", { output: pnpmRun(`scripts/testnet-stack.js propose ${agentId}`) });
  const proposal = await waitFor(
    "the agent's proposal",
    async () => (await intents()).find((/** @type {any} */ i) => !before.has(i.intentId)),
    10 * 60_000,
    5_000,
  );
  step("proposed", {
    intentId: proposal.intentId,
    status: proposal.status,
    sell: proposal.sell,
    blockers: proposal.blockers,
  });
  if (proposal.status === "awaiting_approval") {
    const approved = await api(`/v1/agents/${agentId}/intents/${proposal.intentId}/approve`, {
      method: "POST",
      session,
    });
    step("approved", { status: approved.status, armed: approved.body?.armed });
  }
  const approvedAt = Date.now();
  const settled = await waitFor(
    "the trade to settle",
    async () => {
      const i = (await intents()).find((/** @type {any} */ x) => x.intentId === proposal.intentId);
      return i &&
        ["settled", "reconciled", "failed", "rejected", "expired", "cancelled"].includes(i.status)
        ? i
        : null;
    },
    10 * 60_000,
    1_000,
  );
  step("trade outcome", {
    status: settled.status,
    txHash: settled.txHash,
    amountOut: settled.amountOut,
    failure: settled.failure,
    approveToSettleMs: Date.now() - approvedAt,
  });
  if (settled.txHash)
    await track(settled.txHash, "swap (signer, Executor, P2-EC pool)", approvedAt);

  // 5. A blocked trade with its reason.
  const beforeOver = new Set((await intents()).map((/** @type {any} */ i) => i.intentId));
  step("over-limit proposal", {
    output: pnpmRun(`scripts/testnet-stack.js propose ${agentId} --over-limit`),
  });
  const blocked = await waitFor(
    "the over-limit proposal's outcome",
    async () => {
      const i = (await intents()).find((/** @type {any} */ x) => !beforeOver.has(x.intentId));
      return i && !["awaiting_approval", "approved", "submitted", "confirmed"].includes(i.status)
        ? i
        : null;
    },
    5 * 60_000,
    2_000,
  );
  const why = await api(`/v1/agents/${agentId}/why-not-traded`);
  step("blocked", {
    status: blocked.status,
    reasonCodes: blocked.reasonCodes,
    failure: blocked.failure,
    txHash: blocked.txHash,
    why: why.body,
  });

  // 6. Disarm and withdraw everything.
  const disarm = await api(`/v1/agents/${agentId}/disarm`, { method: "POST", session });
  step("disarm", { status: disarm.status, state: disarm.body?.arming?.state });
  const revoke = disarm.body?.revokeCall ?? disarm.body?.call;
  if (revoke)
    await send("disarm (revokeSession)", { to: getAddress(revoke.to), data: revoke.data });
  await send("withdraw all", {
    to: accountAddress,
    data: encodeFunctionData({
      abi: ACCOUNT_ABI,
      functionName: "withdrawAll",
      args: [account.address],
    }),
  });
  const left = (await api(`/v1/agents/${agentId}/portfolio`, { session })).body?.portfolio;
  step("after withdrawal", { balances: left?.balances, mode: left?.mode });
  run.finishedAt = new Date().toISOString();
  run.ok = true;
} catch (err) {
  run.ok = false;
  run.error = redact(err instanceof Error ? err.message : String(err), secrets);
  say(`FAILED: ${run.error}`);
}
mkdirSync(join(ROOT, "evidence/p2-ec"), { recursive: true });
const file = join(
  ROOT,
  "evidence/p2-ec",
  `e2e-run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
);
writeFileSync(
  file,
  `${redact(
    JSON.stringify(run, (_k, v) => (typeof v === "bigint" ? String(v) : v), 2),
    secrets,
  )}\n`,
);
say(`recorded in ${file}`);
process.exit(run.ok ? 0 : 1);
