import { writeFileSync } from "node:fs";
import { BUILTIN_ROOT, type VersionLock, loadBuiltinSet, readVersionLock } from "./builtin.ts";

/**
 * `pnpm skills:lock` (P3-U7): records each built-in package's version and
 * content hash in builtin/versions.json. It refuses a package whose bytes
 * changed while its version stayed the same: published versions are
 * immutable, so a change needs a new version.
 */
let lock: VersionLock;
try {
  lock = readVersionLock();
} catch {
  lock = {};
}
const set = loadBuiltinSet(BUILTIN_ROOT, lock);
const reused = set.issues.filter((i) => i.message.includes("already published"));
if (reused.length > 0) {
  for (const i of reused) console.error(`${i.id}: ${i.message}`);
  process.exit(1);
}
const blocking = set.issues.filter(
  (i) => i.severity === "block" && !i.message.includes("versions.json"),
);
if (blocking.length > 0) {
  for (const i of blocking) console.error(`${i.id} ${i.rule} ${i.path}: ${i.message}`);
  process.exit(1);
}
const next: VersionLock = { ...lock };
for (const p of set.packages)
  next[p.manifest.id] = { version: p.manifest.version, contentHash: p.contentHash };
writeFileSync(
  new URL("versions.json", BUILTIN_ROOT),
  `${JSON.stringify({ note: "Each built-in skill and playbook version's content hash (P3-U7). A version never changes; a change needs a new version. Written by pnpm skills:lock.", versions: next }, null, 2)}\n`,
);
for (const p of set.packages)
  console.log(`${p.manifest.id}@${p.manifest.version} ${p.contentHash.slice(0, 12)}`);
