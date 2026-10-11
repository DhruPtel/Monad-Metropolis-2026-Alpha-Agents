import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UniversePanel, type UniverseRowView } from "./universe";

/**
 * The "Universe considered" panel (F-U12): every token the cycle saw with
 * its lane, whether this account could buy it and why not, its theme and
 * why it was or was not dived, and why it was proposed or dropped.
 */
const row = (over: Partial<UniverseRowView> = {}): UniverseRowView => ({
  token: "0x00000000000000000000000000000000000000a1",
  symbol: "WMON",
  priceClass: "F",
  lane: "core",
  status: "listed",
  buyable: true,
  whyNot: null,
  held: true,
  themeCode: "TVL_OUTFLOW",
  themeReason: "chosen for a Dive (high materiality)",
  researched: true,
  proposed: true,
  droppedReason: null,
  ...over,
});

describe("the universe panel", () => {
  it("lists every token with its lane, its buyability and why not, its theme and its outcome", () => {
    render(
      <UniversePanel
        universe={{
          cycleId: "cycle-1",
          kind: "ROUTINE",
          at: "2026-10-11T12:00:00.000Z",
          rows: [
            row(),
            row({
              token: "0x00000000000000000000000000000000000000a2",
              symbol: "GHO",
              priceClass: "A",
              lane: "screened",
              held: false,
              themeCode: "GHO_PEG",
              themeReason: "low materiality: not worth a Dive today",
              researched: false,
              proposed: false,
            }),
            row({
              token: "0x00000000000000000000000000000000000000a3",
              symbol: "CHAOS",
              priceClass: "A",
              lane: "screened",
              buyable: false,
              whyNot: "in the screened lane; the owner has not opted in on chain",
              held: false,
              themeCode: null,
              themeReason: null,
              researched: false,
              proposed: false,
            }),
            row({
              token: "0x00000000000000000000000000000000000000a4",
              symbol: "WBTC",
              status: "sell_only",
              buyable: false,
              whyNot: "sell-only in the registry",
              themeCode: "BTC_FLOW",
              proposed: false,
              droppedReason: "the thesis weakened under challenge",
            }),
          ],
        }}
      />,
    );
    const panel = screen.getByTestId("universe-panel");
    expect(panel).toHaveAttribute("data-rows", "4");
    expect(within(panel).getByText("4 seen")).toBeInTheDocument();
    expect(within(panel).getByText("2 buyable")).toBeInTheDocument();
    expect(within(panel).getByText("2 researched")).toBeInTheDocument();
    expect(within(panel).getByText(/routine cycle of 2026-10-11 12:00 UTC/)).toBeInTheDocument();
    const rows = within(panel).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent("WMON");
    expect(rows[0]).toHaveTextContent("held");
    expect(rows[0]).toHaveTextContent("core");
    expect(rows[0]).toHaveTextContent("TVL_OUTFLOW");
    expect(rows[0]).toHaveTextContent("proposed");
    expect(rows[1]).toHaveTextContent("screened");
    expect(rows[1]).toHaveTextContent("low materiality: not worth a Dive today");
    expect(rows[1]).toHaveTextContent("seen");
    expect(rows[2]).toHaveAttribute("data-buyable", "false");
    expect(rows[2]).toHaveTextContent(
      "no: in the screened lane; the owner has not opted in on chain",
    );
    expect(rows[2]).toHaveTextContent("no theme");
    expect(rows[3]).toHaveTextContent("sell only");
    expect(rows[3]).toHaveTextContent("not proposed");
    expect(rows[3]).toHaveTextContent("the thesis weakened under challenge");
  });

  it("says what the first cycle will record before one ran, and when nothing was seen", () => {
    const { unmount } = render(<UniversePanel universe={null} />);
    expect(screen.getByTestId("universe-panel")).toHaveAttribute("data-rows", "0");
    expect(screen.getByText(/The first cycle records every token/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    unmount();
    render(
      <UniversePanel
        universe={{ cycleId: "cycle-2", kind: "REVIEW", at: "2026-10-11T12:00:00.000Z", rows: [] }}
      />,
    );
    expect(screen.getByText("No token was seen.")).toBeInTheDocument();
  });
});
