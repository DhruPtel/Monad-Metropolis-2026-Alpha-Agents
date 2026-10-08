import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type HoldingAddress, HoldingsPanel } from "./holdings";

/** Agent 2 on testnet: 3 MON and 5 USDC sent to its token-bound account. */
const TESTNET: HoldingAddress[] = [
  {
    role: "funding",
    address: "0x45BB3eC560c7A19bbedad9cB42051401Ecc30d7B",
    lines: [
      { symbol: "MON", raw: 5n * 10n ** 17n, decimals: 18, use: "gas", status: "in_use" },
      { symbol: "USDC", raw: 10_000_000n, decimals: 6, use: "credits", status: "in_use" },
    ],
  },
  {
    role: "token_bound",
    address: "0x487ff500699226631e477F54eaeF41537a5eccAA",
    lines: [
      { symbol: "MON", raw: 3n * 10n ** 18n, decimals: 18, use: null, status: "movable" },
      { symbol: "USDC", raw: 5_000_000n, decimals: 6, use: null, status: "movable" },
    ],
  },
  { role: "personal_account", address: null, lines: [] },
];

describe("HoldingsPanel (D-315)", () => {
  it("names every address in plain words and what each balance does there", () => {
    render(<HoldingsPanel addresses={TESTNET} network="Monad Testnet" />);
    const funding = screen.getByTestId("holdings-funding");
    expect(within(funding).getByRole("heading", { name: "Funding address" })).toBeVisible();
    expect(within(funding).getByText("Gas")).toBeVisible();
    expect(within(funding).getByText("Credits")).toBeVisible();
    const tba = screen.getByTestId("holdings-token_bound");
    expect(within(tba).getByRole("heading", { name: "The agent's own account" })).toBeVisible();
    expect(
      within(tba).getByRole("list", { name: "The agent's own account balances" }),
    ).toHaveTextContent(/3\s*MON/);
    expect(
      within(tba).getAllByText("Does nothing here. You can move it to your wallet."),
    ).toHaveLength(2);
    expect(
      within(screen.getByTestId("holdings-personal_account")).getByText(/Not opened yet/),
    ).toBeVisible();
  });

  it("moves a stranded balance through the owner's own action", async () => {
    const onMove = vi.fn();
    render(<HoldingsPanel addresses={TESTNET} network="Monad Testnet" onMove={onMove} />);
    await userEvent.click(screen.getByRole("button", { name: "Move MON to my wallet" }));
    expect(onMove).toHaveBeenCalledWith("token_bound", "MON");
  });

  it("says a declined wallet request plainly and lets the owner try again", () => {
    const declined: HoldingAddress[] = TESTNET.map((a) =>
      a.role === "token_bound"
        ? {
            ...a,
            lines: a.lines.map((l) =>
              l.symbol === "MON"
                ? {
                    ...l,
                    move: {
                      state: "rejected" as const,
                      text: "You declined the request in your wallet.",
                    },
                  }
                : l,
            ),
          }
        : a,
    );
    render(<HoldingsPanel addresses={declined} network="Monad Testnet" onMove={() => undefined} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "You declined the request in your wallet.",
    );
    expect(screen.getByRole("button", { name: "Move MON to my wallet" })).toBeEnabled();
  });

  it("offers no move for what only the platform can move or nothing can, nor without an owner action", () => {
    const other: HoldingAddress[] = [
      {
        role: "funding",
        address: "0x45BB3eC560c7A19bbedad9cB42051401Ecc30d7B",
        lines: [{ symbol: "WMON", raw: 1n, decimals: 18, use: null, status: "platform_only" }],
      },
      {
        role: "personal_account",
        address: "0x88EF98439A62BADab65D14B0FE5442bba47FFDCb",
        lines: [{ symbol: "MON", raw: 1n, decimals: 18, use: null, status: "stuck" }],
      },
    ];
    render(<HoldingsPanel addresses={other} network="Monad Testnet" onMove={() => undefined} />);
    expect(screen.getByText("Does nothing here, and only the platform can move it.")).toBeVisible();
    expect(screen.getByText("Does nothing here, and nothing can move it.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Move/ })).toBeNull();
    const { container } = render(<HoldingsPanel addresses={TESTNET} network="Monad Testnet" />);
    for (const b of within(container).getAllByRole("button", { name: /Move/ }))
      expect(b).toBeDisabled();
  });

  it("keeps a finished move's outcome on its address after the balance has left", () => {
    const after: HoldingAddress[] = [
      {
        role: "token_bound",
        address: "0x487ff500699226631e477F54eaeF41537a5eccAA",
        lines: [],
        moved: [{ symbol: "MON", text: "Moved MON to your wallet.", hash: null }],
      },
    ];
    render(<HoldingsPanel addresses={after} network="Monad Testnet" />);
    const tba = screen.getByTestId("holdings-token_bound");
    expect(within(tba).getByText("Holds nothing.")).toBeVisible();
    expect(within(tba).getByTestId("wallet-action-status")).toHaveTextContent(
      "Moved MON to your wallet.",
    );
  });
});
