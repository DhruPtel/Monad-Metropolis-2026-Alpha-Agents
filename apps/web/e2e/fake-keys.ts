import type { DataKeyJson, DataKeysJson } from "../src/api/client";

/**
 * The owner's data keys as the fake API serves them (BK-U1): one paid source
 * (Dune), the key the page saved (kept here only to prove it was sent, never
 * served back), and the hint the page shows from then on.
 */
export const DUNE_SOURCE: DataKeyJson = {
  provider: "dune",
  label: "Dune",
  gives:
    "The dune_query tool: the platform's saved Monad analytics (DEX volume, active addresses, MON flows to exchanges), run on your Dune plan.",
  keyHelp: "Create an API key in your Dune account settings and paste it here.",
  tool: "dune_query",
  present: false,
  hint: null,
  addedAt: null,
};

export class FakeKeys {
  available = true;
  /** The keys the page sent, in order; the fake never serves them back. */
  readonly saved: { provider: string; key: string }[] = [];
  readonly removals: string[] = [];
  present: { hint: string; addedAt: string } | null = null;

  list(agentId: string): DataKeysJson {
    return {
      agentId,
      available: this.available,
      keys: [
        {
          ...DUNE_SOURCE,
          present: this.present !== null,
          hint: this.present?.hint ?? null,
          addedAt: this.present?.addedAt ?? null,
        },
      ],
    };
  }

  save(agentId: string, provider: string, body: { key?: unknown } | null) {
    if (provider !== "dune")
      return { status: 404, body: { error: "not_found", message: "No such source." } };
    const key = body?.key;
    if (typeof key !== "string" || key.length < 16)
      return {
        status: 400,
        body: { error: "bad_request", message: "That is too short for an API key." },
      };
    this.saved.push({ provider, key });
    this.present = { hint: `••••${key.slice(-4)}`, addedAt: "2026-10-12T09:00:00.000Z" };
    return {
      status: 201,
      body: {
        agentId,
        key: { provider, present: true, hint: this.present.hint, addedAt: this.present.addedAt },
      },
    };
  }

  remove(agentId: string, provider: string) {
    this.removals.push(provider);
    if (provider !== "dune" || !this.present)
      return {
        status: 404,
        body: { error: "not_found", message: "No key of yours is stored for that source." },
      };
    this.present = null;
    return { status: 200, body: { agentId, removed: provider } };
  }
}
