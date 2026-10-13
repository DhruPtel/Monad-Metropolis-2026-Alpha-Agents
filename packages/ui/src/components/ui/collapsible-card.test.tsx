import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CollapsibleCard } from "./collapsible-card";

describe("CollapsibleCard (2026-10-13)", () => {
  it("folds to its full-size title and current value, and opens on a click", async () => {
    render(
      <CollapsibleCard title="Positions" value="Up to 8" testId="c">
        <p>Inside</p>
      </CollapsibleCard>,
    );
    const card = screen.getByTestId("c");
    expect(card).toHaveClass("bg-surface", "border", "p-5");
    expect(screen.getByRole("heading", { name: "Positions" })).toHaveClass(
      "text-base",
      "font-semibold",
    );
    expect(screen.getByTestId("collapsible-card-value")).toHaveTextContent("Up to 8");
    expect(card).not.toHaveAttribute("open");
    await userEvent.click(screen.getByText("Positions"));
    expect(card).toHaveAttribute("open");
  });
});
