import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { toEventSignature } from "viem";
import { describe, expect, it } from "vitest";
import { AGENT_NFT_EVENTS_ABI, PROJECTED_EVENTS } from "./events.ts";

const MONAD_DIR = fileURLToPath(new URL("../../../chains/monad", import.meta.url));
const forge = spawnSync("forge", ["--version"], { encoding: "utf8" });

describe("AgentNFT's events", () => {
  it.skipIf(forge.status !== 0)(
    "match the compiled contract exactly, so none goes unindexed",
    () => {
      const out = spawnSync("forge", ["inspect", "src/AgentNFT.sol:AgentNFT", "abi", "--json"], {
        cwd: MONAD_DIR,
        encoding: "utf8",
        timeout: 240_000,
      });
      expect(out.status).toBe(0);
      const compiled = (JSON.parse(out.stdout) as { type: string }[])
        .filter((e) => e.type === "event")
        .map((e) => toEventSignature(e as never))
        .sort();
      expect(AGENT_NFT_EVENTS_ABI.map((e) => toEventSignature(e)).sort()).toEqual(compiled);
    },
    300_000,
  );

  it("projects the four that change an agent", () => {
    const names = AGENT_NFT_EVENTS_ABI.map((e) => e.name);
    for (const name of PROJECTED_EVENTS) expect(names).toContain(name);
  });
});
