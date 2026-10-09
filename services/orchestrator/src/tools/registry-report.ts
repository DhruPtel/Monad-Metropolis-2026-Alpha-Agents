import { registryReport } from "./registry-check.ts";

/**
 * `pnpm registry:check` (P3-U9): prints which registry IDs resolve to live
 * tools, which are deferred and to which unit, and every problem. Exits 1 when
 * any registry ID or launch skill tool does not resolve.
 */
const r = await registryReport();
console.log(
  `Live tools: chain ${r.live.chain.length}, data ${r.live.data.length}, platform ${r.live.platform.length}`,
);
console.log(`\nResolved to a live tool (${r.resolved.length}):`);
for (const id of r.resolved) console.log(`  ${id}`);
console.log(`\nDeferred, with the unit that builds each (${r.deferred.length}):`);
for (const d of r.deferred) console.log(`  ${d.id}  ->  ${d.unit}: ${d.reason}`);
if (r.problems.length === 0) {
  console.log(
    "\nRegistry check passed: every ID resolves, and every launch skill's tools are registered.",
  );
} else {
  console.log(`\nRegistry check FAILED (${r.problems.length}):`);
  for (const p of r.problems) console.log(`  ${p.id} ${p.problem}`);
  process.exitCode = 1;
}
