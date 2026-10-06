// A fixed control API and orchestrator for the console's screenshot tests
// (P1-U4, P1-U5): the agents panel renders on the server, so it is served this
// instead of the real services, and the capture is the same on every run. Two
// agents: a revealed, provisioned bee and an unrevealed agent. The no-op task
// for agent 1 is queued, then reads as succeeded with a fixed result; agent 1
// has credits and its refund is sent at once (P1-U6). P1-U7: agent 1 has two
// activity entries and five tool calls (answered, refused and failed), and its
// Scan reads as succeeded with a fixed result.
import { createServer } from "node:http";
import process from "node:process";

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
  server: tool === "complete_stage" || tool === "write_thesis" ? "platform" : "data",
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
    modelCalls: 7,
    sandboxStopped: true,
    timingsMs: { sandbox: 912, hermesBoot: 14210, run: 38150, total: 61420 },
  },
});

const routes = {
  "GET /health": [200, body],
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
};

createServer((req, res) => {
  const [status, reply] = routes[`${req.method} ${req.url}`] ?? [
    404,
    JSON.stringify({ error: "not_found" }),
  ];
  res.writeHead(status, { "content-type": "application/json" });
  res.end(reply);
}).listen(PORT, "127.0.0.1");
