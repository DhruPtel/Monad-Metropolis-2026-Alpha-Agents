// @ts-check
// pnpm test:live:pending (P0-API): every live check that waits on the Anthropic
// account, in one command, in order. The list itself is evidence/live-pending.md;
// this runs each step, records its exit code and stops at nothing, so one run
// shows which checks pass once the account accepts calls. Nothing here touches
// the playtest fork on 8545: each step starts its own stack.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/paths.js";

const STEPS = [
  {
    name: "Anthropic request shapes (free token counts, every alias and stage)",
    cmd: ["node", "services/orchestrator/src/anthropic-dry-run.ts"],
  },
  {
    name: "orchestrator live run: mint, credits, no-op, chain check, trade flow, research check, token check, a research cycle",
    cmd: ["pnpm", "test:orchestrator:live"],
  },
  {
    // F-U8: the two skills added with research v2 are chosen from a task alone (Q-07).
    name: "skill selection (Q-07): the stage playbooks and every built-in skill chosen from a task alone",
    cmd: ["pnpm", "test:skills:selection"],
  },
];

console.log(readFileSync(join(ROOT, "evidence", "live-pending.md"), "utf8"));
const outcomes = [];
for (const step of STEPS) {
  console.log(`\n== ${step.name}\n   ${step.cmd.join(" ")}\n`);
  const [bin = "node", ...args] = step.cmd;
  const r = spawnSync(bin, args, { cwd: ROOT, stdio: "inherit" });
  outcomes.push({ name: step.name, status: r.status ?? 1 });
}
console.log("\n== summary");
for (const o of outcomes) console.log(`${o.status === 0 ? "PASS" : "FAIL"}  ${o.name}`);
process.exit(outcomes.every((o) => o.status === 0) ? 0 : 1);
