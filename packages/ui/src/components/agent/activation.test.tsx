import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ActivationChecks,
  type ActivationPanelView,
  ActivationPanel,
  ActivationStatusTag,
  elapsedText,
} from "./activation";
import { SpeciesArt } from "./species-art";

const NOW = "2026-10-10T20:05:00.000Z";
const step = (
  key: string,
  label: string,
  state: ActivationPanelView["steps"][number]["state"],
  over: Partial<ActivationPanelView["steps"][number]> = {},
) => ({
  key,
  label,
  state,
  result: null,
  reason: null,
  chargedUsdcE6: "0",
  ceilingUsdcE6: "0",
  startedAt: null,
  finishedAt: null,
  ...over,
});
const view = (over: Partial<ActivationPanelView> = {}): ActivationPanelView => ({
  activationId: "act-1",
  status: "running",
  tier: { label: "Medium", model: "Claude Sonnet 5.5" },
  ceilingUsdcE6: "3800000",
  chargedUsdcE6: "1110000",
  steps: [
    step("account", "Reading your goal and account", "done", {
      result: "Balanced on the Medium tier; 90.00 USDC to trade with; 12.00 USDC of credits.",
    }),
    step("scan", "Scanning the market", "done", {
      result: "3 themes worth a closer look.",
      chargedUsdcE6: "210000",
      ceilingUsdcE6: "500000",
    }),
    step("market", "Reading pools and prices", "done", {
      result: "11 of 12 tokens priced across 42 pools; 9 safety screens fresh.",
    }),
    step("dives", "Researching in depth", "running", {
      result: "1 of 2 themes researched.",
      chargedUsdcE6: "900000",
      ceilingUsdcE6: "2400000",
      startedAt: "2026-10-10T20:02:35.000Z",
    }),
    step("challenge", "Checking risk", "pending"),
    step("test", "Testing the plan against your limits", "pending"),
    step("plan", "Building a plan", "pending"),
    step("active", "Active", "pending"),
  ],
  outcome: {
    title: "Building the first plan",
    message: "Nothing is traded until you approve it.",
    action: "none",
  },
  startedAt: "2026-10-10T20:00:00.000Z",
  finishedAt: null,
  ...over,
});

describe("the activation panel (F-U10)", () => {
  it("shows every step with its state, result, cost against its ceiling and the running step's elapsed time", () => {
    render(<ActivationPanel view={view()} now={NOW} />);
    const panel = screen.getByTestId("activation-panel");
    expect(panel.dataset.status).toBe("running");
    expect(screen.getByTestId("activation-status")).toHaveTextContent("Activating");
    expect(panel).toHaveTextContent("Medium tier · Claude Sonnet 5.5");
    expect(screen.getByRole("meter", { name: "Cost against the ceiling" })).toHaveAttribute(
      "aria-valuetext",
      "1.11 of at most 3.80 USDC",
    );
    const steps = screen.getAllByTestId("activation-step");
    expect(steps.map((s) => `${s.dataset.step}:${s.dataset.state}`)).toEqual([
      "account:done",
      "scan:done",
      "market:done",
      "dives:running",
      "challenge:pending",
      "test:pending",
      "plan:pending",
      "active:pending",
    ]);
    expect(steps[0]).toHaveTextContent("free");
    expect(steps[1]).toHaveTextContent("3 themes worth a closer look.");
    expect(steps[1]).toHaveTextContent("0.21 of at most 0.50 USDC");
    expect(steps[3]).toHaveTextContent("running for 2 min 25 s");
    expect(within(steps[3] as HTMLElement).getByText(/running for/)).toHaveAttribute(
      "data-elapsed",
    );
    expect(steps[4]).toHaveTextContent("Checking risk: waiting");
    expect(screen.getByTestId("activation-outcome")).toHaveTextContent("Building the first plan");
  });

  it("shows a failed step's reason, the skipped steps after it, and what the owner can do", () => {
    render(
      <ActivationPanel
        view={view({
          status: "out_of_credits",
          chargedUsdcE6: "1110000",
          steps: [
            ...view().steps.slice(0, 3),
            step("dives", "Researching in depth", "failed", {
              reason: "the credits ran out",
              chargedUsdcE6: "900000",
              ceilingUsdcE6: "2400000",
            }),
            step("challenge", "Checking risk", "skipped"),
            step("test", "Testing the plan against your limits", "skipped"),
            step("plan", "Building a plan", "skipped"),
            step("active", "Active", "skipped"),
          ],
          outcome: {
            title: "The agent ran out of credits",
            message: "Add USDC to the funding address, then try again.",
            action: "add_credits",
          },
          finishedAt: "2026-10-10T20:04:00.000Z",
        })}
        now={NOW}
        actions={<button type="button">Try again</button>}
      />,
    );
    expect(screen.getByTestId("activation-status")).toHaveTextContent("Out of credits");
    const dives = screen.getAllByTestId("activation-step")[3] as HTMLElement;
    expect(dives.dataset.state).toBe("failed");
    expect(dives).toHaveTextContent("the credits ran out");
    expect(dives).toHaveTextContent("0.90 of at most 2.40 USDC");
    expect(screen.getByTestId("activation-outcome").dataset.action).toBe("add_credits");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByText(/running for/)).toBeNull();
  });

  it("lists the checks before a sweep, counts the blocking failures, and leaves the grant as a step to come", () => {
    render(
      <ActivationChecks
        tierLabel="Medium"
        ceilingUsdcE6="3800000"
        checks={[
          { code: "GOAL", ok: true, message: "Goal: Balanced on the Medium tier.", blocking: true },
          {
            code: "CREDITS",
            ok: false,
            message: "Credits are short: 3.00 USDC available.",
            blocking: true,
          },
          {
            code: "GRANT",
            ok: false,
            message: "Your wallet registers the trading permission when you turn trading on.",
            blocking: false,
          },
        ]}
      />,
    );
    const list = screen.getByRole("list", { name: "Before the sweep" });
    expect(
      within(list)
        .getAllByTestId("activation-check")
        .map((c) => c.dataset.ok),
    ).toEqual(["true", "false", "false"]);
    expect(screen.getByTestId("activation-checks")).toHaveTextContent("at most 3.80 USDC");
    expect(screen.getByTestId("activation-blocked")).toHaveTextContent(
      "One thing to do before turning trading on.",
    );
  });

  it("renders the status tag and the 2D art's pulse ring", () => {
    render(
      <>
        <ActivationStatusTag status="running" />
        <ActivationStatusTag status="active" />
        <SpeciesArt image={null} speciesName="Ant" tier="base" pulse />
        <SpeciesArt image={null} speciesName="Ant" tier="base" />
      </>,
    );
    const tags = screen.getAllByTestId("activation-status-tag");
    expect(tags.map((t) => t.textContent)).toEqual(["Activating", "Active"]);
    expect(screen.getAllByTestId("species-pulse")).toHaveLength(1);
    expect(elapsedText("2026-10-10T20:00:00.000Z", "2026-10-10T20:00:42.000Z")).toBe("42 s");
    expect(elapsedText("2026-10-10T20:00:00.000Z", "2026-10-10T20:03:05.000Z")).toBe("3 min 05 s");
    expect(elapsedText("2026-10-10T20:00:10.000Z", "2026-10-10T20:00:00.000Z")).toBe("0 s");
  });
});

describe("ActivationChecks with actions (UI-U1)", () => {
  it("puts the exact action beside each unmet item and lets a note replace the platform's line", () => {
    render(
      <ActivationChecks
        checks={[
          { code: "GOAL", ok: true, message: "Goal: Balanced on the Medium tier.", blocking: true },
          {
            code: "CREDITS",
            ok: false,
            message: "Credits are short: 3.00 USDC available.",
            blocking: true,
          },
          { code: "GRANT", ok: false, message: "The grant is a step to come.", blocking: false },
        ]}
        ceilingUsdcE6="3800000"
        tierLabel="Medium"
        notes={{ GRANT: "Your wallet registers it when you press Turn on automatic trading." }}
        actions={{
          GOAL: <a href="/goal">Set goal</a>,
          CREDITS: <button type="button">Add credits</button>,
          GRANT: <button type="button">Turn on automatic trading</button>,
        }}
      />,
    );
    const row = (code: string) => document.querySelector(`[data-check="${code}"]`) as HTMLElement;
    // A met item carries no action, even when one is offered for its code.
    expect(within(row("GOAL")).queryByRole("link")).toBeNull();
    expect(within(row("CREDITS")).getByRole("button", { name: "Add credits" })).toBeTruthy();
    expect(row("CREDITS").textContent).toContain("Credits are short");
    expect(row("GRANT").textContent).toContain("when you press Turn on automatic trading");
    expect(row("GRANT").textContent).not.toContain("a step to come");
    expect(
      within(row("GRANT")).getByRole("button", { name: "Turn on automatic trading" }),
    ).toBeTruthy();
  });
});
