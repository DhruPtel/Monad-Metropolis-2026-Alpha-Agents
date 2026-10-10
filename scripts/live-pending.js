// @ts-check
// pnpm test:live:pending (P0-API): every live check that waits on the Anthropic
// account, in one command, in order. The list itself is evidence/live-pending.md;
// this runs each step, records its exit code and stops at nothing, so one run
// shows which checks pass once the account accepts calls. Nothing here touches
// the playtest fork on 8545: each step starts its own stack.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadRootEnv } from "./lib/config.js";
import { ROOT } from "./lib/paths.js";

// P0-SPEND (D-369): the whole list stops once its model spend, as LiteLLM's /global/spend
// counts it, reaches the cap; the steps that ran keep their results.
const SPEND_CAP_USD = 10;
loadRootEnv();
const litellmUrl = process.env.LITELLM_BASE_URL ?? "http://127.0.0.1:4000";
const masterKey = process.env.LITELLM_MASTER_KEY ?? "";
/** The gateway's total spend in USD, or null when it cannot be read. */
async function globalSpendUsd() {
  try {
    const res = await fetch(`${litellmUrl}/global/spend`, {
      headers: { authorization: `Bearer ${masterKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const j = /** @type {{ spend?: number }} */ (await res.json());
    return typeof j.spend === "number" ? j.spend : null;
  } catch {
    return null;
  }
}

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
const spendAtStart = await globalSpendUsd();
if (spendAtStart === null)
  console.log("(LiteLLM's spend could not be read; the cap cannot be enforced here)");
let spent = 0;
for (const step of STEPS) {
  if (spent >= SPEND_CAP_USD) {
    outcomes.push({ name: step.name, status: null, spendUsd: 0 });
    continue;
  }
  console.log(`\n== ${step.name}\n   ${step.cmd.join(" ")}\n`);
  const before = await globalSpendUsd();
  const [bin = "node", ...args] = step.cmd;
  const r = spawnSync(bin, args, { cwd: ROOT, stdio: "inherit" });
  const after = await globalSpendUsd();
  const stepSpend = before !== null && after !== null ? after - before : 0;
  spent = spendAtStart !== null && after !== null ? after - spendAtStart : spent + stepSpend;
  outcomes.push({ name: step.name, status: r.status ?? 1, spendUsd: stepSpend });
  console.log(
    `   step spend ${stepSpend.toFixed(3)} USD; run spend ${spent.toFixed(3)} of the ${SPEND_CAP_USD} USD cap`,
  );
}
console.log("\n== summary");
for (const o of outcomes)
  console.log(
    `${o.status === null ? "SKIP (spend cap)" : o.status === 0 ? "PASS" : "FAIL"}  ${o.name}${o.status === null ? "" : `  (${o.spendUsd.toFixed(3)} USD)`}`,
  );
console.log(`model spend of this run: ${spent.toFixed(3)} USD (cap ${SPEND_CAP_USD})`);
process.exit(outcomes.every((o) => o.status === 0) ? 0 : 1);
