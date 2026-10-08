import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ChoiceGroup } from "../ui/choice-group";
import {
  CostPreview,
  EffectiveLimits,
  GoalSaveStatus,
  GoalSummary,
  LimitField,
  bpsText,
  percentToBps,
} from "./goal";

const HARD = {
  maxTradeBps: 1_000,
  maxWmonShareBps: 4_000,
  minUsdcShareBps: 1_000,
  maxSlippageBps: 50,
  maxTradesPer24h: 20,
};

describe("goal components (P3-U1)", () => {
  it("ChoiceGroup is a labelled radio group: a click or an arrow key changes the choice", async () => {
    const onChange = vi.fn();
    function Controlled() {
      const [v, setV] = useState<"A" | "B" | "C">("A");
      return (
        <ChoiceGroup
          legend="Risk preset"
          hint="How much of the account may be in WMON."
          value={v}
          onValueChange={(next) => {
            onChange(next);
            setV(next);
          }}
          options={[
            { value: "A", title: "Conservative", description: "Up to 20% in WMON." },
            { value: "B", title: "Balanced", note: "Default" },
            { value: "C", title: "Growth", disabled: true, note: "Available later" },
          ]}
        />
      );
    }
    render(<Controlled />);
    const group = screen.getByRole("radiogroup", { name: "Risk preset" });
    expect(group).toHaveAccessibleDescription("How much of the account may be in WMON.");
    const a = within(group).getByRole("radio", { name: /Conservative/ });
    expect(a).toBeChecked();
    expect(a).toHaveAccessibleDescription("Up to 20% in WMON.");
    await userEvent.click(within(group).getByRole("radio", { name: /Balanced/ }));
    expect(onChange).toHaveBeenLastCalledWith("B");
    expect(within(group).getByRole("radio", { name: /Balanced/ })).toBeChecked();
    expect(within(group).getByRole("radio", { name: /Growth/ })).toBeDisabled();
  });

  it("reads percentages as basis points and shows them back", () => {
    expect(percentToBps("5")).toBe(500);
    expect(percentToBps("2.5")).toBe(250);
    expect(percentToBps("0.05")).toBe(5);
    for (const bad of ["", "abc", "1.234", "-1", "5%"]) expect(percentToBps(bad)).toBeNull();
    expect([bpsText(1_000), bpsText(250), bpsText(1_001), bpsText(5)]).toEqual([
      "10%",
      "2.5%",
      "10.01%",
      "0.05%",
    ]);
  });

  it("LimitField names its hard limit and which way is tighter, and shows an error", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <LimitField field="minUsdcShareBps" hard={1_000} valueText="" onChange={onChange} />,
    );
    const input = screen.getByLabelText("Least in USDC (%)");
    expect(input).toHaveAccessibleDescription(
      "The smallest share of the account the agent must keep in USDC. Hard limit 10%; yours can only be higher. Empty keeps the hard limit.",
    );
    await userEvent.type(input, "2");
    expect(onChange).toHaveBeenLastCalledWith("2");
    rerender(
      <LimitField
        field="maxTradesPer24h"
        hard={20}
        valueText="21"
        onChange={onChange}
        error="Most trades a day can only tighten the hard limit of 20; 21 would loosen it."
      />,
    );
    const trades = screen.getByLabelText("Most trades a day (trades)");
    expect(trades).toBeInvalid();
    expect(trades).toHaveAccessibleDescription(/would loosen it/);
  });

  it("EffectiveLimits shows the hard limit, the owner's and what applies", () => {
    render(
      <EffectiveLimits
        hard={HARD}
        owner={{
          maxTradeBps: 500,
          maxWmonShareBps: null,
          minUsdcShareBps: null,
          maxSlippageBps: null,
          maxTradesPer24h: 6,
        }}
        effective={{ ...HARD, maxTradeBps: 500, maxTradesPer24h: 6 }}
      />,
    );
    const table = within(screen.getByRole("region", { name: "Limits that apply" }));
    const trade = table.getByRole("row", { name: /Largest trade/ });
    expect(trade).toHaveTextContent(/10%.*5%.*5%/);
    expect(table.getByRole("row", { name: /Most in WMON/ })).toHaveTextContent(
      /40%.*Same as hard limit.*40%/,
    );
    expect(table.getByRole("row", { name: /Most trades a day/ })).toHaveTextContent(
      /20 trades.*6 trades.*6 trades/,
    );
  });

  it("EffectiveLimits never shows a refused value as the owner's", () => {
    render(
      <EffectiveLimits
        hard={HARD}
        owner={{
          maxTradeBps: 1_200,
          maxWmonShareBps: null,
          minUsdcShareBps: null,
          maxSlippageBps: null,
          maxTradesPer24h: null,
        }}
        refused={["maxTradeBps"]}
        effective={HARD}
      />,
    );
    const row = screen
      .getByTestId("effective-limits")
      .querySelector('tr[data-field="maxTradeBps"]');
    expect(row).toHaveTextContent(/10%.*Not accepted.*10%/);
    expect(row).not.toHaveTextContent("12%");
  });

  it("CostPreview gives a month's cost at each intensity and marks the chosen one (D-299)", () => {
    render(
      <CostPreview
        rows={[
          { intensity: "LIGHT", dailyBudgetUsdcE6: 1_000_000n },
          { intensity: "STANDARD", dailyBudgetUsdcE6: 2_500_000n },
          { intensity: "DEEP", dailyBudgetUsdcE6: 6_000_000n },
        ]}
        selected="LIGHT"
        days={30}
        sweepMaxUsdcE6={4_000_000n}
      />,
    );
    const region = screen.getByRole("region", { name: "What research costs" });
    const row = (i: string) => region.querySelector(`tr[data-intensity="${i}"]`);
    const light = row("LIGHT");
    expect(light).toHaveTextContent(/Light \(chosen\)/);
    expect(light).toHaveAttribute("aria-current", "true");
    expect(row("STANDARD")).not.toHaveAttribute("aria-current");
    expect(light).toHaveTextContent(/A Scan every 12 hours, up to 1 Dive a day/);
    expect(light).toHaveTextContent(/1\.00 USDC.*30\.00 USDC/);
    expect(row("STANDARD")).toHaveTextContent(/75\.00 USDC/);
    expect(row("DEEP")).toHaveTextContent(/180\.00 USDC/);
    expect(screen.getByTestId("cost-preview")).toHaveTextContent(/at most 4\.00 USDC/);
  });

  it("GoalSummary shows the state and the goal, or that there is none", () => {
    const { rerender } = render(
      <GoalSummary state="UNCONFIGURED" template={null} riskPreset={null} />,
    );
    expect(screen.getByTestId("goal-summary")).toHaveTextContent(
      /Not configured\s*No goal yet: set one to get the agent ready\./,
    );
    rerender(<GoalSummary state="READY" template="rebalance_bands@1" riskPreset="GROWTH" />);
    expect(screen.getByTestId("goal-summary")).toHaveTextContent(
      /Ready\s*Goal: Band rebalancer, Growth/,
    );
  });

  it("GoalSaveStatus says what happened, with each refused field's reason", () => {
    render(
      <GoalSaveStatus
        state="refused"
        text="The goal was not saved; fix the fields named below."
        reasons={["Largest trade can only tighten the hard limit of 10%; 10.01% would loosen it."]}
      />,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("data-state", "refused");
    expect(within(status).getByRole("listitem")).toHaveTextContent(/would loosen it/);
  });
});
