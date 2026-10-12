import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  AllocationDonut,
  type AssetRow,
  AssetMakeupTable,
  HundredDollarTile,
  PerformanceChart,
  ScoreTiles,
  type SeriesPoint,
  type TradeMarkView,
  allocationSlices,
} from "./window";

/**
 * The portfolio window's pieces (F-U11): the asset makeup with cost basis
 * and gain, the allocation donut folding a seventh token into Other with
 * colours that follow the token, the performance chart with its trade
 * markers, crosshair tooltip and table twin, and the scores with their
 * "not enough data yet" states.
 */
const E18 = 10n ** 18n;
const row = (over: Partial<AssetRow> & { symbol: string }): AssetRow => ({
  decimals: 18,
  amountRaw: E18.toString(),
  isCash: false,
  valueUsdcE6: "10000000",
  shareBps: 1_000,
  costBasisUsdcE6: "9000000",
  gainUsdcE6: "1000000",
  gainBps: 1_111,
  ...over,
});
const ROWS: AssetRow[] = [
  row({
    symbol: "USDC",
    decimals: 6,
    amountRaw: "60000000",
    isCash: true,
    valueUsdcE6: "60000000",
    shareBps: 6_000,
    costBasisUsdcE6: "60000000",
    gainUsdcE6: null,
    gainBps: null,
  }),
  row({
    symbol: "WBTC",
    decimals: 8,
    amountRaw: "30000",
    valueUsdcE6: "30000000",
    shareBps: 3_000,
    costBasisUsdcE6: "28000000",
    gainUsdcE6: "2000000",
    gainBps: 714,
  }),
  row({
    symbol: "WMON",
    valueUsdcE6: "10000000",
    shareBps: 1_000,
    costBasisUsdcE6: "12000000",
    gainUsdcE6: "-2000000",
    gainBps: -1_666,
  }),
  row({
    symbol: "CHOG",
    valueUsdcE6: null,
    shareBps: null,
    costBasisUsdcE6: "5000000",
    gainUsdcE6: null,
    gainBps: null,
  }),
];
const T0 = Date.parse("2026-10-09T00:00:00.000Z");
const at = (hours: number) => new Date(T0 + hours * 3_600_000).toISOString();
const SERIES: SeriesPoint[] = Array.from({ length: 25 }, (_, i) => ({
  at: at(i),
  perUnitE18: (E18 + BigInt(i) * 2n * 10n ** 15n).toString(),
  valueUsdcE6: String(100_000_000 + i * 200_000),
  reason: i === 6 ? "trade" : "interval",
}));
const MARKS: TradeMarkView[] = [
  {
    at: at(6),
    intentId: "i-1",
    side: "buy",
    symbol: "WBTC",
    amountRaw: "30000",
    decimals: 8,
    usdcE6: "28000000",
    txHash: "0xab",
  },
  {
    at: at(18),
    intentId: "i-2",
    side: "sell",
    symbol: "WMON",
    amountRaw: (100n * E18).toString(),
    decimals: 18,
    usdcE6: "2500000",
    txHash: null,
  },
];

describe("the asset makeup (F-U11)", () => {
  it("lists every held token with its amount, value, share, cost basis and gain, and keeps an unpriced token", () => {
    render(
      <AssetMakeupTable
        rows={ROWS}
        totalValueUsdcE6="100000000"
        asOf={{ at: at(24), live: false }}
      />,
    );
    const rows = screen.getAllByTestId("asset-row");
    expect(rows.map((r) => r.dataset.symbol)).toEqual(["USDC", "WBTC", "WMON", "CHOG"]);
    const cash = within(rows[0] as HTMLElement);
    expect(cash.getByText("cash", { selector: "span[data-slot=tag]" })).toBeInTheDocument();
    expect(cash.getByText("60.00%")).toBeInTheDocument();
    const btc = within(rows[1] as HTMLElement);
    expect(btc.getByText("+2.00")).toHaveClass("text-positive");
    expect(btc.getByText("+7.14%")).toBeInTheDocument();
    const mon = within(rows[2] as HTMLElement);
    expect(mon.getByText("-2.00")).toHaveClass("text-negative");
    expect(mon.getByText("-16.66%")).toBeInTheDocument();
    const chog = within(rows[3] as HTMLElement);
    expect(chog.getByText("no usable price")).toBeInTheDocument();
    expect(chog.getAllByText("unknown")).toHaveLength(2);
    expect(screen.getByText(/Total value/)).toHaveTextContent("100.00 USDC");
    expect(
      screen.getByText(/As of 2026-10-10 00:00 UTC \(the latest snapshot\)/),
    ).toBeInTheDocument();
  });

  it("says when nothing is held, and when the total is unknown", () => {
    const { rerender } = render(<AssetMakeupTable rows={[]} totalValueUsdcE6={null} asOf={null} />);
    expect(screen.getByTestId("asset-makeup-empty")).toHaveTextContent("Nothing is held yet");
    rerender(
      <AssetMakeupTable rows={ROWS} totalValueUsdcE6={null} asOf={{ at: at(24), live: true }} />,
    );
    expect(screen.getByText(/Total value unknown/)).toHaveTextContent(
      "As of 2026-10-10 00:00 UTC.",
    );
  });
});

describe("the allocation donut (F-U11)", () => {
  it("names each priced slice with its share, lists the unpriced tokens, and draws one arc per slice", () => {
    render(<AllocationDonut rows={ROWS} />);
    expect(
      screen.getByRole("img", {
        name: "Allocation by value: USDC 60.00%, WBTC 30.00%, WMON 10.00%",
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId("allocation-slice")).toHaveLength(3);
    expect(screen.getByTestId("allocation-unpriced")).toHaveTextContent("CHOG");
  });

  it("folds a seventh token into Other, and a token keeps its colour whatever its rank", () => {
    const many = ["A", "B", "C", "D", "E", "F", "G"].map((symbol, i) =>
      row({ symbol, shareBps: 1_000 - i * 50, valueUsdcE6: String(10_000_000 - i * 500_000) }),
    );
    const withCash = [row({ symbol: "USDC", isCash: true, shareBps: 3_500 }), ...many];
    const slices = allocationSlices(withCash);
    expect(slices.map((s) => s.label)).toEqual(["USDC", "A", "B", "C", "D", "E", "Other (2)"]);
    expect(slices[slices.length - 1]?.shareBps).toBe(750 + 700);
    expect(slices[0]?.stroke).toBe("stroke-rare");
    const colourOf = (rows: AssetRow[], symbol: string) =>
      allocationSlices(rows).find((s) => s.label === symbol)?.stroke;
    // B outranks A now; both keep their colours.
    const reranked = [
      withCash[0] as AssetRow,
      { ...(many[1] as AssetRow), shareBps: 2_000 },
      ...many.filter((r) => r.symbol !== "B"),
    ];
    expect(colourOf(reranked, "A")).toBe(colourOf(withCash, "A"));
    expect(colourOf(reranked, "B")).toBe(colourOf(withCash, "B"));
    render(<AllocationDonut rows={withCash} />);
    expect(screen.getAllByTestId("allocation-slice")).toHaveLength(7);
    expect(screen.getByText("Other (2)")).toBeInTheDocument();
  });

  it("says when nothing priced is held", () => {
    render(<AllocationDonut rows={[row({ symbol: "CHOG", shareBps: null, valueUsdcE6: null })]} />);
    expect(
      screen.getByRole("img", { name: "Allocation: nothing priced is held" }),
    ).toBeInTheDocument();
    expect(screen.queryAllByTestId("allocation-slice")).toHaveLength(0);
  });
});

describe("the performance chart (F-U11)", () => {
  it("waits for two readings", () => {
    render(<PerformanceChart series={SERIES.slice(0, 1)} marks={[]} />);
    expect(screen.getByTestId("performance-empty")).toHaveTextContent("Not enough data yet");
  });

  it("draws the $100 line with a marker per trade, a tooltip on hover, and the readings as a table", () => {
    render(<PerformanceChart series={SERIES} marks={MARKS} />);
    const svg = screen.getByRole("img", {
      name: /Value of \$100 put in at the start: 100\.00 on 2026-10-09 00:00 UTC, 104\.80 on 2026-10-10 00:00 UTC, with 2 trades marked/,
    });
    const marks = screen.getAllByTestId("trade-mark");
    expect(marks.map((m) => m.dataset.side)).toEqual(["buy", "sell"]);
    expect(
      within(marks[0] as HTMLElement).getByText(/Bought 0.0003 WBTC for 28.00 USDC/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("performance-tooltip")).not.toBeInTheDocument();
    // The chart falls back to a 640px width before it is measured; the far right is the last reading.
    fireEvent.pointerMove(svg, { clientX: 630, clientY: 100 });
    const tip = screen.getByTestId("performance-tooltip");
    expect(tip).toHaveTextContent("2026-10-10 00:00 UTC");
    expect(tip).toHaveTextContent("$100 is worth 104.80");
    expect(tip).toHaveTextContent("Account value 104.80 USDC");
    expect(screen.getByTestId("crosshair")).toBeInTheDocument();
    fireEvent.pointerLeave(svg);
    expect(screen.queryByTestId("performance-tooltip")).not.toBeInTheDocument();
    // The table twin, on request.
    expect(screen.queryByTestId("performance-table")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("performance-table-toggle"));
    const table = screen.getByTestId("performance-table");
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(26);
    expect(rows[1]).toHaveTextContent("100.00");
    expect(rows[7]).toHaveTextContent("Bought 0.0003 WBTC");
    expect(rows[19]).toHaveTextContent("Sold 100 WMON");
    expect(rows[25]).toHaveTextContent("104.80");
  });
});

describe("the scores and the $100 figure (F-U11)", () => {
  it("shows each score with its sign and plain note", () => {
    render(
      <ScoreTiles
        scores={{
          returnSinceStart: { ok: true, bps: 480, since: at(0), asOf: at(24) },
          maxDrawdown: { ok: true, bps: 250, peakAt: at(10), troughAt: at(14) },
          winShare: { ok: true, bps: 5_000, closed: 2, won: 1 },
        }}
      />,
    );
    expect(screen.getByTestId("score-return")).toHaveAttribute("data-state", "ready");
    expect(screen.getByText("+4.80%")).toHaveClass("text-positive");
    expect(screen.getByText("-2.50%")).toHaveClass("text-negative");
    expect(screen.getByTestId("score-drawdown")).toHaveTextContent(
      "From the peak of 2026-10-09 10:00 UTC to 2026-10-09 14:00 UTC.",
    );
    expect(screen.getByText("50%")).toHaveClass("text-positive");
    expect(screen.getByTestId("score-winshare")).toHaveTextContent("1 of 2 closed positions.");
  });

  it("says not enough data yet, and why, for each score and for the $100 figure", () => {
    render(
      <>
        <ScoreTiles
          scores={{
            returnSinceStart: {
              ok: false,
              reason: "Not enough data yet: the account needs at least an hour of history.",
            },
            maxDrawdown: {
              ok: false,
              reason: "Not enough data yet: the account needs at least an hour of history.",
            },
            winShare: { ok: false, reason: "Not enough data yet: no position has been closed." },
          }}
        />
        <HundredDollarTile
          hundred={{
            ok: false,
            reason: "Not enough data yet: the account needs at least two readings.",
          }}
        />
      </>,
    );
    expect(screen.getAllByText("Not enough data yet")).toHaveLength(4);
    expect(screen.getByTestId("score-winshare")).toHaveTextContent("no position has been closed");
    expect(screen.getByTestId("hundred-dollars")).toHaveAttribute("data-state", "waiting");
  });

  it("puts the $100 figure beside holding USDC, coloured by which is ahead", () => {
    const { rerender } = render(
      <HundredDollarTile hundred={{ ok: true, now: "104.80", usdc: "100.00", since: at(0) }} />,
    );
    expect(screen.getByText("$104.80")).toHaveClass("text-positive");
    expect(screen.getByText("$100.00")).toBeInTheDocument();
    expect(screen.getByText(/with this agent since 2026-10-09 00:00 UTC/)).toBeInTheDocument();
    rerender(
      <HundredDollarTile hundred={{ ok: true, now: "97.10", usdc: "100.00", since: at(0) }} />,
    );
    expect(screen.getByText("$97.10")).toHaveClass("text-negative");
  });
});
