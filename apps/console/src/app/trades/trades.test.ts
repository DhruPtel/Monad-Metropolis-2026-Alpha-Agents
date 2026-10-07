import { describe, expect, it } from "vitest";
import {
  type TradesView,
  type TransactionView,
  describeSwap,
  inFlight,
  knownReason,
  setupSteps,
} from "./trades";

const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const SIGNER_ADDRESS = "0xc7F0C302B03CFD3b61FEd398eaDBa3E78d97CA56";

const tx = (status: string, over: Partial<TransactionView> = {}): TransactionView => ({
  txId: status,
  status,
  reasonCode: null,
  reason: null,
  txHash: null,
  nonce: null,
  blockNumber: null,
  intent: { tokenIn: USDC.toLowerCase(), tokenOut: "0x3bd3", amountIn: "5000000" },
  amountOut: null,
  balances: null,
  ledgerEntryId: null,
  history: [],
  createdAt: "2026-10-07T12:00:00.000Z",
  ...over,
});

const view = (over: Partial<TradesView> = {}): TradesView => ({
  signerOn: true,
  snapshot: {
    agentId: "1",
    owner: "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
    ownerEpoch: "0",
    account: "0x42cF12E641CD11d1C6853978a729eF9B86239820",
    grant: { key: SIGNER_ADDRESS.toLowerCase(), validUntil: "1793468425" },
    usdcE6: "60000000",
    wmonWei: "0",
    blockNumber: "109670100",
  },
  forkError: null,
  sessionKey: SIGNER_ADDRESS,
  transactions: [],
  ledger: {},
  ...over,
});

describe("the Trades panel's data (P2-U4)", () => {
  it("names a reason the design system renders, from either list, and nothing else", () => {
    expect(knownReason("SLIPPAGE_TOO_HIGH")).toBe("SLIPPAGE_TOO_HIGH");
    expect(knownReason("TARGET_NOT_ALLOWED")).toBe("TARGET_NOT_ALLOWED");
    expect(knownReason("SOMETHING_ELSE")).toBeNull();
    expect(knownReason(null)).toBeNull();
  });

  it("keeps polling while a transaction is between accepted and an outcome", () => {
    for (const s of ["accepted", "signed", "submitted", "unknown", "confirmed"])
      expect(inFlight([tx(s)]), s).toBe(true);
    expect(inFlight([tx("reconciled"), tx("failed")])).toBe(false);
    expect(inFlight([tx("confirmed", { reasonCode: "RECONCILE_MISMATCH" })])).toBe(false);
  });

  it("describes the swap's direction from its tokens", () => {
    expect(describeSwap(tx("accepted"), USDC)).toBe("Buy WMON with USDC");
    expect(describeSwap(tx("accepted", { intent: { tokenIn: "0x3bd3" } }), USDC)).toBe(
      "Sell WMON for USDC",
    );
    expect(describeSwap(tx("failed", { intent: null }), USDC)).toBe("Not a swap");
  });

  it("counts the grant only when it names the signer's session key", () => {
    expect(setupSteps(view())).toEqual({ account: true, funded: true, grant: true });
    expect(setupSteps(view({ sessionKey: null })).grant).toBe(false);
    const other = view();
    expect(
      setupSteps({
        ...other,
        snapshot: other.snapshot && { ...other.snapshot, grant: { key: "0x01", validUntil: "1" } },
      }).grant,
    ).toBe(false);
    expect(setupSteps(view({ snapshot: null }))).toEqual({
      account: false,
      funded: false,
      grant: false,
    });
  });
});
