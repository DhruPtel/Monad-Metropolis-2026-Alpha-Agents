import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  AgentTerminal,
  BudgetMeter,
  MarketSnapshotPanel,
  PlanUnchangedCard,
  ResearchOverview,
  ResearchScheduleCard,
  type ResearchScheduleView,
  ResearchShortNotice,
  ResearchTiles,
  StageTimeline,
  type TerminalLineView,
  ThemesPanel,
  TriggerList,
  everyText,
  relativeText,
  researchShortText,
  researchTileWords,
} from "./research";

/**
 * The research loop's components (P3-U10): the terminal's lines, states and
 * the reconnect note; the schedule's words per state; the budget meter; the
 * triggers; the timeline's stage costs; and the records' empty states.
 */
const NOW = "2026-10-11T12:00:00.000Z";
const line = (seq: number, over: Partial<TerminalLineView> = {}): TerminalLineView => ({
  seq,
  at: `2026-10-11T11:5${seq}:00.000Z`,
  kind: "stage",
  stage: "SCAN",
  text: `line ${seq}`,
  tone: "info",
  ...over,
});
const schedule = (over: Partial<ResearchScheduleView> = {}): ResearchScheduleView => ({
  running: true,
  schedulingOn: true,
  paused: false,
  fastCadence: false,
  intensity: "STANDARD",
  nextDueAt: "2026-10-11T15:00:00.000Z",
  lastScanAt: "2026-10-11T09:00:00.000Z",
  lastZoomOutAt: "2026-10-10T12:30:00.000Z",
  lastOverviewAt: null,
  waitingReason: null,
  waitingSince: null,
  scanEveryMs: 6 * 3_600_000,
  zoomOutEveryMs: 24 * 3_600_000,
  overviewEveryMs: 7 * 24 * 3_600_000,
  triggerSpacingMs: 2 * 3_600_000,
  refreshesOverview: true,
  ...over,
});

describe("the agent terminal", () => {
  it("renders each line with its time, tone and stage, live, and names the cycle", () => {
    render(
      <AgentTerminal
        lines={[
          line(1, { text: "Scan started on research-medium; it may cost up to 0.5 USDC." }),
          line(2, { kind: "tool", text: "web_search: 5 results from news.example.", tone: "ok" }),
          line(3, {
            kind: "withheld",
            text: "[a line was withheld: it carried playbook text]",
            tone: "warn",
          }),
        ]}
        state="live"
        cycle={{ kind: "ROUTINE", status: "running" }}
      />,
    );
    const log = screen.getByRole("log", { name: "Agent terminal" });
    expect(log).toHaveAttribute("aria-live", "polite");
    expect(screen.getByTestId("agent-terminal")).toHaveAttribute("data-state", "live");
    expect(screen.getByTestId("terminal-state")).toHaveTextContent("Live");
    expect(screen.getByText("routine · running")).toBeInTheDocument();
    const items = within(log).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveAttribute("data-seq", "1");
    expect(items[0]).toHaveTextContent("11:51:00");
    expect(items[1]).toHaveAttribute("data-tone", "ok");
    expect(items[2]).toHaveAttribute("data-kind", "withheld");
    expect(items[2]).toHaveClass("italic");
  });

  it("says what it is doing without lines, and notes a dropped connection with the last line it has", () => {
    const { rerender } = render(<AgentTerminal lines={[]} state="idle" />);
    expect(screen.getByText(/Nothing has run yet/)).toBeInTheDocument();
    expect(screen.getByRole("log")).toHaveAttribute("aria-live", "off");
    rerender(<AgentTerminal lines={[]} state="connecting" />);
    expect(screen.getByText("Waiting for the first line.")).toBeInTheDocument();
    expect(screen.getByRole("log")).toHaveAttribute("aria-busy", "true");
    rerender(<AgentTerminal lines={[line(1), line(2)]} state="reconnecting" />);
    expect(screen.getByTestId("terminal-reconnecting")).toHaveTextContent(
      "trying again from line 2",
    );
    expect(screen.getByTestId("terminal-state")).toHaveTextContent("Reconnecting");
    rerender(<AgentTerminal lines={[line(1), line(2)]} state="ended" />);
    expect(screen.queryByTestId("terminal-reconnecting")).toBeNull();
    expect(screen.getByTestId("terminal-state")).toHaveTextContent("Ended");
  });

  it("keeps following the newest line until the reader scrolls up", () => {
    render(<AgentTerminal lines={[line(1), line(2)]} state="live" />);
    const log = screen.getByRole("log");
    Object.defineProperty(log, "scrollHeight", { value: 400, configurable: true });
    Object.defineProperty(log, "clientHeight", { value: 100, configurable: true });
    log.scrollTop = 100;
    fireEvent.scroll(log);
    // Scrolled up: the view stays where the reader put it.
    expect(log.scrollTop).toBe(100);
    // Back at the bottom: the view pins again and follows the newest line.
    log.scrollTop = 300;
    fireEvent.scroll(log);
    expect(log.scrollTop).toBe(400);
  });
});

describe("the schedule, the budget and the triggers", () => {
  it("names the cadence, the next due time and the last work for a running agent", () => {
    render(<ResearchScheduleCard view={schedule()} now={NOW} />);
    expect(screen.getByTestId("research-schedule")).toHaveAttribute("data-state", "On schedule");
    expect(
      screen.getByText(
        "Standard intensity: a Scan every 6 hours, a review every day, the overview refreshed every week.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("research-next-due")).toHaveTextContent("in 3 h");
    expect(screen.getByText("3 h ago")).toBeInTheDocument();
    expect(screen.getByText("never")).toBeInTheDocument();
    expect(everyText(2 * 60_000)).toBe("every 2 min");
    expect(relativeText("2026-10-11T11:59:30.000Z", NOW)).toBe("under a minute ago");
  });

  it("says why it waits, when it is paused, when the agent is not running and when the loop is off", () => {
    const { rerender } = render(
      <ResearchScheduleCard
        view={schedule({ waitingReason: "BUDGET_SHORT", waitingSince: "2026-10-11T10:00:00.000Z" })}
        now={NOW}
      />,
    );
    expect(screen.getByTestId("research-waiting")).toHaveTextContent(
      "Waiting for tomorrow's research budget. Since 2026-10-11 10:00 UTC.",
    );
    expect(screen.getByTestId("research-schedule")).toHaveAttribute("data-state", "Waiting");
    rerender(<ResearchScheduleCard view={schedule({ paused: true })} now={NOW} />);
    expect(screen.getByText(/Research is paused/)).toBeInTheDocument();
    expect(screen.getByTestId("research-next-due")).toHaveTextContent("—");
    rerender(<ResearchScheduleCard view={schedule({ running: false })} now={NOW} />);
    expect(screen.getByText(/runs once a plan is approved/)).toBeInTheDocument();
    rerender(<ResearchScheduleCard view={schedule({ schedulingOn: false })} now={NOW} />);
    expect(screen.getByText(/Scheduled research is off on this stack/)).toBeInTheDocument();
  });

  it("the budget meter and the triggers", () => {
    render(
      <>
        <BudgetMeter usedUsdcE6="1410000" dailyUsdcE6="3800000" divesToday={1} divesPerDay={2} />
        <TriggerList
          now={NOW}
          triggers={[
            {
              triggerId: "t1",
              code: "PRICE_MOVE",
              text: "MON's price moved past the goal's trigger since the last Zoom out",
              kind: "TRIGGERED",
              firedAt: "2026-10-11T11:00:00.000Z",
              cycleId: "cycle-1",
              spaced: false,
            },
            {
              triggerId: "t2",
              code: "MODE_CHANGED",
              text: "the account's mode changed",
              kind: "REVIEW",
              firedAt: "2026-10-11T11:30:00.000Z",
              cycleId: null,
              spaced: true,
            },
          ]}
        />
      </>,
    );
    expect(screen.getByText("1.41 of 3.80 USDC")).toBeInTheDocument();
    expect(screen.getByText(/1 of 2 Dives today/)).toBeInTheDocument();
    expect(screen.getByText("scan ran")).toBeInTheDocument();
    expect(screen.getByText("waiting its turn")).toBeInTheDocument();
  });
});

describe("the timeline and the records", () => {
  it("shows each cycle's stages with their cost against the ceiling, and selects one", () => {
    const picked: string[] = [];
    render(
      <StageTimeline
        selected="cycle-2"
        onSelect={(id) => picked.push(id)}
        cycles={[
          {
            cycleId: "cycle-2",
            kind: "REVIEW",
            status: "running",
            startedAt: "2026-10-11T11:40:00.000Z",
            finishedAt: null,
            chargedUsdcE6: "0",
            stages: [
              {
                stage: "TEST",
                themeCode: null,
                status: "completed",
                chargedUsdcE6: "0",
                ceilingUsdcE6: "0",
              },
              {
                stage: "ZOOM_OUT",
                themeCode: null,
                status: "running",
                chargedUsdcE6: "0",
                ceilingUsdcE6: "600000",
              },
            ],
          },
          {
            cycleId: "cycle-1",
            kind: "ROUTINE",
            status: "completed",
            startedAt: "2026-10-11T06:00:00.000Z",
            finishedAt: "2026-10-11T06:05:00.000Z",
            chargedUsdcE6: "410000",
            stages: [
              {
                stage: "SCAN",
                themeCode: null,
                status: "completed",
                chargedUsdcE6: "190000",
                ceilingUsdcE6: "500000",
              },
              {
                stage: "DIVE",
                themeCode: "TVL_OUTFLOW",
                status: "capped",
                chargedUsdcE6: "220000",
                ceilingUsdcE6: "1200000",
              },
            ],
          },
        ]}
      />,
    );
    const rows = screen.getAllByRole("button");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("aria-pressed", "true");
    expect(rows[1]).toHaveTextContent("Dive TVL_OUTFLOW0.22/1.20");
    expect(rows[1]).toHaveTextContent("0.41 USDC");
    if (rows[1]) fireEvent.click(rows[1]);
    expect(picked).toEqual(["cycle-1"]);
  });

  it("the overview, the themes, the snapshot and the plan's standing, each with its empty state", () => {
    const { rerender } = render(
      <>
        <ResearchOverview overview={null} />
        <ThemesPanel themes={null} />
        <MarketSnapshotPanel snapshot={null} />
        <PlanUnchangedCard view={null} />
      </>,
    );
    expect(screen.getByText(/writes its overview when it is activated/)).toBeInTheDocument();
    expect(screen.getByText(/first Scan names the themes/)).toBeInTheDocument();
    expect(screen.getByText(/reads the market once the agent has an account/)).toBeInTheDocument();
    expect(screen.getByText(/Every review ends with a reason/)).toBeInTheDocument();
    rerender(
      <>
        <ResearchOverview
          overview={{
            at: "2026-10-11T06:05:00.000Z",
            summary: "Monad's DEX liquidity is thinning while lending holds.",
            points: [
              {
                text: "Lending holds 412 million USD.",
                class: "onchain",
                sources: ["defillama.com"],
              },
            ],
          }}
        />
        <ThemesPanel
          themes={{
            at: "2026-10-11T06:01:00.000Z",
            summary: "TVL fell 6.8% in a week.",
            quiet: false,
            themes: [
              {
                code: "TVL_OUTFLOW",
                materiality: "high",
                scope: "MARKET",
                symbol: null,
                whyNow: "A large weekly fall.",
              },
            ],
          }}
        />
        <MarketSnapshotPanel
          snapshot={{
            at: "2026-10-11T11:55:00.000Z",
            monUsd: "0.03",
            volatilityPct: 110,
            mode: "NORMAL",
            navUsdcE6: "41600000",
            held: [
              {
                symbol: "WMON",
                priceUsd: "0.03",
                liquidityUsd: 1_250_000,
                screen: "passed",
                status: "sell_only",
              },
            ],
          }}
        />
        <PlanUnchangedCard
          view={{
            at: "2026-10-11T06:05:00.000Z",
            reasonCode: "EVIDENCE_THIN",
            portfolioView: "One position, the rest in USDC.",
            whatWouldChangeIt: "a second source for the lending figure",
          }}
        />
      </>,
    );
    expect(screen.getByText("Lending holds 412 million USD.")).toBeInTheDocument();
    expect(screen.getByText("defillama.com")).toBeInTheDocument();
    expect(screen.getByText("TVL_OUTFLOW")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText("0.03 USD · 1.3M USD of liquidity")).toBeInTheDocument();
    expect(screen.getByText("sell only")).toBeInTheDocument();
    expect(screen.getByText("110%")).toBeInTheDocument();
    expect(screen.getByText(/kept the plan because the evidence was too thin/)).toBeInTheDocument();
    expect(screen.getByText(/What would change it: a second source/)).toBeInTheDocument();
  });
});

describe("the research loop at a glance as tiles (UI-U2)", () => {
  const NOW = "2026-10-11T12:05:00.000Z";
  const base = {
    running: true,
    schedulingOn: true,
    paused: false,
    waitingReason: null,
    nextDueAt: "2026-10-11T15:00:00.000Z",
    lastScanAt: "2026-10-11T09:00:00.000Z",
    intensity: "STANDARD",
    budget: {
      usedTodayUsdcE6: "1410000",
      dailyBudgetUsdcE6: "3800000",
      divesToday: 1,
      divesPerDay: 2,
    },
    cycles: 2,
    open: false,
  };

  it("says whether the loop runs, when the next Scan is due, what today spent and how many cycles ran", () => {
    const w = researchTileWords(base, NOW);
    expect(w.status).toMatchObject({ value: "On schedule", state: "On schedule", tone: "accent" });
    expect(w.status.note).toBe("Standard intensity.");
    expect(w.next).toEqual({ value: "in 3 h", note: "The next Scan, at 2026-10-11 15:00 UTC." });
    expect(w.spent).toEqual({
      value: "1.41 USDC",
      note: "of 3.80 USDC today, 1 of 2 Dives.",
      tone: "neutral",
    });
    expect(w.cycles).toEqual({ value: "2", note: "Cycles so far; the last Scan 3 h ago." });
  });

  it("paused, waiting, by hand and not running each say so, a used-up budget warns, an open cycle is now, no goal has no budget", () => {
    expect(researchTileWords({ ...base, paused: true }, NOW).status).toMatchObject({
      value: "Paused",
      tone: "warning",
    });
    expect(
      researchTileWords({ ...base, waitingReason: "Waiting for tomorrow's budget." }, NOW).status,
    ).toMatchObject({
      value: "Waiting",
      note: "Waiting for tomorrow's budget.",
    });
    expect(researchTileWords({ ...base, schedulingOn: false }, NOW).status.value).toBe("By hand");
    expect(researchTileWords({ ...base, running: false }, NOW).status.value).toBe("Not running");
    expect(
      researchTileWords({ ...base, budget: { ...base.budget, usedTodayUsdcE6: "3800000" } }, NOW)
        .spent.tone,
    ).toBe("warning");
    expect(researchTileWords({ ...base, open: true }, NOW).next.value).toBe("Now");
    expect(researchTileWords({ ...base, nextDueAt: null }, NOW).next.value).toBe("None due");
    expect(researchTileWords({ ...base, budget: null, cycles: 0 }, NOW).spent).toEqual({
      value: "No budget",
      note: "Set a goal to give research a budget.",
      tone: "warning",
    });
    expect(researchTileWords({ ...base, cycles: 0 }, NOW).cycles.note).toBe("No cycle yet.");
  });

  it("renders the four tiles with the action on the status tile", () => {
    render(
      <ResearchTiles
        view={base}
        now={NOW}
        action={<button type="button">Pause research</button>}
      />,
    );
    const tiles = within(screen.getByRole("group", { name: "Research at a glance" }));
    expect(screen.getByTestId("research-tile-status").getAttribute("data-state")).toBe(
      "On schedule",
    );
    expect(tiles.getByRole("button", { name: "Pause research" })).toBeTruthy();
    expect(tiles.getByText("in 3 h")).toBeTruthy();
    expect(tiles.getByText("1.41 USDC")).toBeTruthy();
    expect(tiles.getByText("2")).toBeTruthy();
  });
});

describe("research that cannot start or stopped short (2026-10-16)", () => {
  it("says the credits, what a run needs and the fix, before a run or at the stage it stopped", () => {
    expect(
      researchShortText({
        reason: "CREDITS_SHORT",
        availableUsdcE6: "169892",
        neededUsdcE6: "2350000",
        stage: null,
      }),
    ).toEqual({
      title: "Not enough research credits: 0.16 USDC available, a run needs about 2.35",
      body: "The run did not start. Add credits to run research; the reserve for gas stays untouched.",
    });
    render(
      <ResearchShortNotice
        view={{
          reason: "BUDGET_SHORT",
          usedUsdcE6: "1000000",
          budgetUsdcE6: "1000000",
          stage: "DIVE",
        }}
        action={<button type="button">Raise daily budget</button>}
      />,
    );
    const notice = screen.getByTestId("research-short");
    expect(notice).toHaveAttribute("data-reason", "BUDGET_SHORT");
    expect(notice).toHaveTextContent("Today's research budget is used up: 1.00 of 1.00 USDC");
    expect(notice).toHaveTextContent("The run stopped before its Dive.");
    expect(within(notice).getByRole("button", { name: "Raise daily budget" })).toBeVisible();
  });
});
