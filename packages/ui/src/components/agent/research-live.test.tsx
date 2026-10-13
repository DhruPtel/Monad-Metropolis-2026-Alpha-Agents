import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NextResearchStrip, ResearchBranchChart } from "./research-live";

describe("NextResearchStrip and ResearchBranchChart (2026-10-13)", () => {
  it("says when research is next due, with the owner's action", () => {
    render(
      <NextResearchStrip
        line="Scheduled research is off."
        action={<button>Research now</button>}
      />,
    );
    expect(screen.getByTestId("next-research")).toHaveTextContent(
      "Scheduled research is off.Research now",
    );
  });

  it("draws a line per stage and source with a sub-branch per call, labeled, and its count", () => {
    render(
      <ResearchBranchChart
        art={null}
        empty="none"
        branches={[
          {
            id: "s",
            label: "Scan",
            kind: "stage",
            calls: [
              { id: "a", label: "Reading the market snapshot" },
              { id: "b", label: "Listing the registry's tokens" },
            ],
          },
          {
            id: "m",
            label: "Market data",
            kind: "source",
            calls: [{ id: "a2", label: "Reading the market snapshot" }],
          },
        ]}
      />,
    );
    const lines = screen.getAllByTestId("branch");
    expect(lines.map((l) => [l.getAttribute("data-kind"), l.getAttribute("data-calls")])).toEqual([
      ["stage", "2"],
      ["source", "1"],
    ]);
    expect(screen.getAllByTestId("branch-call")).toHaveLength(3);
    expect(screen.getAllByLabelText("Reading the market snapshot")).toHaveLength(2);
    expect(screen.getByRole("img")).toHaveAccessibleName(
      "The run's branches: Scan 2, Market data 1",
    );
  });

  it("says so when the run has no calls", () => {
    render(<ResearchBranchChart art={null} empty="No calls recorded." branches={[]} />);
    expect(screen.getByText("No calls recorded.")).toBeInTheDocument();
  });
});
