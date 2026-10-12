import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RevealMoment, countdownWords, rarityWords } from "./reveal-moment";

describe("the reveal moment (UI-U2)", () => {
  it("says the time left in whole seconds, then any moment, and something plain when unknown", () => {
    expect(countdownWords(12.2)).toBe("About 13 seconds to go.");
    expect(countdownWords(1)).toBe("About 1 second to go.");
    expect(countdownWords(0)).toBe("Any moment now.");
    expect(countdownWords(null)).toBe("The keeper reveals it soon.");
  });

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
    expect(screen.getByTestId("one-of-one")).toBeTruthy();
    expect(screen.getByText(/Pro: 200 of 1,000 agents/)).toBeTruthy();
  });

  it("while the chain has not drawn yet, shows the placeholder with the time left and no Reveal", () => {
    const { container } = render(
      <RevealMoment
        agentId={14n}
        speciesIndex={null}
        secondsLeft={9}
        seen={false}
        onSeen={() => undefined}
      />,
    );
    expect(container.querySelector("[data-slot=reveal-moment]")?.getAttribute("data-phase")).toBe(
      "waiting",
    );
    expect(screen.getByText("About 9 seconds to go.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reveal" })).toBeNull();
  });
});
