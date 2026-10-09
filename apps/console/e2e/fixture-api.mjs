// A fixed control API and orchestrator for the console's screenshot tests
// (P1-U4, P1-U5, P2-U4): the agents panel renders on the server, so it is served this
// instead of the real services, and the capture is the same on every run. Two
// agents: a revealed, provisioned bee and an unrevealed agent. The no-op task
// for agent 1 is queued, then reads as succeeded with a fixed result; agent 1
// has credits and its refund is sent at once (P1-U6). P1-U7: agent 1 has two
// activity entries and five tool calls (answered, refused and failed), and its
// Scan reads as succeeded with a fixed result.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import process from "node:process";
import { URL } from "node:url";

const PORT = Number(process.env.FIXTURE_API_PORT ?? 4199);
const body = JSON.stringify({
  environment: "fork",
  chainId: 143143,
  watermark: {
    block: 109670012,
    hash: `0x${"ab".repeat(32)}`,
    updatedAt: "2026-10-05T00:00:00.000Z",
  },
  agents: [
    {
      agentId: "1",
      owner: "0x683eE842A16f85e69883F433745263BFe8D55f76",
      tba: "0x6Fecdf055F91d41b74B73729844F9b16A579F6BF",
      species: 14,
      tier: "pro",
      ownerEpoch: "0",
      mintedBlock: 109670002,
      mintedTx: `0x${"cd".repeat(32)}`,
    },
    {
      agentId: "2",
      owner: "0x00000000000000000000000000000000000E2e01",
      tba: "0x7bA0000000000000000000000000000000000002",
      species: 0,
      tier: null,
      ownerEpoch: "0",
      mintedBlock: 109670010,
      mintedTx: `0x${"ef".repeat(32)}`,
    },
  ],
});

const runtimes = JSON.stringify({
  devActions: true,
  runtimes: [{ agentId: "1", status: "ready", latestTask: null }],
});
const task = JSON.stringify({
  taskId: "fixture-task",
  agentId: "1",
  kind: "noop",
  status: "succeeded",
  error: null,
  result: {
    kind: "noop",
    agentId: 1,
    tier: "pro",
    slots: 8,
    playbook: "tier-pro@0",
    replied: "NOOP_OK",
    modelCalls: 2,
    modelCallsOk: 2,
    sandboxStopped: true,
    timingsMs: { sandbox: 824, hermesBoot: 13667, run: 10159, total: 32427 },
    configHash: "92f01aabdc6097af43a687ebb497b03b1dba8cfbbb74e14cea6d2ceedf5a1eca",
  },
});

// P1-U6: agent 1 has credits (and 2 USDC held above the cap); agent 2 has a funding address and none.
const credits = JSON.stringify({
  enabled: true,
  agents: [
    {
      agentId: "1",
      fundingAddress: "0x9f8e2b1c0d3a4e5f60718293a4b5c6d7e8f90a1b",
      creditsUsdcE6: "4994400",
      spendableUsdcE6: "4994400",
      heldUsdcE6: "2000000",
      unsettledUsdcE6: "5600",
      fundingAddressUsdcE6: "7000000",
      restricted: false,
      spent24hUsdcE6: "5600",
      recent: [],
    },
    {
      agentId: "2",
      fundingAddress: "0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
      creditsUsdcE6: "0",
      spendableUsdcE6: "0",
      heldUsdcE6: "0",
      unsettledUsdcE6: "0",
      fundingAddressUsdcE6: "0",
      restricted: true,
      spent24hUsdcE6: "0",
      recent: [],
    },
  ],
});
const refund = JSON.stringify({
  refundId: "fixture-refund",
  agentId: "1",
  status: "sent",
  creditsUsdcE6: "4994400",
  heldUsdcE6: "2000000",
  txHash: `0x${"ef".repeat(32)}`,
  reason: null,
});

// P1-U7: activity entries (control API) and tool calls (orchestrator) for agent 1.
const activity = JSON.stringify({
  agentId: "1",
  entries: [
    {
      entryId: "act-3",
      kind: "intent",
      text: "Agent #1 proposed selling 2.5 USDC for WMON (about 99.9 WMON at the current quote). It passed every check and waits for the owner's approval.",
      renderedBy: "template",
      at: "2026-10-07T12:06:00.000Z",
    },
    {
      entryId: "act-2",
      kind: "scan",
      text: "Agent #1 searched for Monad DEX volume and network upgrades, read 1 page and flagged WMON at 55% confidence. Tools cost 0.022 USDC.",
      renderedBy: "narrator",
      at: "2026-10-06T16:42:00.000Z",
    },
    {
      entryId: "act-1",
      kind: "scan",
      text: "Agent #1's Scan did not finish (deadline). It ran 1 web search and read 0 pages. Tools cost 0.01 USDC; 4.9944 USDC of credits left.",
      renderedBy: "template",
      at: "2026-10-06T10:42:00.000Z",
    },
  ],
});
const call = (callId, tool, target, status, errorCode, chargeUsdcE6, minute) => ({
  callId,
  leaseId: "fixture-lease",
  server:
    tool === "complete_stage" || tool === "write_thesis"
      ? "platform"
      : ["get_portfolio", "get_prices", "get_limits", "tradable_now", "propose_swap"].includes(tool)
        ? "chain"
        : "data",
  tool,
  target,
  status,
  errorCode,
  chargeUsdcE6,
  reversed: status === "failed",
  cacheHit: false,
  results: null,
  startedAt: `2026-10-06T16:${minute}:00.000Z`,
});
const toolCalls = JSON.stringify({
  agentId: "1",
  calls: [
    call("c11", "propose_swap", "2.5 USDC to WMON", "succeeded", null, "0", "46"),
    call("c10", "tradable_now", "2.5 USDC to WMON", "succeeded", null, "0", "45"),
    call("c9", "get_limits", null, "succeeded", null, "0", "44"),
    call("c8", "get_prices", null, "succeeded", null, "0", "43"),
    call("c7", "get_portfolio", null, "succeeded", null, "0", "42"),
    call("c6", "complete_stage", "SCAN", "succeeded", null, "0", "41"),
    call("c5", "write_thesis", "SCAN", "succeeded", null, "0", "41"),
    call("c4", "read_url", "169.254.169.254", "refused", "PRIVATE_ADDRESS", "0", "40"),
    call("c3", "read_url", "news.example", "succeeded", null, "2000", "40"),
    call(
      "c2",
      "web_search",
      "monad network upgrade",
      "failed",
      "UPSTREAM_UNAVAILABLE",
      "10000",
      "39",
    ),
    call("c1", "web_search", "monad dex volume", "succeeded", null, "10000", "39"),
  ],
});
const scanTask = JSON.stringify({
  taskId: "fixture-scan",
  agentId: "1",
  kind: "scan",
  status: "succeeded",
  error: null,
  result: {
    kind: "scan",
    stopReason: "COMPLETED",
    stage: {
      stageId: "stage-fixture",
      outcome: "DONE",
      schemaValid: true,
      candidates: [{ asset: "WMON", thesisCode: "DEX_VOLUME_UP", confidenceBps: 5500 }],
    },
    toolCalls: [
      { tool: "web_search", status: "succeeded", errorCode: null, chargeUsdcE6: "10000" },
      { tool: "read_url", status: "succeeded", errorCode: null, chargeUsdcE6: "2000" },
      { tool: "write_thesis", status: "succeeded", errorCode: null, chargeUsdcE6: "0" },
      { tool: "complete_stage", status: "succeeded", errorCode: null, chargeUsdcE6: "0" },
    ],
    toolChargeUsdcE6: "12000",
    skillsLoaded: ["aa-playbook-scan", "aa-defi-regime-read"],
    modelCalls: 7,
    sandboxStopped: true,
    timingsMs: { sandbox: 912, hermesBoot: 14210, run: 38150, total: 61420 },
  },
});

// P2-U5, P2-U6: what the chain tools recorded for agent 1 and its arming; the console's arm,
// disarm and approve change it, and a test-only reset puts it back.
const WAITING = "intent-6f1c2d9e-7b1a-4c3e-9d2f-1a2b3c4d5e6f";
const amount = (asset, amount, amountRaw) => ({ asset, amount, amountRaw });
const blocker = (code, message, clears, clearsAt, hint) => ({
  code,
  message,
  clears,
  clearsAt,
  hint,
});
let armingState = "unarmed";
let waitingStatus = "awaiting_approval";
const armingView = () => ({
  state: armingState,
  armingId: armingState === "unarmed" ? null : "arming-fixture",
  validUntil: armingState === "unarmed" ? null : 1_794_000_000,
  validUntilDate: armingState === "unarmed" ? null : "2026-11-06",
  renewalDue: false,
  armedAt: armingState === "armed" ? "2026-10-07T12:08:00.000Z" : null,
  firstIntentId: armingState === "armed" ? WAITING : null,
  ended: null,
});
const intent = (over) => ({
  buy: "WMON",
  expectedOut: null,
  minAmountOut: null,
  amountOut: null,
  reasonCodes: [],
  blockers: [],
  failure: null,
  approvedBy: null,
  txHash: null,
  deadline: null,
  approvedAt: null,
  submittedAt: null,
  settledAt: null,
  ...over,
});
const chainView = () =>
  JSON.stringify({
    agentId: "1",
    portfolio: {
      block: "109670021",
      usdc: "20",
      wmon: "400",
      totalValueUsdc: "30",
      mode: "NORMAL",
      drawdownBps: 0,
      at: "2026-10-07T12:02:00.000Z",
    },
    arming: armingView(),
    tradeFlow: true,
    intents: [
      intent({
        intentId: WAITING,
        status: waitingStatus,
        sell: amount("USDC", "2.5", "2500000"),
        expectedOut: amount("WMON", "99.9", "99900000000000000000"),
        reason: "Add a little WMON while the price is near its weekly low.",
        approvedBy: waitingStatus === "approved" ? "owner" : null,
        createdAt: "2026-10-07T12:06:00.000Z",
        expiresAt: "2026-10-07T12:36:00.000Z",
      }),
      intent({
        intentId: "intent-1d2c3b4a-5f6e-4d7c-8b9a-0f1e2d3c4b5a",
        status: "reconciled",
        sell: amount("USDC", "1", "1000000"),
        amountOut: amount("WMON", "39.94", "39940000000000000000"),
        reason: "A small first position in WMON.",
        approvedBy: "auto",
        txHash: `0x${"7d".repeat(32)}`,
        createdAt: "2026-10-07T11:58:00.000Z",
        expiresAt: "2026-10-07T12:28:00.000Z",
        settledAt: "2026-10-07T11:58:09.000Z",
      }),
      intent({
        intentId: "intent-0a9b8c7d-6e5f-4a3b-2c1d-0e9f8a7b6c5d",
        status: "rejected",
        sell: amount("USDC", "15", "15000000"),
        reason: "Buy a larger WMON position.",
        reasonCodes: ["TRADE_SIZE_EXCEEDED", "CONCENTRATION_CAP"],
        blockers: [
          blocker(
            "TRADE_SIZE_EXCEEDED",
            "The trade is larger than 10% of the account's value.",
            "by_changing_the_trade",
            null,
            "Propose at most 3 USDC.",
          ),
          blocker(
            "CONCENTRATION_CAP",
            "The trade would put more than 40% of the account in one asset.",
            "by_changing_the_trade",
            null,
            "Buy less WMON.",
          ),
        ],
        createdAt: "2026-10-07T11:50:00.000Z",
        expiresAt: "2026-10-07T12:20:00.000Z",
      }),
      intent({
        intentId: "intent-9e8d7c6b-5a4f-4e3d-2c1b-0a9f8e7d6c5b",
        status: "rejected",
        sell: amount("USDC", "1", "1000000"),
        reason: "Another small buy.",
        reasonCodes: ["GAS_UNFUNDED"],
        blockers: [
          blocker(
            "GAS_UNFUNDED",
            "The agent's funding address has no MON to pay gas for the trade.",
            "by_the_owner",
            null,
            "Send a little MON to the agent's funding address for gas.",
          ),
        ],
        failure: "a check changed between proposal and submission",
        approvedBy: "auto",
        createdAt: "2026-10-07T11:45:00.000Z",
        expiresAt: "2026-10-07T12:15:00.000Z",
      }),
    ],
  });
const chainCheckTask = JSON.stringify({
  taskId: "fixture-chain-check",
  agentId: "1",
  kind: "chain_check",
  status: "succeeded",
  error: null,
  result: {
    kind: "chain_check",
    stopReason: "COMPLETED",
    toolCalls: [
      { tool: "get_portfolio", status: "succeeded", errorCode: null },
      { tool: "get_prices", status: "succeeded", errorCode: null },
      { tool: "get_limits", status: "succeeded", errorCode: null },
      { tool: "tradable_now", status: "succeeded", errorCode: null },
      { tool: "propose_swap", status: "succeeded", errorCode: null },
      { tool: "get_intent_status", status: "succeeded", errorCode: null },
    ],
    intents: [
      {
        intentId: "intent-6f1c2d9e-7b1a-4c3e-9d2f-1a2b3c4d5e6f",
        status: "awaiting_approval",
        reasonCodes: [],
      },
    ],
    modelCalls: 8,
    timingsMs: { run: 41200, total: 58900 },
  },
});

// D-221: the local fork's steering; steers are set and cancelled by the console.
// Agent #2 is the fixture's unrevealed agent, owned by OWNER_2.
const OWNER_2 = "0x00000000000000000000000000000000000e2e01";
let steers = [];
let steerSeq = 0;
const steering = () => ({
  firstReveal: "bee",
  pending: steers.filter((s) => s.status === "pending"),
  recent: steers.filter((s) => s.status !== "pending").slice(0, 5),
});
const appliesTo = (target) => {
  if (target.kind === "agent")
    return {
      agentId: target.agentId,
      text: `agent #${target.agentId}, unrevealed, owned by ${target.owner}`,
    };
  return target.wallet === OWNER_2
    ? { agentId: "2", text: "agent #2, this wallet's unrevealed agent" }
    : { agentId: null, text: "the next agent this wallet mints" };
};

// P2-U4: the signer's outbox for agent 1, one transaction in each kind of outcome.
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";
const SIGNER_ADDRESS = "0xc7F0C302B03CFD3b61FEd398eaDBa3E78d97CA56";
const swapIntent = (tokenIn, tokenOut, amountIn) => ({
  schemaVersion: 1,
  chainId: "143143",
  agentId: "1",
  account: "0x42cF12E641CD11d1C6853978a729eF9B86239820",
  actionId: `0x${"a1".repeat(32)}`,
  tokenIn,
  tokenOut,
  amountIn,
  minAmountOut: "1",
  deadline: "1790876545",
});
const at = (status, minute, detail) => ({
  status,
  at: `2026-10-07T12:0${minute}:00.000Z`,
  ...(detail ? { detail } : {}),
});
const transaction = (txId, status, over) => ({
  txId,
  agentId: 1,
  status,
  reasonCode: null,
  reason: null,
  actionId: `0x${"a1".repeat(32)}`,
  keyAddress: SIGNER_ADDRESS,
  nonce: null,
  txHash: null,
  blockNumber: null,
  gasUsed: null,
  intent: swapIntent(USDC, WMON, "5000000"),
  amountOut: null,
  balances: null,
  ledgerEntryId: null,
  history: [at("accepted", 0)],
  createdAt: "2026-10-07T12:00:00.000Z",
  updatedAt: "2026-10-07T12:00:00.000Z",
  ...over,
});
const outbox = JSON.stringify({
  transactions: [
    transaction("tx-refund", "reconciled", {
      kind: "usdc_refund",
      actionId: "refund:5f0c2d9e-7b1a-4c3e-9d2f-1a2b3c4d5e6f",
      nonce: 2,
      txHash: `0x${"5e7d".repeat(16)}`,
      blockNumber: 109670104,
      gasUsed: "51203",
      intent: {
        kind: "usdc_refund",
        to: "0x683ee842a16f85e69883f433745263bfe8d55f76",
        amount: "4000000",
      },
      amountOut: "4000000",
      history: [
        at("accepted", 5),
        at("signed", 5, "nonce 2"),
        at("submitted", 5),
        at("confirmed", 5, "block 109670104"),
        at("reconciled", 5),
      ],
    }),
    transaction("tx-refused", "failed", {
      reasonCode: "TARGET_NOT_ALLOWED",
      reason:
        "refused before signing: The signer signs calls to the Executor, and USDC transfers for credits, only.",
      intent: null,
      history: [at("failed", 4, "TARGET_NOT_ALLOWED")],
    }),
    transaction("tx-slippage", "failed", {
      reasonCode: "SLIPPAGE_TOO_HIGH",
      reason: "the Executor would refuse it: SLIPPAGE_TOO_HIGH",
      intent: swapIntent(USDC, WMON, "1000000"),
      history: [at("accepted", 3), at("failed", 3, "SLIPPAGE_TOO_HIGH")],
    }),
    transaction("tx-unknown", "unknown", {
      nonce: 1,
      txHash: `0x${"18b9".repeat(16)}`,
      intent: swapIntent(USDC, WMON, "1000000"),
      history: [at("accepted", 2), at("signed", 2, "nonce 1"), at("unknown", 2)],
    }),
    transaction("tx-reconciled", "reconciled", {
      nonce: 0,
      txHash: `0x${"af00".repeat(16)}`,
      blockNumber: 109670101,
      gasUsed: "998211",
      amountOut: "145376875974903213012",
      balances: {
        tokenIn: { before: "60000000", after: "55000000" },
        tokenOut: { before: "0", after: "145376875974903213012" },
      },
      ledgerEntryId: "0b6ac513-5421-41e8-8403-64e6a2efd8b1",
      history: [
        at("accepted", 1),
        at("signed", 1, "nonce 0"),
        at("submitted", 1),
        at("confirmed", 1, "block 109670101"),
        at("reconciled", 1),
      ],
    }),
  ],
});
const ledgerEntry = JSON.stringify({
  entryId: "0b6ac513-5421-41e8-8403-64e6a2efd8b1",
  kind: "trade",
  occurredAt: "2026-10-07T12:01:00.000Z",
  source: {},
  lines: [
    { account: "personal_account", asset: "USDC", amount: "-5000000" },
    { account: "venue", asset: "USDC", amount: "5000000" },
    { account: "venue", asset: "WMON", amount: "-145376875974903213012" },
    { account: "personal_account", asset: "WMON", amount: "145376875974903213012" },
  ],
});

// P3-U3: agent 1's plan and the runner's decisions; the console's "Set plan" moves the target.
let planTarget = 2_000;
let planEpoch = 2;
const planParams = (target) => ({
  targetWmonBps: target,
  bandHalfWidthBps: 500,
  minTradeUsdcE6: "500000",
  volatilityBrakeBps: 20_000,
  costHurdleBps: 40,
  maxLegBps: 1_000,
});
const decision = (decisionId, outcome, code, message, wmonShareBps, leg, lastAt, ticks) => ({
  decisionId,
  outcome,
  code,
  codes: outcome === "hold" ? [code] : [],
  message,
  leg,
  intentId: leg ? "intent-0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e" : null,
  facts: { wmonShareBps, targetWmonBps: planTarget, bandHalfWidthBps: 500 },
  strategyEpoch: String(planEpoch),
  paramId: "plan-fixture",
  block: "109670021",
  firstAt: lastAt,
  lastAt,
  ticks,
});
const planView = () => ({
  agentId: "1",
  runner: { on: true, canSet: true, canRun: true },
  strategyEpoch: String(planEpoch),
  goal: {
    riskPreset: "BALANCED",
    presetLabel: "Balanced",
    defaults: planParams(2_000),
    targetRange: { minBps: 0, maxBps: 3_000 },
    ownerLimits: {
      maxTradeBps: 1_000,
      maxWmonShareBps: 4_000,
      minUsdcShareBps: 1_000,
      maxSlippageBps: 50,
      maxTradesPer24h: 20,
    },
  },
  plan: {
    paramId: "plan-fixture",
    template: "rebalance_bands@1",
    params: planParams(planTarget),
    paramsHash: `0x${"ab".repeat(32)}`,
    strategyEpoch: String(planEpoch),
    setBy: "console",
    createdAt: "2026-10-07T12:00:00.000Z",
    stale: false,
  },
  decisions: [
    decision(
      3,
      "hold",
      "IN_BAND",
      "The account's WMON share is inside its band around the target, so no trade is needed.",
      1_988,
      null,
      "2026-10-07T12:20:00.000Z",
      14,
    ),
    decision(
      2,
      "hold",
      "LEG_PENDING",
      "The previous trade of this rebalance is still on its way; the next one waits for it to settle.",
      995,
      null,
      "2026-10-07T12:05:00.000Z",
      2,
    ),
    decision(
      1,
      "leg",
      "LEG",
      "Proposed a leg toward the target.",
      0,
      { sell: "USDC", buy: "WMON", amountIn: "9950000", valueUsdcE6: "9950000" },
      "2026-10-07T12:03:00.000Z",
      1,
    ),
  ],
});

// P3-U4: one routine cycle as the orchestrator's cycle routes served it after an offline run
// (services/orchestrator's cycle test writes these with CYCLE_FIXTURE_DIR=apps/console/e2e).
const cyclesFixture = readFileSync(new URL("./cycles-fixture.json", import.meta.url), "utf8");
const cycleDetailFixture = readFileSync(
  new URL("./cycle-detail-fixture.json", import.meta.url),
  "utf8",
);
const FIXTURE_CYCLE = JSON.parse(cyclesFixture).cycles[0].cycleId;

// F-U1: the token registry as the orchestrator's token routes served it after an offline run
// (services/orchestrator's registry test writes these with TOKENS_FIXTURE_DIR=apps/console/e2e).
const tokensFixture = readFileSync(new URL("./tokens-fixture.json", import.meta.url), "utf8");
const tokenDetailFixture = readFileSync(
  new URL("./token-detail-fixture.json", import.meta.url),
  "utf8",
);
const FIXTURE_TOKEN = JSON.parse(tokenDetailFixture).token.address;

const routes = {
  "GET /health": [200, body],
  "GET /v1/signer": [200, JSON.stringify({ on: true, chainId: 143143 })],
  "GET /v1/signer/outbox?agentId=1": [200, outbox],
  "GET /v1/agents/1/session-key": [200, JSON.stringify({ address: SIGNER_ADDRESS })],
  "GET /v1/signer/ledger/0b6ac513-5421-41e8-8403-64e6a2efd8b1": [200, ledgerEntry],
  "GET /v1/agents": [200, body],
  "GET /v1/runtimes": [200, runtimes],
  "POST /v1/agents/1/tasks/noop": [202, JSON.stringify({ taskId: "fixture-task" })],
  "GET /v1/tasks/fixture-task": [200, task],
  "POST /v1/agents/1/reset": [202, JSON.stringify({ queued: true })],
  "GET /v1/credits": [200, credits],
  "POST /v1/agents/1/refund": [202, JSON.stringify({ refundId: "fixture-refund" })],
  "GET /v1/refunds/fixture-refund": [200, refund],
  "GET /v1/agents/1/activity": [200, activity],
  "GET /v1/agents/1/tool-calls": [200, toolCalls],
  "POST /v1/agents/1/tasks/scan": [202, JSON.stringify({ taskId: "fixture-scan" })],
  "GET /v1/tasks/fixture-scan": [200, scanTask],

  "POST /v1/agents/1/tasks/chain-check": [202, JSON.stringify({ taskId: "fixture-chain-check" })],
  "GET /v1/tasks/fixture-chain-check": [200, chainCheckTask],
  // P3-U2: the market snapshot, built from packages/market's recorded upstream answers.
  "GET /v1/market": [200, readFileSync(new URL("./market-fixture.json", import.meta.url), "utf8")],
  // P3-U9: research sources, built from packages/market's recorded X and Dune answers (synthetic posts).
  "GET /v1/research": [
    200,
    readFileSync(new URL("./research-fixture.json", import.meta.url), "utf8"),
  ],
  "GET /v1/tokens": [200, tokensFixture],
  [`GET /v1/tokens/${FIXTURE_TOKEN}`]: [200, tokenDetailFixture],
  [`POST /v1/tokens/${FIXTURE_TOKEN}/screen`]: [
    200,
    JSON.stringify({ screen: JSON.parse(tokenDetailFixture).screens[0] }),
  ],
  "GET /v1/agents/1/cycles": [200, cyclesFixture],
  [`GET /v1/cycles/${FIXTURE_CYCLE}`]: [200, cycleDetailFixture],
  "POST /v1/agents/1/cycles": [
    409,
    JSON.stringify({
      error: "cycle_open",
      message: "Agent 1 already has a research cycle queued or running.",
    }),
  ],
};

createServer((req, res) => {
  if (req.url === "/v1/keeper")
    return res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ running: true, recent: [], steering: steering() }));
  // P2-U6: the chain view follows the console's arm, disarm and approve.
  const json = (status, body) =>
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  if (req.method === "GET" && req.url === "/v1/agents/1/chain")
    return res.writeHead(200, { "content-type": "application/json" }).end(chainView());
  if (req.method === "POST" && req.url === "/v1/agents/1/arm") {
    armingState = "awaiting_first_trade";
    return json(201, { renewed: false, arming: armingView() });
  }
  if (req.method === "POST" && req.url === "/v1/agents/1/disarm") {
    armingState = "unarmed";
    return json(200, { disarmed: true, arming: armingView() });
  }
  if (req.method === "POST" && req.url === `/v1/agents/1/intents/${WAITING}/approve`) {
    const armed = armingState === "awaiting_first_trade";
    armingState = "armed";
    waitingStatus = "approved";
    return json(200, { armed, intent: { intentId: WAITING, status: "approved" } });
  }
  if (req.method === "GET" && req.url === "/v1/agents/1/plan") return json(200, planView());
  // P3-U7: the mounted skills and playbooks, as the orchestrator served them for the built-in set.
  if (req.method === "GET" && req.url === "/v1/agents/1/skills")
    return res
      .writeHead(200, { "content-type": "application/json" })
      .end(readFileSync(new URL("./skills-fixture.json", import.meta.url), "utf8"));
  if (req.method === "PUT" && req.url === "/v1/agents/1/plan") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const params = JSON.parse(raw || "{}");
      if (params.targetWmonBps > 3_000)
        return json(400, {
          error: "plan_out_of_bounds",
          message: "The target WMON share must be within the goal's range, 0% to 30%.",
          errors: [
            {
              field: "template.params.targetWmonBps",
              message: "The target WMON share must be within the goal's range, 0% to 30%.",
            },
          ],
        });
      planTarget = params.targetWmonBps;
      planEpoch += 1;
      json(201, { plan: { ...planView().plan } });
    });
    return;
  }
  if (req.method === "POST" && req.url === "/v1/agents/1/runner/run")
    return json(200, { decision: planView().decisions[0] });
  if (req.method === "POST" && req.url === "/v1/agents/1/test-over-limit")
    return json(201, { intentId: "intent-5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d" });
  // Test-only: puts agent 1's arming and intents back, so one test's arming never reaches another's.
  if (req.method === "POST" && req.url === "/__fixture/reset-arming") {
    planTarget = 2_000;
    planEpoch = 2;
    armingState = "unarmed";
    waitingStatus = "awaiting_approval";
    return json(200, { reset: true });
  }
  // Test-only: forgets every steer, so one run's steers never reach another's capture.
  if (req.method === "POST" && req.url === "/__fixture/reset-steers") {
    steers = [];
    return res.writeHead(204).end();
  }
  if (req.method === "POST" && req.url === "/v1/keeper/reveal-steers") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const { species, wallet, agentId } = JSON.parse(raw || "{}");
      const json = (status, value) =>
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (agentId !== undefined && agentId !== "2")
        return json(400, { error: "revealed", message: `Agent #${agentId} is already revealed.` });
      const target = wallet
        ? { kind: "wallet", wallet: wallet.toLowerCase() }
        : { kind: "agent", agentId, owner: OWNER_2 };
      steerSeq += 1;
      const steer = {
        steerId: `steer-${steerSeq}`,
        target,
        species,
        status: "pending",
        appliesTo: appliesTo(target),
        appliedAgentId: null,
        note: null,
        createdAt: "2026-10-07T08:00:00.000Z",
      };
      steers = [steer, ...steers];
      json(200, { steer, steering: steering() });
    });
    return;
  }
  const cancel = /^\/v1\/keeper\/reveal-steers\/([\w-]+)\/cancel$/.exec(req.url ?? "");
  if (req.method === "POST" && cancel) {
    steers = steers.map((s) =>
      s.steerId === cancel[1]
        ? { ...s, status: "cancelled", appliesTo: null, note: "cancelled in the dev console" }
        : s,
    );
    return res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ steering: steering() }));
  }
  const [status, reply] = routes[`${req.method} ${req.url}`] ?? [
    404,
    JSON.stringify({ error: "not_found" }),
  ];
  res.writeHead(status, { "content-type": "application/json" });
  res.end(reply);
}).listen(PORT, "127.0.0.1");
