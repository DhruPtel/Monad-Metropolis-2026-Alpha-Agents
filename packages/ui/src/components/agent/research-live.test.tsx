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

describe("the live run's parts (2026-10-13)", () => {
  it("RunStatusStrip says where the run stands; the branch chart's lines and calls are clickable", async () => {
    const { RunStatusStrip } = await import("./research-live");
    const { default: userEvent } = await import("@testing-library/user-event");
    render(
      <RunStatusStrip
        state="running"
        line="Running: Scan: starting"
        detail="0:12 · 0.01 of at most 1.75 USDC"
      />,
    );
    expect(screen.getByTestId("run-status")).toHaveAttribute("data-state", "running");
    expect(screen.getByTestId("run-status")).toHaveTextContent(
      "Running: Scan: starting0:12 · 0.01 of at most 1.75 USDC",
    );
    const picked: string[] = [];
    render(
      <ResearchBranchChart
        art={null}
        empty="none"
        onSelectBranch={(id) => picked.push(`branch ${id}`)}
        onSelectCall={(id) => picked.push(`call ${id}`)}
        branches={[
          {
            id: "stage-SCAN",
            label: "Scan",
            kind: "stage",
            calls: [{ id: "c-1", label: "Reading the market" }],
          },
        ]}
      />,
    );
    await userEvent.click(screen.getByTestId("branch-line"));
    await userEvent.click(screen.getByTestId("branch-call"));
    expect(picked).toEqual(["branch stage-SCAN", "call c-1"]);
  });
});

describe("SkillCatalog and SkillDetailPanel (2026-10-13)", () => {
  it("filters cards by category, marks the equipped one, and opens a skill's detail", async () => {
    const { SkillCatalog, SkillDetailPanel } = await import("./skill-loadout");
    const { default: userEvent } = await import("@testing-library/user-event");
    const cards = [
      {
        id: "a",
        name: "Token risk screen",
        publisher: "Vivarium",
        verified: true,
        category: "Research" as const,
        description: "Reads a screen.",
        version: "1.0.0",
        tools: ["safety screen"],
        stage: "Dive",
      },
      {
        id: "b",
        name: "Portfolio construction",
        publisher: "Vivarium",
        verified: true,
        category: "Strategy" as const,
        description: "Drafts weights.",
        version: "1.0.2",
        tools: [],
        stage: "Zoom out",
      },
    ];
    const picked: string[] = [];
    render(
      <SkillCatalog
        skills={cards}
        slotOf={{ b: 0 }}
        selected={null}
        onSelect={(id) => picked.push(id)}
      />,
    );
    expect(screen.getAllByTestId("skill-card")).toHaveLength(2);
    expect(screen.getAllByTestId("skill-card")[1]).toHaveTextContent("Equipped");
    expect(screen.getAllByTestId("skill-card")[0]).toHaveTextContent("Free");
    await userEvent.click(screen.getByTestId("skill-filter-Strategy"));
    expect(screen.getAllByTestId("skill-card").map((c) => c.getAttribute("data-skill"))).toEqual([
      "b",
    ]);
    await userEvent.click(screen.getByTestId("skill-card"));
    expect(picked).toEqual(["b"]);
    const toggled: string[] = [];
    render(
      <SkillDetailPanel
        skill={cards[0] as never}
        equippedSlot={null}
        canEquip
        onToggle={() => toggled.push("a")}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByTestId("skill-detail")).toHaveTextContent("Used inDive");
    await userEvent.click(screen.getByTestId("skill-detail-toggle"));
    expect(toggled).toEqual(["a"]);
  });
});

describe("SkillCatalog pages (2026-10-13)", () => {
  it("shows two columns of six per page with Previous, Next and the page count", async () => {
    const { SkillCatalog } = await import("./skill-loadout");
    const { default: userEvent } = await import("@testing-library/user-event");
    const cards = Array.from({ length: 14 }, (_, i) => ({
      id: `s${i}`,
      name: `Skill ${i}`,
      publisher: "Vivarium",
      verified: true,
      category: (i < 10 ? "Research" : "Protocol") as "Research" | "Protocol",
      description: "Does a thing.",
      version: "1.0.0",
      tools: [],
      stage: null,
    }));
    render(<SkillCatalog skills={cards} slotOf={{}} selected={null} onSelect={() => undefined} />);
    expect(screen.getByTestId("skill-grid")).toHaveClass("grid-cols-2");
    expect(screen.getAllByTestId("skill-card")).toHaveLength(6);
    expect(screen.getByTestId("skill-pages")).toHaveTextContent("Page 1 of 3");
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByTestId("skill-pages")).toHaveTextContent("Page 3 of 3");
    expect(screen.getAllByTestId("skill-card")).toHaveLength(2);
    // A filter starts again at its first page.
    await userEvent.click(screen.getByTestId("skill-filter-Protocol"));
    expect(screen.getAllByTestId("skill-card")).toHaveLength(4);
    expect(screen.queryByTestId("skill-pages")).toBeNull();
  });
});
