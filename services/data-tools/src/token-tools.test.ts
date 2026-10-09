import { type AgentIdentity, ToolErrorBody, type ToolServer } from "@alpha-agents/tool-server";
import { connectClient, staticResolver, structured } from "@alpha-agents/tool-server/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type Meter, startDataTools } from "./server.ts";
import type { WebProvider } from "./tavily.ts";
import { type ScreenOutput, type TokenSource, TokenOutputs } from "./token-tools.ts";

const ALICE: AgentIdentity = { chainId: 143, agentId: 7, tier: "base", leaseId: "lease-alice" };
const ALICE_TOKEN = "A".repeat(43);
const TOKEN = "0x00000000000000000000000000000000000000aa";

interface Begin {
  tool: string;
  price: bigint;
  identity: AgentIdentity;
  maxPerLease?: number;
  cacheHit?: boolean;
}

class FakeMeter implements Meter {
  readonly begins: Begin[] = [];
  readonly finishes: { status: string; errorCode?: string }[] = [];
  async begin(identity: AgentIdentity, call: Parameters<Meter["begin"]>[1]) {
    // The run cap: past it, a charged call is refused (as the real meter does).
    const charged = this.begins.filter((b) => b.tool === call.tool && b.price > 0n).length;
    if (call.maxPerLease !== undefined && call.priceUsdcE6 > 0n && charged >= call.maxPerLease) {
      const { ToolError } = await import("@alpha-agents/tool-server");
      throw new ToolError("RATE_LIMITED", "run cap reached", false);
    }
    this.begins.push({
      tool: call.tool,
      price: call.priceUsdcE6,
      identity,
      ...(call.maxPerLease === undefined ? {} : { maxPerLease: call.maxPerLease }),
      ...(call.cacheHit === undefined ? {} : { cacheHit: call.cacheHit }),
    });
    return `call-${this.begins.length}`;
  }
  async finish(_id: string, outcome: Parameters<Meter["finish"]>[1]) {
    this.finishes.push(
      outcome.status === "failed"
        ? { status: "failed", errorCode: outcome.errorCode }
        : { status: outcome.status },
    );
  }
  async refuse() {
    // The token tools never refuse before the meter.
  }
}

const provider: WebProvider = {
  name: "fake",
  search: async () => [],
  extract: async () => null,
};

const screenResult = (
  verdict: "passed" | "refused",
): Omit<ScreenOutput, "source" | "cacheHit"> => ({
  address: TOKEN,
  symbol: "AAA",
  verdict,
  buyable: verdict === "passed",
  summary: verdict === "passed" ? "Passed every check." : "Refused: SELL failed.",
  screenedAt: "2026-10-09T20:00:00.000Z",
  expiresAt: "2026-10-10T02:00:00.000Z",
  forkBlock: 111_990_000,
  route: {
    pool: "0x00000000000000000000000000000000000000b1",
    dex: "uniswap_v3",
    base: "USDC",
    fee: 3000,
  },
  checks: [
    {
      code: "SELL",
      status: verdict === "passed" ? "pass" : "fail",
      reason: "r",
      evidence: { taxBps: 0 },
    },
  ],
});

class FakeTokens implements TokenSource {
  configured = { discovery: true, screen: true };
  cached: Omit<ScreenOutput, "source" | "cacheHit"> | null = null;
  screens: { address: string; requestedBy: string }[] = [];
  failWith: Error | null = null;
  async list() {
    return [
      {
        address: TOKEN,
        symbol: "AAA",
        name: "Token A",
        decimals: 18,
        priceClass: "A" as const,
        feed: null,
        liquidityUsd: 120_000,
        volume24hUsd: 5_000,
        oldestPoolAt: "2026-01-01T00:00:00.000Z",
        listedOnCoinGecko: true,
        coinMarketCapRank: null,
        screen: null,
      },
    ];
  }
  async newPools() {
    return [];
  }
  async freshScreen() {
    return this.cached;
  }
  async screen(address: string, requestedBy: string) {
    if (this.failWith) throw this.failWith;
    this.screens.push({ address, requestedBy });
    return screenResult("refused");
  }
  asOf() {
    return "2026-10-09T20:00:00.000Z";
  }
}

const servers: ToolServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(tokens: TokenSource | null) {
  const meter = new FakeMeter();
  const server = await startDataTools({
    resolve: staticResolver({ [ALICE_TOKEN]: ALICE }),
    meter,
    provider,
    tokens,
  });
  servers.push(server);
  const client = await connectClient(server.url, ALICE_TOKEN);
  return { meter, client };
}

describe("the token tools (F-U1)", () => {
  it("lists tokens for free, with the rules, under a typed schema", async () => {
    const tokens = new FakeTokens();
    const { meter, client } = await start(tokens);
    const r = await client.callTool({ name: "list_tokens", arguments: { priceClass: "A" } });
    const out = TokenOutputs.list_tokens.parse(structured(r));
    expect(out.tokens[0]?.symbol).toBe("AAA");
    expect(out.rules).toMatch(/passing screen under six hours old/);
    expect(meter.begins[0]).toMatchObject({ tool: "list_tokens", price: 0n });
    await client.close();
  });

  it("charges a new screen to the agent the token names, and records who asked", async () => {
    const tokens = new FakeTokens();
    const { meter, client } = await start(tokens);
    const r = await client.callTool({
      name: "screen_token",
      arguments: { token: TOKEN.toUpperCase().replace("0X", "0x") },
    });
    const out = TokenOutputs.screen_token.parse(structured(r));
    expect(out).toMatchObject({ verdict: "refused", buyable: false, cacheHit: false });
    expect(tokens.screens).toEqual([{ address: TOKEN, requestedBy: "agent:7" }]);
    expect(meter.begins[0]).toMatchObject({ tool: "screen_token", price: 5_000n, maxPerLease: 3 });
    expect(meter.begins[0]?.identity.agentId).toBe(7);
    await client.close();
  });

  it("returns a fresh cached screen for free, and runs anew only when asked", async () => {
    const tokens = new FakeTokens();
    tokens.cached = screenResult("passed");
    const { meter, client } = await start(tokens);
    const cached = TokenOutputs.screen_token.parse(
      structured(await client.callTool({ name: "screen_token", arguments: { token: TOKEN } })),
    );
    expect(cached).toMatchObject({ verdict: "passed", cacheHit: true });
    expect(meter.begins[0]).toMatchObject({ price: 0n, cacheHit: true });
    expect(tokens.screens).toHaveLength(0);
    await client.callTool({ name: "screen_token", arguments: { token: TOKEN, fresh: true } });
    expect(tokens.screens).toHaveLength(1);
    expect(meter.begins[1]?.price).toBe(5_000n);
    await client.close();
  });

  it("stops new screens at the run cap, while cached ones stay free", async () => {
    const tokens = new FakeTokens();
    const { client } = await start(tokens);
    for (let i = 0; i < 3; i++)
      await client.callTool({ name: "screen_token", arguments: { token: TOKEN, fresh: true } });
    const fourth = await client.callTool({
      name: "screen_token",
      arguments: { token: TOKEN, fresh: true },
    });
    expect(ToolErrorBody.parse(structured(fourth)).code).toBe("RATE_LIMITED");
    tokens.cached = screenResult("passed");
    const cached = await client.callTool({ name: "screen_token", arguments: { token: TOKEN } });
    expect(TokenOutputs.screen_token.parse(structured(cached)).cacheHit).toBe(true);
    await client.close();
  });

  it("reports a token outside the registry, and reverses the charge", async () => {
    const tokens = new FakeTokens();
    tokens.failWith = Object.assign(new Error("This token is not in the registry."), {
      code: "NOT_FOUND",
    });
    const { meter, client } = await start(tokens);
    const r = await client.callTool({ name: "screen_token", arguments: { token: TOKEN } });
    expect(ToolErrorBody.parse(structured(r)).code).toBe("ASSET_NOT_ALLOWED");
    expect(meter.finishes[0]).toEqual({ status: "failed", errorCode: "ASSET_NOT_ALLOWED" });
    await client.close();
  });

  it("refuses before the meter when the registry is not configured, and rejects a malformed address", async () => {
    const { meter, client } = await start(null);
    const r = await client.callTool({ name: "list_tokens", arguments: {} });
    expect(ToolErrorBody.parse(structured(r)).code).toBe("UPSTREAM_UNAVAILABLE");
    expect(meter.begins).toHaveLength(0);
    const bad = await client.callTool({ name: "screen_token", arguments: { token: "USDC" } });
    expect(bad.isError).toBe(true);
    await client.close();
  });
});
