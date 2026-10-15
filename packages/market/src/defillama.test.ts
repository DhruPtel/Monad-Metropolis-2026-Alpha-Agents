import { describe, expect, it } from "vitest";
import { LLAMA_URLS, llamaUrlNow } from "./defillama.ts";

describe("DefiLlama's request URLs (CO-U1)", () => {
  it("names the end of a price chart, so a long span answers the latest points", () => {
    expect(llamaUrlNow("chartHourly", 1_792_023_742.9)).toBe(
      `${LLAMA_URLS.chartHourly}&end=1792023742`,
    );
    expect(llamaUrlNow("chart4h", 1_792_023_742)).toBe(`${LLAMA_URLS.chart4h}&end=1792023742`);
  });

  it("leaves every other request as it is", () => {
    expect(llamaUrlNow("protocols", 1_792_023_742)).toBe(LLAMA_URLS.protocols);
  });
});
