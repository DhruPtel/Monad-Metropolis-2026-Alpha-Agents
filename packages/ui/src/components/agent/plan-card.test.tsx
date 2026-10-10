import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NoChangeNotice, PlanCard, type PlanCardView } from "./plan-card";

const view = (over: Partial<PlanCardView> = {}): PlanCardView => ({
  proposalId: "prop-00000000-0000-4000-8000-000000000001",
  status: "pending_owner",
  needsApproval: true,
  cashTargetBps: 6_000,
  currentCashBps: 7_000,
  positions: [
    {
      token: "0x0555e30da8f98308edb960aa94c0db47230d2b9c",
      symbol: "WBTC",
      targetWeightBps: 2_000,
      bandBps: 300,
      currentWeightBps: null,
      action: "ADD",
      thesis: "WBTC tracks bitcoin while its pool stays deep.",
      killCriterion: "The pool halves.",
      recheckAt: "2026-11-01",
      trimAboveBps: 3_000,
      confidence: "medium",
      sources: { onchain: 2, market: 1, primary: 0, news: 0, social: 1 },
      verdict: "WEAKENED",
      reason: "A deep pool.",
    },
  ],
  leaving: [{ symbol: "CHOG", currentWeightBps: 500 }],
  portfolioView: "One position plus cash.",
  evidenceStrength: "mixed",
  whatWouldChangeIt: "The pool thinning out.",
  evaluation: {
    passed: true,
    checkedAt: "2026-10-10T12:00:00.000Z",
    findings: [],
    cost: { legs: 2, turnoverUsdcE6: "40000000", estimatedCostUsdcE6: "80000", costBps: 20 },
  },
  createdAt: "2026-10-10T12:00:00.000Z",
  expiresAt: "2026-10-11T12:00:00.000Z",
  decidedAt: null,
  ...over,
});

describe("the plan card (F-U9)", () => {
  it("renders every position with its weights, thesis, exit plan, sources, verdict and the cost to move", () => {
    render(<PlanCard view={view()} actions={<button type="button">Approve this plan</button>} />);
    const card = screen.getByTestId("plan-card");
    expect(card.dataset.status).toBe("pending_owner");
    expect(card).toHaveTextContent("Waiting for your approval");
    expect(card).toHaveTextContent("mixed evidence");
    expect(screen.getAllByTestId("plan-position")).toHaveLength(2);
    expect(card).toHaveTextContent("WBTC");
    expect(card).toHaveTextContent("new to 20.00% (band 3.00%)");
    expect(card).toHaveTextContent("Recheck by 2026-11-01; trim above 30.00%");
    expect(card).toHaveTextContent("2 onchain");
    expect(card).toHaveTextContent("1 social");
    expect(card).toHaveTextContent("Skeptic: weakened");
    expect(card).toHaveTextContent("CHOG");
    expect(card).toHaveTextContent("5.00% to 0.00%");
    expect(screen.getByTestId("plan-cost")).toHaveTextContent(
      "0.08 USDC over 2 legs (0.20% of 40.00 USDC)",
    );
    expect(screen.getByTestId("plan-evaluation")).toHaveTextContent("Passed every check");
    expect(screen.getByRole("button", { name: "Approve this plan" })).toBeInTheDocument();
  });

  it("shows a rejected proposal's findings and a no-change decision's reason", () => {
    render(
      <>
        <PlanCard
          view={view({
            status: "rejected",
            evaluation: {
              passed: false,
              checkedAt: "2026-10-10T12:00:00.000Z",
              findings: [{ code: "DEPTH", message: "The pool is too thin." }],
              cost: null,
            },
          })}
        />
        <NoChangeNotice
          reasonCode="EVIDENCE_THIN"
          explanation="One source only."
          at="2026-10-10T11:00:00.000Z"
        />
      </>,
    );
    expect(screen.getByTestId("plan-card")).toHaveTextContent("Rejected by the platform's checks");
    expect(screen.getByTestId("plan-evaluation")).toHaveTextContent("DEPTH: The pool is too thin.");
    expect(screen.getByTestId("plan-cost")).toHaveTextContent("not estimated");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByTestId("plan-no-change")).toHaveTextContent("evidence thin");
    expect(screen.getByTestId("plan-no-change")).toHaveTextContent("One source only.");
  });
});
