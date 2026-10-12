/**
 * Paid data sources an owner may bring their own key for (BK-U1, D-368 item
 * 5): the key is stored encrypted by the platform, used only for that owner's
 * agent by the platform's tool servers, never placed in the sandbox or shown
 * again, and metered apart from the platform's own keys. Dune first (D-326:
 * the platform never needs a Dune key); BC-U1 added X and CoinMarketCap on
 * the same mechanism: with the owner's key the tool runs on it for that
 * agent alone, charged nothing and counted under the agent's own daily
 * budget, and without one the platform's key serves as before.
 */
export const PAID_DATA_SOURCES = [
  {
    id: "dune",
    label: "Dune",
    /** What the agent gains with the key, in the owner's words. */
    gives:
      "The dune_query tool: the platform's saved Monad analytics (DEX volume, active addresses, MON flows to exchanges), run on your Dune plan.",
    /** Where the owner gets a key. */
    keyHelp: "Create an API key in your Dune account settings and paste it here.",
    /** The tool the key switches on for the agent. */
    tool: "dune_query",
    /** Whether the platform's own key serves the tool without the owner's (D-326: never for Dune). */
    platformKey: false,
  },
  {
    id: "x",
    label: "X",
    gives:
      "The x_search tool: recent posts on the platform's curated Monad topics, read on your X API plan instead of the platform's shared daily budget.",
    keyHelp: "Create an app in the X developer portal and paste its bearer token (app-only) here.",
    tool: "x_search",
    platformKey: true,
  },
  {
    id: "coinmarketcap",
    label: "CoinMarketCap",
    gives:
      "The coinmarketcap_prices tool: the latest MON and USDC quotes, 24-hour change, volume and market cap, on your CoinMarketCap plan's credits.",
    keyHelp: "Create an API key at pro.coinmarketcap.com and paste it here.",
    tool: "coinmarketcap_prices",
    platformKey: true,
  },
] as const;
export type PaidDataSourceId = (typeof PAID_DATA_SOURCES)[number]["id"];
export const PAID_DATA_SOURCE_IDS = PAID_DATA_SOURCES.map(
  (s) => s.id,
) as readonly PaidDataSourceId[];
export const isPaidDataSourceId = (v: unknown): v is PaidDataSourceId =>
  typeof v === "string" && (PAID_DATA_SOURCE_IDS as readonly string[]).includes(v);

/** The shape every owner-key reading takes: present or not, the last characters, never the key. */
export interface OwnerKeyView {
  readonly provider: PaidDataSourceId;
  readonly present: boolean;
  /** The key's last four characters as "••••abcd", or null when none is stored. */
  readonly hint: string | null;
  readonly addedAt: string | null;
}

/** The hint a stored key is shown by from then on: its last four characters behind dots. */
export const keyHint = (key: string): string => `••••${key.slice(-4)}`;

/** Why a key cannot be saved, in the owner's words, or null when it can. */
export function ownerKeyProblem(key: unknown): string | null {
  if (typeof key !== "string" || key.trim().length === 0) return "Paste the key first.";
  const k = key.trim();
  if (k !== key) return "The key has spaces around it; paste it without them.";
  if (/\s/.test(k)) return "A key has no spaces in it.";
  if (k.length < 16) return "That is too short for an API key.";
  if (k.length > 256) return "That is too long for an API key.";
  return null;
}
