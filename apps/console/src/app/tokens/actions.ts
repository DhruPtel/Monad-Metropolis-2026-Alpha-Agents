"use server";

import { type ActionResult, attempt } from "@/lib/action-result";
import { orchestratorUrl } from "../agents/extension";

/**
 * F-U1: screens a token now on the orchestrator's screen fork, or runs a
 * discovery pass now. The orchestrator offers both only to operators (D-205);
 * a screen takes a few seconds to a minute, and the page waits for it.
 */
export async function screenTokenAction(
  address: string,
): Promise<ActionResult<{ verdict: "passed" | "refused"; failed: number }>> {
  return attempt(async () => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("That is not a token address.");
    const res = await fetch(`${orchestratorUrl()}/v1/tokens/${address}/screen`, {
      method: "POST",
      cache: "no-store",
    });
    const body = (await res.json().catch(() => ({}))) as {
      screen?: { verdict: "passed" | "refused"; checks: { status: string }[] };
      message?: string;
    };
    if (!res.ok || !body.screen)
      throw new Error(body.message ?? `The orchestrator answered ${res.status}.`);
    return {
      verdict: body.screen.verdict,
      failed: body.screen.checks.filter((c) => c.status === "fail").length,
    };
  });
}

/** What a discovery run reports while it runs and once it ends (the orchestrator's run record). */
export interface DiscoveryRunView {
  readonly runId: string;
  readonly status: "running" | "completed" | "failed";
  readonly tokensSeen: number;
  readonly poolsSeen: number;
  readonly newPools: number;
  readonly error: string | null;
}

/**
 * Starts a discovery pass and answers at once with its run (L-197): the pass
 * can outlast any request, so the button watches the run with
 * `discoveryRunAction` until it ends. A pass already under way is joined.
 */
export async function discoverTokensAction(): Promise<
  ActionResult<{ runId: string; started: boolean }>
> {
  return attempt(async () => {
    const res = await fetch(`${orchestratorUrl()}/v1/tokens/discover`, {
      method: "POST",
      cache: "no-store",
    });
    const body = (await res.json().catch(() => ({}))) as {
      runId?: string;
      started?: boolean;
      message?: string;
    };
    if (!res.ok || !body.runId)
      throw new Error(body.message ?? `The orchestrator answered ${res.status}.`);
    return { runId: body.runId, started: body.started ?? true };
  });
}

/** One discovery run as the registry records it, for the button watching it. */
export async function discoveryRunAction(runId: string): Promise<ActionResult<DiscoveryRunView>> {
  return attempt(async () => {
    if (!/^[0-9a-f-]{36}$/.test(runId)) throw new Error("That is not a discovery run.");
    const res = await fetch(`${orchestratorUrl()}/v1/tokens/discovery/${runId}`, {
      cache: "no-store",
    });
    const body = (await res.json().catch(() => ({}))) as {
      run?: DiscoveryRunView;
      message?: string;
    };
    if (!res.ok || !body.run)
      throw new Error(body.message ?? `The orchestrator answered ${res.status}.`);
    return body.run;
  });
}

/** D-360: looks up any token by address; it joins the shared registry, and its page opens. */
export async function lookupTokenAction(
  address: string,
): Promise<ActionResult<{ address: string; symbol: string }>> {
  return attempt(async () => {
    const a = address.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(a))
      throw new Error("Enter a token address: 0x and 40 hex characters.");
    const res = await fetch(`${orchestratorUrl()}/v1/tokens/lookup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: a }),
      cache: "no-store",
    });
    const body = (await res.json().catch(() => ({}))) as {
      token?: { address: string; symbol: string };
      message?: string;
    };
    if (!res.ok || !body.token)
      throw new Error(body.message ?? `The orchestrator answered ${res.status}.`);
    return { address: body.token.address, symbol: body.token.symbol };
  });
}
