import { AGGRESSIVENESS_ENVELOPES, type Aggressiveness } from "@alpha-agents/domain";
import type { PositionAction } from "@alpha-agents/platform-tools";

/**
 * 2026-10-16 (owner): on a testnet the Zoom out decides on the real tokens it researched
 * (WETH, WBTC, ...) with a conviction and a weight each; this step, in code and on testnets
 * only, carries those picks onto the tokens the testnet can trade. By conviction the top pick
 * executes as the wrapped native (WMON on Monad), the next as TALPHA, the next as TBETA; each
 * keeps its weight up to the stand-in's cap. The plan then invests at least the goal's floor on
 * testnet (Aggressive 90%) and at most its range's top: what is missing goes to the picks by
 * conviction and then to the next stand-in, never to cash, and an excess comes off the
 * lowest-conviction position first. The model never decides what is tradable here.
 * Pure: every record comes in as an argument.
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
  readonly pairs: { real: string; standIn: string; weightBps: number }[];
}

/**
 * The testnet's invested range for a level: the range's top as the goal sets it, and its floor,
 * which on testnet is at least 90% for Aggressive (cash needs a reason; owner, 2026-10-16).
 */
export const TESTNET_INVESTED_FLOOR_BPS: Readonly<Record<Aggressiveness, number>> = Object.freeze({
  CONSERVATIVE: AGGRESSIVENESS_ENVELOPES.CONSERVATIVE.investedRangeBps.min,
  BALANCED: AGGRESSIVENESS_ENVELOPES.BALANCED.investedRangeBps.min,
  AGGRESSIVE: 9_000,
});

export function testnetInvestedRange(level: Aggressiveness): { min: number; max: number } {
  const range = AGGRESSIVENESS_ENVELOPES[level].investedRangeBps;
  return { min: Math.max(range.min, TESTNET_INVESTED_FLOOR_BPS[level]), max: range.max };
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

/** Spreads `amount` over the slots by weight, each up to its room, in whole basis points. */
function fill(slots: { w: number; cap: number; weight: number }[], amount: number): number {
  let left = amount;
  for (;;) {
    const open = slots.filter((s) => s.w < s.cap);
    if (left <= 0 || open.length === 0) return left;
    const total = open.reduce((n, s) => n + s.weight, 0);
    let given = 0;
    for (const s of open) {
      const share = Math.floor(
        (left * (total > 0 ? s.weight : 1)) / (total > 0 ? total : open.length),
      );
      const add = Math.min(share, s.cap - s.w);
      s.w += add;
      given += add;
    }
    // Rounding leaves a few basis points: the highest-weighted open slot takes them one by one.
    if (given === 0) {
      const first = open.reduce((a, b) => (b.weight > a.weight ? b : a));
      const add = Math.min(left, first.cap - first.w);
      first.w += add;
      given = add;
    }
    left -= given;
  }
}

export function mapToStandIns(o: {
  readonly level: Aggressiveness;
  readonly picks: readonly PickPosition[];
  readonly calls: readonly PickCall[];
  readonly standIns: readonly StandIn[];
  /** The target portfolio in force, for ADD, HOLD, TRIM or EXIT. */
  readonly current: readonly { token: string; targetWeightBps: number }[];
  /** Symbols for tokens a call does not name (held tokens, stand-ins). */
  readonly symbols: Readonly<Record<string, string>>;
}): StandInMapping {
  const callOf = new Map(o.calls.map((c) => [lower(c.token), c]));
  const symbolOf = (t: string) => callOf.get(lower(t))?.symbol ?? o.symbols[lower(t)] ?? t;
  const range = testnetInvestedRange(o.level);
  const picks = o.picks
    .map((p, i) => ({ p, i, conviction: callOf.get(lower(p.token))?.conviction ?? 0 }))
    .filter((x) => x.p.targetWeightBps > 0)
    .sort(
      (a, b) =>
        b.conviction - a.conviction || b.p.targetWeightBps - a.p.targetWeightBps || a.i - b.i,
    );
  const drafted = picks.reduce((n, x) => n + x.p.targetWeightBps, 0);
  const target = Math.min(range.max, Math.max(range.min, drafted));

  // Picks onto stand-ins by conviction, each keeping its weight up to the stand-in's cap. A pick
  // that is itself a stand-in keeps its own token; the real picks take the others in order.
  const own = new Map(
    picks
      .filter((x) => o.standIns.some((s) => s.token === lower(x.p.token)))
      .map((x) => [lower(x.p.token), x]),
  );
  const real = picks.filter((x) => !own.has(lower(x.p.token)));
  const overflow: typeof picks = [];
  let next = 0;
  const assigned = o.standIns.map((s) => {
    const mine = own.get(s.token);
    if (mine) return mine;
    return real[next++] ?? null;
  });
  overflow.push(...real.slice(next));
  const slots = o.standIns.map((s, i) => {
    const pick = assigned[i] ?? null;
    return {
      standIn: s,
      pick,
      cap: s.capBps,
      w: pick ? Math.min(pick.p.targetWeightBps, s.capBps) : 0,
      weight: pick ? Math.max(pick.conviction, 1) : 0,
    };
  });
  const placed = slots.reduce((n, s) => n + s.w, 0);
  if (placed > target) {
    // Too much invested: the lowest-conviction position gives way first.
    let excess = placed - target;
    for (const s of [...slots].sort((a, b) => a.weight - b.weight)) {
      const cut = Math.min(s.w, excess);
      s.w -= cut;
      excess -= cut;
    }
  } else if (placed < target) {
    // Too little: the picks by conviction up to their caps, then the next stand-ins evenly.
    const left = fill(
      slots.filter((s) => s.pick),
      target - placed,
    );
    const spare = slots.filter((s) => !s.pick);
    for (const s of spare) s.weight = 1;
    fill(spare, left);
  }

  const top = picks[0]?.p ?? null;
  const used = slots.filter((s) => s.w > 0);
  const positions: PickPosition[] = used.map((s) => {
    const base = s.pick?.p ?? top;
    const exit = s.pick
      ? s.pick.p.exit
      : {
          killCriterion: `Leaves with the plan's top pick: it fills the goal's invested range on testnet (${top ? symbolOf(top.token) : "the top pick"}).`,
          recheckAt: top?.exit.recheckAt ?? new Date().toISOString(),
        };
    const { trimAboveBps, ...rest } = exit;
    return {
      token: s.standIn.token,
      targetWeightBps: s.w,
      bandBps: base?.bandBps ?? 200,
      thesisId: base?.thesisId ?? "testnet-range",
      // A trim line at or under the new weight would sell what the plan just bought.
      exit:
        trimAboveBps !== undefined && trimAboveBps > s.w + (base?.bandBps ?? 0)
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
  const calls: MappedCall[] = used.map((s) => {
    const call = s.pick ? callOf.get(lower(s.pick.p.token)) : undefined;
    const real = s.pick && lower(s.pick.p.token) !== s.standIn.token ? s.pick.p.token : null;
    return {
      token: s.standIn.token,
      symbol: s.standIn.symbol,
      action: action(s.standIn.token, s.w),
      themeCode: s.pick ? (call?.themeCode ?? s.pick.p.thesisId) : null,
      reason: s.pick
        ? call?.reason || `${symbolOf(s.pick.p.token)} at ${pct(s.w)} from the research.`
        : "Fills the goal's invested range on testnet; it carries no pick of its own.",
      conviction: s.pick ? (call?.conviction ?? null) : null,
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
    if (s.pick && lower(s.pick.p.token) !== s.standIn.token) {
      const line = `${symbolOf(s.pick.p.token)} ${pct(s.w)}, executes as ${s.standIn.symbol} on testnet`;
      lines.push(line);
      pairs.push({ real: symbolOf(s.pick.p.token), standIn: s.standIn.symbol, weightBps: s.w });
      notProposed.push({
        token: lower(s.pick.p.token),
        symbol: symbolOf(s.pick.p.token),
        reason: `${line}.`,
      });
    }
  for (const s of slots)
    if (s.pick && s.w === 0 && lower(s.pick.p.token) !== s.standIn.token)
      notProposed.push({
        token: lower(s.pick.p.token),
        symbol: symbolOf(s.pick.p.token),
        reason: "Left out to keep the plan within the goal's invested range on testnet.",
      });
  for (const x of overflow)
    notProposed.push({
      token: lower(x.p.token),
      symbol: symbolOf(x.p.token),
      reason:
        "No tradable stand-in left on testnet; its weight went to the plan's other positions.",
    });
  for (const s of slots)
    if (s.w === 0 && !current.has(s.standIn.token))
      notProposed.push({
        token: s.standIn.token,
        symbol: s.standIn.symbol,
        reason: "No research pick maps to it this cycle.",
      });

  return { positions, cashTargetBps: 10_000 - invested, calls, notProposed, lines, pairs };
}
