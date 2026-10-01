// @ts-check
import { spawnSync } from "node:child_process";

/**
 * Runs a command and captures its output. Never throws.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number }} [options]
 * @returns {{ ok: boolean, stdout: string, stderr: string }}
 */
export function run(command, args, options = {}) {
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

/**
 * Runs a command with inherited stdio, for long or interactive steps.
 * @param {string} command
 * @param {string[]} args
 * @returns {boolean} true when the command exits 0
 */
export function runInherit(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", env: process.env });
  return result.status === 0 && !result.error;
}
