// A fixed control API and orchestrator for the console's screenshot tests
// (P1-U4, P1-U5): the agents panel renders on the server, so it is served this
// instead of the real services, and the capture is the same on every run. Two
// agents: a revealed, provisioned bee and an unrevealed agent. The no-op task
// for agent 1 is queued, then reads as succeeded with a fixed result.
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

const routes = {
  "GET /health": [200, body],
  "GET /v1/agents": [200, body],
  "GET /v1/runtimes": [200, runtimes],
  "POST /v1/agents/1/tasks/noop": [202, JSON.stringify({ taskId: "fixture-task" })],
  "GET /v1/tasks/fixture-task": [200, task],
  "POST /v1/agents/1/reset": [202, JSON.stringify({ queued: true })],
};

createServer((req, res) => {
  const [status, reply] = routes[`${req.method} ${req.url}`] ?? [
    404,
    JSON.stringify({ error: "not_found" }),
  ];
  res.writeHead(status, { "content-type": "application/json" });
  res.end(reply);
}).listen(PORT, "127.0.0.1");
