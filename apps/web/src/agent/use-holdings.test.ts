import { describe, expect, it } from "vitest";
import type { HoldingsJson } from "@/api/client";
import { holdingAddresses, moveFailure } from "./use-holdings";
import { runWalletSteps, walletTxText } from "./wallet-tx";

const TBA = "0x487ff500699226631e477F54eaeF41537a5eccAA" as const;
const JSON_2: HoldingsJson = {
  agentId: 2,
  owner: "0x683eE842A16f85e69883F433745263BFe8D55f76",
  block: "1",
  addresses: [
    {
      role: "funding",
      address: "0x45BB3eC560c7A19bbedad9cB42051401Ecc30d7B",
      holdings: [
        {
          symbol: "MON",
          token: null,
          decimals: 18,
          raw: "500000000000000000",
          use: "gas",
          status: "in_use",
          recoverCall: null,
        },
      ],
    },
    {
      role: "token_bound",
      address: TBA,
      holdings: [
        {
          symbol: "MON",
          token: null,
          decimals: 18,
          raw: "3000000000000000000",
          use: null,
          status: "movable",
          recoverCall: { to: TBA, data: "0x51945447", value: "0" },
        },
      ],
    },
    { role: "personal_account", address: null, holdings: [] },
  ],
};

describe("All holdings in the app (D-315)", () => {
  it("turns the API's holdings into the panel's lines, with a move in progress on its line", () => {
    const view = holdingAddresses(JSON_2, {
      "token_bound:MON": { state: "waiting-wallet", text: "Waiting for your wallet." },
    });
    expect(view[0]?.lines[0]).toEqual({
      symbol: "MON",
      raw: 5n * 10n ** 17n,
      decimals: 18,
      use: "gas",
      status: "in_use",
    });
    expect(view[1]?.lines[0]).toMatchObject({
      status: "movable",
      raw: 3n * 10n ** 18n,
      move: { state: "waiting-wallet" },
    });
    expect(view[2]).toEqual({ role: "personal_account", address: null, lines: [] });
  });

  it("names only the token-bound account's own refusal, and leaves other errors to the wallet's words", () => {
    expect(moveFailure(new Error("boom"))).toBeNull();
  });

  it("reports a declined wallet request as declined, with nothing sent after it", async () => {
    let sent = 0;
    const steps: string[] = [];
    const final = await runWalletSteps(
      {
        checkNetwork: async () => ({ ok: true }),
        send: async () => {
          sent++;
          throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        },
        waitForReceipt: async () => "success",
      },
      [{ label: "Move MON to your wallet", call: { to: TBA, data: "0x" } }],
      (p) => steps.push(p.state),
    );
    expect(final.state).toBe("rejected");
    expect(walletTxText(final)).toBe("You declined the request in your wallet; nothing was sent.");
    expect(steps).toEqual(["checking", "waiting-wallet", "rejected"]);
    expect(sent).toBe(1);
  });

  it("sends nothing when the wallet is on another network", async () => {
    let sent = 0;
    const final = await runWalletSteps(
      {
        checkNetwork: async () => ({
          ok: false,
          reason: "wrong-chain-id" as const,
          message: "Your wallet is on another network.",
        }),
        send: async () => {
          sent++;
          return "0x1";
        },
        waitForReceipt: async () => "success",
      },
      [{ label: "Move MON to your wallet", call: { to: TBA, data: "0x" } }],
      () => undefined,
    );
    expect(final).toMatchObject({ state: "failed", message: "Your wallet is on another network." });
    expect(sent).toBe(0);
  });
});
