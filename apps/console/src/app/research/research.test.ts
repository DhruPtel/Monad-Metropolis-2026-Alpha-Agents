import { describe, expect, it } from "vitest";
import { type ResearchCallJson, callSubject, usdc } from "./research";

const call = (
  tool: string,
  input: Record<string, unknown>,
  summary: Record<string, unknown> | null = null,
) =>
  ({
    callId: "c",
    agentId: 1,
    server: "data",
    tool,
    input,
    status: "succeeded",
    errorCode: null,
    chargeUsdcE6: "0",
    cacheHit: false,
    summary,
    at: "2026-10-08T22:50:00.000Z",
  }) satisfies ResearchCallJson;

describe("the research view's words (P3-U9)", () => {
  it("shows a charge in USDC, and a free call as free", () => {
    expect(usdc("62500")).toBe("0.0625 USDC");
    expect(usdc("20000")).toBe("0.0200 USDC");
    expect(usdc("0")).toBe("Free");
  });

  it("says what each call asked for", () => {
    expect(callSubject(call("x_search", { topic: "monad_news", windowHours: 6 }))).toBe(
      "monad_news, 6 h",
    );
    expect(callSubject(call("dune_query", { query: "monad_dex_volume_daily" }))).toBe(
      "monad_dex_volume_daily, 30 days",
    );
    expect(callSubject(call("read_contract", { function: "erc20_symbol", target: "0xabc" }))).toBe(
      "erc20_symbol on 0xabc",
    );
    expect(callSubject(call("get_code", { target: "0xabc" }, { hasCode: false }))).toBe(
      "0xabc, no code",
    );
    expect(
      callSubject(call("get_code", { target: "0xabc" }, { hasCode: true, proxy: "eip1967" })),
    ).toBe("0xabc, eip1967");
  });
});
