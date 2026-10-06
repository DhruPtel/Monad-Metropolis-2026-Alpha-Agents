import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ActivityFeed,
  TOOL_CALL_RENDERING,
  TOOL_CALL_STATUSES,
  ToolCallStatusBadge,
} from "./activity";

describe("ToolCallStatusBadge", () => {
  it("renders every status with its meaning, and the code when there is one", () => {
    for (const status of TOOL_CALL_STATUSES) {
      const { unmount } = render(<ToolCallStatusBadge status={status} />);
      const badge = screen.getByText(TOOL_CALL_RENDERING[status].label);
      expect(badge.getAttribute("title")).toBe(TOOL_CALL_RENDERING[status].meaning);
      expect(badge.getAttribute("data-tool-status")).toBe(status);
      unmount();
    }
    render(<ToolCallStatusBadge status="refused" code="PRIVATE_ADDRESS" />);
    expect(screen.getByText("Refused").getAttribute("title")).toBe(
      "Refused before it ran; not charged (PRIVATE_ADDRESS)",
    );
  });
});

describe("ActivityFeed", () => {
  it("lists entries in order with a fixed UTC time and who wrote them", () => {
    render(
      <ActivityFeed
        label="Activity of Alpha Agent #1"
        entries={[
          {
            entryId: "a2",
            text: "Alpha Agent #1 read 1 page.",
            at: "2026-10-06T16:30:12.000Z",
            renderedBy: "template",
          },
          {
            entryId: "a1",
            text: "Alpha Agent #1 ran 2 web searches.",
            at: "2026-10-06T16:27:00.000Z",
            renderedBy: "narrator",
          },
        ]}
      />,
    );
    const list = screen.getByRole("list", { name: "Activity of Alpha Agent #1" });
    const items = list.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("Alpha Agent #1 read 1 page.");
    expect(items[0]?.textContent).toContain("2026-10-06 16:30 UTC");
    expect(items[0]?.textContent).toContain("Template");
    expect(items[1]?.textContent).toContain("Narrator");
  });

  it("says when there is nothing yet", () => {
    render(<ActivityFeed label="Activity" entries={[]} empty="No Scans yet." />);
    expect(screen.getByTestId("activity-empty").textContent).toBe("No Scans yet.");
  });
});
