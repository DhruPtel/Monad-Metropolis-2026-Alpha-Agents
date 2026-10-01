import { spawnSync } from "node:child_process";

export interface RunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a command and captures its output. Never throws. */
export function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): RunResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 30_000,
    env: process.env,
  });
  return {
    ok: result.status === 0 && !result.error,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Runs a command with inherited stdio, for long or interactive steps. True when it exits 0. */
export function runInherit(command: string, args: readonly string[]): boolean {
  const result = spawnSync(command, args, { stdio: "inherit", env: process.env });
  return result.status === 0 && !result.error;
}
