import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ContributeCreditsPanel,
  VaultCreateCard,
  VaultDepositForm,
  VaultPanel,
  type VaultPanelView,
  VaultPositionCard,
  VaultWithdrawForm,
  depositsWords,
  lockWords,
  lockupWords,
  parseShares,
} from "./vault";

/**
 * The vault's pieces (P7-U4): the vault at a glance with its notices, a
 * holder's position with the lock in plain words, the deposit form's blocker
 * and top-up warning, the withdrawal form's two ways out, the contribution
 * panel's words and split, and the create card for the owner and for a visitor.
 */
const E18 = 10n ** 18n;
const NOW = 1_791_374_400;
/** WMON on Monad, the token of the claimable credit in these tests. */
const WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";
const panel: VaultPanelView = {
  vault: "0x00000000000000000000000000000000000a0170",
  mode: "NORMAL",
  inHandover: false,
  windDownAt: 0,
  depositsOpen: true,
  depositsClosed: false,
  navUsdcE6: "82000000",
  totalSupply: (80n * E18).toString(),
  perUnitE18: "1025000000000000000",
  lockupSeconds: 86_400,
  leaderStakeBps: 2_500,
  leaderMinBps: 500,
  feeBps: 0,
  principalUsdcE6: "80000000",
  vaultCapUsdcE6: "500000000",
  allowlistEnabled: true,
  depositsEnabled: false,
  handoverPeriodSeconds: 259_200,
  asOf: NOW,
};

describe("the words", () => {
  it("say the lockup and the lock plainly", () => {
    expect(lockupWords(86_400)).toBe("1 day");
    expect(lockupWords(7 * 86_400)).toBe("7 days");
    expect(lockupWords(36 * 3_600)).toBe("36 hours");
    expect(lockWords(NOW - 1, NOW)).toBe("Free to withdraw");
    expect(lockWords(NOW + 3_600, NOW)).toBe("Locked until 2026-10-07 13:00 UTC (1 hour left)");
  });

  it("say what deposits are doing, the strictest reason first", () => {
    expect(depositsWords(panel)).toBe("Open to allowlisted wallets (beta)");
    expect(depositsWords({ ...panel, allowlistEnabled: false, depositsEnabled: true })).toBe(
      "Open",
    );
    expect(depositsWords({ ...panel, depositsOpen: false })).toContain("Not open yet");
    expect(depositsWords({ ...panel, depositsClosed: true })).toBe("Closed by a tightener");
    expect(depositsWords({ ...panel, mode: "PAUSED" })).toBe("Closed while paused");
    expect(depositsWords({ ...panel, windDownAt: NOW })).toContain("winding down");
    expect(depositsWords({ ...panel, inHandover: true, mode: "HANDOVER" })).toBe(
      "Closed during the handover",
    );
  });

  it("parse shares with up to 18 decimals", () => {
    expect(parseShares("1.5")).toBe(15n * 10n ** 17n);
    expect(parseShares("0")).toBe(0n);
    expect(parseShares("1.2345678901234567891")).toBeNull();
    expect(parseShares("abc")).toBeNull();
  });
});

describe("VaultPanel", () => {
  it("shows the value, the share value, the lockup, the leader's stake, the cap room and the beta label", () => {
    render(<VaultPanel v={panel} />);
    const p = screen.getByTestId("vault-panel");
    expect(p).toHaveAttribute("data-mode", "NORMAL");
    expect(within(p).getByTestId("vault-value")).toHaveTextContent("82.00");
    expect(within(p).getByTestId("vault-share-value")).toHaveTextContent("1.0250 USDC");
    expect(within(p).getByTestId("vault-lockup")).toHaveTextContent("1 day");
    expect(within(p).getByTestId("vault-leader-stake")).toHaveTextContent(
      "25% of the vault (at least 5% required)",
    );
    expect(within(p).getByTestId("vault-cap")).toHaveTextContent("420.00 of 500.00 USDC");
    expect(within(p).getByTestId("vault-fee")).toHaveTextContent("None");
    expect(
      within(p).getByText("Unaudited beta: allowlisted wallets, small caps"),
    ).toBeInTheDocument();
    expect(within(p).queryByRole("status")).toBeNull();
  });

  it("names the handover, the wind-down and a pause as notices", () => {
    const { rerender } = render(
      <VaultPanel v={{ ...panel, inHandover: true, mode: "HANDOVER" }} />,
    );
    expect(screen.getByTestId("vault-notice-handover")).toHaveTextContent("stakes at least 5%");
    rerender(<VaultPanel v={{ ...panel, windDownAt: NOW, mode: "WIND_DOWN" }} />);
    expect(screen.getByTestId("vault-notice-wind-down")).toHaveTextContent("nothing is locked");
    rerender(<VaultPanel v={{ ...panel, mode: "PAUSED" }} />);
    expect(screen.getByTestId("vault-notice-paused")).toHaveTextContent("Withdrawals always work");
    rerender(<VaultPanel v={{ ...panel, navUsdcE6: null, perUnitE18: null }} />);
    expect(screen.getByTestId("vault-value")).toHaveTextContent(
      "Unknown while a held token has no usable price",
    );
  });
});

describe("VaultPositionCard", () => {
  const inKind = [
    { symbol: "USDC", decimals: 6, amountRaw: "15750000" },
    { symbol: "WMON", decimals: 18, amountRaw: (600n * E18).toString() },
  ];
  it("shows a locked position with its in-kind slices", () => {
    render(
      <VaultPositionCard
        shares={(30n * E18).toString()}
        valueUsdcE6="30592500"
        unlockAt={NOW + 7_200}
        now={NOW}
        inKind={inKind}
        claimables={[]}
        isLeader={false}
      />,
    );
    const c = screen.getByTestId("vault-position");
    expect(c).toHaveAttribute("data-state", "locked");
    expect(within(c).getByTestId("vault-lock")).toHaveTextContent(
      "Locked until 2026-10-07 14:00 UTC (2 hours left)",
    );
    expect(within(c).getByTestId("vault-in-kind")).toHaveTextContent("600 WMON");
    expect(within(c).getByText("30 shares")).toBeInTheDocument();
  });

  it("is free after the lock, offers each claimable credit, and marks the leader", () => {
    const onClaim = vi.fn();
    render(
      <VaultPositionCard
        shares={(20n * E18).toString()}
        valueUsdcE6="20000000"
        unlockAt={NOW - 1}
        now={NOW}
        inKind={null}
        claimables={[
          {
            token: WMON,
            symbol: "WMON",
            decimals: 18,
            amountRaw: (3n * E18).toString(),
          },
        ]}
        isLeader
        onClaim={onClaim}
      />,
    );
    const c = screen.getByTestId("vault-position");
    expect(c).toHaveAttribute("data-state", "free");
    expect(within(c).getByText("Leader: your deposits are the stake")).toBeInTheDocument();
    fireEvent.click(within(c).getByRole("button", { name: "Claim WMON" }));
    expect(onClaim).toHaveBeenCalledWith(WMON);
  });

  it("says when there is nothing", () => {
    render(
      <VaultPositionCard
        shares="0"
        valueUsdcE6={null}
        unlockAt={0}
        now={NOW}
        inKind={null}
        claimables={[]}
        isLeader={false}
      />,
    );
    expect(screen.getByTestId("vault-position")).toHaveAttribute("data-state", "none");
    expect(screen.getByText("You hold no shares of this vault.")).toBeInTheDocument();
  });
});

describe("VaultDepositForm", () => {
  const base = {
    onAmountChange: vi.fn(),
    onDeposit: vi.fn(),
    walletUsdcE6: "120000000",
    maxUsdcE6: "300000000",
    lockupSeconds: 86_400,
    isLeader: false,
    spreadBps: 50,
    topUpWarning: null,
    previewShares: (24n * E18).toString(),
    lockUntil: NOW + 86_400,
  };
  it("blocks before anything is sent and says why", () => {
    render(
      <VaultDepositForm
        {...base}
        amountText="25"
        block="Your wallet is not on the beta deposit allowlist."
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("not on the beta deposit allowlist");
    expect(screen.getByTestId("vault-deposit-submit")).toBeDisabled();
  });

  it("warns before a top-up extends the lock, previews the shares and submits the amount", () => {
    const onDeposit = vi.fn();
    render(
      <VaultDepositForm
        {...base}
        onDeposit={onDeposit}
        amountText="25"
        block={null}
        topUpWarning="You already hold shares. This deposit locks all of them until 2026-10-08 12:00 UTC."
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("locks all of them");
    expect(screen.getByText(/you would receive about/)).toHaveTextContent("24 shares");
    fireEvent.click(screen.getByTestId("vault-deposit-submit"));
    expect(onDeposit).toHaveBeenCalledWith(25_000_000n);
  });

  it("refuses more than the wallet holds or the vault takes", () => {
    const { rerender } = render(<VaultDepositForm {...base} amountText="121" block={null} />);
    expect(screen.getByText("Your wallet does not hold that much USDC.")).toBeInTheDocument();
    rerender(<VaultDepositForm {...base} walletUsdcE6="900000000" amountText="301" block={null} />);
    expect(
      screen.getByText("The vault can take at most 300.00 USDC from you now."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("vault-deposit-submit")).toBeDisabled();
  });
});

describe("VaultWithdrawForm", () => {
  const base = {
    onMethodChange: vi.fn(),
    onSharesChange: vi.fn(),
    freeShares: (30n * E18).toString(),
    heldShares: (30n * E18).toString(),
    previewUsdcE6: "30592500",
    previewInKind: [
      { symbol: "USDC", decimals: 6, amountRaw: "15750000" },
      { symbol: "WMON", decimals: 18, amountRaw: (600n * E18).toString() },
    ],
    usdcAvailableE6: "33800000",
    block: null,
    spreadBps: 50,
    onWithdraw: vi.fn(),
  };
  it("pays USDC or in kind, previewing each, and submits the shares with the method", () => {
    const onWithdraw = vi.fn();
    const { rerender } = render(
      <VaultWithdrawForm {...base} method="usdc" sharesText="30" onWithdraw={onWithdraw} />,
    );
    expect(screen.getByTestId("vault-withdraw-form")).toHaveAttribute("data-method", "usdc");
    expect(screen.getByTestId("vault-withdraw-preview")).toHaveTextContent("about 30.59 USDC");
    fireEvent.click(screen.getByTestId("vault-withdraw-submit"));
    expect(onWithdraw).toHaveBeenCalledWith(30n * E18, "usdc");
    rerender(
      <VaultWithdrawForm {...base} method="in_kind" sharesText="30" onWithdraw={onWithdraw} />,
    );
    expect(screen.getByTestId("vault-withdraw-preview")).toHaveTextContent("15.75 USDC, 600 WMON");
    fireEvent.click(screen.getByRole("button", { name: "Redeem in kind" }));
    expect(onWithdraw).toHaveBeenLastCalledWith(30n * E18, "in_kind");
  });

  it("points to the in-kind path when the vault's USDC cannot cover the exit, and blocks while locked", () => {
    const { rerender } = render(
      <VaultWithdrawForm {...base} method="usdc" sharesText="30" usdcAvailableE6="10000000" />,
    );
    expect(screen.getByText(/Redeem in kind instead/)).toBeInTheDocument();
    expect(screen.getByTestId("vault-withdraw-submit")).toBeDisabled();
    rerender(
      <VaultWithdrawForm
        {...base}
        method="usdc"
        sharesText="30"
        freeShares="0"
        block="Your shares are locked until 2026-10-08 12:00 UTC."
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("locked until");
    expect(screen.getByTestId("vault-withdraw-submit")).toBeDisabled();
  });
});

describe("ContributeCreditsPanel", () => {
  it("calls the contribution what it is, splits it against the cap, and sends the amount", () => {
    const onFund = vi.fn();
    render(
      <ContributeCreditsPanel
        agentName="Agent #7"
        creditsUsdcE6={45_000_000n}
        capUsdcE6={50_000_000n}
        walletUsdcE6={120_000_000n}
        amountText="8"
        onAmountChange={vi.fn()}
        onFund={onFund}
      />,
    );
    const p = screen.getByTestId("fund-agent");
    expect(p).toHaveTextContent("contribution to Agent #7's credits");
    expect(p).toHaveTextContent("not a deposit into the vault and buys no shares");
    expect(p).toHaveTextContent("5.00 would be credited and 3.00 held above the cap");
    fireEvent.click(screen.getByTestId("fund-agent-submit"));
    expect(onFund).toHaveBeenCalledWith(8_000_000n);
  });
});

describe("VaultCreateCard", () => {
  it("lets the owner create the vault and tells a visitor there is none yet", () => {
    const onCreate = vi.fn();
    const { rerender } = render(
      <VaultCreateCard
        agentName="Agent #7"
        predictedVault="0x00000000000000000000000000000000000a0170"
        isOwner
        lockupSeconds={86_400}
        leaderMinBps={500}
        vaultCapUsdcE6="500000000"
        onCreate={onCreate}
      />,
    );
    expect(screen.getByTestId("vault-create")).toHaveAttribute("data-role", "owner");
    expect(screen.getByText(/at most 500.00 USDC during the beta/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("vault-create-submit"));
    expect(onCreate).toHaveBeenCalled();
    rerender(
      <VaultCreateCard
        agentName="Agent #7"
        predictedVault="0x00000000000000000000000000000000000a0170"
        isOwner={false}
        lockupSeconds={86_400}
        leaderMinBps={500}
        vaultCapUsdcE6="500000000"
      />,
    );
    expect(screen.getByTestId("vault-create")).toHaveAttribute("data-role", "visitor");
    expect(screen.queryByTestId("vault-create-submit")).toBeNull();
    expect(screen.getByText(/fund the agent's credits below/)).toBeInTheDocument();
  });
});
