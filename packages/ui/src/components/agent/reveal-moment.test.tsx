import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RevealMoment, rarityWords } from "./reveal-moment";

describe("the reveal moment (UI-U2)", () => {
  it("says what a draw means: the tier's share of the supply and the species' count, one-of-ones as the only one", () => {
    const ant = rarityWords(3);
    expect(ant).toMatchObject({ tier: "base", name: "Ant", oneOfOne: false });
    expect(ant.tierLine).toBe("Base: 500 of 1,000 agents (50%)");
    expect(ant.speciesLine).toBe("One of 83 ant agents in the whole supply.");
    const mantis = rarityWords(15);
    expect(mantis).toMatchObject({ tier: "pro", name: "Praying mantis", oneOfOne: true });
    expect(mantis.tierLine).toBe("Pro: 200 of 1,000 agents (20%)");
    expect(mantis.speciesLine).toMatch(/^One of one/);
  });

  it("hides the result until Reveal is clicked, then shows the real art with the rarity and tells the app it was seen", async () => {
    const onSeen = vi.fn();
    const { container, rerender } = render(
      <RevealMoment agentId={14n} speciesIndex={14} seen={false} onSeen={onSeen} durationMs={0} />,
    );
    const root = container.querySelector("[data-slot=reveal-moment]");
    expect(root?.getAttribute("data-phase")).toBe("ready");
    expect(screen.getByRole("img", { name: "Unrevealed agent" })).toBeTruthy();
    expect(screen.queryByText("Bee")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Reveal" }));
    expect(onSeen).toHaveBeenCalledTimes(1);
    rerender(<RevealMoment agentId={14n} speciesIndex={14} seen onSeen={onSeen} durationMs={0} />);
    expect(root?.getAttribute("data-phase")).toBe("revealed");
    expect(screen.getByRole("img", { name: "Bee agent" })).toBeTruthy();
    expect(screen.getByText("Bee")).toBeTruthy();
    // 2026-10-13: no "1 of 1" badge; the species line still says it is the only one.
    expect(screen.queryByTestId("one-of-one")).toBeNull();
    expect(screen.getByText(/Pro: 200 of 1,000 agents/)).toBeTruthy();
  });

  it("offers Reveal from the moment the agent is minted, with the chain's status and no timer", () => {
    const { container } = render(
      <RevealMoment
        agentId={14n}
        speciesIndex={null}
        waitingNote="Randomness requested from Pyth Entropy; waiting for the number."
        seen={false}
        onSeen={() => undefined}
      />,
    );
    expect(container.querySelector("[data-slot=reveal-moment]")?.getAttribute("data-phase")).toBe(
      "waiting",
    );
    expect(screen.getByTestId("reveal-status")).toHaveTextContent(/waiting for the number/);
    expect(screen.getByRole("button", { name: "Reveal" })).toBeEnabled();
    expect(container.textContent).not.toMatch(/seconds? to go/);
  });

  it("clicked before the draw, waits armed and plays the moment as soon as the species lands", async () => {
    const onSeen = vi.fn();
    const { container, rerender } = render(
      <RevealMoment
        agentId={14n}
        speciesIndex={null}
        seen={false}
        onSeen={onSeen}
        durationMs={0}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Reveal" }));
    const root = container.querySelector("[data-slot=reveal-moment]");
    expect(root?.getAttribute("data-phase")).toBe("armed");
    expect(screen.getByRole("button", { name: "Waiting for the draw" })).toBeDisabled();
    expect(onSeen).not.toHaveBeenCalled();
    rerender(
      <RevealMoment agentId={14n} speciesIndex={14} seen={false} onSeen={onSeen} durationMs={0} />,
    );
    expect(onSeen).toHaveBeenCalledTimes(1);
  });
});
