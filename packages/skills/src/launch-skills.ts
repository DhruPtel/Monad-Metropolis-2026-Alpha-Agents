/**
 * The nine launch skills' manifests (FINAL_PLAN 4.5.4), as fixtures: tools and
 * intents exactly as the table lists them, slot costs as listed, all
 * `required_tier: base` (D-127). The swap skill's real ID waits for the venue
 * decision (Q-01), so it is `venue-swap` here. Descriptions are placeholders
 * until P3-U7 writes the skills.
 */
const PLATFORM_PUBLISHER = {
  id: "alpha-agents",
  address: "0x0000000000000000000000000000000000000001",
  key_id: "platform-1",
};

const skill = (
  id: string,
  type: "protocol" | "strategy" | "research",
  required_tools: string[],
  intents: string[],
  slot_cost: number,
  extra: Record<string, unknown> = {},
) => ({
  schema_version: 1,
  id,
  name: id,
  version: "1.0.0",
  type,
  publisher: PLATFORM_PUBLISHER,
  description: {
    model: `Placeholder for ${id}. Use when testing.`,
    marketplace: `Placeholder listing for ${id}.`,
  },
  required_tools,
  intents,
  data_sources: [],
  required_tier: "base",
  slot_cost,
  chains: ["eip155:143"],
  privacy: "public",
  ...extra,
});

export const LAUNCH_SKILL_MANIFESTS: readonly unknown[] = [
  skill(
    "monad-assets-basics",
    "protocol",
    ["chain.get_assets@1", "chain.read_contract@1", "chain.balance@1"],
    [],
    1,
  ),
  skill(
    "venue-swap",
    "protocol",
    ["chain.get_quote@1", "chain.get_pool_depth@1", "chain.get_prices@1"],
    ["intent.propose_swap@1"],
    1,
  ),
  skill(
    "usdc-wmon-band-rebalancer",
    "strategy",
    [
      "chain.get_prices@1",
      "chain.get_quote@1",
      "chain.get_limits@1",
      "chain.get_portfolio@1",
      "chain.simulate_rebalance@1",
      "data.volatility@1",
    ],
    ["intent.propose_swap@1", "intent.propose_strategy_update@1"],
    2,
    {
      privacy: "private",
      compatible_templates: [{ template: "rebalance_bands@1", params: "data/params.json" }],
    },
  ),
  skill(
    "wmon-dca-accumulator",
    "strategy",
    ["chain.get_prices@1", "chain.get_limits@1", "chain.get_portfolio@1", "data.volatility@1"],
    ["intent.propose_swap@1", "intent.propose_strategy_update@1"],
    2,
    { compatible_templates: [{ template: "dca@1", params: "data/params.json" }] },
  ),
  skill(
    "deep-dive-research",
    "research",
    [
      "data.web_search@1",
      "data.read_url@1",
      "data.x_search@1",
      "data.dune_query@1",
      "chain.read_contract@1",
    ],
    [],
    1,
  ),
  skill(
    "token-risk-screen",
    "research",
    ["chain.read_contract@1", "chain.get_code@1", "data.holders@1", "data.dune_query@1"],
    [],
    1,
  ),
  skill(
    "defi-regime-read",
    "research",
    [
      "data.defillama_yields@1",
      "data.defillama_tvl@1",
      "data.coinmarketcap_prices@1",
      "chain.get_prices@1",
      "data.dune_query@1",
    ],
    [],
    1,
  ),
  skill(
    "narrative-and-flow-tracker",
    "research",
    // `data.unlocks@1` is deferred for the beta and not declared (D-302).
    ["data.x_search@1", "data.web_search@1"],
    [],
    1,
  ),
  skill(
    "wallet-intel",
    "research",
    [
      "data.wallet_portfolio@1",
      "data.wallet_positions@1",
      "data.wallet_pnl@1",
      "chain.balance@1",
      "chain.get_portfolio@1",
    ],
    [],
    1,
  ),
];
