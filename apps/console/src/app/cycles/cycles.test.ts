import { describe, expect, it } from "vitest";
import {
  cacheShare,
  callSubject,
  fillBps,
  freshTokens,
  isLive,
  paidCalls,
  statusTone,
  usdc,
} from "./cycles";

describe("the console's research cycles (P3-U4)", () => {
  it("shows USDC with four decimals, truncated", () => {
    expect(usdc("300000")).toBe("0.3000 USDC");
    expect(usdc("1234567")).toBe("1.2345 USDC");
    expect(usdc(0)).toBe("0.0000 USDC");
  });

  it("fills a meter by use against its cap, never past full", () => {
    expect(fillBps(5, 10)).toBe(5_000);
    expect(fillBps(12, 10)).toBe(10_000);
    expect(fillBps(1, 0)).toBe(0);
    expect(fillBps(150_000n, 300_000n)).toBe(5_000);
  });

  it("reads statuses as tones, cache reads as a share, and paid calls without the cached ones", () => {
    expect(statusTone("completed")).toBe("positive");
    expect(statusTone("capped")).toBe("warning");
    expect(statusTone("failed")).toBe("negative");
    expect(statusTone("running")).toBe("neutral");
    expect(cacheShare({ inputTokens: 20_000, cacheReadTokens: 15_000 })).toBe("75%");
    expect(cacheShare({ inputTokens: 0, cacheReadTokens: 0 })).toBe("0%");
    // The token cap counts what was not read from the cache (A-59).
    expect(freshTokens({ inputTokens: 20_000, cacheReadTokens: 15_000, outputTokens: 500 })).toBe(
      5_500,
    );
    const call = (charge: string, status = "succeeded") => ({
      callId: "c",
      server: "data",
      tool: "web_search",
      input: {},
      status,
      errorCode: null,
      chargeUsdcE6: charge,
      cacheHit: charge === "0",
      resultStored: true,
      resultTruncated: false,
      startedAt: "",
    });
    expect(paidCalls({ toolCalls: [call("10000"), call("0"), call("10000", "refused")] })).toBe(1);
  });

  it("names what a call asked for, and refreshes only while a cycle can change", () => {
    expect(callSubject({ query: "monad tvl" })).toBe("monad tvl");
    expect(callSubject({ url: "https://news.example/a" })).toBe("news.example");
    expect(callSubject({ topic: "monad_news" })).toBe("monad_news");
    expect(callSubject({})).toBe("");
    expect(isLive("running")).toBe(true);
    expect(isLive("completed")).toBe(false);
  });
});
