import type { ActivityRowView } from "@alpha-agents/ui";
import type { IntentJson, MoneyEventJson, ProposalJson, ResearchJson } from "@/api/client";
import { stoppedShortText } from "./research-short";

/**
 * 2026-10-13: the shared Activity panel's rows, newest first, from real
 * records only: deposits, withdrawals and credit top-ups from the chain's logs
 * and the indexer; and, for the owner, the agent's trades, its research runs
 * with their cost, the plans approved and the runs that kept the plan.
 */

const minute = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
const usdc = (e6: string) =>
  `${(Number(e6) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`;
const KIND_WORD: Readonly<Record<string, string>> = {
  ACTIVATION: "Activation research",
  ROUTINE: "Routine research",
  TRIGGERED: "Triggered research",
  REVIEW: "Plan review",
};
const SETTLED = new Set(["settled", "reconciled"]);
const FAILED = new Set(["failed", "rejected", "expired"]);

export interface ActivitySources {
  readonly money: readonly MoneyEventJson[];
  /** Null where the viewer is not the owner. */
  readonly intents: readonly IntentJson[] | null;
  readonly cycles: ResearchJson["cycles"] | null;
  readonly proposals: readonly ProposalJson[] | null;
  readonly txFor: (hash: string) => string | null;
  readonly reportFor: (cycleId: string) => string;
}

type Row = ActivityRowView & { readonly at: string };

export function activityRows(s: ActivitySources): ActivityRowView[] {
  const rows: Row[] = [];
  const tx = (hash: string | null) => {
    const href = hash ? s.txFor(hash) : null;
    return href ? { href, label: "Transaction", external: true } : null;
  };
  for (const m of s.money) {
    const where = m.account === "vault" ? "the vault" : "the trading account";
    rows.push({
      id: `m-${m.txHash}-${m.kind}-${m.account}`,
      type:
        m.kind === "credit_top_up" ? "Credits" : m.kind === "deposit" ? "Deposit" : "Withdrawal",
      filter: "deposits",
      title:
        m.kind === "credit_top_up"
          ? "Research credits added"
          : m.kind === "deposit"
            ? m.leaderStake
              ? "Leader stake into the vault"
              : `Deposit into ${where}`
            : m.inKind
              ? "Redeemed from the vault in kind"
              : `Withdrawal from ${where}`,
      amount: `${m.amount} ${m.symbol}`,
      time: minute(m.at),
      at: m.at,
      link: tx(m.txHash),
    });
  }
  for (const i of s.intents ?? []) {
    if (i.status === "awaiting_approval") continue;
    const buy = /USDC$/i.test(i.sell.asset);
    const state = SETTLED.has(i.status) ? "" : FAILED.has(i.status) ? " (failed)" : " (pending)";
    const at = i.settledAt ?? i.submittedAt ?? i.createdAt;
    rows.push({
      id: `t-${i.intentId}`,
      type: "Trade",
      filter: "trades",
      title: `${buy ? "Buy" : "Sell"} ${buy ? i.buy : i.sell.asset}${state}`,
      amount: `${i.sell.amount} ${i.sell.asset}`,
      time: minute(at),
      at,
      link: tx(i.txHash),
    });
  }
  for (const c of s.cycles ?? []) {
    const at = c.finishedAt ?? c.startedAt;
    if (!at) continue;
    rows.push({
      id: `r-${c.cycleId}`,
      type: "Research",
      filter: "research",
      // 2026-10-16: a run stopped for credits or budget says where and why.
      title: `${KIND_WORD[c.kind] ?? "Research"}${c.status === "completed" ? "" : ` (${stoppedShortText(c) ?? c.status})`}`,
      amount: usdc(c.chargedUsdcE6),
      time: minute(at),
      at,
      link: { href: s.reportFor(c.cycleId), label: "Report", external: false },
    });
  }
  for (const p of s.proposals ?? []) {
    // 2026-10-15: a run that kept the plan, said as such.
    if (p.kind === "no_change") {
      rows.push({
        id: `p-${p.proposalId}`,
        type: "Plan",
        filter: "research",
        title: "Plan unchanged",
        amount: null,
        time: minute(p.createdAt),
        at: p.createdAt,
        link: p.cycleId ? { href: s.reportFor(p.cycleId), label: "Report", external: false } : null,
      });
      continue;
    }
    if (p.status !== "applied" || !p.decidedAt) continue;
    rows.push({
      id: `p-${p.proposalId}`,
      type: "Plan",
      filter: "research",
      title: "Plan approved",
      amount: null,
      time: minute(p.decidedAt),
      at: p.decidedAt,
      link: p.cycleId ? { href: s.reportFor(p.cycleId), label: "Report", external: false } : null,
    });
  }
  return rows
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .map(({ at, ...r }) => {
      void at;
      return r;
    });
}
