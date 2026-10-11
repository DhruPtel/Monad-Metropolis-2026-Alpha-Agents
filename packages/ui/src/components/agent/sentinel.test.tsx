import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SentinelCard, type SentinelView } from "./sentinel";

/** The sentinel card (P4-U2): calm, tightened with its actions and reasons, and not configured. */
const action = (
  over: Partial<SentinelView["actions"][number]> = {},
): SentinelView["actions"][number] => ({
  actionId: "s1",
  code: "DRAWDOWN_12",
  text: "the account fell 12% or more from its 7-day peak",
  action: "REDUCE_ONLY",
  state: null,
  reason: "12.5% below the 7-day peak",
  txHash: "0xa1",
  status: "done",
  at: "2026-10-11T12:30:00.000Z",
  ...over,
});

describe("the sentinel card", () => {
  it("says nothing is wrong, with the mode and the last look", () => {
    render(
      <SentinelCard
        view={{
          configured: true,
          active: {},
          lastCheckedAt: "2026-10-11T13:05:00.000Z",
          actions: [],
          mode: "NORMAL",
        }}
      />,
    );
    expect(screen.getByTestId("sentinel-card")).toHaveAttribute("data-state", "calm");
    expect(screen.getByText("Nothing wrong")).toBeInTheDocument();
    expect(screen.getByText("normal")).toBeInTheDocument();
    expect(screen.getByText(/Last look 2026-10-11 13:05 UTC/)).toBeInTheDocument();
    expect(screen.getByText("No action so far.")).toBeInTheDocument();
  });

  it("lists the conditions in force and each action with its reason, a failed or skipped one marked", () => {
    render(
      <SentinelCard
        view={{
          configured: true,
          active: { DRAWDOWN_12: "2026-10-11T12:30:00.000Z" },
          lastCheckedAt: null,
          actions: [
            action(),
            action({
              actionId: "s2",
              code: "STALE_FEED",
              text: "a held token's price feed is stale or unusable",
              status: "skipped",
              reason: "WBTC: 4000 s old",
              txHash: null,
            }),
            action({
              actionId: "s3",
              action: "INCIDENT",
              state: "INCIDENT",
              reason: "agent state RUNNING to INCIDENT",
            }),
          ],
          mode: "REDUCE_ONLY",
        }}
      />,
    );
    expect(screen.getByTestId("sentinel-card")).toHaveAttribute("data-state", "tightened");
    expect(screen.getByText("1 condition in force")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("sentinel-active")).getByText(
        /drawdown 12 since 2026-10-11 12:30 UTC/,
      ),
    ).toBeInTheDocument();
    const items = within(screen.getByTestId("sentinel-actions")).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Set the account to reduce-only");
    expect(items[0]).toHaveTextContent(
      "the account fell 12% or more from its 7-day peak: 12.5% below the 7-day peak.",
    );
    expect(items[1]).toHaveTextContent("nothing to tighten");
    expect(items[2]).toHaveTextContent("Marked an incident");
  });

  it("says when the sentinel is not running on the stack", () => {
    render(
      <SentinelCard
        view={{ configured: false, active: {}, lastCheckedAt: null, actions: [], mode: null }}
      />,
    );
    expect(screen.getByText("The sentinel is not running on this stack.")).toBeInTheDocument();
  });
});
