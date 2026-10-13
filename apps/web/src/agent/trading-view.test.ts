import { describe, expect, it } from "vitest";
import type { ActivityJson, IntentJson, PlanCardJson, ProposalJson } from "@/api/client";
import {
  decisionRows,
  insightRows,
  insights,
  planMoves,
  planRows,
  skipWords,
  tradeRows,
} from "./trading-view";

const position = (over: Partial<ProposalJson["positions"][number]>) =>
  ({
    token: "0xfb8bf4c1cc7a94c73d209a149ea2abea852bc541",
    symbol: "WMON",
    targetWeightBps: 2000,
    bandBps: 500,
    currentWeightBps: 0,
    action: "ADD",
    thesisCode: null,
    thesis: "Deep pools and a clean price.",
    killCriterion: "",
    recheckAt: "",
    trimAboveBps: null,
    confidence: "medium",
    sources: { onchain: 1, market: 1, primary: 0, news: 0, social: 0 },
    verdict: null,
    reason: "fallback reason",
    ...over,
  }) as ProposalJson["positions"][number];

describe("the Trading tab's words (UI-FAST)", () => {
  it("turns each plan position into one move: Buy to add, Sell to trim or exit, Hold to keep", () => {
    const moves = planMoves({
      positions: [
        position({}),
        position({
          symbol: "TALPHA",
          action: "TRIM",
          targetWeightBps: 500,
          currentWeightBps: 1200,
        }),
        position({ symbol: "TBETA", action: "EXIT", currentWeightBps: 300, thesis: null }),
        position({ symbol: "USDC", action: "HOLD", targetWeightBps: 8000, currentWeightBps: null }),
      ],
      rationale: { portfolioView: "A view.", allocationNote: null },
    } as unknown as ProposalJson);
    expect(moves.map((m) => [m.side, m.symbol, m.amount, m.reason])).toEqual([
      ["Buy", "WMON", "Target 20% (now 0%)", "Deep pools and a clean price."],
      ["Sell", "TALPHA", "Target 5% (now 12%)", "Deep pools and a clean price."],
      ["Sell", "TBETA", "Sell all (now 3%)", "fallback reason"],
      ["Hold", "USDC", "Target 80%", "Deep pools and a clean price."],
    ]);
  });

  it("writes a past trade as token, side, date, amount and result", () => {
    const [row] = tradeRows([
      {
        intentId: "i1",
        status: "settled",
        sell: { asset: "USDC", amountRaw: "20000" },
        buy: "WMON",
        amountOut: { asset: "WMON", amountRaw: "19980010470007175" },
        expectedOut: null,
        createdAt: "2026-10-13T01:28:42.000Z",
        settledAt: "2026-10-13T01:28:55.000Z",
      } as unknown as IntentJson,
    ]);
    expect(row).toMatchObject({
      symbol: "WMON",
      side: "Buy",
      date: "2026-10-13 01:28",
      amount: "0.02 USDC → 0.01998 WMON",
      result: "Settled",
      resultTone: "positive",
    });
  });

  it("moves a band plan with no position rows by its own targets (agent #4's waiting plan)", () => {
    const band = {
      positions: [],
      plan: {
        targetWmonBps: 2000,
        minTradeUsdcE6: "500000",
        volatilityBrakeBps: 20000,
        costHurdleBps: 40,
        maxLegBps: 1000,
      },
      rationale: {
        portfolioView: "Use the two-asset band plan: WMON at the 20% target, rest in USDC.",
        allocationNote: null,
      },
    } as unknown as ProposalJson;
    expect(planMoves(band, null).map((m) => [m.side, m.symbol, m.amount])).toEqual([
      ["Buy", "WMON", "Target 20%"],
      ["Hold", "USDC", "Keep 80%"],
    ]);
    expect(planMoves(band, null)[0]?.reason).toMatch(/two-asset band plan/);
  });

  it("feeds plans, trades and blocked trades newest first, a plan with its report", () => {
    const pending = {
      proposalId: "prop-1",
      kind: "proposal",
      status: "pending_owner",
      cycleId: "cycle-1",
      createdAt: "2026-10-13T17:48:40.000Z",
      positions: [],
      plan: { targetWmonBps: 2000 },
      explanation: null,
      rationale: {
        portfolioView: "WMON at 20%.",
        whatWouldChangeIt: "A failed screen.",
        evidenceStrength: "mixed",
        allocationNote: null,
      },
    } as unknown as ProposalJson;
    const card = { pending, noChange: null, recent: [], current: null } as unknown as PlanCardJson;
    const trade = {
      intentId: "i1",
      status: "settled",
      sell: { asset: "USDC", amountRaw: "20000" },
      buy: "WMON",
      reason: "Rebalance toward the target.",
      blockers: [],
      failure: null,
      txHash: null,
      createdAt: "2026-10-13T01:28:42.000Z",
      settledAt: "2026-10-13T01:28:55.000Z",
    } as unknown as IntentJson;
    const blocked = {
      entryId: "a1",
      kind: "blocked",
      text: "Did not trade: over the cap.",
      renderedBy: "template",
      at: "2026-10-13T01:29:00.000Z",
    } as ActivityJson;
    const runner = {
      outcome: "hold",
      code: "BELOW_MIN_TRADE",
      message:
        "The account is outside its band, but the trade back would be smaller than the plan's minimum trade.",
      since: "2026-10-13T19:51:34.183Z",
      lastAt: "2026-10-13T19:55:39.864Z",
      intentId: null,
    };
    const feed = decisionRows({
      card,
      intents: [{ ...trade, txHash: "0xabc" } as IntentJson],
      activity: [blocked],
      runner,
      reportFor: (c) => `/r/${c}`,
      txFor: (h) => `https://x/tx/${h}`,
    });
    expect(feed.map((d) => [d.kind, d.token, d.link?.href ?? null])).toEqual([
      ["Skipped", "WMON", null],
      ["Plan", "WMON", "/r/cycle-1"],
      ["Refused", null, null],
      ["Trade", "WMON", "https://x/tx/0xabc"],
    ]);
  });

  it("says what the account holds, with dashes where the data does not exist", () => {
    const row = (symbol: string, shareBps: number, gainBps: number | null, isCash = false) => ({
      symbol,
      decimals: 18,
      amountRaw: "1000",
      isCash,
      valueUsdcE6: "1",
      shareBps,
      costBasisUsdcE6: null,
      gainUsdcE6: null,
      gainBps,
    });
    const out = insights(
      [row("USDC", 7000, null, true), row("WMON", 2500, 300), row("TALPHA", 500, -150)],
      [],
      Date.parse("2026-10-13T18:00:00Z"),
    );
    expect(Object.fromEntries(out.map((i) => [i.label, i.value]))).toMatchObject({
      Positions: "2",
      "Average position age": "–",
      Largest: "WMON 25%",
      Smallest: "TALPHA 5%",
      Best: "WMON +3%",
      Worst: "TALPHA -1.5%",
    });
  });

  it("says a recorded skip plainly, with the plan's target and minimum", () => {
    const runner = {
      outcome: "hold",
      code: "BELOW_MIN_TRADE",
      message: "The trade back would be smaller than the plan's minimum trade.",
      since: "x",
      lastAt: "x",
      intentId: null,
    };
    expect(
      skipWords(runner, { targetWmonBps: 2000, minTradeUsdcE6: "1000000" } as ProposalJson["plan"]),
    ).toBe("Skipped: the trade back to 20% WMON was below the 1.00 USDC minimum.");
    expect(skipWords({ ...runner, code: "OTHER" }, null)).toBe(
      "Skipped: the trade back would be smaller than the plan's minimum trade.",
    );
  });

  it("lays the plan out as rows with each token's target and its share now", () => {
    const band = {
      positions: [],
      plan: { targetWmonBps: 2000 },
      rationale: { portfolioView: "v", allocationNote: null },
    } as unknown as ProposalJson;
    const holdings = [
      { symbol: "USDC", shareBps: 10_000, isCash: true },
      { symbol: "WMON", shareBps: 0, isCash: false },
    ] as unknown as Parameters<typeof planRows>[2];
    expect(planRows(band, null, holdings)).toEqual([
      { symbol: "WMON", side: "Buy", targetBps: 2000, currentBps: 0 },
      { symbol: "USDC", side: "Hold", targetBps: 8000, currentBps: 10_000 },
    ]);
  });

  it("expands the insights with notes where a figure does not exist yet", () => {
    const rows = insightRows(
      [
        {
          symbol: "USDC",
          decimals: 6,
          amountRaw: "5000000",
          isCash: true,
          valueUsdcE6: "5000000",
          shareBps: 10_000,
          costBasisUsdcE6: null,
          gainUsdcE6: null,
          gainBps: null,
        },
      ],
      "5000000",
      [],
      Date.parse("2026-10-13T18:00:00Z"),
    );
    const by = Object.fromEntries(rows.map((r) => [r.label, r]));
    expect(by["Total value"]?.value).toBe("5.00 USDC");
    expect(by["Cash / invested"]).toMatchObject({ value: "100% / 0%", bar: 10_000 });
    expect(by["Realized PnL"]).toMatchObject({ value: "–", note: "Not recorded per trade yet" });
    expect(by["Unrealized PnL"]).toMatchObject({ value: "–", note: "No cost basis yet" });
  });
});
