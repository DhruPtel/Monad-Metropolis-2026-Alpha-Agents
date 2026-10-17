import { describe, expect, it } from "vitest";
import type { SentinelJson } from "@/api/client";
import { pausedBySentinel, resumeBlocker, resumeReason, resumeStatusText } from "./resume-account";

type Action = SentinelJson["actions"][number];

const action = (over: Partial<Action>): Action => ({
  actionId: "sentinel-1",
  code: "STALE_FEED",
  text: "a held token's price feed is stale or unusable",
  action: "REDUCE_ONLY",
  state: "INCIDENT",
  reason: "WMON: feed reverted",
  detail: {},
  txHash: null,
  status: "done",
  at: "2026-10-15T07:24:18.817Z",
  ...over,
});

const OWNER = "0xe0dad03b9CD74FD67D1288773525467b261C2008";

describe("resume account (2026-10-17)", () => {
  it("reads the newest tightening that went through from the sentinel's record", () => {
    const paused = pausedBySentinel([
      action({ actionId: "a", at: "2026-10-15T07:24:18.817Z" }),
      action({
        actionId: "b",
        at: "2026-10-15T07:38:19.475Z",
        reason: "WMON: 3604 s old",
        detail: { tokens: [{ symbol: "WMON", ageSeconds: 3604 }] },
      }),
      action({ actionId: "n", action: "NOTE", at: "2026-10-16T00:00:00.000Z", reason: "cleared" }),
      action({ actionId: "f", at: "2026-10-16T01:00:00.000Z", status: "failed" }),
    ]);
    expect(paused).toEqual({ at: "2026-10-15", why: "the WMON price feed failed" });
    expect(pausedBySentinel([])).toBeNull();
    expect(pausedBySentinel([action({ action: "NOTE" })])).toBeNull();
  });

  it("writes the owner's reason line for reduce-only and for a pause", () => {
    expect(
      resumeReason("REDUCE_ONLY", { at: "2026-10-15", why: "the WMON price feed failed" }),
    ).toBe(
      "Paused on 2026-10-15 by the safety monitor: the WMON price feed failed. Buys are blocked until you resume; sells and withdrawals still work.",
    );
    expect(
      resumeReason("PAUSED", {
        at: "2026-10-15",
        why: "the account fell 22% or more from its 7-day peak",
      }),
    ).toBe(
      "Paused on 2026-10-15 by the safety monitor: the account fell 22% or more from its 7-day peak. Trading and deposits are blocked until you resume; withdrawals still work.",
    );
    // No record of the tightening: the mode alone.
    expect(resumeReason("REDUCE_ONLY", null)).toBe(
      "The account is reduce only. Buys are blocked until you resume; sells and withdrawals still work.",
    );
  });

  it("names the other breaches in plain words", () => {
    const why = (over: Partial<Action>) => pausedBySentinel([action(over)])?.why;
    expect(why({ code: "DRAWDOWN_12" })).toBe("the account fell 12% or more from its 7-day peak");
    expect(why({ code: "RESCREEN_FAILED", reason: "TALPHA: sell-only" })).toBe(
      "TALPHA failed its safety re-screen",
    );
    expect(why({ code: "LIQUIDITY_DROP", reason: "TBETA: 60% down" })).toBe(
      "TBETA's liquidity fell",
    );
    expect(why({ code: "SIGNER_DOWN", text: "the platform's signer is not running" })).toBe(
      "the platform's signer is not running",
    );
  });

  it("shows the reason instead of the button when no wallet is connected or another one is", () => {
    expect(resumeBlocker({ connected: null, owner: OWNER })).toBe(
      "Connect the wallet that owns this agent to resume its account.",
    );
    expect(
      resumeBlocker({ connected: "0x4eBe7500F408fA0b6b79eC40B6E9099675f1bbBF", owner: OWNER }),
    ).toMatch(
      /^Only the owner wallet \(0xe0da…2008\) can resume this account; 0x4eBe…bbBF is connected\.$/,
    );
    expect(resumeBlocker({ connected: OWNER.toLowerCase(), owner: OWNER })).toBeNull();
    // A page that does not know the owner leaves ownership to the owner session.
    expect(resumeBlocker({ connected: OWNER, owner: null })).toBeNull();
  });

  it("says each step of the wallet action in the owner's words", () => {
    expect(resumeStatusText("waiting-wallet", "x")).toBe("Confirm in your wallet.");
    expect(resumeStatusText("confirming", "x")).toBe("Waiting for the network.");
    expect(resumeStatusText("confirmed", "x")).toBe(
      "The account is back to normal. You can turn on automatic trading.",
    );
    expect(resumeStatusText("rejected", "You declined the request in your wallet.")).toBe(
      "You declined the request in your wallet.",
    );
  });
});
