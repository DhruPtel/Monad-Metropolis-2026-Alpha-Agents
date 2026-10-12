import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  ComingLater,
  CreditsTile,
  MakeupSwitch,
  PageLoading,
  PortfolioHero,
  PositionTiles,
  SetupFlow,
  TradingTile,
} from "./owner-pages";
import type { AssetRow, SeriesPoint } from "./window";

const ROWS: AssetRow[] = [
  {
    symbol: "USDC",
    decimals: 6,
    amountRaw: "30000000",
    isCash: true,
    valueUsdcE6: "30000000",
    shareBps: 4_285,
    costBasisUsdcE6: null,
    gainUsdcE6: null,
    gainBps: null,
  },
  {
    symbol: "WBTC",
    decimals: 8,
    amountRaw: "50000",
    isCash: false,
    valueUsdcE6: "30000000",
    shareBps: 4_285,
    costBasisUsdcE6: "28000000",
    gainUsdcE6: "2000000",
    gainBps: 714,
  },
  {
    symbol: "WMON",
    decimals: 18,
    amountRaw: "400000000000000000000",
    isCash: false,
    valueUsdcE6: "10000000",
    shareBps: 1_428,
    costBasisUsdcE6: "10500000",
    gainUsdcE6: "-500000",
    gainBps: -476,
  },
  {
    symbol: "CHOG",
    decimals: 18,
    amountRaw: "1000000000000000000",
    isCash: false,
    valueUsdcE6: null,
    shareBps: null,
    costBasisUsdcE6: null,
    gainUsdcE6: null,
    gainBps: null,
  },
];
const SERIES: SeriesPoint[] = [
  {
    at: "2026-10-11T10:00:00.000Z",
    perUnitE18: "1000000000000000000",
    valueUsdcE6: "70000000",
    reason: "interval",
  },
  {
    at: "2026-10-11T11:00:00.000Z",
    perUnitE18: "1020000000000000000",
    valueUsdcE6: "71400000",
    reason: "interval",
  },
];

describe("TradingTile (UI-U1)", () => {
  it("shows the value, the allocation, the state and the primary action for an open account", () => {
    render(
      <TradingTile
        agentName="Alpha Agent #7"
        trading={{
          hasAccount: true,
          valueUsdcE6: 70_000_000n,
          mode: "NORMAL",
          makeup: ROWS,
          series: SERIES,
          state: { label: "Automatic trading on", tone: "positive" },
        }}
        primary={<a href="/agents/7/portfolio">Open portfolio</a>}
      />,
    );
    const tile = screen.getByTestId("trading-summary");
    expect(tile.getAttribute("data-state")).toBe("open");
    expect(tile.textContent).toContain("70.00");
    expect(tile.textContent).toContain("Automatic trading on");
    expect(
      within(tile).getByRole("img", {
        name: "Allocation by value: USDC 42.85%, WBTC 42.85%, WMON 14.28%",
      }),
    ).toBeTruthy();
    expect(within(tile).getByRole("link", { name: "Open portfolio" })).toBeTruthy();
    expect(within(tile).queryByTestId("trading-no-series")).toBeNull();
  });

  it("says what the account is and offers to set it up when there is none, or while it is unread", () => {
    const { unmount } = render(
      <TradingTile
        agentName="Alpha Agent #8"
        trading={{ hasAccount: false, valueUsdcE6: null, mode: null }}
        primary={<a href="/agents/8/portfolio">Set up trading</a>}
      />,
    );
    const tile = screen.getByTestId("trading-summary");
    expect(tile.getAttribute("data-state")).toBe("none");
    expect(tile.textContent).toContain("No trading account yet");
    expect(tile.textContent).toContain("only you can withdraw from");
    expect(within(tile).getByRole("link", { name: "Set up trading" })).toBeTruthy();
    unmount();
    render(
      <TradingTile
        agentName="Alpha Agent #9"
        trading={null}
        primary={<a href="/x">Set up trading</a>}
      />,
    );
    expect(screen.getByTestId("trading-summary").getAttribute("data-state")).toBe("reading");
    expect(screen.getByRole("link", { name: "Set up trading" })).toBeTruthy();
  });

  it("says the performance line needs two readings, and that a value is unknown without a price", () => {
    render(
      <TradingTile
        agentName="Alpha Agent #7"
        trading={{
          hasAccount: true,
          valueUsdcE6: null,
          mode: "PAUSED",
          makeup: ROWS,
          series: SERIES.slice(0, 1),
        }}
        primary={<a href="/x">Open portfolio</a>}
      />,
    );
    expect(screen.getByTestId("trading-no-series").textContent).toContain("two readings");
    expect(screen.getByTestId("trading-summary").textContent).toContain("Value unknown");
  });
});

describe("CreditsTile (UI-U1)", () => {
  it("shows the balance against the cap, the held note, the research line and the paused note", () => {
    render(
      <CreditsTile
        agentName="Alpha Agent #7"
        creditsUsdcE6={4_994_400n}
        capUsdcE6={50_000_000n}
        heldUsdcE6={2_000_000n}
        addCredits={<button type="button">Add credits</button>}
        research={<button type="button">Research now</button>}
        researchLine="It costs about 0.15 to 0.30 USDC of credits."
        researchStatus={<p data-testid="scan-status">Last research completed at 16:41 UTC.</p>}
        restrictedNote="Research is paused because Alpha Agent #7 has no credits. Add credits to resume."
      />,
    );
    const tile = screen.getByRole("region", { name: "Credits of Alpha Agent #7" });
    expect(tile.textContent).toContain("4.9944");
    expect(tile.textContent).toContain("of 50.00 during the beta");
    expect(
      within(tile)
        .getByRole("meter", { name: "Credits against the beta cap" })
        .getAttribute("aria-valuenow"),
    ).toBe("998");
    expect(within(tile).getByTestId("credits-held-note").textContent).toContain("2.00 USDC held");
    expect(within(tile).getByTestId("restricted-note").textContent).toContain(
      "Add credits to resume",
    );
    expect(within(tile).getByRole("button", { name: "Research now" })).toBeTruthy();
    expect(tile.textContent).toContain("about 0.15 to 0.30 USDC");
    expect(within(tile).getByTestId("scan-status")).toBeTruthy();
  });
});

describe("PositionTiles (UI-U1)", () => {
  it("renders every held token as a tile with its value, share and gain, and says when a price is missing", () => {
    render(<PositionTiles rows={ROWS} totalValueUsdcE6="70000000" />);
    const tiles = screen.getAllByTestId("asset-row");
    expect(tiles.map((t) => t.getAttribute("data-symbol"))).toEqual([
      "USDC",
      "WBTC",
      "WMON",
      "CHOG",
    ]);
    const wbtc = tiles[1] as HTMLElement;
    expect(wbtc.textContent).toContain("+2.00");
    expect(wbtc.textContent).toContain("+7.14%");
    expect(wbtc.textContent).toContain("42.85%");
    expect((tiles[2] as HTMLElement).textContent).toContain("-0.50");
    expect((tiles[3] as HTMLElement).textContent).toContain("no usable price");
    expect(screen.getByTestId("asset-makeup").textContent).toContain("70.00 USDC");
  });

  it("says what to do when nothing is held", () => {
    render(<PositionTiles rows={[]} totalValueUsdcE6={null} />);
    expect(screen.getByTestId("asset-makeup-empty").textContent).toContain("Deposit USDC");
  });
});

describe("PortfolioHero (UI-U1)", () => {
  it("shows the total, the mode, the state, the donut, the performance line, the note and the actions", () => {
    render(
      <PortfolioHero
        totalValueUsdcE6="70000000"
        rows={ROWS}
        series={SERIES}
        mode="NORMAL"
        state={{ label: "Automatic trading off: each trade waits for you", tone: "neutral" }}
        custody="v3"
        note="3 of 4 held tokens priced."
        actions={<button type="button">Deposit</button>}
      />,
    );
    const hero = screen.getByTestId("portfolio-overview");
    expect(hero.getAttribute("data-custody")).toBe("v3");
    expect(hero.textContent).toContain("70.00 USDC");
    expect(hero.textContent).toContain("Normal");
    expect(hero.textContent).toContain("each trade waits for you");
    expect(hero.textContent).toContain("3 of 4 held tokens priced.");
    expect(within(hero).getByRole("img", { name: /Allocation by value/ })).toBeTruthy();
    expect(within(hero).getByRole("button", { name: "Deposit" })).toBeTruthy();
  });

  it("says the total is unknown without a usable price", () => {
    render(
      <PortfolioHero totalValueUsdcE6={null} rows={[]} series={[]} mode="PAUSED" custody="v2" />,
    );
    expect(screen.getByTestId("portfolio-overview").textContent).toContain(
      "Unknown while a held token has no usable price",
    );
  });
});

describe("SetupFlow (UI-U1)", () => {
  it("renders each step with its state, counts the done ones, and shows the action on the next step", () => {
    render(
      <SetupFlow
        steps={[
          { key: "open", title: "Open a trading account", state: "done", detail: "Open." },
          {
            key: "deposit",
            title: "Deposit",
            state: "next",
            detail: "At least 5.00 USDC.",
            action: <button type="button">Deposit</button>,
          },
          {
            key: "goal",
            title: "Set a goal",
            state: "later",
            detail: "The goal fixes the limits.",
          },
          {
            key: "turnOn",
            title: "Turn on automatic trading",
            state: "later",
            detail: "Your wallet registers the permission.",
          },
        ]}
      />,
    );
    const flow = screen.getByTestId("setup-flow");
    expect(flow.getAttribute("data-done")).toBe("1");
    expect(flow.textContent).toContain("1 of 4 steps done");
    const steps = within(flow).getAllByTestId("setup-step");
    expect(steps.map((s) => s.getAttribute("data-state"))).toEqual([
      "done",
      "next",
      "later",
      "later",
    ]);
    expect(within(steps[1] as HTMLElement).getByRole("button", { name: "Deposit" })).toBeTruthy();
  });
});

describe("PageLoading and ComingLater (UI-U1)", () => {
  it("marks the loading block busy with its label", () => {
    render(<PageLoading label="Reading the portfolio" />);
    const block = screen.getByTestId("page-loading");
    expect(block.getAttribute("aria-busy")).toBe("true");
    expect(block.getAttribute("aria-label")).toBe("Reading the portfolio");
  });

  it("names the page that comes later and links every live page", () => {
    render(
      <ComingLater
        title="The leaderboard comes after the beta"
        description="Every agent ranked comes after the beta."
        links={[
          { href: "/agents", label: "My Agents", note: "Your agents." },
          { href: "/mint", label: "Mint", note: "Mint an agent." },
        ]}
      />,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "The leaderboard comes after the beta",
    );
    expect(screen.getByText("Coming after the beta")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open My Agents" }).getAttribute("href")).toBe(
      "/agents",
    );
    expect(screen.getByRole("link", { name: "Open Mint" }).getAttribute("href")).toBe("/mint");
  });
});

describe("the holdings as tiles with the table on request (UI-U2)", () => {
  it("shows the tiles and the donut, swaps in the table on the toggle, and back", async () => {
    render(
      <MakeupSwitch
        rows={ROWS}
        totalValueUsdcE6="70000000"
        asOf={{ at: "2026-10-11T12:00:00.000Z", live: true }}
      />,
    );
    expect(screen.getByRole("list", { name: "Positions" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Asset makeup" })).toBeNull();
    const toggle = screen.getByTestId("makeup-table-toggle");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(toggle);
    expect(screen.getByRole("region", { name: "Asset makeup" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Positions" })).toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(toggle);
    expect(screen.getByRole("list", { name: "Positions" })).toBeTruthy();
  });

  it("with nothing held, says so in plain words with the next action and no toggle", () => {
    render(
      <MakeupSwitch
        rows={[]}
        totalValueUsdcE6={null}
        asOf={null}
        emptyText="The makeup appears after the first deposit."
        emptyAction={<a href="#deposit">Deposit on the portfolio page</a>}
      />,
    );
    const empty = within(screen.getByTestId("asset-makeup-empty"));
    expect(empty.getByText("Nothing held yet")).toBeTruthy();
    expect(empty.getByText("The makeup appears after the first deposit.")).toBeTruthy();
    expect(empty.getByRole("link", { name: "Deposit on the portfolio page" })).toBeTruthy();
    expect(screen.queryByTestId("makeup-table-toggle")).toBeNull();
  });
});
