import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HERMES_HOME } from "./hermes/materialize.ts";
import { skillsLoaded } from "./noop.ts";
import type { SandboxHandle } from "./sandbox.ts";

/**
 * P3-U7: which skills a session loaded, read from Hermes's own session
 * database. The test writes a database shaped like Hermes's messages (a tool
 * call to skill_view in JSON) and runs the reader's script locally.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const python = (() => {
  try {
    execFileSync("python3", ["-c", "import sqlite3"]);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!python)("the skills a session loaded (P3-U7)", () => {
  it("lists each aa- skill named in a skill_view call, once, in order", async () => {
    const home = mkdtempSync(join(tmpdir(), "hermes-home-"));
    dirs.push(home);
    execFileSync("python3", [
      "-c",
      [
        "import sqlite3, sys",
        `db = sqlite3.connect('${home}/state.db')`,
        "db.execute('create table messages (id integer, role text, content text, tool_calls text)')",
        'db.execute(\'insert into messages values (1, "assistant", "", ?)\', (\'[{"type": "function", "function": {"name": "skill_view", "arguments": "{\\\\"name\\\\": \\\\"aa-playbook-scan\\\\"}"}}]\',))',
        'db.execute(\'insert into messages values (2, "assistant", "", ?)\', (\'[{"function": {"name": "skill_view", "arguments": {"name": "aa-defi-regime-read"}}}]\',))',
        'db.execute(\'insert into messages values (3, "assistant", "", ?)\', (\'[{"function": {"name": "skill_view", "arguments": {"name": "aa-playbook-scan"}}}]\',))',
        'db.execute(\'insert into messages values (4, "tool", "mcp__data__web_search aa-not-a-skill-view", null)\')',
        "db.commit()",
      ].join("\n"),
    ]);
    const sbx = {
      id: "local",
      run: async (cmd: string) => {
        const out = execFileSync("sh", ["-c", cmd.replaceAll(HERMES_HOME, home)], {
          encoding: "utf8",
        });
        return { exitCode: 0, stdout: out, stderr: "" };
      },
    } as unknown as SandboxHandle;
    expect(await skillsLoaded(sbx)).toEqual(["aa-playbook-scan", "aa-defi-regime-read"]);
  });
});

describe("the strategy skill matches the runner's template (P3-U7, F6)", () => {
  it("carries P3-U3's evals and the goal translator's defaults for each preset", async () => {
    const { readFileSync } = await import("node:fs");
    const { loadEvals } = await import("@alpha-agents/policy/evals");
    const { translateGoal } = await import("@alpha-agents/policy");
    const { DEFAULT_GOAL_INPUT, RISK_PRESETS, RISK_PRESET_FACTS } =
      await import("@alpha-agents/domain");
    const dir = new URL(
      "../../../packages/skills/builtin/skills/usdc-wmon-band-rebalancer/",
      import.meta.url,
    );
    const evals = readFileSync(new URL("evals/evals.yaml", dir), "utf8").replace(/^#.*\n/, "");
    expect(JSON.parse(evals)).toEqual(loadEvals("rebalance_bands@1"));
    const params = JSON.parse(readFileSync(new URL("data/params.json", dir), "utf8")) as {
      presets: Record<string, Record<string, unknown>>;
    };
    for (const riskPreset of RISK_PRESETS) {
      const r = translateGoal({ ...DEFAULT_GOAL_INPUT, riskPreset });
      if (!r.ok) throw new Error("goal");
      const p = r.config.template.params;
      expect(params.presets[riskPreset]).toEqual({
        targetWmonBps: p.targetWmonBps,
        targetRangeBps: [
          RISK_PRESET_FACTS[riskPreset].targetMinBps,
          RISK_PRESET_FACTS[riskPreset].targetMaxBps,
        ],
        bandHalfWidthBps: p.bandHalfWidthBps,
        minTradeUsdcE6: p.minTradeUsdcE6.toString(),
        volatilityBrakeBps: p.volatilityBrakeBps,
        costHurdleBps: p.costHurdleBps,
        maxLegBps: p.maxLegBps,
      });
    }
  });
});
