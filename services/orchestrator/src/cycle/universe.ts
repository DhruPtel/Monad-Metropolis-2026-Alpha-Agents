import type { ChainReaderV3 } from "@alpha-agents/chain-tools";
import { whyNotBuyableV3 } from "@alpha-agents/chain-tools";
import type { Db } from "@alpha-agents/db";
import { type Hex, isAddressEqual } from "viem";
import type { TokenStore } from "../tokens/store.ts";
import type { ScanTheme } from "./stages.ts";
import type { Cycle } from "./store.ts";

/**
 * The universe a research cycle considered (F-U12): every token the agent
 * could see at the Scan, with its lane and whether this account could buy it
 * and why not; which themes the cycle dived and why each was or was not
 * chosen; and, at the Zoom out, why each token seen was not proposed. One
 * row per token per cycle, written as the cycle goes, read by the Research
 * page's "Universe considered" panel and the agent terminal.
 */
/** P-SWEEP (D-384): a chain whose tokens are studied for research only. */
export interface ResearchChain {
  readonly chainId: number;
  readonly name: string;
  readonly whyNot: string;
}

/** The most tokens per chain a cycle's universe records, by liquidity. */
export const RESEARCH_UNIVERSE_LIMIT = 200;

export interface UniverseRow {
  readonly token: Hex;
  readonly symbol: string;
  readonly priceClass: "USDC" | "F" | "A";
  readonly lane: "core" | "screened" | null;
  readonly status: "listed" | "sell_only" | "delisted" | null;
  readonly buyable: boolean;
  readonly whyNot: string | null;
  readonly held: boolean;
  readonly themeCode: string | null;
  readonly themeReason: string | null;
  readonly researched: boolean;
  readonly proposed: boolean;
  readonly droppedReason: string | null;
}

/** Why a theme was or was not chosen for a Dive, by the rules of `divesFor`. */
export function themeDecisions(o: {
  readonly kind: Cycle["kind"];
  readonly themes: readonly ScanTheme[];
  readonly chosen: readonly ScanTheme[];
  readonly divesPerDay: number;
  readonly divesToday: number;
  readonly recentlyDived: readonly string[];
}): { code: string; token: Hex | null; symbol: string | null; chosen: boolean; reason: string }[] {
  const picked = new Set(o.chosen.map((t) => t.code));
  const left = Math.max(0, o.divesPerDay - o.divesToday);
  return o.themes.map((t) => {
    if (picked.has(t.code))
      return {
        code: t.code,
        token: t.token as Hex | null,
        symbol: t.symbol,
        chosen: true,
        reason: `chosen for a Dive (${t.materiality} materiality)`,
      };
    const reason =
      o.kind === "ACTIVATION"
        ? "beyond the activation sweep's two Dives, by materiality"
        : t.materiality === "low"
          ? "low materiality: not worth a Dive today"
          : t.materiality === "medium" && o.recentlyDived.includes(t.code)
            ? "medium materiality and dived in the last 48 hours"
            : left === 0
              ? "today's Dives are used up"
              : "beyond today's remaining Dives, by materiality";
    return { code: t.code, token: t.token as Hex | null, symbol: t.symbol, chosen: false, reason };
  });
}

export class UniverseStore {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  /** The cycle's universe at the Scan: every token seen, written once. */
  async record(cycle: Cycle, rows: readonly UniverseRow[], now = new Date()): Promise<void> {
    if (rows.length === 0) return;
    await this.db
      .insertInto("platform.research_universe")
      .values(
        rows.map((r) => ({
          chain_id: cycle.chainId,
          agent_id: cycle.agentId,
          cycle_id: cycle.cycleId,
          token: r.token.toLowerCase(),
          symbol: r.symbol,
          price_class: r.priceClass,
          lane: r.lane,
          status: r.status,
          buyable: r.buyable,
          why_not: r.whyNot,
          held: r.held,
          theme_code: r.themeCode,
          theme_reason: r.themeReason,
          researched: r.researched,
          proposed: r.proposed,
          dropped_reason: r.droppedReason,
          created_at: now,
          updated_at: now,
        })),
      )
      .onConflict((oc) =>
        oc.columns(["cycle_id", "token"]).doUpdateSet({
          lane: (eb) => eb.ref("excluded.lane"),
          status: (eb) => eb.ref("excluded.status"),
          buyable: (eb) => eb.ref("excluded.buyable"),
          why_not: (eb) => eb.ref("excluded.why_not"),
          held: (eb) => eb.ref("excluded.held"),
          updated_at: now,
        }),
      )
      .execute();
  }

  /** The themes' decisions: a token's theme and why it was or was not dived. */
  async markThemes(
    cycle: Cycle,
    decisions: readonly { token: Hex | null; code: string; chosen: boolean; reason: string }[],
    now = new Date(),
  ): Promise<void> {
    for (const d of decisions) {
      if (!d.token) continue;
      await this.db
        .updateTable("platform.research_universe")
        .set({ theme_code: d.code, theme_reason: d.reason, researched: d.chosen, updated_at: now })
        .where("cycle_id", "=", cycle.cycleId)
        .where("token", "=", d.token.toLowerCase())
        .execute();
    }
    // P-SWEEP: every other token seen says why it was not researched, so no cycle quietly drops one.
    await this.db
      .updateTable("platform.research_universe")
      .set({
        theme_reason: "seen at the Scan; not one of its themes this cycle",
        updated_at: now,
      })
      .where("cycle_id", "=", cycle.cycleId)
      .where("theme_code", "is", null)
      .where("theme_reason", "is", null)
      .execute();
  }

  /** The Zoom out's outcome: proposed tokens, and every other token seen with its reason. */
  async markOutcome(
    cycle: Cycle,
    proposed: readonly Hex[],
    dropped: readonly { token: Hex; reason: string }[],
    now = new Date(),
  ): Promise<void> {
    for (const t of proposed)
      await this.db
        .updateTable("platform.research_universe")
        .set({ proposed: true, dropped_reason: null, updated_at: now })
        .where("cycle_id", "=", cycle.cycleId)
        .where("token", "=", t.toLowerCase())
        .execute();
    for (const d of dropped)
      await this.db
        .updateTable("platform.research_universe")
        .set({ proposed: false, dropped_reason: d.reason.slice(0, 300), updated_at: now })
        .where("cycle_id", "=", cycle.cycleId)
        .where("token", "=", d.token.toLowerCase())
        .execute();
  }

  async forCycle(cycleId: string): Promise<UniverseRow[]> {
    const rows = await this.db
      .selectFrom("platform.research_universe")
      .selectAll()
      .where("cycle_id", "=", cycleId)
      .orderBy("buyable", "desc")
      .orderBy("symbol")
      .execute();
    return rows.map((r) => ({
      token: r.token as Hex,
      symbol: r.symbol,
      priceClass: r.price_class as UniverseRow["priceClass"],
      lane: r.lane as UniverseRow["lane"],
      status: r.status as UniverseRow["status"],
      buyable: r.buyable,
      whyNot: r.why_not,
      held: r.held,
      themeCode: r.theme_code,
      themeReason: r.theme_reason,
      researched: r.researched,
      proposed: r.proposed,
      droppedReason: r.dropped_reason,
    }));
  }
}

/** What the agent could see at the Scan: every registered token, with this account's buyability. */
export async function universeSnapshot(
  reader: ChainReaderV3,
  tokens: TokenStore,
  cycle: Cycle,
  /** The token table's chain id: Monad mainnet's (the token registry's), not the cycle's (L-216). */
  tokenChainId: number,
  /**
   * P-SWEEP (D-384): the research universe beyond the account's registry: every token the
   * research table holds on Monad mainnet and on each chain named here (Base), as
   * research-only rows with why they cannot be bought.
   */
  researchChains: readonly ResearchChain[] = [],
): Promise<UniverseRow[]> {
  const [m, a] = await Promise.all([reader.market(), reader.agent(cycle.agentId)]);
  const optedIn = a?.account ? a.screenedOptIn : null;
  const held = new Set(
    (a?.holdings ?? []).filter((h) => h.balance > 0n).map((h) => h.token.toLowerCase()),
  );
  const out: UniverseRow[] = [];
  for (const t of m.tokens) {
    const usdc = isAddressEqual(t.token, m.usdc);
    const price = m.prices[t.token.toLowerCase()];
    const row = await tokens.token(tokenChainId, t.token).catch(() => null);
    const whyNot = usdc
      ? "USDC is the account's cash, never bought"
      : whyNotBuyableV3(t, price, optedIn, m.attestorSet, a?.isVault ?? false);
    out.push({
      token: t.token,
      symbol: t.symbol,
      priceClass: usdc ? "USDC" : t.priceClass === "A" ? "A" : "F",
      lane: t.lane === "CORE" ? "core" : t.lane === "SCREENED" ? "screened" : null,
      status:
        t.status === "BUYABLE"
          ? "listed"
          : t.status === "SELL_ONLY"
            ? "sell_only"
            : t.status === "FROZEN"
              ? "delisted"
              : null,
      buyable: !usdc && whyNot === null,
      whyNot:
        whyNot ??
        (row?.screen && !row.screen.fresh
          ? "buyable; its screen is over six hours old and runs again before a buy"
          : null),
      held: held.has(t.token.toLowerCase()),
      themeCode: null,
      themeReason: null,
      researched: false,
      proposed: false,
      droppedReason: null,
    });
  }
  const seen = new Set(out.map((r) => r.token.toLowerCase()));
  const chains: ResearchChain[] = [
    {
      chainId: tokenChainId,
      name: "Monad",
      whyNot: "research only: not in this account's token registry, so not buyable here yet",
    },
    ...researchChains,
  ];
  for (const c of chains) {
    const rows = await tokens
      .listTokens(c.chainId, { limit: RESEARCH_UNIVERSE_LIMIT })
      .catch(() => []);
    for (const t of rows) {
      const key = t.address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        token: key as Hex,
        symbol: c.chainId === tokenChainId ? t.symbol : `${t.symbol} (${c.name})`,
        priceClass: t.priceClass === "A" ? "A" : "F",
        lane: null,
        status: null,
        buyable: false,
        whyNot: c.whyNot,
        held: false,
        themeCode: null,
        themeReason: null,
        researched: false,
        proposed: false,
        droppedReason: null,
      });
    }
  }
  return out;
}
