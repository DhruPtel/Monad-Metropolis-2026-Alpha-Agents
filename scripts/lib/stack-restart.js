// @ts-check
// 2026-10-13: the testnet supervisor's restart backoff and log keeping.
import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** The most restarts in a row (each within 10 minutes of the last start) before the supervisor gives up. */
export const MAX_RESTARTS = 5;

/** How long the supervisor waits before a restart: 5 s, doubling, at most 60 s. */
export function restartDelayMs(/** @type {number} */ restarts) {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, restarts - 1));
}

/**
 * Keeps the last run's log under its time instead of wiping it, and the newest `keep` of those,
 * so a service that stopped on its own can still be read about after a restart.
 */
export function keepLog(/** @type {string} */ path, keep = 5) {
  if (!existsSync(path)) return;
  const stamp = statSync(path).mtime.toISOString().replace(/[:.]/g, "-");
  const dir = dirname(path);
  const base = basename(path, ".log");
  renameSync(path, join(dir, `${base}.${stamp}.log`));
  const old = readdirSync(dir)
    .filter((f) => f.startsWith(`${base}.`) && f.endsWith(".log"))
    .sort()
    .reverse();
  for (const f of old.slice(keep)) rmSync(join(dir, f), { force: true });
}
