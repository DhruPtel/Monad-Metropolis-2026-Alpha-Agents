import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  RUNTIME_STATUSES,
  RUNTIME_STATUS_RENDERING,
  RuntimeStatusBadge,
  TASK_STATUSES,
  TaskResult,
} from "./runtime";

describe("RuntimeStatusBadge", () => {
  it("renders every runtime status with its label and meaning", () => {
    for (const status of RUNTIME_STATUSES) {
      const { unmount } = render(<RuntimeStatusBadge status={status} />);
      const badge = screen.getByText(RUNTIME_STATUS_RENDERING[status].label);
      expect(badge.getAttribute("title")).toBe(RUNTIME_STATUS_RENDERING[status].meaning);
      expect(badge.getAttribute("data-runtime-status")).toBe(status);
      unmount();
    }
  });
});

describe("TaskResult", () => {
  it("shows the status and every field of a result", () => {
    render(
      <TaskResult
        title="No-op task"
        status="succeeded"
        fields={[
          { label: "Reply", value: "NOOP_OK" },
          { label: "Model calls", value: "1 of 1 succeeded" },
        ]}
      />,
    );
    expect(screen.getByText("Succeeded")).toBeTruthy();
    expect(screen.getByText("Reply").nextElementSibling?.textContent).toBe("NOOP_OK");
    expect(screen.getByText("Model calls").nextElementSibling?.textContent).toBe(
      "1 of 1 succeeded",
    );
    expect(screen.queryByTestId("task-error")).toBeNull();
  });

  it("says what is happening while queued or running, and shows a failure's words", () => {
    for (const status of TASK_STATUSES) {
      const { unmount, container } = render(
        <TaskResult
          title="No-op task"
          status={status}
          error={status === "failed" ? "Agent 1 is not provisioned" : null}
        />,
      );
      expect(container.querySelector("[data-task-status]")?.getAttribute("data-task-status")).toBe(
        status,
      );
      if (status === "queued") expect(screen.getByText("Waiting for a worker.")).toBeTruthy();
      if (status === "running") expect(screen.getByText(/Starting the sandbox/)).toBeTruthy();
      if (status === "failed")
        expect(screen.getByTestId("task-error").textContent).toBe("Agent 1 is not provisioned");
      unmount();
    }
  });
});
