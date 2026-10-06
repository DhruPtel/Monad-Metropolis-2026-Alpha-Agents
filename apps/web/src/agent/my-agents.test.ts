import { describe, expect, it } from "vitest";
import type { AgentSummaryJson } from "@/api/client";
import {
  myAgentsPageState,
  refundAmountText,
  refundAvailability,
  refundOutcomeText,
  scanAvailability,
  scanCostText,
  scanStatusText,
  summaryView,
} from "./my-agents";

const summary = (over: Partial<AgentSummaryJson> = {}, spendable = "4994400", held = "0") =>
  summaryView({
    runStatus: "ready",
    wallet: "0x2222222222222222222222222222222222222222",
    ownerEpoch: "2",
    credits: {
      fundingAddress: "0x9F8e2B1C0d3a4E5f60718293A4B5c6D7E8f90a1B",
      creditsUsdcE6: spendable,
      spendableUsdcE6: spendable,
      heldUsdcE6: held,
      restricted: spendable === "0",
    },
    spent24hUsdcE6: "22000",
    charges: [
      {
        entryId: "1",
        at: "2026-10-06T16:40:00.000Z",
        kind: "tool",
        label: "web_search",
        amountUsdcE6: "12000",
      },
    ],
    latestScan: null,
    scan: { minimumUsdcE6: "150000", estimateUsdcE6: { low: "150000", high: "300000" } },
    ...over,
  });

const scanTask = (
  status: "queued" | "running" | "succeeded" | "failed",
  stopReason: string | null = null,
) => ({
  taskId: "t",
  status,
  stopReason,
  error: null,
  requestedBy: "owner",
  createdAt: "2026-10-06T16:40:00.000Z",
  finishedAt: status === "succeeded" || status === "failed" ? "2026-10-06T16:41:30.000Z" : null,
});

describe("the My Agents page state (D-218)", () => {
  const ready = { state: "connected" as const, ready: true };
  it.each([
    [{ state: "logged-out" as const, ready: false }, "ready", 0, "logged-out"],
    [{ state: "connecting" as const, ready: false }, "ready", 0, "connecting"],
    [{ state: "wrong-chain" as const, ready: false }, "ready", 2, "wrong-chain"],
    [ready, "not-deployed", 0, "not-deployed"],
    [ready, "loading", 0, "loading"],
    [ready, "error", 0, "error"],
    [ready, "error", 1, "agents"],
    [ready, "ready", 0, "empty"],
    [ready, "ready", 2, "agents"],
  ] as const)("%o with %s and %i agents is %s", (wallet, status, count, expected) => {
    expect(myAgentsPageState(wallet, { status, count })).toBe(expected);
  });
});

describe("what an owner can do now", () => {
  it("runs a Scan only when set up, funded above the minimum, and none is open", () => {
    expect(scanAvailability(summary())).toEqual({ enabled: true });
    expect(scanAvailability(summary({ runStatus: "awaiting_reveal" }))).toMatchObject({
      enabled: false,
      reason: expect.stringMatching(/revealed/),
    });
    expect(scanAvailability(summary({ runStatus: "provisioning" })).enabled).toBe(false);
    expect(scanAvailability(summary({ latestScan: scanTask("running") }))).toMatchObject({
      reason: "A Scan is already queued or running.",
    });
    expect(scanAvailability(summary({}, "149999"))).toMatchObject({
      enabled: false,
      reason: "A Scan needs at least 0.15 USDC of credits. Add USDC to the funding address.",
    });
    expect(scanAvailability(summary({ latestScan: scanTask("succeeded", "COMPLETED") }))).toEqual({
      enabled: true,
    });
  });

  it("refunds only with credits or held USDC to return, and says what goes back", () => {
    expect(refundAvailability(summary({}, "0")).enabled).toBe(false);
    expect(refundAvailability(summary({}, "0", "2000000")).enabled).toBe(true);
    expect(refundAmountText(summary())).toBe("4.9944 USDC of credits");
    expect(refundAmountText(summary({}, "1000000", "2000000"))).toBe(
      "1 USDC of credits and 2 USDC held above the cap",
    );
  });

  it("states the Scan's cost from the estimate", () => {
    expect(scanCostText(summary())).toBe("about 0.15 to 0.30 USDC");
  });
});

describe("results in plain words", () => {
  it("describes the latest Scan", () => {
    expect(scanStatusText(summary())).toBeNull();
    expect(scanStatusText(summary({ latestScan: scanTask("queued") }))).toMatch(/queued/);
    expect(scanStatusText(summary({ latestScan: scanTask("running") }))).toMatch(/running/);
    expect(scanStatusText(summary({ latestScan: scanTask("succeeded", "COMPLETED") }))).toBe(
      "Last Scan completed at 16:41 UTC.",
    );
    expect(scanStatusText(summary({ latestScan: scanTask("failed", "BILLING") }))).toBe(
      "Last Scan stopped: its credits ran out at 16:41 UTC.",
    );
  });

  it("describes a refund once it has finished", () => {
    const r = (
      status: "requested" | "sent" | "refused" | "failed",
      reason: string | null = null,
    ) => ({
      refundId: "r",
      status,
      creditsUsdcE6: "4994400",
      heldUsdcE6: "2000000",
      txHash: null,
      reason,
    });
    expect(refundOutcomeText(r("requested"))).toBeNull();
    expect(refundOutcomeText(r("sent"))).toEqual({
      ok: true,
      text: "Refunded 6.9944 USDC to your wallet.",
    });
    expect(refundOutcomeText(r("refused", "the agent has a new owner"))).toEqual({
      ok: false,
      text: "The refund was refused: the agent has a new owner",
    });
    expect(refundOutcomeText(r("failed"))?.ok).toBe(false);
  });
});
