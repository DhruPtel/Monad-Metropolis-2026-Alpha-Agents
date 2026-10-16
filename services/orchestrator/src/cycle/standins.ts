import type { PositionAction } from "@alpha-agents/platform-tools";

/**
 * 2026-10-16 (owner): on a testnet the Zoom out decides on the real tokens it researched
 * (WETH, WBTC, ...), with a conviction and a weight each, and the cash it keeps; this step, in
 * code and on testnets only, maps those picks onto the tokens the testnet can trade and nothing
 * else. By conviction the top pick executes as the wrapped native (WMON on Monad), the next as
 * TALPHA, the next as TBETA, each with the model's weight exactly. A weight past a deployed
 * contract's cap is cut to the cap, the cut stays in cash and the report says so; no weight is
 * ever moved to another position. Pure: every record comes in as an argument.
 */

/** A pick as the Zoom out drafted it: one target_portfolio@1 position, on any token. */
export interface PickPosition {
  readonly token: string;
  readonly targetWeightBps: number;
  readonly bandBps: number;
  readonly thesisId: string;
  readonly exit: {
    readonly killCriterion: string;
    readonly recheckAt: string;
    readonly trimAboveBps?: number | undefined;
  };
}

/** The RATIONALE's call on a token: why, and how strongly the research backs it. */
export interface PickCall {
  readonly token: string;
  readonly symbol: string;
  readonly action: PositionAction;
  readonly themeCode: string | null;
  readonly reason: string;
  readonly conviction?: number | null;
}

/** A tradable stand-in, in the order picks map onto them, with its cap for one position. */
export interface StandIn {
  readonly token: string;
  readonly symbol: string;
  readonly capBps: number;
}

export interface MappedCall {
  readonly token: string;
  readonly symbol: string;
  readonly action: PositionAction;
  readonly themeCode: string | null;
  readonly reason: string;
  readonly conviction: number | null;
  readonly standInFor: { readonly token: string | null; readonly symbol: string } | null;
}

export interface StandInMapping {
  readonly positions: PickPosition[];
  readonly cashTargetBps: number;
  /** The RATIONALE's calls rewritten onto the stand-ins, EXIT for a stand-in the plan leaves. */
  readonly calls: MappedCall[];
  /** Each real pick, each stand-in left out and each held token dropped, with the reason. */
  readonly notProposed: { token: string; symbol: string; reason: string }[];
  /** "WETH 45%, executes as WMON on testnet", one per mapped pick, for the report. */
  readonly lines: string[];
  /** The same, structured: the researched token, its stand-in and the weight it carries. */
  readonly pairs: {
    real: string;
    standIn: string;
    weightBps: number;
    cappedFromBps: number | null;
  }[];
}

/**
 * The testnet's stand-ins in mapping order: the wrapped native first, then the other buyable
 * tokens by symbol (TALPHA, TBETA); never USDC or a stablecoin.
 */
export function standInOrder(
  tokens: readonly { token: string; symbol: string; capBps: number; buyable: boolean }[],
  wrappedNative: string,
  isStable: (symbol: string) => boolean,
): StandIn[] {
  const usable = tokens.filter((t) => t.buyable && t.capBps > 0 && !isStable(t.symbol));
  const native = usable.filter((t) => lower(t.token) === lower(wrappedNative));
  const rest = usable
    .filter((t) => lower(t.token) !== lower(wrappedNative))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  return [...native, ...rest].map((t) => ({
    token: lower(t.token),
    symbol: t.symbol,
    capBps: t.capBps,
  }));
}

const lower = (t: string) => t.toLowerCase();
const pct = (bps: number) => `${Number.isInteger(bps / 100) ? bps / 100 : (bps / 100).toFixed(1)}%`;

export function mapToStandIns(o: {
  readonly picks: readonly PickPosition[];
  readonly calls: readonly PickCall[];
  readonly standIns: readonly StandIn[];
  /** The target portfolio in force, for ADD, HOLD, TRIM or EXIT. */
  readonly current: readonly { token: string; targetWeightBps: number }[];
  /** Symbols for tokens a call does not name (held tokens, stand-ins). */
  readonly symbols: Readonly<Record<string, string>>;
  /**
   * 2026-10-16: the real token a stand-in carries where it has one (the testnet's WMON is MON).
   * A pick on that stand-in counts as a pick of the real token, ranked by conviction with the rest.
   */
  readonly realOf?: Readonly<Record<string, { readonly token: string; readonly symbol: string }>>;
}): StandInMapping {
  const realOf = new Map(
    Object.entries(o.realOf ?? {}).map(([k, v]) => [
      lower(k),
      { token: lower(v.token), symbol: v.symbol },
    ]),
  );
  const asReal = <T extends { token: string; symbol?: string }>(x: T): T => {
    const r = realOf.get(lower(x.token));
    return r
      ? { ...x, token: r.token, ...(x.symbol !== undefined ? { symbol: r.symbol } : {}) }
      : x;
  };
  o = {
    ...o,
    picks: o.picks.map((p) => asReal(p)),
    calls: o.calls.map((c) => asReal(c)),
    symbols: {
      ...o.symbols,
      ...Object.fromEntries([...realOf.values()].map((r) => [r.token, r.symbol])),
    },
  };
  const callOf = new Map(o.calls.map((c) => [lower(c.token), c]));
  const symbolOf = (t: string) => callOf.get(lower(t))?.symbol ?? o.symbols[lower(t)] ?? t;
  const picks = o.picks
    .map((p, i) => ({ p, i, conviction: callOf.get(lower(p.token))?.conviction ?? 0 }))
    .filter((x) => x.p.targetWeightBps > 0)
    .sort(
      (a, b) =>
        b.conviction - a.conviction || b.p.targetWeightBps - a.p.targetWeightBps || a.i - b.i,
    );

  // Picks onto stand-ins by conviction, each with its own weight. A pick that is itself a
  // stand-in keeps its token; the real picks take the others in order.
  const own = new Map(
    picks
      .filter((x) => o.standIns.some((s) => s.token === lower(x.p.token)))
      .map((x) => [lower(x.p.token), x]),
  );
  const real = picks.filter((x) => !own.has(lower(x.p.token)));
  let next = 0;
  const slots = o.standIns.map((s) => {
    const pick = own.get(s.token) ?? real[next++] ?? null;
    return {
      standIn: s,
      pick,
      // Only a deployed contract's cap cuts a weight; the cut stays in cash.
      w: pick ? Math.min(pick.p.targetWeightBps, s.capBps) : 0,
      cappedFrom:
        pick && pick.p.targetWeightBps > s.capBps
          ? pick.p.targetWeightBps
          : (null as number | null),
    };
  });
  const overflow = real.slice(next);
  const used = slots.filter(
    (s): s is (typeof slots)[number] & { pick: (typeof picks)[number] } =>
      s.pick !== null && s.w > 0,
  );
  const positions: PickPosition[] = used.map((s) => {
    const { trimAboveBps, ...rest } = s.pick.p.exit;
    return {
      token: s.standIn.token,
      targetWeightBps: s.w,
      bandBps: s.pick.p.bandBps,
      thesisId: s.pick.p.thesisId,
      // A trim line at or under a capped weight would sell what the plan just bought.
      exit:
        trimAboveBps !== undefined && trimAboveBps > s.w + s.pick.p.bandBps
          ? { ...rest, trimAboveBps }
          : rest,
    };
  });
  const invested = positions.reduce((n, p) => n + p.targetWeightBps, 0);

  const current = new Map(o.current.map((c) => [lower(c.token), c.targetWeightBps]));
  const action = (token: string, w: number): PositionAction => {
    const now = current.get(lower(token));
    if (now === undefined) return "ADD";
    return w > now ? "ADD" : w < now ? "TRIM" : "HOLD";
  };
  const capNote = (s: (typeof used)[number]) =>
    s.cappedFrom === null
      ? ""
      : ` Capped at ${pct(s.w)} from ${pct(s.cappedFrom)} by this deploy's per-token limit; the rest stays in cash.`;
  const calls: MappedCall[] = used.map((s) => {
    const call = callOf.get(lower(s.pick.p.token));
    const real = lower(s.pick.p.token) !== s.standIn.token ? s.pick.p.token : null;
    return {
      token: s.standIn.token,
      symbol: s.standIn.symbol,
      action: action(s.standIn.token, s.w),
      themeCode: call?.themeCode ?? s.pick.p.thesisId,
      reason: `${call?.reason || `${symbolOf(s.pick.p.token)} at ${pct(s.w)} from the research.`}${capNote(s)}`,
      conviction: call?.conviction ?? null,
      standInFor: real ? { token: lower(real), symbol: symbolOf(real) } : null,
    };
  });
  const inPlan = new Set(used.map((s) => s.standIn.token));
  for (const [token] of current)
    if (!inPlan.has(token))
      calls.push({
        token,
        symbol: symbolOf(token),
        action: "EXIT",
        themeCode: null,
        reason: "No research pick maps to it this cycle.",
        conviction: null,
        standInFor: null,
      });

  const notProposed: StandInMapping["notProposed"] = [];
  const lines: string[] = [];
  const pairs: StandInMapping["pairs"] = [];
  for (const s of used)
    if (lower(s.pick.p.token) !== s.standIn.token) {
      const line = `${symbolOf(s.pick.p.token)} ${pct(s.w)}, executes as ${s.standIn.symbol} on testnet`;
      lines.push(line);
      pairs.push({
        real: symbolOf(s.pick.p.token),
        standIn: s.standIn.symbol,
        weightBps: s.w,
        cappedFromBps: s.cappedFrom,
      });
      notProposed.push({
        token: lower(s.pick.p.token),
        symbol: symbolOf(s.pick.p.token),
        reason: `${line}.${capNote(s)}`,
      });
    }
  for (const x of overflow)
    notProposed.push({
      token: lower(x.p.token),
      symbol: symbolOf(x.p.token),
      reason: "No tradable stand-in left on testnet; its weight stays in cash.",
    });
  for (const s of slots)
    if (s.pick === null && !current.has(s.standIn.token))
      notProposed.push({
        token: s.standIn.token,
        symbol: s.standIn.symbol,
        reason: "No research pick maps to it this cycle.",
      });

  return { positions, cashTargetBps: 10_000 - invested, calls, notProposed, lines, pairs };
}
