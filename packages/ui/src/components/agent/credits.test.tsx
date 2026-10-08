import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AddCreditsPanel, creditSplit, parseUsdc } from "./credits";
import { AllocationBar, AllocationChart, GasNotice } from "./portfolio";

const base = {
  agentName: "Alpha Agent #7",
  capUsdcE6: 50_000_000n,
  walletUsdcE6: 70_000_000n,
  onAmountChange: () => undefined,
  onAdd: () => undefined,
};

describe("add credits (Phase 2 tuning)", () => {
  it("splits like the platform: up to the cap is credited, the rest held", () => {
    expect(creditSplit(5_000_000n, 45_000_000n, 50_000_000n)).toEqual({
      room: 5_000_000n,
      credited: 5_000_000n,
      held: 0n,
    });
    expect(creditSplit(10_000_000n, 45_000_000n, 50_000_000n)).toEqual({
      room: 5_000_000n,
      credited: 5_000_000n,
      held: 5_000_000n,
    });
    expect(creditSplit(1n, 60_000_000n, 50_000_000n)).toEqual({ room: 0n, credited: 0n, held: 1n });
    expect(parseUsdc("2.5")).toBe(2_500_000n);
    expect(parseUsdc("1.0000001")).toBeNull();
  });

  it("shows the balance and room, and sends the amount", () => {
    const onAdd = vi.fn();
    render(<AddCreditsPanel {...base} creditsUsdcE6={4_994_400n} amountText="5" onAdd={onAdd} />);
    const panel = screen.getByTestId("add-credits");
    expect(panel.textContent).toContain("4.9944 of 50.00 USDC");
    expect(panel.textContent).toContain("Room for 45.0056 USDC more");
    expect(screen.queryByTestId("credit-cap-note")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add credits" }));
    expect(onAdd).toHaveBeenCalledWith(5_000_000n);
  });

  it("explains an amount over the cap as held, not lost", () => {
    render(<AddCreditsPanel {...base} creditsUsdcE6={45_000_000n} amountText="10" />);
    const note = screen.getByTestId("credit-cap-note");
    expect(note.textContent).toContain("5.00 USDC of this is above the 50.00 USDC credit cap");
    expect(note.textContent).toContain("not lost");
    expect(screen.getByRole("button", { name: "Add credits" })).toBeEnabled();
  });

  it("refuses more than the wallet holds, or no amount, before sending", () => {
    const { unmount } = render(
      <AddCreditsPanel {...base} creditsUsdcE6={0n} walletUsdcE6={2_000_000n} amountText="3" />,
    );
    expect(screen.getByText("Your wallet does not hold that much USDC.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add credits" })).toBeDisabled();
    unmount();
    render(<AddCreditsPanel {...base} creditsUsdcE6={0n} amountText="" />);
    expect(screen.getByRole("button", { name: "Add credits" })).toBeDisabled();
  });
});

describe("portfolio visuals (Phase 2 tuning)", () => {
  it("labels the allocation chart and bar with each share, and says when it is unknown", () => {
    const { unmount } = render(
      <AllocationChart usdcShareBps={7_500} wmonShareBps={2_500} totalUsdc={40_000_000n} />,
    );
    expect(
      screen.getByRole("img", { name: "Allocation by value: USDC 75.00%, WMON 25.00%" }),
    ).toBeTruthy();
    unmount();
    const { unmount: u2 } = render(
      <AllocationChart usdcShareBps={null} wmonShareBps={null} totalUsdc={null} />,
    );
    expect(screen.getByRole("img", { name: /unknown while the WMON price/ })).toBeTruthy();
    u2();
    render(<AllocationBar usdcShareBps={10_000} />);
    expect(
      screen.getByRole("img", { name: "Allocation by value: USDC 100.00%, WMON 0.00%" }),
    ).toBeTruthy();
  });

  it("warns when the wallet's MON is too low for gas", () => {
    const { unmount } = render(
      <GasNotice monWei={10n ** 18n} lowBelowWei={10n ** 16n} network="Monad" />,
    );
    expect(screen.getByTestId("gas-notice").dataset.low).toBe("false");
    unmount();
    render(<GasNotice monWei={10n ** 14n} lowBelowWei={10n ** 16n} network="Monad" />);
    expect(screen.getByRole("alert").textContent).toContain(
      "too little to arm, deposit or withdraw",
    );
  });
});
