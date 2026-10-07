// @ts-check
// pnpm devenv:local-feed: writes LocalFeed's runtime code (from the forge build)
// into packages/devenv/src/local-feed-code.ts, which refreshLocalFeeds puts at
// the Chainlink feed addresses on the local fork (D-237). The forge test
// test/LocalFeedCode.t.sol fails if the two ever differ.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MONAD_DIR, ROOT } from "./lib/paths.js";

if (spawnSync("forge", ["build"], { cwd: MONAD_DIR, stdio: "inherit" }).status !== 0) {
  console.error("error: forge build failed");
  process.exit(1);
}
const artifact = JSON.parse(
  readFileSync(join(MONAD_DIR, "out", "LocalFeed.sol", "LocalFeed.json"), "utf8"),
);
const code = artifact.deployedBytecode.object;
if (!/^0x[0-9a-f]+$/.test(code)) throw new Error("LocalFeed has no runtime code in the build");
const out = join(ROOT, "packages", "devenv", "src", "local-feed-code.ts");
writeFileSync(
  out,
  `/**
 * LocalFeed's runtime code (chains/monad/script/LocalFeed.sol), written by
 * pnpm devenv:local-feed. Local fork only (D-237). The forge test
 * test/LocalFeedCode.t.sol fails if this differs from the build. Do not edit.
 */
export const LOCAL_FEED_RUNTIME_CODE =
  "${code}";
`,
);
console.log(`wrote ${out}`);
