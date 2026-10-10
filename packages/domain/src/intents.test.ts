import { describe, expect, it } from "vitest";
import {
  type ActionId,
  type Address,
  type AgentId,
  type AmountRaw,
  type Bytes32,
  type ConfigEpoch,
  type ExecutorSwapIntent,
  FORBIDDEN_INTENT_FIELDS,
  INTENT_REGISTRY,
  IntentSchema,
  type OwnerEpoch,
  RETIRED_TOOL_IDS,
  RebalanceIntentSchema,
  SwapIntentSchema,
  TOOL_DEFERRALS,
  TOOL_IDS,
  TOOL_REGISTRY,
  checkToolRegistry,
  isToolId,
  parseToolId,
  toExecutorSwap,
} from "./index.ts";

const swap = {
  kind: "swap",
  schemaVersion: 1,
  account: "personal",
  sell: "USDC",
  buy: "WMON",
  sellAmountRaw: "25000000",
  maxSlippageBps: 30,
  reason: "Rebalance toward the 30% WMON target",
  clientRequestId: "req-0001-abcd",
};

const rebalance = {
  kind: "rebalance",
  schemaVersion: 1,
  account: "vault",
  targets: [
    { asset: "USDC", targetBps: 7000 },
    { asset: "WMON", targetBps: 3000 },
  ],
  toleranceBps: 200,
  reason: "Daily band check",
  clientRequestId: "req-0002-abcd",
};

describe("tool registry (FINAL_PLAN 4.4.5)", () => {
  it("lists 54 unique, well-formed tool IDs", () => {
    expect(TOOL_IDS).toHaveLength(54);
    expect(new Set(TOOL_IDS).size).toBe(TOOL_IDS.length);
    for (const t of TOOL_REGISTRY) {
      const parsed = parseToolId(t.id);
      expect(parsed, t.id).toBeDefined();
      expect(parsed?.server).toBe(t.server);
      expect(parsed?.major).toBe(1);
    }
  });

  it("has 17 chain, 21 data and 16 platform tools", () => {
    const count = (s: string) => TOOL_REGISTRY.filter((t) => t.server === s).length;
    expect([count("chain"), count("data"), count("platform")]).toEqual([17, 21, 16]);
  });

  it("maps every intent to a registered tool", () => {
    expect(Object.keys(INTENT_REGISTRY)).toEqual([
      "intent.propose_swap@1",
      "intent.propose_rebalance@1",
      "intent.propose_strategy_update@1",
    ]);
    for (const tool of Object.values(INTENT_REGISTRY)) expect(isToolId(tool)).toBe(true);
  });

  it("does not accept retired research IDs or the reserved premium pattern", () => {
    for (const id of RETIRED_TOOL_IDS) expect(isToolId(id)).toBe(false);
    expect(isToolId("data.premium_*@1")).toBe(false);
    expect(isToolId("chain.get_quote@2")).toBe(false);
  });
});

describe("swap intent", () => {
  it("parses a valid swap with the amount as an exact bigint", () => {
    const parsed = SwapIntentSchema.parse(swap);
    expect(parsed.sellAmountRaw).toBe(25_000_000n);
  });

  it.each([
    ["same asset on both sides", { buy: "USDC" }],
    ["zero amount", { sellAmountRaw: "0" }],
    ["amount as a JSON number", { sellAmountRaw: 25_000_000 }],
    ["fractional amount", { sellAmountRaw: "2.5" }],
    ["asset outside the enum", { buy: "WETH" }],
    ["native MON", { sell: "NATIVE" }],
    ["fractional slippage", { maxSlippageBps: 0.5 }],
    ["empty reason", { reason: " " }],
    ["short client request ID", { clientRequestId: "abc" }],
    ["unknown account", { account: "funding" }],
    ["wrong schema version", { schemaVersion: 2 }],
  ])("rejects %s", (_, patch) => {
    expect(SwapIntentSchema.safeParse({ ...swap, ...patch }).success).toBe(false);
  });

  it.each(FORBIDDEN_INTENT_FIELDS)(
    "rejects a %s field: intents never carry calldata or addresses",
    (field) => {
      const withField = { ...swap, [field]: "0x1234" };
      expect(SwapIntentSchema.safeParse(withField).success).toBe(false);
      expect(IntentSchema.safeParse(withField).success).toBe(false);
    },
  );
});

describe("rebalance intent", () => {
  it("parses a valid rebalance", () => {
    expect(RebalanceIntentSchema.parse(rebalance).targets).toHaveLength(2);
  });

  it.each([
    [
      "targets that do not sum to 100%",
      [
        { asset: "USDC", targetBps: 7000 },
        { asset: "WMON", targetBps: 2000 },
      ],
    ],
    [
      "a duplicated asset",
      [
        { asset: "USDC", targetBps: 5000 },
        { asset: "USDC", targetBps: 5000 },
      ],
    ],
    ["no targets", []],
    [
      "percent instead of basis points",
      [
        { asset: "USDC", targetBps: 70.5 },
        { asset: "WMON", targetBps: 29.5 },
      ],
    ],
  ])("rejects %s", (_, targets) => {
    expect(RebalanceIntentSchema.safeParse({ ...rebalance, targets }).success).toBe(false);
  });

  it("rejects a calldata field on a target", () => {
    const targets = [{ asset: "USDC", targetBps: 10000, calldata: "0x" }];
    expect(RebalanceIntentSchema.safeParse({ ...rebalance, targets }).success).toBe(false);
  });

  it("is told apart from a swap by kind", () => {
    expect(IntentSchema.parse(rebalance).kind).toBe("rebalance");
    expect(IntentSchema.parse(swap).kind).toBe("swap");
  });
});

describe("Executor swap intent", () => {
  const ctx = {
    chainId: 143,
    agentId: 7n as AgentId,
    account: "0x1111111111111111111111111111111111111111" as Address,
    actionId: `0x${"ab".repeat(32)}` as ActionId,
    ownerEpoch: 1n as OwnerEpoch,
    configEpoch: 3n as ConfigEpoch,
    policyHash: `0x${"cd".repeat(32)}` as Bytes32,
    adapterId: `0x${"ef".repeat(32)}` as Bytes32,
    minAmountOut: 900n as AmountRaw,
    deadline: 1_790_000_120,
  };

  it("resolves verified token addresses on the fork", () => {
    const signable = toExecutorSwap(SwapIntentSchema.parse(swap), { ...ctx, environment: "local" });
    expect(signable.tokenIn).toBe("0x754704Bc059F8C67012fEd69BC8A327a5aafb603");
    expect(signable.tokenOut).toBe("0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A");
    expect(Object.keys(signable)).not.toContain("recipient");
  });

  it("builds a testnet intent from testnet's own tokens, never mainnet's (P2-EC)", () => {
    const built = toExecutorSwap(SwapIntentSchema.parse(swap), {
      ...ctx,
      chainId: 10143,
      environment: "testnet",
    });
    const testnetTokens = [
      "0x534b2f3A21130d7a60830c2Df862319e593943A3",
      "0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541",
    ];
    expect(testnetTokens).toContain(built.tokenIn);
    expect(testnetTokens).toContain(built.tokenOut);
  });

  it("does not accept a plain address where a verified one is required", () => {
    const plain = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as Address;
    const build = (): ExecutorSwapIntent => ({
      ...ctx,
      schemaVersion: 1,
      amountIn: 1n as AmountRaw,
      // @ts-expect-error an unbranded Address is not a VerifiedAddress
      tokenIn: plain,
      // @ts-expect-error an unbranded Address is not a VerifiedAddress
      tokenOut: plain,
    });
    expect(build().tokenIn).toBe(plain);
  });
});

describe("the registry check (P3-U9)", () => {
  const live = {
    chain: ["get_portfolio", "read_contract"],
    data: ["x_search"],
    platform: ["complete_stage"],
  } as const;
  const registry = [
    { id: "chain.get_portfolio@1", server: "chain", tier: "baseline", purpose: "" },
    { id: "chain.read_contract@1", server: "chain", tier: "baseline", purpose: "" },
    { id: "chain.whoami@1", server: "chain", tier: "baseline", purpose: "" },
    { id: "data.x_search@1", server: "data", tier: "baseline", purpose: "" },
    { id: "platform.complete_stage@1", server: "platform", tier: "baseline", purpose: "" },
  ] as const;
  const deferrals = { "chain.whoami@1": { unit: "W-2", reason: "later" } };

  it("passes when every ID is live or deferred and every declared tool is registered", () => {
    expect(
      checkToolRegistry({
        registry,
        deferrals,
        live,
        declared: [
          {
            skill: "s",
            tools: ["chain.read_contract@1", "chain.whoami@1", "intent.propose_swap@1"],
          },
        ],
      }),
    ).toEqual([]);
  });

  it("fails on an ID with no tool and no deferral, naming it", () => {
    const problems = checkToolRegistry({
      registry: [
        ...registry,
        { id: "data.new_source@1", server: "data", tier: "baseline", purpose: "" },
      ],
      deferrals,
      live,
    });
    expect(problems).toEqual([
      {
        id: "data.new_source@1",
        problem: "has no tool on the data server and no deferral naming its unit",
      },
    ]);
  });

  it("fails on a live tool missing from the registry, a stale deferral and an undeclared skill tool", () => {
    const problems = checkToolRegistry({
      registry,
      deferrals: { ...deferrals, "chain.read_contract@1": { unit: "P3-U9", reason: "x" } },
      live: { ...live, data: ["x_search", "rogue_tool"] },
      declared: [{ skill: "s", tools: ["data.unknown@1", "intent.propose_anything@1"] }],
    });
    expect(problems.map((p) => p.id)).toEqual([
      "chain.read_contract@1",
      "data.rogue_tool@1",
      "data.unknown@1",
      "intent.propose_anything@1",
    ]);
  });

  it("defers only registry IDs", () => {
    for (const id of Object.keys(TOOL_DEFERRALS)) expect(TOOL_IDS).toContain(id);
  });
});
