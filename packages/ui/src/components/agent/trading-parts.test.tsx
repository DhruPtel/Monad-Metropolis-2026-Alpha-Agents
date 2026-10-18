import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LiveTrades, PlanSummaryCard } from "./trading-parts";

describe("LiveTrades (2026-10-13)", () => {
  it("lists each leg with its side, token, amount, status, time and transaction, and a hold as one line", () => {
    render(
      <LiveTrades
        holding="Holding: the next trade would cost more than the 0.5% limit."
        empty="none"
        items={[
          {
            id: "b",
            side: "Buy",
            token: "WMON",
            amount: "0.80 USDC",
            status: "pending",
            time: "2026-10-13 22:25",
            txHref: null,
          },
          {
            id: "a",
            side: "Buy",
            token: "WMON",
            amount: "0.80 USDC",
            status: "settled",
            time: "2026-10-13 22:24",
            txHref: "https://testnet.monadvision.com/tx/0x11",
          },
        ]}
      />,
    );
    expect(screen.getByTestId("live-trades-holding")).toHaveTextContent(
      "Holding: the next trade would cost more than the 0.5% limit.",
    );
    const [pending, settled] = screen.getAllByTestId("live-trade");
    expect(pending).toHaveAttribute("data-status", "pending");
    expect(pending).toHaveTextContent(
      /Buy.*WMON.*0\.80 USDC.*pending.*2026-10-13 22:25.*Not sent yet/,
    );
    expect(settled).toHaveAttribute("data-status", "settled");
    expect(
      within(settled as HTMLElement).getByRole("link", { name: /Transaction/ }),
    ).toHaveAttribute("href", "https://testnet.monadvision.com/tx/0x11");
  });

  it("says so when nothing has traded and the runner is not holding", () => {
    render(<LiveTrades holding={null} empty="No trades yet." items={[]} />);
    expect(screen.getByTestId("live-trades")).toHaveTextContent("No trades yet.");
    expect(screen.queryByTestId("live-trades-holding")).toBeNull();
  });
});

describe("LiveTrades toward a plan (2026-10-13)", () => {
  it("shows each token's share against its target and each leg's state and reason", () => {
    render(
      <LiveTrades
        holding={null}
        empty="none"
        progress={[{ symbol: "WMON", currentBps: 1_000, targetBps: 2_000 }]}
        items={[
          {
            id: "f",
            side: "Buy",
            token: "WMON",
            amount: "0.80 USDC",
            status: "failed",
            stage: "Failed",
            reason: "The pool moved.",
            time: "2026-10-14 02:12",
            txHref: null,
          },
        ]}
      />,
    );
    expect(screen.getByRole("progressbar", { name: "WMON toward its target" })).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
    expect(screen.getByTestId("live-trades-progress")).toHaveTextContent("WMON10.0% of 20.0%");
    expect(screen.getByTestId("live-trade-reason")).toHaveTextContent("The pool moved.");
  });
});

describe("PlanSummaryCard status (2026-10-18)", () => {
  const card = (status?: Parameters<typeof PlanSummaryCard>[0]["status"]) =>
    render(
      <PlanSummaryCard
        heading="In force since 2026-10-18"
        goal="Aggressive"
        rows={[{ symbol: "WMON", side: "Buy", targetBps: 4000, currentBps: 0 }]}
        rationale="Buy WMON."
        status={status ?? null}
        actions={<button type="button">Start trading</button>}
      />,
    );

  it("says what holds the plan back in plain words, as a live status beside its button", () => {
    card({
      tone: "warning",
      title: "Not trading: a dry run of the trade failed before it was sent.",
      detail: "The venue could not quote this trade; check again later or trade less.",
    });
    const status = screen.getByTestId("plan-status");
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("data-tone", "warning");
    expect(status).toHaveTextContent("Not trading: a dry run of the trade failed");
    expect(screen.getByTestId("plan-status-detail")).toHaveTextContent("check again later");
    expect(screen.getByRole("button", { name: "Start trading" })).toBeInTheDocument();
  });

  it("shows no status when nothing holds the plan back", () => {
    card();
    expect(screen.queryByTestId("plan-status")).toBeNull();
  });
});
