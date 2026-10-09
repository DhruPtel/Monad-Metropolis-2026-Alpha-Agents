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
  chain("tradable_now", "every rule that blocks a trade now, and when each clears"),
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
  data("market_snapshot", "every market figure in one call, each with its source and time"),
  data("web_search", "web search"),
  data("read_url", "fetch a page through the broker"),
  data("x_search", "X search"),
  data("dune_query", "saved Dune queries"),
  data("defillama_yields", "yields"),
  data("defillama_tvl", "TVL"),
  data("coinmarketcap_prices", "latest market prices, 24h change, volume, market cap"),
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
  platform("check_strategy_params", "the deterministic Test (D-282)"),
  platform("get_research_context", "the agent's own research record (D-287)"),
  platform("write_research_brief", "owner-visible typed briefs (D-284)"),
  platform("directory_search", "agent-to-agent (Phase 5)"),
  platform("list_offers", "agent-to-agent (Phase 5)"),
  platform("send_message", "agent-to-agent (Phase 5)"),
  platform("buy_signal_access", "agent-to-agent (Phase 5)"),
  platform("read_signal_feed", "agent-to-agent (Phase 5)"),
] as const satisfies readonly ToolEntry[];

export type ToolId = (typeof TOOL_REGISTRY)[number]["id"];
export const TOOL_IDS: readonly ToolId[] = TOOL_REGISTRY.map((t) => t.id);

/**
 * Registry entries that have no live tool yet, each naming the unit that builds
 * it (P3-U9). The registry check passes only when every other ID resolves to a
 * tool registered on its server, and every ID here is not yet live.
 */
export interface ToolDeferral {
  readonly unit: string;
  readonly reason: string;
}
const w2 = { unit: "W-2", reason: "the Pass 2 tools (BUILD_PLAN row 50)" } as const;
export const TOOL_DEFERRALS: Readonly<Partial<Record<ToolId, ToolDeferral>>> = {
  "chain.whoami@1": w2,
  "chain.get_assets@1": w2,
  "chain.simulate_rebalance@1": w2,
  "chain.list_intents@1": w2,
  "chain.cancel_intent@1": w2,
  "chain.propose_rebalance@1": w2,
  "data.wallet_portfolio@1": { unit: "W-2", reason: "wallet data, provider chosen in Q-24" },
  "data.wallet_positions@1": { unit: "W-2", reason: "wallet data, provider chosen in Q-24" },
  "data.wallet_pnl@1": { unit: "W-2", reason: "wallet data, provider chosen in Q-24" },
  "data.holders@1": { unit: "W-2", reason: "holder concentration, provider chosen in Q-24" },
  "data.hypersync_events@1": { unit: "after PB-U2", reason: "event history" },
  "data.ohlcv@1": { unit: "after PB-U2", reason: "candles" },
  "data.unlocks@1": { unit: "after the beta", reason: "deferred for the beta (D-302)" },
  "platform.update_thesis@1": {
    unit: "P3-U5",
    reason: "the Thesis Board, cut from the beta (D-160)",
  },
  "platform.list_theses@1": {
    unit: "P3-U5",
    reason: "the Thesis Board, cut from the beta (D-160)",
  },
  "platform.get_thesis@1": { unit: "P3-U5", reason: "the Thesis Board, cut from the beta (D-160)" },
  "platform.propose_strategy_update@1": { unit: "P3-U6", reason: "parameter proposals" },
  "platform.no_change@1": { unit: "P3-U6", reason: "parameter proposals" },
  "platform.check_strategy_params@1": { unit: "P3-U6", reason: "the deterministic Test" },
  "platform.get_research_context@1": { unit: "P3-U4", reason: "the discovery loop" },
  "platform.write_research_brief@1": { unit: "P3-U4", reason: "the discovery loop" },
  "platform.directory_search@1": { unit: "Phase 5", reason: "agent-to-agent tools" },
  "platform.list_offers@1": { unit: "Phase 5", reason: "agent-to-agent tools" },
  "platform.send_message@1": { unit: "Phase 5", reason: "agent-to-agent tools" },
  "platform.buy_signal_access@1": { unit: "Phase 5", reason: "agent-to-agent tools" },
  "platform.read_signal_feed@1": { unit: "Phase 5", reason: "agent-to-agent tools" },
};

export interface RegistryProblem {
  readonly id: string;
  readonly problem: string;
}

/**
 * The registry check (P3-U9): every registry ID resolves to a tool live on
 * its server or carries a deferral; a deferred ID is not already live; every
 * live tool is in the registry; and every tool a skill declares is in the
 * registry and live or deferred. Returns every problem; empty means it passes.
 */
export function checkToolRegistry(o: {
  readonly registry: readonly ToolEntry[];
  readonly deferrals: Readonly<Partial<Record<string, ToolDeferral>>>;
  /** The MCP tool names each server registers, as tools/list reports them. */
  readonly live: Readonly<Record<ToolServer, readonly string[]>>;
  readonly declared?: readonly { readonly skill: string; readonly tools: readonly string[] }[];
}): RegistryProblem[] {
  const problems: RegistryProblem[] = [];
  const ids = new Set(o.registry.map((t) => t.id));
  const isLive = (id: string) => {
    const p = parseToolId(id);
    return p !== undefined && o.live[p.server].includes(p.tool);
  };
  for (const t of o.registry) {
    const parsed = parseToolId(t.id);
    if (!parsed || parsed.server !== t.server) {
      problems.push({ id: t.id, problem: "is not a well-formed ID for its server" });
      continue;
    }
    const deferral = o.deferrals[t.id];
    if (isLive(t.id) && deferral)
      problems.push({
        id: t.id,
        problem: `is live on ${t.server} but still marked deferred to ${deferral.unit}`,
      });
    if (!isLive(t.id) && !deferral)
      problems.push({
        id: t.id,
        problem: `has no tool on the ${t.server} server and no deferral naming its unit`,
      });
  }
  for (const id of Object.keys(o.deferrals))
    if (!ids.has(id)) problems.push({ id, problem: "is deferred but not in the registry" });
  for (const server of TOOL_SERVERS)
    for (const tool of o.live[server]) {
      const id = `${server}.${tool}@1`;
      if (!ids.has(id))
        problems.push({ id, problem: `is live on ${server} but missing from the registry` });
    }
  for (const s of o.declared ?? [])
    for (const id of s.tools) {
      if (id.startsWith("intent.")) {
        if (!(id in INTENT_REGISTRY))
          problems.push({
            id,
            problem: `is declared by ${s.skill} but is not a registered intent`,
          });
        continue;
      }
      if (!ids.has(id))
        problems.push({ id, problem: `is declared by ${s.skill} but is not in the registry` });
    }
  return problems;
}

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
