import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  AccountValueChart,
  PositionsTable,
  StatTileRow,
  TabbedPanel,
  monthReturnBps,
} from "./vault-layout";
import type { SeriesPoint } from "./window";

const rows = [
  {
    symbol: "USDC",
    decimals: 6,
    amountRaw: "412500000",
    isCash: true,
    valueUsdcE6: "412500000",
    shareBps: 3850,
    costBasisUsdcE6: null,
    gainUsdcE6: null,
    gainBps: null,
  },
  {
    symbol: "WMON",
    decimals: 18,
    amountRaw: "14200000000000000000000",
    isCash: false,
    valueUsdcE6: "352160000",
    shareBps: 3287,
    costBasisUsdcE6: "310000000",
    gainUsdcE6: "42160000",
    gainBps: 1360,
  },
  {
    symbol: "cbBTC",
    decimals: 8,
    amountRaw: "280000",
    isCash: false,
    valueUsdcE6: "306600000",
    shareBps: 2863,
    costBasisUsdcE6: "321000000",
    gainUsdcE6: "-14400000",
    gainBps: -449,
    chain: "Base",
  },
];

const series: SeriesPoint[] = Array.from({ length: 10 }, (_, i) => ({
  at: new Date(Date.UTC(2026, 9, 1) + i * 5 * 86_400_000).toISOString(),
  perUnitE18: String(BigInt(1_000_000 + i * 10_000) * 10n ** 12n),
  valueUsdcE6: String(1_000_000_000 + i * 10_000_000),
  reason: "interval",
}));

describe("the vault-style layout (UX-U1)", () => {
  it("shows the top tiles with their tone and a dash while a figure is unknown", () => {
    render(
      <StatTileRow
        tiles={[
          { label: "Total value", value: "1,071.26 USDC", testId: "t-total" },
          { label: "All-time earned", value: "+71.26 USDC", tone: "positive", testId: "t-earned" },
          { label: "Past month", value: null, note: "Needs two readings", testId: "t-month" },
        ]}
      />,
    );
    expect(screen.getByTestId("t-total")).toHaveTextContent("1,071.26 USDC");
    expect(screen.getByTestId("t-earned").querySelector(".text-positive")).not.toBeNull();
    expect(screen.getByTestId("t-month")).toHaveAttribute("data-state", "waiting");
    expect(screen.getByTestId("t-month")).toHaveTextContent("Needs two readings");
  });

  it("switches the panel's tabs", async () => {
    render(
      <TabbedPanel
        tabs={[
          { id: "about", label: "About", content: <p>the about text</p> },
          { id: "agent", label: "Agent performance", content: <p>the scores</p> },
        ]}
      />,
    );
    expect(screen.getByText("the about text")).toBeVisible();
    await userEvent.click(screen.getByTestId("tab-agent"));
    expect(screen.getByText("the scores")).toBeVisible();
  });

  it("lists the positions densely with entry and current prices and a coloured PnL", () => {
    render(<PositionsTable rows={rows} chain="Monad" />);
    const list = screen.getAllByTestId("position-row");
    expect(list).toHaveLength(3);
    const wmon = list[1] as HTMLElement;
    expect(wmon).toHaveTextContent("14,200");
    expect(wmon).toHaveTextContent("352.16 USDC");
    // 310 USDC over 14,200 WMON is 0.0218 each; 352.16 over the same is 0.0248.
    expect(wmon).toHaveTextContent("0.02183");
    expect(wmon).toHaveTextContent("0.0248");
    expect(wmon).toHaveTextContent("+42.16 (+13.60%)");
    expect(wmon.querySelector('[data-tone="positive"]')).not.toBeNull();
    const btc = list[2] as HTMLElement;
    expect(btc).toHaveTextContent("-14.40 (-4.49%)");
    expect(btc.querySelector('[data-tone="negative"]')).not.toBeNull();
    expect(btc).toHaveTextContent("Base");
    expect(list[0]).toHaveTextContent("Monad");
  });

  it("draws the chart in both modes and over the picked range", async () => {
    render(<AccountValueChart series={series} principalUsdcE6="1000000000" defaultRange="all" />);
    const chart = screen.getByTestId("account-chart");
    expect(chart).toHaveAttribute("data-mode", "value");
    expect(screen.getByRole("img")).toHaveAccessibleName(/Account value: 1,000.00 USDC/);
    await userEvent.click(screen.getByTestId("chart-mode-pnl"));
    expect(chart).toHaveAttribute("data-mode", "pnl");
    expect(screen.getByRole("img")).toHaveAccessibleName(/PnL: 0.00 USDC on .* 90.00 USDC/);
    await userEvent.click(screen.getByTestId("chart-range-7d"));
    expect(chart).toHaveAttribute("data-range", "7d");
    // Two points lie within seven days of the last reading.
    expect(screen.getByRole("img")).toHaveAccessibleName(/over 2 readings/);
  });

  it("reads the month's return from the series", () => {
    // The last 30 days hold the readings from day 15 (1.03) to day 45 (1.09): 5.83%.
    expect(monthReturnBps(series)).toBe(583);
    expect(monthReturnBps([])).toBeNull();
    expect(monthReturnBps(series.slice(-1))).toBeNull();
  });
});
