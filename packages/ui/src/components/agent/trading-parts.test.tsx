import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LiveTrades } from "./trading-parts";

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
