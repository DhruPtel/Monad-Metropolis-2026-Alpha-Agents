import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ResumeAccountPanel } from "./resume-account";

const REASON =
  "Paused on 2026-10-15 by the safety monitor: the WMON price feed failed. Buys are blocked until you resume; sells and withdrawals still work.";

describe("ResumeAccountPanel (2026-10-17)", () => {
  it("says why the account is tightened and offers Resume account to the owner", () => {
    const onResume = vi.fn();
    render(
      <ResumeAccountPanel
        reason={REASON}
        blocker={null}
        busy={false}
        status={null}
        onResume={onResume}
      />,
    );
    expect(screen.getByTestId("resume-account-reason")).toHaveTextContent(REASON);
    fireEvent.click(screen.getByRole("button", { name: "Resume account" }));
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("resume-account-blocker")).toBeNull();
  });

  it("shows the reason instead of the button when the wallet cannot resume it", () => {
    render(
      <ResumeAccountPanel
        reason={REASON}
        blocker="Connect the wallet that owns this agent to resume its account."
        busy={false}
        status={null}
        onResume={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Resume account" })).toBeNull();
    expect(screen.getByTestId("resume-account")).toHaveAttribute("data-blocked", "true");
    expect(screen.getByTestId("resume-account-blocker")).toHaveTextContent(
      "Connect the wallet that owns this agent",
    );
  });

  it("shows the wallet action's progress and disables the button meanwhile; compact keeps the reason off", () => {
    render(
      <ResumeAccountPanel
        reason={REASON}
        blocker={null}
        busy
        compact
        status={{ state: "confirming", text: "Waiting for the network.", hash: "0xabc" }}
        onResume={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Resume account" })).toBeDisabled();
    expect(screen.getByTestId("wallet-action-status")).toHaveTextContent(
      "Waiting for the network.",
    );
    expect(screen.queryByTestId("resume-account-reason")).toBeNull();
  });
});
