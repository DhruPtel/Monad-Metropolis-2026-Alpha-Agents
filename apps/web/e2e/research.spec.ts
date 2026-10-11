import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { type Locator, type Page, expect, test } from "@playwright/test";
import type { ResearchJson, SentinelJson, TerminalEventJson } from "../src/api/client";
import { MOCK_WALLET_ADDRESS } from "../src/auth/mock-wallet-constants";
import { FakeApi, fundedDashboard } from "./fake-api";
import { FakeChain } from "./fake-chain";
import {
  ACTIVATION_PLAN_READY,
  FakeTrading,
  activationFixture,
  activationReadFixture,
  planCardFixture,
  portfolioFixture,
  ACCOUNT_V3,
} from "./fake-trading";

/**
 * The Research page and the agent terminal (P3-U10) against the test build
 * with the mock wallet, the fake API and the fake chain, at 1440px and
 * 380px: the terminal follows a running cycle from the cursor it has,
 * resumes after a dropped read without repeating a line, and shows the
 * history of a finished one; the schedule, the budget, the triggers, the
 * timeline, the records and why; pause and resume; the empty page for an
 * agent that never researched; another wallet sees none of it; and the
 * terminal inside the activation panel while a sweep runs.
 */
const BEE = 14;
const AGENT = 7n;
const OTHER_WALLET = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;

const main = (page: Page) => page.getByRole("main");
const walletButton = (page: Page) => page.locator("header [data-slot=wallet-button]");

const FIXED_NOW = new Date("2026-10-11T12:05:00.000Z");
/** Anvil account 5, the local fork's sentinel (a public test address). */
const SENTINEL_ADDRESS = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";
const CYCLE_OPEN = "cycle-01234567-89ab-cdef-0123-456789abcde0";
const CYCLE_DONE = "cycle-01234567-89ab-cdef-0123-456789abcde1";

const line = (
  seq: number,
  text: string,
  over: Partial<TerminalEventJson> = {},
): TerminalEventJson => ({
  seq,
  at: `2026-10-11T12:00:${String(seq).padStart(2, "0")}.000Z`,
  kind: "stage",
  stage: "SCAN",
  text,
  tone: "info",
  ...over,
});

const LINES: TerminalEventJson[] = [
  line(1, "Routine research started, reasoning on research-medium.", {
    kind: "cycle",
    stage: null,
  }),
  line(2, "Scan started on research-medium; it may cost up to 0.5 USDC."),
  line(3, 'web_search: searching the web for "monad tvl"', { kind: "tool" }),
  line(4, "web_search: 5 results from news.example, defillama.com.", { kind: "tool", tone: "ok" }),
  line(5, "Scan brief: Monad TVL fell 6.8% in 7 days, a large weekly move for the chain.", {
    kind: "brief",
    tone: "ok",
  }),
  line(6, "Sources, news: news.example; source: web_search.", { kind: "source" }),
  line(7, "Scan cost 0.19 of at most 0.5 USDC, over 3 model calls.", { kind: "cost" }),
];
const MORE: TerminalEventJson[] = [
  line(8, "Dive on TVL_OUTFLOW started on research-medium; it may cost up to 1.2 USDC.", {
    stage: "DIVE",
  }),
  line(9, "[a line was withheld: it carried playbook text]", {
    kind: "withheld",
    stage: "DIVE",
    tone: "warn",
  }),
  line(
    10,
    "Thesis (medium confidence): The outflow is a rotation into lending, not an exit. It fails if lending TVL falls with DEX TVL for 3 days.",
    { kind: "thesis", stage: "DIVE", tone: "ok" },
  ),
];
const END: TerminalEventJson[] = [
  line(11, "Decision: no change (evidence thin).", { kind: "decision", stage: "ZOOM_OUT" }),
  line(
    12,
    "Routine research completed (completed): 0.41 USDC in total. Today's research used 1.41 of its 3.8 USDC budget.",
    { kind: "cycle", stage: null, tone: "ok" },
  ),
];

function researchFixture(over: Partial<ResearchJson> = {}): ResearchJson {
  return {
    agentId: AGENT.toString(),
    running: true,
    schedulingOn: true,
    schedule: {
      paused: false,
      fastCadence: false,
      lastScanAt: "2026-10-11T09:00:00.000Z",
      lastZoomOutAt: "2026-10-10T12:30:00.000Z",
      lastOverviewAt: "2026-10-05T12:30:00.000Z",
      lastTriggerCycleAt: "2026-10-11T11:00:00.000Z",
      waitingReason: null,
      waitingSince: null,
      nextDueAt: "2026-10-11T15:00:00.000Z",
      baselineTakenAt: "2026-10-11T09:05:00.000Z",
    },
    cadence: {
      intensity: "STANDARD",
      aggressiveness: "BALANCED",
      priceTriggerBps: 700,
      positionTriggerBps: 1_500,
      scanEveryMs: 6 * 3_600_000,
      zoomOutEveryMs: 24 * 3_600_000,
      overviewEveryMs: 7 * 24 * 3_600_000,
      triggerSpacingMs: 2 * 3_600_000,
      watchEveryMs: 5 * 60_000,
      refreshesOverview: true,
    },
    budget: {
      dailyBudgetUsdcE6: "3800000",
      usedTodayUsdcE6: "1410000",
      divesPerDay: 2,
      divesToday: 1,
    },
    open: { cycleId: CYCLE_OPEN, kind: "ROUTINE", status: "running" },
    triggers: [
      {
        triggerId: "trigger-1",
        code: "PRICE_MOVE",
        text: "MON's price moved past the goal's trigger since the last Zoom out",
        kind: "TRIGGERED",
        detail: { moveBps: 820 },
        firedAt: "2026-10-11T11:00:00.000Z",
        cycleId: CYCLE_OPEN,
        spaced: false,
      },
      {
        triggerId: "trigger-2",
        code: "MODE_CHANGED",
        text: "the account's mode changed",
        kind: "REVIEW",
        detail: {},
        firedAt: "2026-10-11T11:30:00.000Z",
        cycleId: null,
        spaced: true,
      },
    ],
    overview: {
      at: "2026-10-11T06:05:00.000Z",
      summary: "Monad's DEX liquidity is thinning while lending holds its share.",
      points: [
        {
          text: "Lending protocols hold 412 million USD.",
          class: "onchain",
          sources: ["defillama.com"],
        },
      ],
    },
    themes: {
      at: "2026-10-11T06:01:00.000Z",
      summary: "Monad TVL fell 6.8% in 7 days, a large weekly move for the chain.",
      quiet: false,
      themes: [
        {
          code: "TVL_OUTFLOW",
          materiality: "high",
          scope: "MARKET",
          symbol: null,
          whyNow: "A 6.8% weekly fall is large for the chain.",
        },
      ],
    },
    planUnchanged: {
      at: "2026-10-11T06:05:00.000Z",
      reasonCode: "EVIDENCE_THIN",
      portfolioView: "One position in WMON and the rest in USDC.",
      whatWouldChangeIt: "a second source for the lending figure",
    },
    universe: {
      cycleId: CYCLE_OPEN,
      kind: "ROUTINE",
      at: "2026-10-11T12:00:01.000Z",
      rows: [
        {
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
          proposed: false,
          droppedReason: null,
        },
        {
          token: "0x00000000000000000000000000000000000000a2",
          symbol: "GHO",
          priceClass: "A",
          lane: "screened",
          status: "listed",
          buyable: true,
          whyNot: null,
          held: false,
          themeCode: null,
          themeReason: null,
          researched: false,
          proposed: false,
          droppedReason: null,
        },
        {
          token: "0x00000000000000000000000000000000000000a3",
          symbol: "CHAOS",
          priceClass: "A",
          lane: "screened",
          status: "listed",
          buyable: false,
          whyNot: "in the screened lane; the owner has not opted in on chain",
          held: false,
          themeCode: null,
          themeReason: null,
          researched: false,
          proposed: false,
          droppedReason: null,
        },
      ],
    },
    cycles: [
      {
        cycleId: CYCLE_OPEN,
        kind: "ROUTINE",
        status: "running",
        startedAt: "2026-10-11T12:00:01.000Z",
        finishedAt: null,
        chargedUsdcE6: "190000",
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
            status: "running",
            chargedUsdcE6: "0",
            ceilingUsdcE6: "1200000",
          },
        ],
      },
      {
        cycleId: CYCLE_DONE,
        kind: "REVIEW",
        status: "completed",
        startedAt: "2026-10-10T12:00:00.000Z",
        finishedAt: "2026-10-10T12:03:00.000Z",
        chargedUsdcE6: "140000",
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
            status: "completed",
            chargedUsdcE6: "140000",
            ceilingUsdcE6: "600000",
          },
        ],
      },
    ],
    snapshot: {
      at: "2026-10-11T12:04:00.000Z",
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
          status: "listed",
        },
      ],
    },
    ...over,
  };
}

function sentinelFixture(): SentinelJson {
  return {
    agentId: AGENT.toString(),
    configured: true,
    sentinelAddress: SENTINEL_ADDRESS,
    account: ACCOUNT_V3,
    mode: "REDUCE_ONLY",
    active: { DRAWDOWN_12: "2026-10-11T11:30:00.000Z" },
    lastCheckedAt: "2026-10-11T12:04:30.000Z",
    actions: [
      {
        actionId: "sentinel-2",
        code: "STALE_FEED",
        text: "a held token's price feed is stale or unusable",
        action: "NOTE",
        state: null,
        reason: "the condition cleared; the account's mode stays until its owner reviews it",
        detail: {},
        txHash: null,
        status: "done",
        at: "2026-10-11T11:50:00.000Z",
      },
      {
        actionId: "sentinel-1",
        code: "DRAWDOWN_12",
        text: "the account fell 12% or more from its 7-day peak",
        action: "REDUCE_ONLY",
        state: null,
        reason: "12.5% below the 7-day peak",
        detail: { drawdownBps: 1250 },
        txHash: "0xa1",
        status: "done",
        at: "2026-10-11T11:30:00.000Z",
      },
    ],
  };
}

function stack(owner: string = MOCK_WALLET_ADDRESS) {
  const chain = new FakeChain();
  chain.mint(AGENT, owner as `0x${string}`, BEE);
  const api = new FakeApi(chain);
  api.dashboards.set(AGENT, fundedDashboard());
  const trading = new FakeTrading(
    chain,
    MOCK_WALLET_ADDRESS,
    portfolioFixture(MOCK_WALLET_ADDRESS),
  );
  api.trading.set(AGENT, trading);
  return { chain, api, trading };
}

async function open(page: Page, s: ReturnType<typeof stack>, path = `/agents/${AGENT}/research`) {
  await s.chain.install(page);
  await s.api.install(page);
  // The page's relative times ("in 3 h", "20 h ago") are read against a fixed clock, so the
  // captures are the same on every run; timers still run, so the terminal keeps polling.
  await page.clock.setFixedTime(FIXED_NOW);
  await page.goto(path);
  await page.evaluate(() => document.fonts.ready);
  await main(page).getByRole("button", { name: "Connect wallet" }).click();
  await page.mouse.move(0, 0);
  await expect(walletButton(page)).toHaveAttribute("data-state", "connected");
}

/** The same scroll, no hover, every image loaded and a full repaint (L-44, L-65), then the capture. */
async function capture(page: Page, target: Locator, name: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => document.querySelector("button:hover, a:hover") === null);
  await page.evaluate(async () => {
    const frames = () =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    document.documentElement.style.opacity = "0.99";
    await frames();
    document.documentElement.style.opacity = "";
    await frames();
  });
  await expect(target).toHaveScreenshot(name, {
    stylePath: fileURLToPath(new URL("./portal-capture.css", import.meta.url)),
    timeout: 30_000,
  });
}

async function blockingViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

test.describe("the Research page and the agent terminal (P3-U10)", () => {
  test("follows a running cycle live, resumes after a dropped read without repeating a line, and shows the whole page", async ({
    page,
  }) => {
    const s = stack();
    s.trading.research = researchFixture();
    s.trading.sentinel = sentinelFixture();
    s.trading.terminalCycle = { cycleId: CYCLE_OPEN, kind: "ROUTINE", status: "running" };
    s.trading.terminalLive = true;
    s.trading.terminalLines = [...LINES];
    await open(page, s);
    const root = main(page).getByTestId("research-page");
    // P4-U2: the sentinel's card with its conditions and actions.
    const sentinel = root.getByTestId("sentinel-card");
    await expect(sentinel).toHaveAttribute("data-state", "tightened");
    await expect(sentinel.getByTestId("sentinel-active")).toContainText(
      "drawdown 12 since 2026-10-11 11:30 UTC",
    );
    await expect(sentinel.getByTestId("sentinel-actions").locator("li")).toHaveCount(2);
    await expect(sentinel).toContainText("Set the account to reduce-only");
    await expect(sentinel).toContainText("12.5% below the 7-day peak");
    // F-U12: the owner unpauses the account after review, from their wallet: one unpause() call.
    await sentinel.getByRole("button", { name: "Unpause after review" }).click();
    await expect(sentinel.getByTestId("wallet-action-status")).toContainText(
      "The account is back to normal.",
      { timeout: 15_000 },
    );
    expect(
      s.chain.transactions
        .filter((t) => t.to.toLowerCase() === ACCOUNT_V3.toLowerCase())
        .map((t) => t.data),
    ).toEqual(["0x3f4ba83a"]);
    const terminal = root.getByTestId("agent-terminal");
    await expect(terminal).toHaveAttribute("data-state", "live");
    await expect(terminal).toHaveAttribute("data-lines", "7");
    await expect(terminal).toContainText('web_search: searching the web for "monad tvl"');
    // The schedule, the budget, the triggers, the timeline and the records.
    await expect(root.getByTestId("research-schedule")).toHaveAttribute(
      "data-state",
      "On schedule",
    );
    await expect(root.getByTestId("research-schedule")).toContainText(
      "Standard intensity: a Scan every 6 hours, a review every day, the overview refreshed every week.",
    );
    await expect(root.getByTestId("budget-meter")).toContainText("1.41 of 3.80 USDC");
    await expect(root.getByTestId("trigger-list")).toContainText("scan ran");
    await expect(root.getByTestId("trigger-list")).toContainText("waiting its turn");
    await expect(root.getByTestId("stage-timeline").locator("li[data-cycle]")).toHaveCount(2);
    await expect(root.getByTestId("stage-timeline")).toContainText("Dive TVL_OUTFLOW0.00/1.20");
    await expect(root.getByTestId("research-overview")).toContainText(
      "Lending protocols hold 412 million USD.",
    );
    await expect(root.getByTestId("themes-panel")).toContainText("TVL_OUTFLOW");
    await expect(root.getByTestId("market-snapshot")).toContainText(
      "0.03 USD · 1.3M USD of liquidity",
    );
    await expect(root.getByTestId("plan-unchanged")).toContainText("the evidence was too thin");
    // F-U12: the universe the cycle considered, with each token's buyability and why not.
    const universe = root.getByTestId("universe-panel");
    await expect(universe).toHaveAttribute("data-rows", "3");
    await expect(universe).toContainText("2 buyable");
    await expect(universe.locator('tr[data-buyable="false"]')).toContainText(
      "no: in the screened lane; the owner has not opted in on chain",
    );
    await expect(universe).toContainText("chosen for a Dive (high materiality)");
    await expect(root.getByTestId("why-not-traded")).toBeVisible();
    await capture(page, root, "research-live.png");
    expect(await blockingViolations(page)).toEqual([]);
    // More lines arrive: only those after the cursor are read, in order, and nothing repeats.
    s.trading.terminalLines.push(...MORE);
    await expect(terminal).toHaveAttribute("data-lines", "10", { timeout: 15_000 });
    await expect(terminal.locator("li[data-seq]")).toHaveCount(10);
    await expect(terminal.locator('li[data-kind="withheld"]')).toHaveText(
      /a line was withheld: it carried playbook text/,
    );
    // Two reads fail: the terminal says it is reconnecting from its last line, then resumes from it.
    s.trading.terminalFailures = 2;
    await expect(terminal).toHaveAttribute("data-state", "reconnecting", { timeout: 15_000 });
    await expect(terminal.getByTestId("terminal-reconnecting")).toContainText("from line 10");
    s.trading.terminalLines.push(...END);
    s.trading.terminalLive = false;
    s.trading.terminalCycle = { cycleId: CYCLE_OPEN, kind: "ROUTINE", status: "completed" };
    await expect(terminal).toHaveAttribute("data-state", "ended", { timeout: 20_000 });
    await expect(terminal.locator("li[data-seq]")).toHaveCount(12);
    const seqs = await terminal
      .locator("li[data-seq]")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-seq")));
    expect(seqs).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);
    // Every read asked from the cursor it had: no read ever asked from 0 twice.
    expect(s.trading.terminalReads.filter((n) => n === 0)).toHaveLength(1);
    expect(Math.max(...s.trading.terminalReads)).toBe(10);
  });

  test("pauses and resumes research, and picks a finished cycle's history in the terminal", async ({
    page,
  }) => {
    const s = stack();
    s.trading.research = researchFixture({ open: null });
    s.trading.sentinel = { ...sentinelFixture(), active: {}, actions: [] };
    s.trading.terminalCycle = { cycleId: CYCLE_DONE, kind: "REVIEW", status: "completed" };
    s.trading.terminalLines = [...LINES, ...END];
    await open(page, s);
    const root = main(page).getByTestId("research-page");
    await expect(root.getByTestId("agent-terminal")).toHaveAttribute("data-state", "ended");
    await root.getByTestId("research-pause").click();
    await expect(root.getByTestId("research-schedule")).toHaveAttribute("data-state", "Paused", {
      timeout: 15_000,
    });
    expect(s.trading.pauses).toEqual([true]);
    await expect(root.getByTestId("research-pause")).toHaveText("Resume research");
    await root.getByTestId("research-pause").click();
    await expect(root.getByTestId("research-schedule")).toHaveAttribute(
      "data-state",
      "On schedule",
      { timeout: 15_000 },
    );
    expect(s.trading.pauses).toEqual([true, false]);
    // Picking the finished review reads its history.
    await root
      .getByTestId("stage-timeline")
      .locator(`li[data-cycle="${CYCLE_DONE}"] button`)
      .click();
    await expect(
      root.getByTestId("stage-timeline").locator(`li[data-cycle="${CYCLE_DONE}"] button`),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(root.getByTestId("agent-terminal")).toContainText("review · completed", {
      timeout: 15_000,
    });
    await capture(page, root.getByTestId("agent-terminal"), "research-history.png");
  });

  test("an agent that never researched shows the empty page, and waiting says why", async ({
    page,
  }) => {
    const s = stack();
    s.trading.research = researchFixture({
      running: false,
      open: null,
      triggers: [],
      overview: null,
      themes: null,
      planUnchanged: null,
      universe: null,
      cycles: [],
      snapshot: null,
      budget: null,
      cadence: null,
      schedule: {
        ...researchFixture().schedule,
        lastScanAt: null,
        lastZoomOutAt: null,
        lastOverviewAt: null,
        nextDueAt: null,
        waitingReason: "BUDGET_SHORT",
        waitingSince: "2026-10-11T10:00:00.000Z",
      },
    });
    s.trading.terminalCycle = null;
    await open(page, s);
    const root = main(page).getByTestId("research-page");
    await expect(root.getByTestId("agent-terminal")).toHaveAttribute("data-state", "idle");
    // No sentinel on the stack: the card says so.
    await expect(root.getByTestId("sentinel-card")).toContainText("not running on this stack");
    await expect(root.getByTestId("research-schedule")).toContainText(
      "runs once a plan is approved",
    );
    await expect(root.getByTestId("research-waiting")).toContainText(
      "Waiting for tomorrow's research budget.",
    );
    await expect(root.getByTestId("stage-timeline")).toHaveCount(0);
    await expect(root.getByText("No research yet")).toBeVisible();
    await expect(root.getByTestId("research-overview")).toContainText(
      "writes its overview when it is activated",
    );
    await capture(page, root, "research-empty.png");
    expect(await blockingViolations(page)).toEqual([]);
  });

  test("another wallet sees none of it: the API refuses the owner session and the page says so", async ({
    page,
  }) => {
    const other = stack(OTHER_WALLET);
    other.trading.research = researchFixture();
    await open(page, other);
    await expect(main(page).getByText("Research not available")).toBeVisible();
    await expect(main(page).getByTestId("research-page")).toHaveCount(0);
  });

  test("without the orchestrator the page says research is not available", async ({ page }) => {
    const s = stack();
    s.trading.research = null;
    await open(page, s);
    await expect(main(page).getByText("Research not available")).toBeVisible();
    await expect(main(page).getByText(/orchestrator is not reachable/)).toBeVisible();
  });

  test("the terminal runs inside the activation panel while the sweep runs, with a link to the page", async ({
    page,
  }) => {
    const s = stack();
    s.trading.activation = activationReadFixture();
    s.trading.activationScript = [
      activationFixture("scan", "running"),
      activationFixture("dives", "running"),
      ACTIVATION_PLAN_READY(),
    ];
    s.trading.planCard = planCardFixture({ pending: null, recent: [], noChange: null });
    s.trading.research = researchFixture();
    s.trading.terminalCycle = { cycleId: CYCLE_OPEN, kind: "ACTIVATION", status: "running" };
    s.trading.terminalLive = true;
    s.trading.terminalLines = [...LINES];
    await open(page, s, `/agents/${AGENT}/portfolio`);
    const arming = main(page).getByTestId("arming-card");
    await arming.getByTestId("turn-on").click();
    const panel = main(page).getByTestId("activation-panel");
    await expect(panel).toHaveAttribute("data-status", "running", { timeout: 15_000 });
    const terminal = panel.getByTestId("agent-terminal");
    await expect(terminal).toHaveAttribute("data-state", "live", { timeout: 15_000 });
    await expect(terminal).toContainText("Scan brief: Monad TVL fell 6.8% in 7 days");
    await expect(terminal).toContainText("activation · running");
    await capture(page, panel, "portfolio-activating-terminal.png");
    expect(await blockingViolations(page)).toEqual([]);
    await panel.getByTestId("research-link-panel").click();
    await expect(page).toHaveURL(new RegExp(`/agents/${AGENT}/research$`));
    await expect(main(page).getByTestId("research-page")).toBeVisible();
    // The portfolio's header links there too.
    await page.goto(`/agents/${AGENT}/portfolio`);
    await expect(main(page).getByTestId("research-link")).toHaveAttribute(
      "href",
      `/agents/${AGENT}/research`,
    );
  });
});
