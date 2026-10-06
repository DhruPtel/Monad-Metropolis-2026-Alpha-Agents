import { describe, expect, it } from "vitest";
import { KEEPER_POLICY, type RevealChain, RevealKeeper, type RevealState } from "./keeper.ts";
import { Redactor } from "./secrets.ts";

/** AgentNFT's reveal rules in memory: one batch per request, the timeout, chunked reveals. */
class FakeAgentNft implements RevealChain {
  minted = 0;
  next = 1;
  sequence = 0n;
  requestedAt = 0;
  batchLast = 0;
  seedReady = false;
  chainTime = 1_000_000;
  requests: { first: number; last: number; retry: boolean }[] = [];
  revealCalls: number[] = [];
  failNext: string | null = null;
  deliver?: (sequence: bigint) => Promise<string>;

  constructor(local: boolean) {
    if (local)
      this.deliver = async (sequence) => {
        if (sequence === this.sequence) this.seedReady = true;
        return "0xdeliver";
      };
  }

  async state(): Promise<RevealState> {
    return {
      totalMinted: this.minted,
      nextToReveal: this.next,
      pending: {
        sequence: this.sequence,
        requestedAt: this.requestedAt,
        batchLast: this.batchLast,
        seedReady: this.seedReady,
      },
      chainTime: this.chainTime,
    };
  }

  async requestReveal(): Promise<string> {
    if (this.failNext) {
      const m = this.failNext;
      this.failNext = null;
      throw new Error(m);
    }
    let retry = false;
    if (this.sequence !== 0n) {
      if (this.seedReady || this.chainTime < this.requestedAt + 3_600)
        throw new Error("RevealPending");
      retry = true;
    } else {
      if (this.next > this.minted) throw new Error("NothingToReveal");
      this.batchLast = this.minted;
    }
    this.sequence += 1n;
    this.requestedAt = this.chainTime;
    this.seedReady = false;
    this.requests.push({ first: this.next, last: this.batchLast, retry });
    return `0xrequest${this.requests.length}`;
  }

  async reveal(maxCount: number): Promise<string> {
    if (!this.seedReady) throw new Error("NoSeed");
    this.revealCalls.push(maxCount);
    while (this.next <= this.batchLast && maxCount-- > 0) this.next += 1;
    if (this.next > this.batchLast) {
      this.sequence = 0n;
      this.seedReady = false;
    }
    return "0xreveal";
  }
}

const setup = (local: boolean, chunk = 50) => {
  const chain = new FakeAgentNft(local);
  let now = 0;
  const lines: string[] = [];
  const keeper = new RevealKeeper({
    chain,
    policy: { ...KEEPER_POLICY.local, chunk },
    log: (l) => lines.push(l),
    redactor: new Redactor(),
    clock: () => now,
  });
  return { chain, keeper, lines, advance: (ms: number) => (now += ms) };
};

describe("the reveal keeper (D-201)", () => {
  it("is idle with nothing to reveal", async () => {
    const { keeper, chain } = setup(true);
    expect(await keeper.tick()).toEqual({ kind: "idle" });
    expect(chain.requests).toEqual([]);
  });

  it("batches every mint inside the window into one request", async () => {
    const { keeper, chain, advance } = setup(true);
    chain.minted = 1;
    expect(await keeper.tick()).toMatchObject({ kind: "waiting", unrevealed: 1, msLeft: 10_000 });
    for (let i = 0; i < 4; i += 1) {
      advance(2_000);
      chain.minted += 1;
      expect((await keeper.tick()).kind).toBe("waiting");
    }
    advance(2_000);
    expect(await keeper.tick()).toMatchObject({ kind: "requested", first: 1, last: 5 });
    expect(chain.requests).toEqual([{ first: 1, last: 5, retry: false }]);
  });

  it("delivers on the local fork, reveals, and starts a new window for later mints", async () => {
    const { keeper, chain, advance } = setup(true);
    chain.minted = 2;
    await keeper.tick();
    advance(10_000);
    await keeper.tick();
    // A mint after the request is not in the batch.
    chain.minted = 3;
    expect(await keeper.tick()).toMatchObject({ kind: "delivered", sequence: 1n });
    expect(await keeper.tick()).toMatchObject({ kind: "revealed", upTo: 2 });
    expect(chain.next).toBe(3);
    expect(await keeper.tick()).toMatchObject({ kind: "waiting", unrevealed: 1, msLeft: 10_000 });
    advance(10_000);
    expect(await keeper.tick()).toMatchObject({ kind: "requested", first: 3, last: 3 });
    expect(chain.requests).toHaveLength(2);
  });

  it("reveals a large batch in chunks", async () => {
    const { keeper, chain, advance } = setup(true, 50);
    chain.minted = 120;
    await keeper.tick();
    advance(10_000);
    await keeper.tick();
    await keeper.tick();
    const reveals = [await keeper.tick(), await keeper.tick(), await keeper.tick()];
    expect(reveals.map((r) => (r.kind === "revealed" ? r.upTo : null))).toEqual([50, 100, 120]);
    expect(chain.revealCalls).toEqual([50, 50, 50]);
    expect(await keeper.tick()).toEqual({ kind: "idle" });
  });

  it("off the fork, waits for Pyth and requests again only after the timeout", async () => {
    const { keeper, chain, advance } = setup(false);
    chain.minted = 1;
    await keeper.tick();
    advance(10_000);
    await keeper.tick();
    expect(await keeper.tick()).toMatchObject({ kind: "awaiting-number", sequence: 1n });
    chain.chainTime += 3_599;
    expect((await keeper.tick()).kind).toBe("awaiting-number");
    chain.chainTime += 1;
    expect(await keeper.tick()).toMatchObject({ kind: "re-requested", sequence: 1n });
    expect(chain.requests).toEqual([
      { first: 1, last: 1, retry: false },
      { first: 1, last: 1, retry: true },
    ]);
  });

  it("logs a failed step without the secret, and retries on the next tick", async () => {
    const redactor = new Redactor();
    const chain = new FakeAgentNft(true);
    const lines: string[] = [];
    let now = 0;
    const keeper = new RevealKeeper({
      chain,
      policy: KEEPER_POLICY.local,
      log: (l) => lines.push(l),
      redactor,
      clock: () => now,
    });
    const secret = "redaction-marker-rpc-path-segment-77";
    redactor.add(secret);
    chain.minted = 1;
    await keeper.tick();
    now += 10_000;
    chain.failNext = `HTTP request failed. URL: http://rpc.test/${secret}`;
    expect((await keeper.tick()).kind).toBe("error");
    expect(lines.join("\n")).not.toContain(secret);
    expect(lines.join("\n")).toContain("<redacted>");
    expect((await keeper.tick()).kind).toBe("requested");
  });
});
