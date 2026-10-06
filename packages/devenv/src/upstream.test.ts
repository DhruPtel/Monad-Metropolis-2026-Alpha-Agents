import { describe, expect, it } from "vitest";
import { backoffMs, forkUpstreams, servesBlock, upstreamFor } from "./upstream.ts";

const answer = (body: unknown) =>
  (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;

describe("fork upstreams (D-220)", () => {
  it("lists the primary, then the secondary when it differs", () => {
    const a = "https://a.example/k";
    const b = "https://b.example/k";
    expect(forkUpstreams({ MONAD_RPC_URL: a, MONAD_RPC_URL_SECONDARY: b })).toEqual([a, b]);
    expect(forkUpstreams({ MONAD_RPC_URL: a, MONAD_RPC_URL_SECONDARY: a })).toEqual([a]);
    expect(forkUpstreams({ MONAD_RPC_URL: ` ${a} ` }).at(0)).toBe(a);
  });

  it("alternates between two upstreams and stays on one", () => {
    expect([1, 2, 3, 4].map((n) => upstreamFor(["p", "s"], n))).toEqual(["p", "s", "p", "s"]);
    expect([1, 2, 3].map((n) => upstreamFor(["p"], n))).toEqual(["p", "p", "p"]);
    expect(() => upstreamFor([], 1)).toThrow(/MONAD_RPC_URL/);
  });

  it("backs off exponentially up to 16 seconds", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => backoffMs(n))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 16_000, 16_000,
    ]);
  });

  it("counts a block as served only when the reply has its hash", async () => {
    expect(await servesBlock("http://u", 1, answer({ result: { hash: "0xab" } }))).toBe(true);
    // L-87: a load-balanced node without the block answers 200 with a null result.
    expect(await servesBlock("http://u", 1, answer({ result: null }))).toBe(false);
    expect(await servesBlock("http://u", 1, answer({ error: { code: -32000 } }))).toBe(false);
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await servesBlock("http://u", 1, down)).toBe(false);
  });
});
