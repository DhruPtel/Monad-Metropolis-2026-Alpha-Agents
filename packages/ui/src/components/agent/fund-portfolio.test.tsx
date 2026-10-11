import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FundOverview, OlderAccountCard } from "./fund-portfolio";
import type { AssetRow } from "./window";

/**
 * The portfolio page's pieces on the fund agent's set (A-80): the account
 * at a glance across every held token, and the older v2 account with one
 * action that moves everything to the owner's wallet.
 */
const E18 = 10n ** 18n;
const row = (over: Partial<AssetRow> & { symbol: string }): AssetRow => ({
  decimals: 18,
  amountRaw: E18.toString(),
  isCash: false,
  valueUsdcE6: "10000000",
  shareBps: 1_000,
  costBasisUsdcE6: "9000000",
  gainUsdcE6: "1000000",
  gainBps: 1_111,
  ...over,
});
const ROWS = [
  row({
    symbol: "USDC",
    decimals: 6,
    amountRaw: "60000000",
    isCash: true,
    valueUsdcE6: "60000000",
    shareBps: 6_000,
    costBasisUsdcE6: "60000000",
    gainUsdcE6: null,
    gainBps: null,
  }),
  row({
    symbol: "WBTC",
    decimals: 8,
    amountRaw: "30000",
    valueUsdcE6: "30000000",
    shareBps: 3_000,
  }),
  row({ symbol: "WMON", valueUsdcE6: "10000000", shareBps: 1_000 }),
];

describe("the fund overview (A-80)", () => {
  it("shows the allocation across every token, the total, the mode, the drawdown and the prices' state", () => {
    render(
      <FundOverview
        rows={ROWS}
        totalValueUsdcE6="100000000"
        mode="NORMAL"
        drawdownBps={120}
        prices={{ priced: 3, held: 3, oldestAgeSeconds: 20 }}
      />,
    );
    const o = screen.getByTestId("portfolio-overview");
    expect(o).toHaveAttribute("data-custody", "v3");
    expect(
      within(o).getByRole("img", {
        name: "Allocation by value: USDC 60.00%, WBTC 30.00%, WMON 10.00%",
      }),
    ).toBeInTheDocument();
    expect(o).toHaveTextContent(/100\.00\s*USDC/);
    expect(o).toHaveTextContent("Normal");
    expect(o).toHaveTextContent("1.20%");
    expect(o).toHaveTextContent("Fresh, 20s old at most");
    expect(within(o).getByText("Tokens held").nextSibling).toHaveTextContent("3");
  });

  it("says when the total is unknown and which tokens have no price", () => {
    render(
      <FundOverview
        rows={[...ROWS, row({ symbol: "CHOG", valueUsdcE6: null, shareBps: null })]}
        totalValueUsdcE6={null}
        mode="REDUCE_ONLY"
        drawdownBps={null}
        prices={{ priced: 3, held: 4, oldestAgeSeconds: null }}
      />,
    );
    const o = screen.getByTestId("portfolio-overview");
    expect(o).toHaveTextContent("Unknown while a held token has no usable price");
    expect(o).toHaveTextContent("1 of 4 tokens unpriced");
    expect(o).toHaveTextContent("Reduce only");
  });
});

describe("the older account card (A-80)", () => {
  const lines = [
    { symbol: "USDC", decimals: 6, raw: 100_000_000n, claimableRaw: 0n },
    { symbol: "WMON", decimals: 18, raw: 0n, claimableRaw: 2n * E18 },
  ];

  it("names the account as older and not traded, lists what it holds, and offers one withdraw-all and a claim", () => {
    const onWithdrawAll = vi.fn();
    const onClaim = vi.fn();
    render(
      <OlderAccountCard
        account="0xF8322887Dd39EF54737b8Eb222d8F5b4D039B0e7"
        lines={lines}
        mode="NORMAL"
        busy={false}
        onWithdrawAll={onWithdrawAll}
        onClaim={onClaim}
      />,
    );
    const card = screen.getByTestId("older-account");
    expect(card).toHaveAttribute("data-state", "held");
    expect(card).toHaveTextContent("Not traded any more");
    expect(card).toHaveTextContent("0xF832…B0e7");
    const held = within(screen.getByTestId("older-account-lines"));
    expect(held.getByText("100")).toBeInTheDocument();
    expect(held.getAllByText("USDC").length).toBeGreaterThan(0);
    expect(held.getByText("Held for you to claim")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("older-account-withdraw-all"));
    expect(onWithdrawAll).toHaveBeenCalledTimes(1);
    fireEvent.click(held.getByRole("button", { name: "Claim WMON" }));
    expect(onClaim).toHaveBeenCalledWith("WMON");
  });

  it("waits while an action runs, and says when nothing is left", () => {
    const { rerender } = render(
      <OlderAccountCard
        account="0xF8322887Dd39EF54737b8Eb222d8F5b4D039B0e7"
        lines={lines}
        mode="NORMAL"
        busy
        onWithdrawAll={() => undefined}
      />,
    );
    expect(screen.getByTestId("older-account-withdraw-all")).toBeDisabled();
    rerender(
      <OlderAccountCard
        account="0xF8322887Dd39EF54737b8Eb222d8F5b4D039B0e7"
        lines={lines.map((l) => ({ ...l, raw: 0n, claimableRaw: 0n }))}
        mode={null}
        busy={false}
        onWithdrawAll={() => undefined}
      />,
    );
    expect(screen.getByTestId("older-account")).toHaveAttribute("data-state", "empty");
    expect(screen.getByTestId("older-account-empty")).toHaveTextContent("Nothing is left in it.");
    expect(screen.queryByTestId("older-account-withdraw-all")).not.toBeInTheDocument();
  });
});
