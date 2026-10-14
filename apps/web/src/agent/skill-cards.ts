import type { SkillCardView, SkillCategory } from "@alpha-agents/ui";
import type { SkillJson } from "@/api/client";

/**
 * 2026-10-13: the configure page's skill cards from the skills' real records. The API gives
 * each skill's name, version, description, kind and tools; the category is the manifest's
 * type (research, strategy, protocol), known here by the built-in skill's id, and a skill
 * without one (an owner's upload) takes it from the tools it reads. No price or rarity is
 * invented: every skill is free.
 */
const BUILTIN_CATEGORY: Readonly<Record<string, SkillCategory>> = {
  "deep-dive-research": "Research",
  "defi-regime-read": "Research",
  "narrative-and-flow-tracker": "Research",
  "token-risk-screen": "Research",
  "portfolio-construction": "Strategy",
  "usdc-wmon-band-rebalancer": "Strategy",
  "monad-assets-basics": "Protocol",
  "uniswap-v4-swap": "Protocol",
};

const PLAYBOOK_STAGE: Readonly<Record<string, string>> = {
  "playbook-scan": "Scan",
  "playbook-dive": "Dive",
  "playbook-challenge": "Challenge",
  "playbook-zoom-out": "Zoom out",
};

const TOOL_WORD: Readonly<Record<string, string>> = {
  market_snapshot: "market snapshot",
  list_tokens: "token list",
  new_pools: "new pools",
  web_search: "web search",
  read_url: "web pages",
  x_search: "X search",
  lookup_token: "token lookup",
  find_pools: "pool finder",
  screen_token: "safety screen",
  coinmarketcap_prices: "CoinMarketCap",
  defillama_tvl: "DefiLlama TVL",
  defillama_yields: "DefiLlama yields",
  dune_query: "Dune",
  get_pool_depth: "pool depth",
  read_contract: "contract reads",
  get_code: "contract code",
  get_quote: "swap quotes",
  propose_swap: "swap proposals",
};

/** "data.web_search@1" as "web search". */
export function toolWord(tool: string): string {
  const bare = tool.replace(/^[a-z]+\./, "").replace(/@\d+$/, "");
  return TOOL_WORD[bare] ?? bare.replaceAll("_", " ");
}

function categoryOf(k: Pick<SkillJson, "id" | "kind" | "tools">): SkillCategory {
  if (k.kind === "playbook") return "Research";
  const known = BUILTIN_CATEGORY[k.id];
  if (known) return known;
  const tools = k.tools.join(" ");
  if (/propose_swap|swap|arm/.test(tools)) return "Execution";
  if (/portfolio|allocation|plan/.test(tools)) return "Strategy";
  return "Research";
}

/** The stage a skill serves: a playbook's own, or one its description names ("Use when a Dive..."). */
function stageOf(k: Pick<SkillJson, "id" | "description">): string | null {
  const own = PLAYBOOK_STAGE[k.id];
  if (own) return own;
  const named = ["Scan", "Dive", "Challenge", "Zoom out"].filter((s) => k.description.includes(s));
  return named.length > 0 ? named.join(", ") : null;
}

export function skillCards(skills: readonly SkillJson[]): SkillCardView[] {
  return skills.map((k) => ({
    id: k.id,
    name: k.name,
    publisher: k.kind === "owner" ? "You" : "Vivarium",
    verified: k.kind !== "owner",
    category: categoryOf(k),
    description: k.description,
    version: k.version,
    tools: [...new Set(k.tools.map(toolWord))],
    stage: stageOf(k),
  }));
}
