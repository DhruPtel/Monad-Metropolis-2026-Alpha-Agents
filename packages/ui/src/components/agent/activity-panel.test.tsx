import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { InfoList } from "../ui/info-list";
import { ActivityPanel, type ActivityRowView } from "./activity-panel";

const rows: ActivityRowView[] = [
  {
    id: "a",
    type: "Deposit",
    filter: "deposits",
    title: "Deposit into the vault",
    amount: "5 USDC",
    time: "2026-10-13 23:59",
    link: { href: "https://x/tx/1", label: "Transaction", external: true },
  },
  {
    id: "b",
    type: "Trade",
    filter: "trades",
    title: "Buy WMON",
    amount: "0.796 USDC",
    time: "2026-10-13 22:24",
    link: null,
  },
  {
    id: "c",
    type: "Research",
    filter: "research",
    title: "Activation research",
    amount: "0.79 USDC",
    time: "2026-10-13 22:10",
    link: null,
  },
];

describe("ActivityPanel and InfoList (2026-10-13)", () => {
  it("lists everything newest first and filters by tab", async () => {
    render(<ActivityPanel rows={rows} empty="Nothing yet." note="Owner only rows hidden." />);
    const types = () =>
      screen.getAllByTestId("activity-row").map((r) => r.getAttribute("data-type"));
    expect(types()).toEqual(["Deposit", "Trade", "Research"]);
    expect(screen.getByRole("link", { name: /Transaction/ })).toHaveAttribute(
      "href",
      "https://x/tx/1",
    );
    await userEvent.click(screen.getByTestId("activity-filter-trades"));
    expect(types()).toEqual(["Trade"]);
    await userEvent.click(screen.getByTestId("activity-filter-research"));
    expect(types()).toEqual(["Research"]);
    expect(screen.getByText("Owner only rows hidden.")).toBeInTheDocument();
  });

  it("InfoList lists label and value rows and at most two actions", () => {
    render(
      <InfoList
        testId="info"
        rows={[
          { label: "Lockup", value: "1 day" },
          { label: "Deposits", value: "Open" },
        ]}
        primary={<button type="button">Open deposits</button>}
      />,
    );
    expect(screen.getByTestId("info")).toHaveTextContent("Lockup1 dayDepositsOpenOpen deposits");
  });
});

describe("AccountValueChart with few readings (2026-10-13)", () => {
  it("lists the readings that exist and says more history builds", async () => {
    const { AccountValueChart } = await import("./vault-layout");
    const none = () => undefined;
    globalThis.ResizeObserver ??= class {
      observe = none;
      unobserve = none;
      disconnect = none;
    } as unknown as typeof ResizeObserver;
    render(
      <AccountValueChart
        series={[
          {
            at: "2026-10-14T00:11:02.496Z",
            perUnitE18: "1003566332028222239",
            valueUsdcE6: "7000000",
            reason: "interval",
          },
        ]}
        principalUsdcE6={null}
        fewText="More history builds as the vault runs."
      />,
    );
    expect(screen.getByTestId("account-chart-point")).toHaveTextContent(
      "2026-10-14 00:11 UTC7.00 USDC",
    );
    expect(screen.getByTestId("account-chart-few")).toHaveTextContent(
      "More history builds as the vault runs.",
    );
  });
});
