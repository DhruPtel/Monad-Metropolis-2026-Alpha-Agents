import { describe, expect, it } from "vitest";
import { type RevealChainState, revealStatusWords } from "./reveal-status";

const idle: RevealChainState = {
  nextToReveal: 4,
  totalMinted: 4,
  sequence: 0n,
  requestedAt: 0,
  batchLast: 0,
  seedReady: false,
};

describe("where an unrevealed agent's draw stands (UI-FAST)", () => {
  it("says nothing once the chain has revealed the agent", () => {
    expect(revealStatusWords(3n, idle, "testnet")).toBeNull();
  });

  it("says the keeper has not asked yet, and its real window", () => {
    expect(revealStatusWords(4n, idle, "testnet")).toMatch(
      /not been requested yet.*about 60 seconds/,
    );
    expect(revealStatusWords(4n, idle, "local")).toMatch(/about 10 seconds/);
  });

  it("says the randomness was asked for and is on its way", () => {
    const words = revealStatusWords(
      4n,
      { ...idle, sequence: 812n, requestedAt: 1_760_000_000, batchLast: 4 },
      "testnet",
    );
    expect(words).toMatch(/requested from Pyth Entropy at \d\d:\d\d:\d\d UTC \(request 812\)/);
  });

  it("says the number arrived and the draw is being applied", () => {
    expect(
      revealStatusWords(4n, { ...idle, sequence: 812n, batchLast: 4, seedReady: true }, "testnet"),
    ).toMatch(/number has arrived/);
  });

  it("says an agent minted after the pending batch joins the next one", () => {
    expect(
      revealStatusWords(5n, { ...idle, totalMinted: 5, sequence: 812n, batchLast: 4 }, "testnet"),
    ).toMatch(/up to #4.*next request/);
  });
});
