// @ts-check
// pnpm dev:e2e: 2026-10-16, the monad-dev stack end to end with its own test wallet, through its
// control API (DEV_API, default the owner's tunnel http://127.0.0.1:4410) as the web app drives it:
// a Privy login by Sign-In with Ethereum, the mint claim and the Pyth Entropy reveal, an
// Aggressive goal, credits and a deposit in the stack's test USDC (nad.fun's, open mint), arming,
// Research now, the first plan approved, the runner's trades settling by themselves, then a second
// Research now whose plan applies at once (plan changes: apply and tell) and rebalances. Records
// evidence/dev-nadfun/e2e-run-*.json. Prints no key, token or RPC URL.
//
//   pnpm dev:e2e [--skip-second]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_GOAL_INPUT, NADFUN_TESTNET } from "@alpha-agents/domain";
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

loadRootEnv();
const API = process.env.DEV_API?.trim() || "http://127.0.0.1:4410";
const ORIGIN = "http://localhost:3100";
const USDC = getAddress(NADFUN_TESTNET.bases.usdc);
const DEPOSIT_E6 = 100_000_000n;
const CREDITS_E6 = 20_000_000n;
const skipSecond = process.argv.includes("--skip-second");
const devEnv = Object.fromEntries(
  readFileSync(join(ROOT, ".env.monad-dev"), "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const url = (
  process.env.MONAD_TESTNET_RPC_URL_SECONDARY ||
  process.env.MONAD_TESTNET_RPC_URL ||
  ""
).trim();
const account = privateKeyToAccount(
  /** @type {`0x${string}`} */ (devEnv.TESTNET_TEST_WALLET_PRIVATE_KEY),
);
const chain = {
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [] } },
};
const client = createPublicClient({ chain, transport: http(url) });
const wallet = createWalletClient({ account, chain, transport: http(url) });
const secrets = [url];
const started = Date.now();
/** @type {Record<string, any>} */
const run = { wallet: account.address, api: API, startedAt: new Date().toISOString(), steps: [] };
const say = (/** @type {string} */ line) =>
  console.log(
    `[${((Date.now() - started) / 1000).toFixed(0).padStart(5)} s] ${redact(line, secrets)}`,
  );
const step = (/** @type {string} */ name, data = {}) => {
  run.steps.push({ name, at: new Date().toISOString(), ...data });
  say(`${name} ${JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? String(v) : v))}`);
};
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** @template T @param {string} what @param {() => Promise<T>} read */
async function waitFor(what, read, timeoutMs, everyMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await read().catch(() => null);
    if (v) return /** @type {NonNullable<T>} */ (v);
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
  const res = await fetch(`${API}${path}`, { ...init, headers });
  return { status: res.status, body: /** @type {any} */ (await res.json().catch(() => null)) };
}

async function send(
  /** @type {string} */ kind,
  /** @type {{ to: `0x${string}`, data: `0x${string}` }} */ call,
) {
  const hash = await wallet.sendTransaction({ to: call.to, data: call.data, value: 0n });
  const r = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  step(kind, { hash, status: r.status, gasUsed: r.gasUsed });
  if (r.status !== "success") throw new Error(`${kind} reverted (${hash})`);
  return r;
}

const NFT_ABI = parseAbi([
  "function mintWithClaim(uint64 deadline, bytes32 nonce, bytes signature)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);
const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
]);
const FACTORY_ABI = parseAbi(["function createPersonalAccount(uint256 agentId) returns (address)"]);
const ACCOUNT_ABI = parseAbi(["function deposit(address token, uint256 amount)"]);

async function privyLogin() {
  const appId = process.env.PRIVY_APP_ID ?? "";
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    "privy-app-id": appId,
    "privy-client": "react-auth:3.47.0",
    origin: ORIGIN,
  };
  const init = await fetch("https://auth.privy.io/api/v1/siwe/init", {
    method: "POST",
    headers,
    body: JSON.stringify({ address: account.address }),
  });
  const { nonce } = /** @type {{ nonce: string }} */ (await init.json());
  const message = [
    `localhost:3100 wants you to sign in with your Ethereum account:`,
    account.address,
    "",
    "By signing, you are proving you own this wallet and logging in. This does not initiate a transaction or cost any fees.",
    "",
    `URI: ${ORIGIN}`,
    "Version: 1",
    "Chain ID: 10143",
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
      chainId: "eip155:10143",
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

/** One Research now, followed to its end; returns the cycle as the research view shows it. */
async function researchNow(
  /** @type {number} */ agentId,
  /** @type {string} */ session,
  /** @type {string} */ label,
) {
  const r = await waitFor(
    "Research now to start",
    async () => {
      const x = await api(`/v1/agents/${agentId}/research-run`, { method: "POST", session });
      if (x.status === 202) return x;
      step(`${label}: research-run refused`, {
        status: x.status,
        error: x.body?.error,
        message: x.body?.message,
      });
      return x.body?.error === "not_provisioned" || x.body?.error === "lease_held" ? null : x;
    },
    10 * 60_000,
    15_000,
  );
  if (r.status !== 202) throw new Error(`${label}: research-run refused: ${r.body?.error}`);
  const cycleId = r.body.cycleId;
  step(`${label}: research started`, { cycleId });
  const cycle = await waitFor(
    `${label}: the research run`,
    async () => {
      const v = (await api(`/v1/agents/${agentId}/research`, { session })).body;
      const c = (v?.cycles ?? []).find((/** @type {any} */ x) => x.cycleId === cycleId);
      return c && c.finishedAt && v.open?.cycleId !== cycleId ? c : null;
    },
    40 * 60_000,
    20_000,
  );
  step(`${label}: research finished`, {
    status: cycle.status,
    stopReason: cycle.stopReason ?? null,
    charged: cycle.chargedUsdcE6,
    stages: cycle.stages.map((/** @type {any} */ s) => `${s.stage}:${s.status}`),
  });
  return cycle;
}

/** The plan card's pending proposal or the plan in force, with its positions by symbol. */
async function planCard(/** @type {number} */ agentId, /** @type {string} */ session) {
  return (await api(`/v1/agents/${agentId}/plan-card`, { session })).body;
}

/** Waits until every intent since `since` is settled or failed, and at least `min` exist. */
async function trades(
  /** @type {number} */ agentId,
  /** @type {string} */ session,
  /** @type {Set<string>} */ since,
  label,
  min = 1,
) {
  const done = await waitFor(
    `${label}: the runner's trades`,
    async () => {
      const all = (await api(`/v1/agents/${agentId}/intents`, { session })).body?.intents ?? [];
      const mine = all.filter((/** @type {any} */ i) => !since.has(i.intentId));
      const open = mine.filter(
        (/** @type {any} */ i) =>
          !["settled", "reconciled", "failed", "rejected", "expired", "cancelled"].includes(
            i.status,
          ),
      );
      return mine.length >= min && open.length === 0 ? mine : null;
    },
    40 * 60_000,
    15_000,
  );
  step(`${label}: trades`, {
    count: done.length,
    trades: done.map((/** @type {any} */ i) => ({
      status: i.status,
      sell: `${i.sell?.amount} ${i.sell?.asset}`,
      buy: i.buy,
      amountOut: i.amountOut,
      txHash: i.txHash,
      failure: i.failure ?? null,
    })),
  });
  return done;
}

try {
  const health = await api("/health");
  if (health.status !== 200)
    throw new Error("the dev stack's API is not reachable (is the tunnel up?)");
  const token = await privyLogin();
  step("privy login", { wallet: account.address });

  // 1. Mint and reveal.
  const owned = await api(`/v1/agents?owner=${account.address}`);
  let agentId = owned.body?.agents?.[0] ? Number(owned.body.agents[0].agentId) : null;
  if (agentId === null) {
    const claim = await api("/v1/mint/claim", {
      method: "POST",
      token,
      body: JSON.stringify({ wallet: account.address }),
    });
    if (claim.status !== 200)
      throw new Error(`mint claim refused: ${claim.status} ${claim.body?.error}`);
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
  }
  run.agentId = agentId;
  const revealed = await waitFor(
    "the Pyth Entropy reveal",
    async () => {
      const a = await api(`/v1/agents/${agentId}`);
      return a.body?.agent?.species > 0 ? a.body.agent : null;
    },
    20 * 60_000,
  );
  step("revealed", { agentId, species: revealed.species });

  // 2. Owner session and an Aggressive goal whose later plans apply and tell.
  const sessionRes = await api(`/v1/agents/${agentId}/session`, { method: "POST", token });
  if (sessionRes.status !== 200)
    throw new Error(`owner session refused: ${sessionRes.status} ${sessionRes.body?.error}`);
  const session = sessionRes.body.token;
  secrets.push(session);
  const goal = {
    ...DEFAULT_GOAL_INPUT,
    aggressiveness: "AGGRESSIVE",
    planChanges: "APPLY_AND_TELL",
    research: { intensity: "LIGHT", dailyBudgetUsdcE6: "10000000" },
  };
  const saved = await api(`/v1/agents/${agentId}/goal`, {
    method: "PUT",
    session,
    body: JSON.stringify(goal),
  });
  step("goal", { status: saved.status, error: saved.body?.error, errors: saved.body?.errors });
  if (saved.status !== 200) throw new Error("the goal was refused");

  // 3. Test USDC, credits, the account and a deposit.
  await send("mint test USDC", {
    to: USDC,
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "mint",
      args: [account.address, DEPOSIT_E6 + CREDITS_E6],
    }),
  });
  const credits = (await api(`/v1/agents/${agentId}/credits`)).body;
  if (BigInt(credits?.creditsUsdcE6 ?? "0") < CREDITS_E6 / 2n) {
    await send("credits transfer", {
      to: USDC,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [getAddress(credits.fundingAddress), CREDITS_E6],
      }),
    });
    await waitFor(
      "the credits",
      async () =>
        BigInt((await api(`/v1/agents/${agentId}/credits`)).body?.creditsUsdcE6 ?? "0") >=
        CREDITS_E6 / 2n,
      300_000,
    );
    step("credited", { usdc: Number(CREDITS_E6) / 1e6 });
  }
  let portfolio = (await api(`/v1/agents/${agentId}/portfolio`, { session })).body?.portfolio;
  if (!portfolio?.account) {
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
      120_000,
    );
  }
  const accountAddress = getAddress(portfolio.account);
  await send("approve (exact)", {
    to: USDC,
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [accountAddress, DEPOSIT_E6],
    }),
  });
  await send("deposit", {
    to: accountAddress,
    data: encodeFunctionData({
      abi: ACCOUNT_ABI,
      functionName: "deposit",
      args: [USDC, DEPOSIT_E6],
    }),
  });
  step("account", { account: accountAddress, depositUsdc: Number(DEPOSIT_E6) / 1e6 });

  // 4. Arm: automatic trading on.
  const arming = await api(`/v1/agents/${agentId}/arming`, { session });
  if (arming.body?.arming?.state === "unarmed") {
    const call = arming.body.grantCall;
    if (!call) throw new Error(`no grant call: ${JSON.stringify(arming.body).slice(0, 300)}`);
    await send("arm (registerSession)", { to: getAddress(call.to), data: call.data });
    const confirmed = await api(`/v1/agents/${agentId}/arming`, { method: "POST", session });
    step("armed", { status: confirmed.status, state: confirmed.body?.arming?.state });
  }

  // 5. Research now, the first plan approved, and the runner's trades.
  const before = new Set(
    ((await api(`/v1/agents/${agentId}/intents`, { session })).body?.intents ?? []).map(
      (/** @type {any} */ i) => i.intentId,
    ),
  );
  await researchNow(agentId, session, "first run");
  let card = await planCard(agentId, session);
  step("first plan", {
    pending: card?.pending
      ? {
          id: card.pending.proposalId,
          status: card.pending.status,
          positions: card.pending.positions?.map(
            (/** @type {any} */ p) => `${p.symbol} ${p.targetWeightBps / 100}%`,
          ),
        }
      : null,
    current:
      card?.current?.positions?.map(
        (/** @type {any} */ p) => `${p.symbol} ${p.targetWeightBps / 100}%`,
      ) ?? null,
  });
  if (card?.pending?.status === "pending_owner") {
    const ok = await api(`/v1/agents/${agentId}/proposals/${card.pending.proposalId}/approve`, {
      method: "POST",
      session,
    });
    step("first plan approved", { status: ok.status, error: ok.body?.error });
  }
  run.firstTrades = await trades(agentId, session, before, "first run", 2);

  // 6. A second Research now: its plan applies at once and the runner rebalances.
  if (!skipSecond) {
    const before2 = new Set(
      ((await api(`/v1/agents/${agentId}/intents`, { session })).body?.intents ?? []).map(
        (/** @type {any} */ i) => i.intentId,
      ),
    );
    await researchNow(agentId, session, "second run");
    card = await planCard(agentId, session);
    step("second plan", {
      current:
        card?.current?.positions?.map(
          (/** @type {any} */ p) => `${p.symbol} ${p.targetWeightBps / 100}%`,
        ) ?? null,
      recent:
        card?.recent
          ?.slice(0, 2)
          ?.map((/** @type {any} */ p) => ({ status: p.status, kind: p.kind })) ?? null,
    });
    run.secondTrades = await trades(agentId, session, before2, "second run", 1).catch((e) => {
      step("second run: no trades", { why: String(e.message) });
      return [];
    });
  }
  const final = (await api(`/v1/agents/${agentId}/portfolio`, { session })).body?.portfolio;
  step("portfolio", {
    holdings: final?.holdings?.map((/** @type {any} */ h) => `${h.symbol} ${h.amount}`) ?? null,
    value: final?.totalValueUsdc ?? final?.valueUsdc ?? null,
  });
  run.ok = true;
} catch (err) {
  run.ok = false;
  run.error = redact(err instanceof Error ? err.message : String(err), secrets);
  say(`FAILED: ${run.error}`);
}
mkdirSync(join(ROOT, "evidence/dev-nadfun"), { recursive: true });
const file = join(
  ROOT,
  "evidence/dev-nadfun",
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
