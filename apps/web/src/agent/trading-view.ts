import { TESTNET_CHAIN } from "@alpha-agents/config";
import { formatAmount } from "@alpha-agents/domain";
import type {
  AssetRow,
  DecisionView,
  InsightView,
  LiveTradeView,
  PlanMoveView,
  PlanRowView,
  TradeRowView,
} from "@alpha-agents/ui";
import type {
  ActivityJson,
  IntentJson,
  PlanCardJson,
  ProposalJson,
  ProposalPositionJson,
  WhyNotTradedJson,
} from "@/api/client";
import { DECIMALS } from "./portfolio";
import { WRAPPED_NATIVE, wrappedLabel } from "./wrapped-native";

/** UI-FAST: the Trading tab's words: the plan's moves, the sweep's line, the past trades. */

const pctText = (bps: number) =>
  `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;

/**
 * 2026-10-15: a position's research line: the researched token a testnet stand-in carries
 * ("WETH, 35%, executes as WMON on testnet") and the research's conviction; null for neither.
 */
export function positionNote(x: ProposalPositionJson): string | null {
  const parts: string[] = [];
  if (x.standInFor && x.action !== "EXIT")
    parts.push(
      `${x.standInFor.symbol}, ${pctText(x.targetWeightBps)}, executes as ${x.symbol} on testnet`,
    );
  if (typeof x.conviction === "number" && x.action !== "EXIT")
    parts.push(`conviction ${x.conviction}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The plan as moves, one per token: each proposed position (Buy to add, Sell to trim or exit,
 * Hold to keep); a band plan with no position rows (the two-asset template) moves by its own
 * WMON and cash targets; a position the plan leaves out is sold. The reason is the position's
 * thesis, or the plan's view of the portfolio.
 */
export function planMoves(p: ProposalJson, card?: PlanCardJson | null): PlanMoveView[] {
  const view = p.rationale.portfolioView;
  const moves: PlanMoveView[] = p.positions.map((x) => {
    const now = x.currentWeightBps === null ? "" : ` (now ${pctText(x.currentWeightBps)})`;
    return {
      side: x.action === "ADD" ? "Buy" : x.action === "HOLD" ? "Hold" : "Sell",
      symbol: x.symbol,
      amount: x.action === "EXIT" ? `Sell all${now}` : `Target ${pctText(x.targetWeightBps)}${now}`,
      reason: [positionNote(x), x.thesis ?? x.reason].filter(Boolean).join(". "),
    };
  });
  if (p.positions.length === 0 && p.plan) {
    const target = p.plan.targetWmonBps;
    if (target !== undefined) {
      const was = card?.current?.targetWmonBps ?? null;
      const now = was === null ? "" : ` (plan now ${pctText(was)})`;
      moves.push({
        side: was === null || target > was ? "Buy" : target < was ? "Sell" : "Hold",
        symbol: WRAPPED_NATIVE,
        amount: `Target ${pctText(target)}${now}`,
        reason: view,
      });
    }
    const cash = p.plan.cashTargetBps ?? (target !== undefined ? 10_000 - target : undefined);
    if (cash !== undefined)
      moves.push({
        side: "Hold",
        symbol: "USDC",
        amount: `Keep ${pctText(cash)}`,
        reason: p.rationale.allocationNote ?? "The rest stays in USDC, the account's cash.",
      });
  }
  const kept = new Set(p.positions.map((x) => x.token.toLowerCase()));
  if (p.positions.length > 0)
    for (const c of card?.current?.positions ?? [])
      if (!kept.has(c.token.toLowerCase()))
        moves.push({
          side: "Sell",
          symbol: c.symbol,
          amount: `Sell all (plan now ${pctText(c.targetWeightBps)})`,
          reason: "The new plan leaves it out.",
        });
  return moves;
}

export const SWEEP_WORDS: Readonly<Record<string, string>> = {
  running: "The activation sweep is running",
  plan_ready: "The latest sweep made a plan that waits for you",
  active: "The latest sweep's plan is in force",
  no_plan: "The latest sweep proposed no plan",
  failed: "The latest sweep failed",
  capped: "The latest sweep stopped at its cost ceiling",
  out_of_credits: "The latest sweep stopped: out of credits",
};

const RESULT: Readonly<Record<string, { text: string; tone: TradeRowView["resultTone"] }>> = {
  settled: { text: "Settled", tone: "positive" },
  confirmed: { text: "Settling", tone: "neutral" },
  submitted: { text: "Sent", tone: "neutral" },
  approved: { text: "Approved", tone: "neutral" },
  awaiting_approval: { text: "Waiting for you", tone: "warning" },
  rejected: { text: "Not sent", tone: "neutral" },
  cancelled: { text: "Declined", tone: "neutral" },
  expired: { text: "Expired", tone: "neutral" },
  failed: { text: "Failed", tone: "negative" },
};

export function tradeRows(intents: readonly IntentJson[]): TradeRowView[] {
  const units = (raw: string, asset: string) =>
    formatAmount(BigInt(raw), assetDecimals(asset), { maxFractionDigits: 6 });
  return intents.map((i) => {
    const buying = isUsdc(i.sell.asset);
    const out = i.amountOut ?? i.expectedOut;
    const r = RESULT[i.status] ?? { text: i.status, tone: "neutral" as const };
    const at = i.settledAt ?? i.createdAt;
    return {
      id: i.intentId,
      symbol: wrappedLabel(buying ? i.buy : i.sell.asset),
      side: buying ? "Buy" : "Sell",
      date: `${at.slice(0, 10)} ${at.slice(11, 16)}`,
      amount: `${units(i.sell.amountRaw, i.sell.asset)} ${wrappedLabel(i.sell.asset)}${out ? ` → ${units(out.amountRaw, i.buy)} ${wrappedLabel(i.buy)}` : ""}`,
      result: r.text,
      resultTone: r.tone,
    };
  });
}

/**
 * CO-U1 (2026-10-15): an intent names its assets by the chain's symbols (tUSDC and WETH on the
 * L2 testnets), not only USDC and WMON; a symbol the table does not know is a USDC (6 decimals)
 * or an 18-decimal token, never undefined, which crashed the page.
 */
const isUsdc = (asset: string) => /USDC$/i.test(asset);
const assetDecimals = (asset: string): number =>
  DECIMALS[asset as keyof typeof DECIMALS] ?? (isUsdc(asset) ? 6 : 18);

const minute = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;

/**
 * A few figures about what the account holds and how it traded; "–" where the data does not
 * exist yet (no position records its first buy, so its age is unknown).
 */
export function insights(
  rows: readonly AssetRow[],
  intents: readonly IntentJson[],
  now: number,
): InsightView[] {
  const held = rows.filter((r) => !r.isCash && BigInt(r.amountRaw) > 0n);
  const priced = held.filter((r) => r.shareBps !== null);
  const byShare = [...priced].sort((a, b) => (b.shareBps ?? 0) - (a.shareBps ?? 0));
  const gained = held.filter((r) => r.gainBps !== null);
  const byGain = [...gained].sort((a, b) => (b.gainBps ?? 0) - (a.gainBps ?? 0));
  const share = (r?: AssetRow) =>
    r && r.shareBps !== null ? `${r.symbol} ${pctText(r.shareBps)}` : "–";
  const gain = (r?: AssetRow) =>
    r && r.gainBps !== null ? `${r.symbol} ${r.gainBps >= 0 ? "+" : ""}${pctText(r.gainBps)}` : "–";
  const month = now - 30 * 86_400_000;
  const recent = intents.filter(
    (i) => i.status === "settled" && Date.parse(i.settledAt ?? i.createdAt) >= month,
  );
  const buys = recent.filter((i) => isUsdc(i.sell.asset)).length;
  const best = byGain[0];
  const worst = byGain.length > 1 ? byGain[byGain.length - 1] : undefined;
  return [
    { label: "Positions", value: String(held.length) },
    { label: "Average position age", value: "–" },
    { label: "Largest", value: share(byShare[0]) },
    { label: "Smallest", value: byShare.length > 1 ? share(byShare[byShare.length - 1]) : "–" },
    {
      label: "Best",
      value: gain(best),
      tone:
        best?.gainBps == null
          ? "neutral"
          : best.gainBps > 0
            ? "positive"
            : best.gainBps < 0
              ? "negative"
              : "neutral",
    },
    {
      label: "Worst",
      value: gain(worst),
      tone:
        worst?.gainBps == null
          ? "neutral"
          : worst.gainBps < 0
            ? "negative"
            : worst.gainBps > 0
              ? "positive"
              : "neutral",
    },
    { label: "Buys, last 30 days", value: String(buys) },
    { label: "Sells, last 30 days", value: String(recent.length - buys) },
  ];
}

/** UI-FAST: a transaction on the environment's explorer; null where the chain has none (the forks). */
export function txHref(environment: string, hash: string): string | null {
  // CO-U1: the explorer of the testnet this build runs on.
  if (environment === "testnet") return `${TESTNET_CHAIN.explorerTxUrl}${hash}`;
  if (environment === "beta" || environment === "canary")
    return `https://monadvision.com/tx/${hash}`;
  return null;
}

const usdcText = (e6: string | bigint) =>
  `${formatAmount(BigInt(e6), 6, { minFractionDigits: 2, maxFractionDigits: 2 })} USDC`;

/** The runner's recorded skip in plain words: what it would have done and why it did not. */
export function skipWords(
  runner: NonNullable<WhyNotTradedJson["runner"]>,
  plan: ProposalJson["plan"] | null,
): string {
  if (runner.code === "BELOW_MIN_TRADE" && plan?.targetWmonBps !== undefined && plan.minTradeUsdcE6)
    return `Skipped: the trade back to ${pctText(plan.targetWmonBps)} ${WRAPPED_NATIVE} was below the ${usdcText(plan.minTradeUsdcE6)} minimum.`;
  return `Skipped: ${runner.message.charAt(0).toLowerCase()}${runner.message.slice(1)}`;
}

/**
 * The Trading tab's decisions, newest first: every plan and no-change decision (linked to its
 * research report), every trade (linked to its transaction), every trade the limits refused,
 * and the runner's latest recorded skip.
 */
export function decisionRows(input: {
  card: PlanCardJson | null;
  intents: readonly IntentJson[];
  activity: readonly ActivityJson[];
  runner: WhyNotTradedJson["runner"] | null;
  reportFor: (cycleId: string) => string;
  txFor: (hash: string) => string | null;
}): DecisionView[] {
  const { card } = input;
  const proposals = new Map<string, ProposalJson>();
  for (const p of [card?.pending, card?.noChange, ...(card?.recent ?? [])])
    if (p) proposals.set(p.proposalId, p);
  const rows: (DecisionView & { at: string })[] = [];
  for (const p of proposals.values()) {
    const move = planMoves(p, card).find((m) => m.symbol !== "USDC");
    const noChange = p.kind === "no_change";
    rows.push({
      id: p.proposalId,
      kind: "Plan",
      token: noChange ? null : (move?.symbol ?? null),
      detail: noChange ? "No change" : (move?.amount ?? null),
      summary: (noChange ? p.explanation : null) ?? p.rationale.portfolioView,
      time: minute(p.createdAt),
      at: p.createdAt,
      link: p.cycleId
        ? { href: input.reportFor(p.cycleId), label: "Report", external: false }
        : null,
    });
  }
  const units = (raw: string, asset: string) =>
    formatAmount(BigInt(raw), assetDecimals(asset), { maxFractionDigits: 6 });
  for (const i of input.intents) {
    const buying = isUsdc(i.sell.asset);
    const at = i.settledAt ?? i.createdAt;
    const href = i.txHash ? input.txFor(i.txHash) : null;
    const result = RESULT[i.status]?.text ?? i.status;
    rows.push({
      id: i.intentId,
      kind: "Trade",
      token: wrappedLabel(buying ? i.buy : i.sell.asset),
      detail: `${buying ? "Buy" : "Sell"} ${units(i.sell.amountRaw, i.sell.asset)} ${wrappedLabel(i.sell.asset)}`,
      summary: `${result}. ${i.reason}`,
      time: minute(at),
      at,
      link: href ? { href, label: "Transaction", external: true } : null,
    });
  }
  for (const e of input.activity.filter((x) => x.kind === "blocked"))
    rows.push({
      id: e.entryId,
      kind: "Refused",
      token: null,
      detail: null,
      summary: e.text,
      time: minute(e.at),
      at: e.at,
      link: null,
    });
  const r = input.runner;
  if (r && r.outcome !== "trade" && r.code) {
    const plan = (card?.pending ?? latestApplied(card))?.plan ?? null;
    rows.push({
      id: `runner-${r.since}`,
      kind: "Skipped",
      token: plan?.targetWmonBps !== undefined ? WRAPPED_NATIVE : null,
      detail: plan?.targetWmonBps !== undefined ? `Target ${pctText(plan.targetWmonBps)}` : null,
      summary: skipWords(r, plan),
      time: minute(r.lastAt),
      at: r.lastAt,
      link: null,
    });
  }
  return rows
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .map((d) => {
      const { at, ...view } = d;
      void at;
      return view;
    });
}

/** The plan in force: the latest applied proposal. */
export function latestApplied(card: PlanCardJson | null): ProposalJson | null {
  return card?.recent.find((p) => p.status === "applied") ?? null;
}

/** The plan's moves as rows: each token's target and its share now (from the holdings). */
export function planRows(
  p: ProposalJson,
  card: PlanCardJson | null,
  holdings: readonly AssetRow[],
): PlanRowView[] {
  // With priced holdings, a token the account does not hold is 0% of it, not unknown.
  const priced = holdings.some((h) => h.shareBps !== null);
  const shareOf = (symbol: string) => {
    const h = holdings.find((x) => x.symbol === symbol);
    return h ? h.shareBps : priced ? 0 : null;
  };
  const targetOf = (symbol: string): number | null => {
    const pos = p.positions.find((x) => x.symbol === symbol);
    if (pos) return pos.action === "EXIT" ? 0 : pos.targetWeightBps;
    if (symbol === WRAPPED_NATIVE && p.plan?.targetWmonBps !== undefined)
      return p.plan.targetWmonBps;
    if (symbol === "USDC") {
      if (p.plan?.cashTargetBps !== undefined) return p.plan.cashTargetBps;
      if (p.plan?.targetWmonBps !== undefined) return 10_000 - p.plan.targetWmonBps;
    }
    return null;
  };
  // 2026-10-13: the side comes from the account's share now against the target and its range,
  // as the runner judges it; comparing with the previous plan's target showed a Sell the
  // runner had no reason to make.
  const bandOf = (symbol: string): number => {
    const pos = p.positions.find((x) => x.symbol === symbol);
    return pos?.bandBps ?? p.plan?.bandHalfWidthBps ?? 500;
  };
  return planMoves(p, card).map((m) => {
    const targetBps = targetOf(m.symbol);
    const currentBps = shareOf(m.symbol);
    const side =
      m.symbol === "USDC" || targetBps === null || currentBps === null
        ? m.side
        : Math.abs(currentBps - targetBps) <= bandOf(m.symbol)
          ? "Hold"
          : currentBps < targetBps
            ? "Buy"
            : "Sell";
    const pos = p.positions.find((x) => x.symbol === m.symbol);
    const note = pos ? positionNote(pos) : null;
    return { symbol: m.symbol, side, targetBps, currentBps, ...(note ? { note } : {}) };
  });
}

/** 2026-10-13: a plan the account already matches: every move a Hold, so approving it trades nothing. */
export function planIsMet(rows: readonly PlanRowView[]): boolean {
  return rows.length > 0 && rows.every((r) => r.side === "Hold");
}

/** The expanded insights: value, cash against invested, positions, gains, trades, age. */
export function insightRows(
  rows: readonly AssetRow[],
  totalUsdcE6: string | null,
  intents: readonly IntentJson[],
  now: number,
): InsightView[] {
  const base = insights(rows, intents, now);
  const by = (label: string) => base.find((b) => b.label === label) ?? { label, value: "–" };
  const cashBps = rows.filter((r) => r.isCash).reduce((t, r) => t + (r.shareBps ?? 0), 0);
  const priced = rows.some((r) => r.shareBps !== null);
  const withBasis = rows.filter((r) => !r.isCash && r.gainUsdcE6 !== null);
  const unrealized = withBasis.reduce((t, r) => t + BigInt(r.gainUsdcE6 as string), 0n);
  const signed = (e6: bigint) => `${e6 >= 0n ? "+" : "-"}${usdcText(e6 < 0n ? -e6 : e6)}`;
  return [
    { label: "Total value", value: totalUsdcE6 === null ? "–" : usdcText(totalUsdcE6) },
    priced
      ? {
          label: "Cash / invested",
          value: `${pctText(cashBps)} / ${pctText(10_000 - cashBps)}`,
          bar: cashBps,
          barKind: "split" as const,
        }
      : { label: "Cash / invested", value: "–", note: "No priced holdings yet" },
    by("Positions"),
    { ...by("Average position age"), note: "Positions do not record when they were bought" },
    by("Largest"),
    by("Smallest"),
    by("Best"),
    by("Worst"),
    { label: "Realized PnL", value: "–", note: "Not recorded per trade yet" },
    withBasis.length > 0
      ? {
          label: "Unrealized PnL",
          value: signed(unrealized),
          tone: unrealized > 0n ? "positive" : unrealized < 0n ? "negative" : "neutral",
        }
      : { label: "Unrealized PnL", value: "–", note: "No cost basis yet" },
    by("Buys, last 30 days"),
    by("Sells, last 30 days"),
  ];
}

const PENDING = new Set(["awaiting_approval", "approved", "submitted", "confirmed"]);
/** 2026-10-13: a leg's state in words, from its intent's status. */
const LEG_STAGE: Readonly<Record<string, string>> = {
  approved: "Waiting for the next check",
  submitted: "Sending",
  confirmed: "Confirming",
  settled: "Settled",
  reconciled: "Settled",
};

/**
 * How many legs a plan still needs (2026-10-13): for each token outside its range, the gap to
 * its target in legs of at most `maxLegBps`.
 */
export function legsLeft(
  rows: readonly { readonly targetBps: number | null; readonly currentBps: number | null }[],
  maxLegBps: number,
  bandBps: number,
): number {
  let n = 0;
  for (const r of rows) {
    if (r.targetBps === null || r.currentBps === null) continue;
    const gap = Math.abs(r.targetBps - r.currentBps);
    if (gap > bandBps) n += Math.ceil(gap / Math.max(1, maxLegBps));
  }
  return n;
}
const SETTLED = new Set(["settled", "reconciled"]);

/** Where a leg stands in the owner's words: pending until it settles or fails. */
export function liveStatus(status: string): LiveTradeView["status"] {
  return SETTLED.has(status) ? "settled" : PENDING.has(status) ? "pending" : "failed";
}

/** Whether any leg is still on its way, so the panel keeps refreshing. */
export function tradesInFlight(intents: readonly IntentJson[]): boolean {
  return intents.some((i) => PENDING.has(i.status) && i.status !== "awaiting_approval");
}

/**
 * The approved plan's legs as they happen (2026-10-13), newest first: every
 * leg created since the plan was approved, except one still waiting for the
 * owner (those show under "Waiting for you").
 */
/** "From the research run of 2026-10-14 01:28 UTC": the run a plan came from, by its proposal's time. */
export function runLabel(
  p: Pick<ProposalJson, "createdAt" | "cycleId"> | null | undefined,
): string | null {
  if (!p?.cycleId) return null;
  return `From the research run of ${minute(p.createdAt)} UTC`;
}

/** The approved plan a trade came from: the latest approval before the trade. */
export function planOfTrade(
  i: Pick<IntentJson, "createdAt">,
  approved: readonly Pick<ProposalJson, "decidedAt" | "createdAt" | "cycleId">[],
) {
  return (
    [...approved]
      .filter((p) => p.decidedAt !== null && (p.decidedAt as string) <= i.createdAt)
      .sort((a, b) => ((a.decidedAt as string) < (b.decidedAt as string) ? 1 : -1))[0] ?? null
  );
}

export function liveTradeRows(
  intents: readonly IntentJson[],
  since: string | null,
  txFor: (hash: string) => string | null,
  approved: readonly Pick<ProposalJson, "decidedAt" | "createdAt" | "cycleId">[] = [],
): LiveTradeView[] {
  return intents
    .filter((i) => i.status !== "awaiting_approval" && (since === null || i.createdAt >= since))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((i) => {
      const buy = i.sell.asset === "USDC";
      return {
        id: i.intentId,
        side: buy ? "Buy" : "Sell",
        token: buy ? i.buy : i.sell.asset,
        amount: `${i.sell.amount} ${i.sell.asset}`,
        status: liveStatus(i.status),
        time: minute(i.settledAt ?? i.submittedAt ?? i.createdAt),
        txHref: i.txHash ? txFor(i.txHash) : null,
        source:
          runLabel(planOfTrade(i, approved))?.replace(
            "From the research run",
            "Plan from the run",
          ) ?? null,
        stage: LEG_STAGE[i.status] ?? (liveStatus(i.status) === "failed" ? "Failed" : null),
        reason:
          liveStatus(i.status) === "failed"
            ? (i.failure ?? i.blockers?.[0]?.message ?? (i.reason || null))
            : null,
      };
    });
}

/**
 * The runner's hold as one plain line ("Holding: ..."), or null while it
 * trades. A cost hold names the limit: the plan's, or the testnet profile's.
 */
export function holdingLine(
  runner: WhyNotTradedJson["runner"] | null | undefined,
  costLimitBps: number | null,
): string | null {
  if (!runner || runner.outcome !== "hold") return null;
  if (runner.code === "COST_HURDLE" && costLimitBps !== null)
    return `Holding: the next trade would cost more than the ${(costLimitBps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}% limit.`;
  const m = runner.message.trim();
  return m ? `Holding: ${m.charAt(0).toLowerCase()}${m.slice(1)}` : "Holding.";
}

/** "4 min ago", "2 h ago", "3 days ago": how long since an instant. */
export function ago(iso: string, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  if (s < 3_600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3_600)} h ago`;
  const d = Math.floor(s / 86_400);
  return `${d} ${d === 1 ? "day" : "days"} ago`;
}

/**
 * 2026-10-13: every trade the agent made, newest first, for the Trade history section: side,
 * token, amount with the price it filled at, time and transaction; and the one-line summary.
 */
export function tradeHistory(
  intents: readonly IntentJson[],
  txFor: (hash: string) => string | null,
  nowMs: number,
): { rows: LiveTradeView[]; line: string } {
  const done = intents
    .filter((i) => SETTLED.has(i.status) || liveStatus(i.status) === "failed")
    .filter((i) => i.status !== "awaiting_approval")
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const rows = done.map((i): LiveTradeView => {
    const buy = i.sell.asset === "USDC";
    const token = buy ? i.buy : i.sell.asset;
    const inAmt = Number(i.sell.amount);
    const outAmt = i.amountOut ? Number(i.amountOut.amount) : null;
    const price = outAmt && inAmt > 0 ? (buy ? inAmt / outAmt : outAmt / inAmt) : null;
    return {
      id: i.intentId,
      side: buy ? "Buy" : "Sell",
      token,
      amount: `${i.sell.amount} ${i.sell.asset}${
        price === null
          ? ""
          : ` at ${price.toLocaleString("en-US", { maximumFractionDigits: 4 })} USDC`
      }`,
      status: liveStatus(i.status),
      time: minute(i.settledAt ?? i.createdAt),
      txHref: i.txHash ? txFor(i.txHash) : null,
      stage: SETTLED.has(i.status) ? "Settled" : "Failed",
      reason: SETTLED.has(i.status) ? null : (i.failure ?? i.blockers?.[0]?.message ?? null),
    };
  });
  const settled = done.filter((i) => SETTLED.has(i.status));
  const last = settled[0]?.settledAt ?? settled[0]?.createdAt ?? null;
  const line =
    settled.length === 0
      ? "No trades yet"
      : `${settled.length} ${settled.length === 1 ? "trade" : "trades"}${last ? ` · last ${ago(last, nowMs)}` : ""}`;
  return { rows, line };
}

/**
 * 2026-10-13: the Overview's one-line banner while a plan is being traded: trades settled since
 * its approval against the legs still needed; null when nothing is left or no plan is approved.
 */
export function planBanner(o: {
  readonly approvedAt: string | null;
  readonly intents: readonly IntentJson[];
  readonly rows: readonly {
    readonly targetBps: number | null;
    readonly currentBps: number | null;
  }[];
  readonly maxLegBps: number;
  readonly bandBps: number;
}): string | null {
  if (!o.approvedAt) return null;
  const since = o.intents.filter((i) => i.createdAt >= (o.approvedAt as string));
  const done = since.filter((i) => SETTLED.has(i.status)).length;
  const moving = since.some((i) => PENDING.has(i.status) && i.status !== "awaiting_approval");
  const left = legsLeft(o.rows, o.maxLegBps, o.bandBps);
  if (left === 0 && !moving) return null;
  const total = done + Math.max(left, moving ? 1 : 0);
  return `Trading toward the new plan: ${done} of ${total} ${total === 1 ? "trade" : "trades"} done`;
}
