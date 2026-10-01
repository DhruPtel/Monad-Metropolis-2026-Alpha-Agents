import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The repository root: the nearest folder above `start` holding
 * pnpm-workspace.yaml. Found from the working directory, not from this file,
 * because a bundled copy (the console's Next.js server) no longer sits in the
 * source tree.
 */
export function repoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error("not inside the Alpha Agents repository (no pnpm-workspace.yaml found)");
    dir = parent;
  }
}

export interface LocalPaths {
  readonly root: string;
  readonly monadDir: string;
  readonly forkConfig: string;
  readonly composeFile: string;
  readonly env: string;
  readonly devDir: string;
  readonly anvilPid: string;
  readonly anvilLog: string;
}

export function localPaths(root: string = repoRoot()): LocalPaths {
  const devDir = join(root, ".dev");
  return {
    root,
    monadDir: join(root, "chains/monad"),
    forkConfig: join(root, "chains/monad/fork.json"),
    composeFile: join(root, "infra/compose.yaml"),
    env: join(root, ".env"),
    devDir,
    anvilPid: join(devDir, "anvil.pid"),
    anvilLog: join(devDir, "anvil.log"),
  };
}
