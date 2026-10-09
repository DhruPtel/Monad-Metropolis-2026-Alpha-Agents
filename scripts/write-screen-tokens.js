// @ts-check
// pnpm devenv:screen-tokens: writes the creation code of F-U1's screen test
// tokens (chains/monad/test/mocks/ScreenTokenMocks.sol, from the forge build)
// into services/orchestrator/src/tokens/screen-token-code.ts, which the token
// screen's fork tests deploy on a throwaway fork. The forge test
// test/ScreenTokenCode.t.sol fails if the two ever differ.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MONAD_DIR, ROOT } from "./lib/paths.js";

const NAMES = ["ScreenPlainToken", "ScreenTaxToken", "ScreenHoneypotToken", "ScreenBlacklistToken"];
const build = spawnSync("forge", ["build", "test/mocks/ScreenTokenMocks.sol"], {
  cwd: MONAD_DIR,
  stdio: "inherit",
});
if (build.status !== 0) {
  console.error("error: forge build failed");
  process.exit(1);
}
const lines = NAMES.map((name) => {
  const artifact = JSON.parse(
    readFileSync(join(MONAD_DIR, "out", "ScreenTokenMocks.sol", `${name}.json`), "utf8"),
  );
  const code = artifact.bytecode.object;
  if (!/^0x[0-9a-f]+$/.test(code)) throw new Error(`${name} has no creation code in the build`);
  return `  ${name}:\n    "${code}",`;
});
const out = join(ROOT, "services", "orchestrator", "src", "tokens", "screen-token-code.ts");
writeFileSync(
  out,
  `/**
 * Creation code of the token screen's test tokens
 * (chains/monad/test/mocks/ScreenTokenMocks.sol), written by
 * pnpm devenv:screen-tokens. Throwaway forks only (F-U1). The forge test
 * test/ScreenTokenCode.t.sol fails if this differs from the build. Do not edit.
 * Each constructor takes the supply (uint256), minted to the deployer.
 */
export const SCREEN_TOKEN_CODE = {
${lines.join("\n")}
} as const;
`,
);
console.log(`wrote ${out}`);
