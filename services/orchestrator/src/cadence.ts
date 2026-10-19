/**
 * CO-U1 (2026-10-19, owner): a loop that reads the chain only when it has to. Its step wakes every
 * few seconds and asks `busy()`, a database read with no RPC call; it runs `fn` while work is in
 * flight, once more right after that work clears (so the next leg goes out at once), and
 * otherwise every `idleMs`.
 */
export function cadence(
  o: {
    readonly idleMs: number;
    readonly busy: () => Promise<boolean>;
    readonly now?: () => number;
  },
  fn: () => Promise<void>,
): () => Promise<void> {
  const now = o.now ?? Date.now;
  let last: number | null = null;
  let wasBusy = false;
  return async () => {
    const busy = await o.busy();
    const t = now();
    const due = last === null || t - last >= o.idleMs;
    const run = busy || wasBusy || due;
    wasBusy = busy;
    if (!run) return;
    last = t;
    await fn();
  };
}
