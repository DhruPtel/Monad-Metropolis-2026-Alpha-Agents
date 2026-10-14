import { describe, expect, it } from "vitest";
import type { IntentJson, MoneyEventJson, ProposalJson, ResearchJson } from "@/api/client";
import { activityRows } from "./activity-feed";

const money = (over: Partial<MoneyEventJson>): MoneyEventJson => ({
  kind: "deposit",
  account: "vault",
  who: null,
  symbol: "USDC",
  amount: "5",
  valueUsdcE6: "5000000",
  inKind: false,
  leaderStake: false,
  txHash: "0x11",
  block: "1",
  at: "2026-10-13T23:59:48.000Z",
  ...over,
});
const tx = (h: string) => `https://testnet.monadvision.com/tx/${h}`;

describe("the Activity panel's rows (2026-10-13)", () => {
  it("merges deposits, top-ups, trades, research runs and approved plans, newest first", () => {
    const rows = activityRows({
      money: [
        money({}),
        money({
          account: "vault",
          leaderStake: true,
          amount: "2",
          at: "2026-10-13T23:55:12.000Z",
          txHash: "0x22",
        }),
        money({
          kind: "credit_top_up",
          account: "credits",
          at: "2026-10-13T17:41:00.000Z",
          txHash: "0x33",
        }),
        money({
          kind: "withdrawal",
          account: "trading",
          amount: "1",
          at: "2026-10-13T21:00:00.000Z",
          txHash: "0x44",
        }),
      ],
      intents: [
        {
          intentId: "i1",
          status: "reconciled",
          sell: { asset: "USDC", amount: "0.796", amountRaw: "796000" },
          buy: "WMON",
          txHash: "0x55",
          createdAt: "2026-10-13T22:24:19.000Z",
          submittedAt: null,
          settledAt: "2026-10-13T22:24:39.000Z",
        } as unknown as IntentJson,
        {
          intentId: "i2",
          status: "awaiting_approval",
          sell: { asset: "USDC", amount: "1" },
          buy: "WMON",
          createdAt: "2026-10-13T23:00:00.000Z",
        } as unknown as IntentJson,
      ],
      cycles: [
        {
          cycleId: "cycle-1",
          kind: "ACTIVATION",
          status: "completed",
          startedAt: "2026-10-13T22:06:00.000Z",
          finishedAt: "2026-10-13T22:10:07.000Z",
          chargedUsdcE6: "791580",
          stages: [],
        },
      ] as unknown as ResearchJson["cycles"],
      proposals: [
        {
          proposalId: "p1",
          status: "applied",
          decidedAt: "2026-10-13T22:22:47.000Z",
          cycleId: "cycle-1",
        },
        { proposalId: "p2", status: "pending_owner", decidedAt: null, cycleId: null },
      ] as unknown as ProposalJson[],
      txFor: tx,
      reportFor: (c) => `/agents/4/research/reports/${c}`,
    });
    expect(rows.map((r) => [r.type, r.filter, r.title, r.amount, r.time])).toEqual([
      ["Deposit", "deposits", "Deposit into the vault", "5 USDC", "2026-10-13 23:59"],
      ["Deposit", "deposits", "Leader stake into the vault", "2 USDC", "2026-10-13 23:55"],
      ["Trade", "trades", "Buy WMON", "0.796 USDC", "2026-10-13 22:24"],
      ["Plan", "research", "Plan approved", null, "2026-10-13 22:22"],
      ["Research", "research", "Activation research", "0.79 USDC", "2026-10-13 22:10"],
      [
        "Withdrawal",
        "deposits",
        "Withdrawal from the trading account",
        "1 USDC",
        "2026-10-13 21:00",
      ],
      ["Credits", "deposits", "Research credits added", "5 USDC", "2026-10-13 17:41"],
    ]);
    expect(rows[0]?.link).toEqual({ href: tx("0x11"), label: "Transaction", external: true });
    expect(rows[4]?.link).toEqual({
      href: "/agents/4/research/reports/cycle-1",
      label: "Report",
      external: false,
    });
  });

  it("shows only the public rows when the viewer is not the owner", () => {
    const rows = activityRows({
      money: [money({})],
      intents: null,
      cycles: null,
      proposals: null,
      txFor: tx,
      reportFor: (c) => c,
    });
    expect(rows.map((r) => r.type)).toEqual(["Deposit"]);
  });
});
