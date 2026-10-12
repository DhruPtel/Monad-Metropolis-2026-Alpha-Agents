import { PAID_DATA_SOURCES } from "@alpha-agents/domain";
import type { DataKeyJson, DataKeysJson } from "../src/api/client";

/**
 * The owner's data keys as the fake API serves them (BK-U1, BC-U1): every
 * paid source the domain lists (Dune, X, CoinMarketCap), the keys the page
 * saved (kept here only to prove they were sent, never served back), and
 * the hint the page shows from then on.
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

const SOURCES: readonly DataKeyJson[] = PAID_DATA_SOURCES.map((s) => ({
  provider: s.id,
  label: s.label,
  gives: s.gives,
  keyHelp: s.keyHelp,
  tool: s.tool,
  present: false,
  hint: null,
  addedAt: null,
}));
const known = (provider: string) => SOURCES.some((s) => s.provider === provider);

export class FakeKeys {
  available = true;
  /** The keys the page sent, in order; the fake never serves them back. */
  readonly saved: { provider: string; key: string }[] = [];
  readonly removals: string[] = [];
  /** The stored key per source, by its hint alone. */
  readonly present = new Map<string, { hint: string; addedAt: string }>();

  list(agentId: string): DataKeysJson {
    return {
      agentId,
      available: this.available,
      keys: SOURCES.map((s) => {
        const p = this.present.get(s.provider);
        return {
          ...s,
          present: p !== undefined,
          hint: p?.hint ?? null,
          addedAt: p?.addedAt ?? null,
        };
      }),
    };
  }

  save(agentId: string, provider: string, body: { key?: unknown } | null) {
    if (!known(provider))
      return { status: 404, body: { error: "not_found", message: "No such source." } };
    const key = body?.key;
    if (typeof key !== "string" || key.length < 16)
      return {
        status: 400,
        body: { error: "bad_request", message: "That is too short for an API key." },
      };
    this.saved.push({ provider, key });
    const stored = { hint: `••••${key.slice(-4)}`, addedAt: "2026-10-12T09:00:00.000Z" };
    this.present.set(provider, stored);
    return {
      status: 201,
      body: {
        agentId,
        key: { provider, present: true, hint: stored.hint, addedAt: stored.addedAt },
      },
    };
  }

  remove(agentId: string, provider: string) {
    this.removals.push(provider);
    if (!known(provider) || !this.present.has(provider))
      return {
        status: 404,
        body: { error: "not_found", message: "No key of yours is stored for that source." },
      };
    this.present.delete(provider);
    return { status: 200, body: { agentId, removed: provider } };
  }
}
