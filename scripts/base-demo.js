// @ts-check
// pnpm base:demo (M-FAST): the agent on Base, end to end, through the running
// Base fork stack (pnpm base:fork:up, pnpm base:deploy, pnpm base:up) exactly
// as the web app drives it: a demo owner (anvil account 6, on the factory's
// deposit allowlist) with ETH and real Base USDC on the fork, an agent minted
// on the fork's AgentNFT and revealed, credits by a USDC transfer, an
// Aggressive goal, the PersonalAccountV3 opened and funded, the grant on
// Executor v3, then the activation sweep (the agent researches Base's tokens
// and proposes a portfolio), the plan approved as the owner, and the runner's
// trades through the real Base pools on the fork. Everything the agent saw,
// looked up, proposed and settled is printed and written to
// evidence/m-fast/demo-run-*.json. Prints no key, token or RPC URL.
//
//   pnpm base:demo                       the whole run with the demo owner
//   pnpm base:demo --owner 0x...         also mints an agent to that wallet and funds it with ETH and
//                                        USDC on the fork, for the owner's own run in the web app
//   pnpm base:demo --prepare-only        funds and mints, and stops before the sweep
process.env.FORK_ENV = "base";
process.env.APP_ENV = "base";
const { mkdirSync, writeFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { DEFAULT_GOAL_INPUT, addressEntry } = await import("@alpha-agents/domain");
const { redact, rpc } = await import("@alpha-agents/devenv");
const { createPublicClient, formatUnits, getAddress, http, isAddress, parseAbi, toHex } =
  await import("viem");
const { mnemonicToAccount } = await import("viem/accounts");
const { ANVIL_URL, loadRootEnv } = await import("./lib/config.js");
const { ROOT } = await import("./lib/paths.js");
const { ANVIL_MNEMONIC, mintLocal } = await import("./lib/agent-mint.js");
const { impersonate, revealLocal, send } = await import("./lib/agent-reveal.js");
const { LOCAL_TEST_OWNERS } = await import("./lib/account-factory.js");

loadRootEnv();
const API = "http://127.0.0.1:4110";
const ORCH = "http://127.0.0.1:4210";
const BASE_FORK_CHAIN_ID = 84538453;
/** Privy knows Base mainnet; the login message names it (the session is the fork's). */
const SIWE_CHAIN_ID = 8453;
const OWNER_ETH = 10n ** 19n; // 10 ETH
const OWNER_USDC_E6 = 5_000_000_000n; // 5,000 USDC
const DEPOSIT_USDC_E6 = 1_000_000_000n; // 1,000 USDC into the trading account
const CREDITS_USDC_E6 = 25_000_000n; // 25 USDC of credits: the sweep's ceiling is well under
const CREDITS_LOW_USDC_E6 = 10_000_000n;
const SWEEP_TIMEOUT_MS = 30 * 60_000;
const TRADES_TIMEOUT_MS = 12 * 60_000;

const args = process.argv.slice(2);
const prepareOnly = args.includes("--prepare-only");
const ownerArg = args[args.indexOf("--owner") + 1];
const extraOwner = args.includes("--owner") ? (ownerArg ?? "") : null;
if (extraOwner !== null && !isAddress(extraOwner)) {
  console.error("--owner takes a wallet address");
  process.exit(1);
}

const USDC_ABI = parseAbi([
  "function masterMinter() view returns (address)",
  "function configureMinter(address minter, uint256 minterAllowedAmount) returns (bool)",
  "function mint(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function paused() view returns (bool)",
]);
const FACTORY_ABI = parseAbi(["function createPersonalAccount(uint256 agentId) returns (address)"]);
const ACCOUNT_ABI = parseAbi(["function deposit(address token, uint256 amount)"]);

const book = (/** @type {Parameters<typeof addressEntry>[1]} */ id) => {
  const e = addressEntry("base", id);
  if (e.status !== "verified") throw new Error(`${id} is not deployed on the Base fork`);
  return getAddress(e.address);
};
const nft = book("agent_nft");
const usdc = book("usdc");
const factoryV3 = book("account_factory_v3");
const client = createPublicClient({ transport: http(ANVIL_URL) });
const demoOwner = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 6 });
if (!LOCAL_TEST_OWNERS[0] || getAddress(LOCAL_TEST_OWNERS[0]) !== demoOwner.address)
  throw new Error("anvil account 6 is not the first local test owner");

const started = Date.now();
/** @type {Record<string, unknown>} */
const run = { owner: demoOwner.address, startedAt: new Date().toISOString(), steps: [] };
/** @type {string[]} */
const secrets = [];
const say = (/** @type {string} */ line) =>
  console.log(
    `[${((Date.now() - started) / 1000).toFixed(0).padStart(4)} s] ${redact(line, secrets)}`,
  );
const step = (/** @type {string} */ name, /** @type {Record<string, unknown>} */ data = {}) => {
  /** @type {unknown[]} */ (run.steps).push({ name, at: new Date().toISOString(), ...data });
  say(`${name} ${JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? String(v) : v))}`);
};
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
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

/** Real Base USDC on the fork: Circle's master minter, impersonated, allows itself and mints. */
async function mintUsdc(/** @type {`0x${string}`} */ to, /** @type {bigint} */ amountE6) {
  const masterMinter = await client.readContract({
    address: usdc,
    abi: USDC_ABI,
    functionName: "masterMinter",
  });
  if (await client.readContract({ address: usdc, abi: USDC_ABI, functionName: "paused" }))
    throw new Error("USDC is paused on the fork");
  await impersonate(masterMinter);
  await send(masterMinter, {
    address: usdc,
    abi: USDC_ABI,
    functionName: "configureMinter",
    args: [masterMinter, 10n ** 15n],
  });
  await send(masterMinter, {
    address: usdc,
    abi: USDC_ABI,
    functionName: "mint",
    args: [to, amountE6],
  });
  await rpc(ANVIL_URL, "anvil_stopImpersonatingAccount", [masterMinter]);
}

async function usdcBalance(/** @type {`0x${string}`} */ who) {
  return client.readContract({
    address: usdc,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: [who],
  });
}

/** Funds a wallet on the fork with ETH for gas and real USDC, and mints it an agent if it has none. */
async function prepareOwner(/** @type {`0x${string}`} */ owner) {
  await rpc(ANVIL_URL, "anvil_setBalance", [owner, toHex(OWNER_ETH)]);
  const held = await usdcBalance(owner);
  if (held < OWNER_USDC_E6) await mintUsdc(owner, OWNER_USDC_E6 - held);
  const owned = await api(`/v1/agents?owner=${owner}`);
  let agentId = owned.body?.agents?.[0] ? Number(owned.body.agents[0].agentId) : null;
  let minted = false;
  if (agentId === null) {
    const m = await mintLocal(nft, owner);
    agentId = Number(m.agentId);
    minted = true;
    // The reveal as the keeper would do it on the fork: Pyth's Base Entropy, impersonated.
    await revealLocal(nft);
  }
  step("owner prepared", {
    owner,
    agentId,
    minted,
    usdc: formatUnits(await usdcBalance(owner), 6),
  });
  return agentId;
}

/** Logs in to Privy with the demo owner's key by Sign-In with Ethereum, as the Privy SDK does. */
async function privyLogin() {
  const appId = process.env.PRIVY_APP_ID ?? "";
  if (!appId) throw new Error("PRIVY_APP_ID is not set");
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
    body: JSON.stringify({ address: demoOwner.address }),
  });
  const { nonce } = /** @type {{ nonce: string }} */ (await init.json());
  const message = [
    "localhost:3000 wants you to sign in with your Ethereum account:",
    demoOwner.address,
    "",
    "By signing, you are proving you own this wallet and logging in. This does not initiate a transaction or cost any fees.",
    "",
    "URI: http://localhost:3000",
    "Version: 1",
    `Chain ID: ${SIWE_CHAIN_ID}`,
    `Nonce: ${nonce}`,
    `Issued At: ${new Date().toISOString()}`,
    "Resources:",
    "- https://privy.io",
  ].join("\n");
  const signature = await demoOwner.signMessage({ message });
  const auth = await fetch("https://auth.privy.io/api/v1/siwe/authenticate", {
    method: "POST",
    headers,
    body: JSON.stringify({
      message,
      signature,
      chainId: `eip155:${SIWE_CHAIN_ID}`,
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

/** One line per activation step, printed when it changes. */
const seen = new Map();
function printSteps(/** @type {any} */ view) {
  for (const s of view?.steps ?? []) {
    const line = `${s.label}: ${s.state}${s.result ? ` (${s.result})` : ""}${s.reason ? ` [${s.reason}]` : ""}`;
    if (seen.get(s.key) !== line) {
      seen.set(s.key, line);
      say(`   step ${line}`);
    }
  }
}

try {
  const chainId = await client.getChainId();
  if (chainId !== BASE_FORK_CHAIN_ID)
    throw new Error(`the fork answers chain ${chainId}, not the Base fork's ${BASE_FORK_CHAIN_ID}`);
  const health = await api("/health");
  if (health.status !== 200)
    throw new Error("the Base stack is not running; start it with pnpm base:up");
  if (
    health.body?.environment?.chainId !== undefined &&
    health.body.environment.chainId !== chainId
  )
    throw new Error("the control API is not on the Base fork");
  step("stack", { fork: ANVIL_URL, block: Number(await client.getBlockNumber()) });

  // 1. The owners: the demo owner, and the owner's own wallet when asked.
  if (extraOwner) run.extraOwnerAgentId = await prepareOwner(getAddress(extraOwner));
  const agentId = await prepareOwner(demoOwner.address);
  run.agentId = agentId;
  await waitFor(
    "the indexer to show the agent",
    async () => (await api(`/v1/agents/${agentId}`)).status === 200,
    120_000,
    500,
  );
  const revealed = await waitFor(
    "the reveal in the index",
    async () => {
      const a = await api(`/v1/agents/${agentId}`);
      return a.body?.agent?.species > 0 ? a.body.agent : null;
    },
    5 * 60_000,
    2_000,
  );
  step("indexed", { agentId, species: revealed.species, tier: revealed.tier });
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
  if (prepareOnly) {
    step("prepared only", { agentId });
    run.ok = true;
    throw new Error("__done__");
  }

  // 2. The owner session, credits and gas for the agent's own addresses.
  const token = await privyLogin();
  const sessionRes = await api(`/v1/agents/${agentId}/session`, { method: "POST", token });
  if (sessionRes.status !== 200)
    throw new Error(`owner session refused: ${sessionRes.status} ${sessionRes.body?.error}`);
  const session = /** @type {string} */ (sessionRes.body.token);
  secrets.push(session);
  step("owner session", { wallet: demoOwner.address });
  const credits = (await api(`/v1/agents/${agentId}/credits`)).body;
  const funding = getAddress(credits.fundingAddress);
  await rpc(ANVIL_URL, "anvil_setBalance", [funding, toHex(10n ** 18n)]);
  if (BigInt(credits.creditsUsdcE6 ?? "0") < CREDITS_LOW_USDC_E6) {
    await mintUsdc(funding, CREDITS_USDC_E6);
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

  // 3. The goal: Aggressive, the rest as the form's defaults.
  const goal = await api(`/v1/agents/${agentId}/goal`, {
    method: "PUT",
    session,
    body: JSON.stringify({ ...DEFAULT_GOAL_INPUT, aggressiveness: "AGGRESSIVE" }),
  });
  if (goal.status !== 200)
    throw new Error(`goal refused: ${goal.status} ${JSON.stringify(goal.body)}`);
  step("goal", { state: goal.body.state, aggressiveness: goal.body.goal?.aggressiveness });

  // 4. The trading account, opened and funded by the owner (impersonated on the fork).
  await impersonate(demoOwner.address);
  let portfolio = (await api(`/v1/agents/${agentId}/portfolio`, { session })).body?.portfolio;
  if (!portfolio) throw new Error("the portfolio route answered nothing");
  if (!portfolio.account) {
    await send(demoOwner.address, {
      address: factoryV3,
      abi: FACTORY_ABI,
      functionName: "createPersonalAccount",
      args: [BigInt(agentId)],
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
  const account = getAddress(portfolio.account);
  const inAccount = await usdcBalance(account);
  if (inAccount < DEPOSIT_USDC_E6) {
    const fresh = await api(`/v1/agents/${agentId}/prices/fresh`, { method: "POST", session });
    step("fresh prices before the deposit", { status: fresh.status });
    await send(demoOwner.address, {
      address: usdc,
      abi: USDC_ABI,
      functionName: "approve",
      args: [account, DEPOSIT_USDC_E6 - inAccount],
    });
    await send(demoOwner.address, {
      address: account,
      abi: ACCOUNT_ABI,
      functionName: "deposit",
      args: [usdc, DEPOSIT_USDC_E6 - inAccount],
    });
  }
  step("account", { account, usdc: formatUnits(await usdcBalance(account), 6) });

  // 5. The grant on Executor v3 (the fork's dev route registers it as the owner's wallet would).
  const arming = await api(`/v1/agents/${agentId}/arming`, { session });
  if (arming.body?.arming?.state !== "armed") {
    const armed = await api(`${ORCH}/v1/agents/${agentId}/arm`, {
      method: "POST",
      body: JSON.stringify({ days: 30, account: "personal" }),
    });
    if (armed.status !== 201)
      throw new Error(`arm refused: ${armed.status} ${JSON.stringify(armed.body)}`);
    step("armed", { managed: armed.body.managed, state: armed.body.arming?.state });
  }

  // 6. The activation sweep: the agent researches Base and proposes a portfolio.
  const startRes = await api(`${ORCH}/v1/agents/${agentId}/activation`, { method: "POST" });
  if (startRes.status !== 202)
    throw new Error(`activation refused: ${startRes.status} ${JSON.stringify(startRes.body)}`);
  step("sweep started", {
    activationId: startRes.body.activation?.activationId,
    tier: startRes.body.activation?.tier,
    ceilingUsdcE6: startRes.body.activation?.ceilingUsdcE6,
  });
  const sweep = await waitFor(
    "the sweep to finish",
    async () => {
      const v = (await api(`${ORCH}/v1/agents/${agentId}/activation`)).body?.activation;
      printSteps(v);
      return v && v.status !== "running" ? v : null;
    },
    SWEEP_TIMEOUT_MS,
    5_000,
  );
  step("sweep finished", {
    status: sweep.status,
    chargedUsdcE6: sweep.chargedUsdcE6,
    outcome: sweep.outcome,
    proposalId: sweep.proposalId,
  });
  run.activation = sweep;

  // What the agent saw and looked up: every tool call of the sweep.
  const calls = (await api(`${ORCH}/v1/agents/${agentId}/tool-calls`)).body;
  const callRows = (calls?.calls ?? calls?.toolCalls ?? []).map((/** @type {any} */ c) => ({
    tool: c.tool,
    status: c.status,
    summary: c.summary ?? null,
    input: c.input ?? null,
  }));
  run.toolCalls = callRows;
  say(`   ${callRows.length} tool calls in the sweep`);
  for (const c of callRows)
    say(
      `   ${c.tool} ${c.status}${c.summary ? ` ${JSON.stringify(c.summary).slice(0, 160)}` : ""}`,
    );

  // 7. The plan, approved as the owner (D-291: that is what arms the agent).
  const card = (await api(`/v1/agents/${agentId}/plan-card`, { session })).body;
  run.planCard = card;
  const pending = card?.pending ?? card?.proposal ?? null;
  say(`   plan card: ${JSON.stringify(card).slice(0, 600)}`);
  if (sweep.status === "plan_ready" && pending?.proposalId) {
    const approved = await api(`/v1/agents/${agentId}/proposals/${pending.proposalId}/approve`, {
      method: "POST",
      session,
    });
    step("plan approved", {
      status: approved.status,
      armed: approved.body?.armed,
      error: approved.body?.error,
      message: approved.body?.message,
    });
  } else {
    step("no plan to approve", { status: sweep.status, outcome: sweep.outcome });
  }

  // 8. The runner's trades through the real Base pools on the fork.
  const intents = async () =>
    (await api(`/v1/agents/${agentId}/intents`, { session })).body?.intents ?? [];
  const before = await intents();
  const terminal = ["settled", "reconciled", "failed", "rejected", "expired", "cancelled"];
  let quietSince = Date.now();
  let lastCount = before.length;
  const deadline = Date.now() + TRADES_TIMEOUT_MS;
  /** @type {any[]} */
  let all = before;
  while (Date.now() < deadline) {
    all = await intents();
    if (all.length !== lastCount) {
      lastCount = all.length;
      quietSince = Date.now();
    }
    const open = all.filter((/** @type {any} */ i) => !terminal.includes(i.status));
    // Nothing open and nothing new for two minutes: the runner is done with this plan for now.
    if (open.length === 0 && all.length > before.length && Date.now() - quietSince > 120_000) break;
    await sleep(5_000);
  }
  const trades = all.map((/** @type {any} */ i) => ({
    intentId: i.intentId,
    status: i.status,
    sell: i.sell,
    buy: i.buy,
    amountIn: i.amountIn ?? i.amount ?? null,
    amountOut: i.amountOut ?? null,
    txHash: i.txHash ?? null,
    failure: i.failure ?? null,
    reasonCodes: i.reasonCodes ?? null,
  }));
  run.trades = trades;
  step("trades", { count: trades.length });
  for (const t of trades)
    say(
      `   ${t.status} ${JSON.stringify(t.sell)} -> ${JSON.stringify(t.buy)} out ${t.amountOut ?? "?"} ${t.txHash ?? ""}${t.failure ? ` ${JSON.stringify(t.failure)}` : ""}`,
    );
  const after = (await api(`/v1/agents/${agentId}/portfolio`, { session })).body?.portfolio;
  run.portfolioAfter = after;
  step("portfolio after", {
    totalValueUsdcE6: after?.totalValueUsdcE6 ?? null,
    holdings:
      after?.holdings?.map((/** @type {any} */ h) => [h.symbol, h.amountRaw ?? h.amount]) ?? null,
  });
  run.finishedAt = new Date().toISOString();
  run.ok = true;
} catch (err) {
  if (!(err instanceof Error && err.message === "__done__")) {
    run.ok = false;
    run.error = redact(err instanceof Error ? err.message : String(err), secrets);
    say(`FAILED: ${run.error}`);
  }
}
const dir = join(ROOT, "evidence/m-fast");
mkdirSync(dir, { recursive: true });
const file = join(dir, `demo-run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(
  file,
  `${redact(
    JSON.stringify(run, (_k, v) => (typeof v === "bigint" ? String(v) : v), 2),
    secrets,
  )}\n`,
);
say(`recorded in ${file.replace(`${ROOT}/`, "")}`);
process.exit(run.ok ? 0 : 1);
