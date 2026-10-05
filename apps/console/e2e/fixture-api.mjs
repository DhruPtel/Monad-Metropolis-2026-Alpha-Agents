// A fixed control API for the console's screenshot tests (P1-U4): the agents
// panel renders on the server, so it is served this instead of the real API,
// and the capture is the same on every run. Two agents: a revealed bee and an
// unrevealed agent.
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

createServer((req, res) => {
  const ok = req.url === "/v1/agents" || req.url === "/health";
  res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
  res.end(ok ? body : JSON.stringify({ error: "not_found" }));
}).listen(PORT, "127.0.0.1");
