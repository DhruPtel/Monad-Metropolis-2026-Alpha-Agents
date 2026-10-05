import { describe, expect, it } from "vitest";
import { apiAgentsSource } from "./extension";

const reply = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("the agents panel's source (P1-U4)", () => {
  it("lists agents from the control API with tier, species, owner and the watermark", async () => {
    const source = apiAgentsSource(
      "http://127.0.0.1:4100",
      reply(200, {
        watermark: { block: 109670005, hash: "0xabc", updatedAt: "2026-10-05T00:00:00.000Z" },
        agents: [
          { agentId: "1", owner: "0x683eE842A16f85e69883F433745263BFe8D55f76", species: 14 },
          { agentId: "2", owner: "0x00000000000000000000000000000000000E2e01", species: 0 },
        ],
      }),
    );
    const list = await source.listAgents();
    expect(list.watermark).toEqual({ block: 109670005, updatedAt: "2026-10-05T00:00:00.000Z" });
    expect(list.agents.map((a) => [a.agentId, a.name, a.tier, a.speciesName, a.state])).toEqual([
      [1n, "Alpha Agent #1", "pro", "Bee", "UNCONFIGURED"],
      [2n, "Alpha Agent #2", null, null, "UNCONFIGURED"],
    ]);
    expect(list.agents[0]?.spendUsdcE6).toBe(0n);
  });

  it("fails when the API does", async () => {
    await expect(apiAgentsSource("http://x", reply(500, {})).listAgents()).rejects.toThrow(/500/);
  });
});
