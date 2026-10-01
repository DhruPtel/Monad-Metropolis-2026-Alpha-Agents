/**
 * The canonical tool registry of FINAL_PLAN 4.4.5 (orientation fix 2): every tool
 * the three MCP servers expose and every intent an agent may propose. IDs are
 * `<server>.<tool>@<major>`; the MCP tool name is the part after the dot.
 * packages/skills validates manifests against this list.
 *
 * `data.premium_*@1` is reserved for the pro tier and enumerated in P6-U5, so it
 * is not a usable ID yet.
 */
export const TOOL_SERVERS = ["chain", "data", "platform"] as const;
export type ToolServer = (typeof TOOL_SERVERS)[number];
export type ToolTier = "baseline" | "pro";

export interface ToolEntry {
  readonly id: string;
  readonly server: ToolServer;
  readonly tier: ToolTier;
  readonly purpose: string;
}

const chain = (tool: string, purpose: string) =>
  ({ id: `chain.${tool}@1`, server: "chain", tier: "baseline", purpose }) as const;
const data = (tool: string, purpose: string) =>
  ({ id: `data.${tool}@1`, server: "data", tier: "baseline", purpose }) as const;
const platform = (tool: string, purpose: string) =>
  ({ id: `platform.${tool}@1`, server: "platform", tier: "baseline", purpose }) as const;

export const TOOL_REGISTRY = [
  chain("whoami", "identity, accounts, epochs"),
  chain("get_assets", "the asset registry"),
  chain("get_portfolio", "holdings and value per account"),
  chain("get_prices", "oracle and pool prices, tradability"),
  chain("get_quote", "indicative quote with the limit check"),
  chain("get_limits", "live limits, headroom, mode"),
  chain("get_pool_depth", "depth at the reference size"),
  chain("simulate_rebalance", "dry run of targets"),
  chain("read_contract", "curated read-only calls on any target"),
  chain("balance", "token or native balance of any target"),
  chain("get_code", "code presence, size, hash, proxy pattern"),
  chain("get_intent_status", "intent lifecycle"),
  chain("list_intents", "intent lifecycle"),
  chain("cancel_intent", "intent lifecycle"),
  chain("propose_swap", "creates a swap intent"),
  chain("propose_rebalance", "creates a rebalance intent"),
  data("web_search", "web search"),
  data("read_url", "fetch a page through the broker"),
  data("x_search", "X search"),
  data("dune_query", "saved Dune queries"),
  data("defillama_yields", "yields"),
  data("defillama_tvl", "TVL"),
  data("coingecko_prices", "market prices and history"),
  data("hypersync_events", "event history"),
  data("wallet_portfolio", "wallet holdings"),
  data("wallet_positions", "wallet positions"),
  data("wallet_pnl", "wallet PnL"),
  data("holders", "holder concentration"),
  data("unlocks", "supply unlock schedules"),
  data("volatility", "realized volatility"),
  data("ohlcv", "candles"),
  platform("get_goals_and_limits", "goal, template, parameters, live limits"),
  platform("write_thesis", "the Thesis Board"),
  platform("update_thesis", "the Thesis Board"),
  platform("list_theses", "the Thesis Board"),
  platform("get_thesis", "the Thesis Board"),
  platform("propose_strategy_update", "parameter change proposal"),
  platform("no_change", "stage terminal"),
  platform("complete_stage", "stage terminal"),
  platform("directory_search", "agent-to-agent (Phase 5)"),
  platform("list_offers", "agent-to-agent (Phase 5)"),
  platform("send_message", "agent-to-agent (Phase 5)"),
  platform("buy_signal_access", "agent-to-agent (Phase 5)"),
  platform("read_signal_feed", "agent-to-agent (Phase 5)"),
] as const satisfies readonly ToolEntry[];

export type ToolId = (typeof TOOL_REGISTRY)[number]["id"];
export const TOOL_IDS: readonly ToolId[] = TOOL_REGISTRY.map((t) => t.id);

/** Reserved, not yet usable: the pro tier's premium data set (P6-U5). */
export const RESERVED_TOOL_PATTERNS = ["data.premium_*@1"] as const;

/** Intents: the registry subset that creates proposals, and the tool that creates each. */
export const INTENT_REGISTRY = {
  "intent.propose_swap@1": "chain.propose_swap@1",
  "intent.propose_rebalance@1": "chain.propose_rebalance@1",
  "intent.propose_strategy_update@1": "platform.propose_strategy_update@1",
} as const satisfies Record<string, ToolId>;
export type IntentToolId = keyof typeof INTENT_REGISTRY;
export const INTENT_TOOL_IDS = Object.keys(INTENT_REGISTRY) as IntentToolId[];

/** Tools every skill may use without declaring them (4.4.5 "every skill implicitly"). */
export const IMPLICIT_TOOL_IDS: readonly ToolId[] = [
  "chain.whoami@1",
  "platform.get_goals_and_limits@1",
  "platform.no_change@1",
  "platform.complete_stage@1",
];

/** Earlier research IDs, replaced by the entries above and invalid in a manifest. */
export const RETIRED_TOOL_IDS = [
  "data.dex_quote",
  "data.pool_state",
  "data.price_feed",
  "data.yields",
  "data.tvl",
  "platform.portfolio",
] as const;

export function isToolId(id: string): id is ToolId {
  return (TOOL_IDS as readonly string[]).includes(id);
}

export function isIntentToolId(id: string): id is IntentToolId {
  return id in INTENT_REGISTRY;
}

const TOOL_ID_PATTERN = /^(chain|data|platform)\.([a-z][a-z0-9_]*)@([1-9]\d*)$/;

/** Splits a tool ID into server, MCP tool name and major version, or undefined if malformed. */
export function parseToolId(
  id: string,
): { server: ToolServer; tool: string; major: number } | undefined {
  const m = TOOL_ID_PATTERN.exec(id);
  if (!m?.[1] || !m[2] || !m[3]) return undefined;
  return { server: m[1] as ToolServer, tool: m[2], major: Number(m[3]) };
}
