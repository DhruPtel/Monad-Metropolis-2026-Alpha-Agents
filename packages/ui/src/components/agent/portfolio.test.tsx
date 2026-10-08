import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ApprovalCard,
  ArmingCard,
  CapsPanel,
  PositionsPanel,
  type PositionsView,
  RecentTrades,
  WalletActionStatus,
  WhyNotTraded,
} from "./portfolio";

const POSITIONS: PositionsView = {
  usdc: 30_000_000n,
  wmon: 400n * 10n ** 18n,
  wmonValueUsdc: 10_000_000n,
  totalUsdc: 40_000_000n,
  usdcShareBps: 7_500,
  wmonShareBps: 2_500,
  mode: "NORMAL",
  drawdownBps: 120,
  peak7d: "1.0125",
  price: { monUsd: "0.0250", ageSeconds: 20, usable: true, reason: "OK" },
};

describe("portfolio components (P2-U7)", () => {
  it("shows positions with value, share, mode, drawdown, the 7-day peak and the price's age", () => {
    render(<PositionsPanel positions={POSITIONS} />);
    const panel = screen.getByTestId("positions");
    expect(panel.textContent).toContain("40.00");
    expect(panel.textContent).toContain("75.00%");
    expect(panel.textContent).toContain("25.00%");
    expect(panel.textContent).toContain("1.20%");
    expect(panel.textContent).toContain("1.0125");
    expect(panel.textContent).toContain("$0.0250");
    expect(panel.textContent).toContain("20s old");
    expect(within(panel).getByText("Normal")).toBeTruthy();
  });

  it("reads values as unknown, and names the oracle's reason, while the price is unavailable", () => {
    render(
      <PositionsPanel
        positions={{
          ...POSITIONS,
          wmonValueUsdc: null,
          totalUsdc: null,
          usdcShareBps: null,
          wmonShareBps: null,
          drawdownBps: null,
          mode: "PAUSED",
          price: { monUsd: null, ageSeconds: 900, usable: false, reason: "STALE" },
        }}
      />,
    );
    const panel = screen.getByTestId("positions");
    expect(panel.textContent).toContain("Unknown while the WMON price is unavailable");
    expect(panel.textContent).toContain("stale");
    expect(within(panel).getByText("Paused")).toBeTruthy();
  });

  it("shows the caps with room left, and names a wallet off the allowlist", () => {
    render(
      <CapsPanel
        caps={{
          personalCapUsdc: 100_000_000n,
          principalUsdc: 40_000_000n,
          platformCapUsdc: 2_000_000_000n,
          platformTotalUsdc: 250_000_000n,
          roomUsdc: 60_000_000n,
          allowlisted: false,
        }}
      />,
    );
    const caps = screen.getByTestId("caps");
    expect(caps.textContent).toContain("40.00 of 100.00 USDC");
    expect(caps.textContent).toContain("250.00 of 2,000.00 USDC");
    expect(caps.textContent).toContain("Room for up to 60.00");
    expect(caps.textContent).toContain("not on the beta allowlist");
  });

  it("gives the arming card's states, expiry, renewal reminder and why arming ended", () => {
    const { unmount } = render(
      <ArmingCard
        agentName="Alpha Agent #7"
        arming={{
          state: "armed",
          validUntilDate: "2026-10-09",
          renewalDue: true,
          endedMessage: null,
          fundingAddress: "0x9F8e2B1C0d3a4E5f60718293A4B5c6D7E8f90a1B",
        }}
        actions={<button type="button">Disarm</button>}
      />,
    );
    const card = screen.getByTestId("arming-card");
    expect(card.getAttribute("data-state")).toBe("armed");
    expect(card.textContent).toContain("2026-10-09");
    expect(card.textContent).toContain("renew to keep trading");
    expect(within(card).getByRole("button", { name: "Disarm" })).toBeTruthy();
    unmount();
    render(
      <ArmingCard
        agentName="Alpha Agent #7"
        arming={{
          state: "unarmed",
          validUntilDate: null,
          renewalDue: false,
          endedMessage: "The agent changed hands, which ends every trading permission.",
          fundingAddress: null,
        }}
      />,
    );
    expect(screen.getByTestId("arming-card").textContent).toContain(
      "Last arming ended: The agent changed hands",
    );
  });

  it("renders every financial field of the approval card from the intent", () => {
    render(
      <ApprovalCard
        approval={{
          intentId: "intent-x",
          account: "0x4d2C9a1B3e5F60718293a4b5C6d7e8F90a1b2C3d",
          chainName: "Monad (local fork)",
          chainId: 143143,
          sell: {
            asset: "USDC",
            token: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
            amount: 2_500_000n,
          },
          buy: { asset: "WMON", token: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A" },
          expectedOut: 99_900_000_000_000_000_000n,
          minOut: null,
          expiresAt: "2026-10-07T12:36:00.000Z",
          reason: "Add a little WMON.",
          arms: true,
        }}
      />,
    );
    const card = screen.getByTestId("approval-card");
    for (const text of [
      "Approve the first trade to arm",
      "2.50",
      "99.9",
      "the fresh quote less 0.5%",
      "2026-10-07 12:36 UTC",
      "Monad (local fork)",
      "143143",
      "Add a little WMON.",
    ])
      expect(card.textContent).toContain(text);
    expect(within(card).getByRole("button", { name: "Copy trading account" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Copy usdc token" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Copy wmon token" })).toBeTruthy();
  });

  it("lists recent trades with settlement and hash, and says where trades come from when there are none", () => {
    const { unmount } = render(
      <RecentTrades
        trades={[
          {
            intentId: "t1",
            status: "reconciled",
            sell: { asset: "USDC", amount: 1_000_000n },
            buy: "WMON",
            amountOut: 39_940_000_000_000_000_000n,
            txHash: `0x${"7d".repeat(32)}`,
            approvedBy: "auto",
            createdAt: "2026-10-07T11:58:00.000Z",
            settledAt: "2026-10-07T11:58:09.000Z",
          },
        ]}
      />,
    );
    const row = screen.getByRole("row", { name: /Settled/ });
    expect(row.textContent).toContain("39.94");
    expect(row.textContent).toContain("approved while armed");
    expect(row.textContent).toContain("7d7d");
    unmount();
    render(<RecentTrades trades={[]} />);
    expect(screen.getByTestId("recent-trades").textContent).toContain("No trades yet");
  });

  it("explains each blocked trade with how and when it clears", () => {
    render(
      <WhyNotTraded
        reasons={[
          {
            code: "DAILY_TRADE_LIMIT",
            clears: "by_waiting",
            clearsAt: "2026-10-08T09:15:00.000Z",
            hint: "The oldest trade leaves the window then.",
            at: "2026-10-07T12:18:00.000Z",
          },
          {
            code: "GAS_UNFUNDED",
            clears: "by_the_owner",
            clearsAt: null,
            hint: "Send a little MON.",
            at: "2026-10-07T12:12:00.000Z",
          },
        ]}
      />,
    );
    const why = screen.getByTestId("why-not-traded");
    expect(why.textContent).toContain("clears by waiting at 2026-10-08 09:15 UTC");
    expect(why.textContent).toContain("no MON to pay gas");
    expect(why.textContent).toContain("you can clear it");
  });

  it("announces a wallet action's state", () => {
    render(<WalletActionStatus state="waiting-wallet" text="Waiting for your wallet: Deposit." />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("data-state")).toBe("waiting-wallet");
    expect(status.textContent).toContain("Waiting for your wallet");
  });
});
