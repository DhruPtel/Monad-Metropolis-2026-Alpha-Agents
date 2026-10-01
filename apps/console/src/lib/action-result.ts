/** What every console server action returns: a value, or a message to show. */
export type ActionResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/**
 * Runs an action and turns any failure into a message. Messages come from our
 * own errors (NotLocalForkError, RpcError, input checks), none of which carry
 * an RPC URL or other secret.
 */
export async function attempt<T>(action: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, value: await action() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "The action failed." };
  }
}
