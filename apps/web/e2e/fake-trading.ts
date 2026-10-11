import {
  type Address,
  type Hex,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  parseAbi,
} from "viem";
import type {
  ResearchJson,
  TerminalEventJson,
  TerminalJson,
  ActivationJson,
  ActivationReadJson,
  ActivationStepJson,
  ArmingJson,
  IntentJson,
  PortfolioJson,
  WhyNotTradedJson,
  PlanCardJson,
  PortfolioV3Json,
  ProposalJson,
  WindowJson,
} from "../src/api/client";
import { ACCOUNT_ABI, ERC20_ABI, FACTORY_ABI } from "../src/agent/custody";
import type { FakeChain } from "./fake-chain";

/**
 * The trading side of the fake control API (P2-U7): one agent's portfolio,
 * arming, intents and why-not-traded, served on the owner session like the
 * real routes, and changed by the mock wallet's own transactions on the fake
 * chain (open the account, deposit, withdraw, claim, the grant and its
 * revoke), so a test drives the page end to end with no real chain.
 */

export const FACTORY = "0x00000000000000000000000000000000000fac70" as const;
export const EXECUTOR = "0x00000000000000000000000000000000000e0ec0" as const;
export const ACCOUNT = getAddress("0x4d2c9a1b3e5f60718293a4b5c6d7e8f90a1b2c3d");
export const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as const;
export const WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A" as const;
export const FUNDING = getAddress("0x9f8e2b1c0d3a4e5f60718293a4b5c6d7e8f90a1b");
/** The block's time all fixtures are dated from: 2026-10-07T12:00:00Z. */
/** WBTC on Monad, the second token the plan card's fixtures name. */
export const WBTC = "0x0555e30da8f98308edb960aa94c0db47230d2b9c" as const;
/** A class A token the plan in force holds in the fixtures and the proposal leaves. */
export const CHOG = "0x00000000000000000000000000000000000c0de5" as const;
/** The fund agent's set (A-80): AccountFactoryV3, the agent's PersonalAccountV3 and OracleAdapterV3. */
export const FACTORY_V3 = "0x00000000000000000000000000000000000fac73" as const;
export const ACCOUNT_V3 = getAddress("0x5d3c9a1b3e5f60718293a4b5c6d7e8f90a1b2c3e");
export const ORACLE_V3 = "0x000000000000000000000000000000000000043e" as const;
export const NOW = 1_791_374_400;
const iso = (s: number) => new Date(s * 1000).toISOString();
const PX = 25_000_000_000_000_000n;

const GRANT_ABI = parseAbi([
  "function registerSession(uint256 agentId, address key, uint64 validUntil)",
  "function revokeSession(uint256 agentId)",
]);

export function portfolioFixture(owner: Address, over: Partial<PortfolioJson> = {}): PortfolioJson {
  return {
    custody: "v2",
    chainId: 143143,
    block: "109670100",
    timestamp: NOW,
    agentId: "7",
    owner: getAddress(owner),
    contracts: {
      agentNft: "0x60cacA6dE327331b321E140Ae19AcbCc4188Be6E",
      accountFactory: FACTORY,
      oracle: "0x000000000000000000000000000000000000041e",
      usdc: USDC,
      wmon: WMON,
      executor: EXECUTOR,
    },
    account: ACCOUNT,
    predictedAccount: ACCOUNT,
    allowlist: { enabled: true, listed: true },
    caps: {
      personalUsdcE6: "100000000",
      platformUsdcE6: "2000000000",
      platformTotalUsdcE6: "250000000",
      principalUsdcE6: "40000000",
    },
    balances: { usdcE6: "30000000", wmonWei: (400n * 10n ** 18n).toString() },
    claimable: { usdcE6: "0", wmonWei: "0" },
    mode: "NORMAL",
    depositsClosed: false,
    breaker: {
      navUsdcE6: "40000000",
      perUnitE18: "1000000000000000000",
      peakE18: "1012500000000000000",
      drawdownBps: 120,
    },
    peak7dE18: "1012500000000000000",
    prices: {
      monUsd: { priceE18: PX.toString(), updatedAt: NOW - 20, reason: "OK" },
      usdcUsd: { priceE18: "1000000000000000000", updatedAt: NOW - 600, reason: "OK" },
    },
    wallet: { usdcE6: "70000000", wmonWei: "0", monWei: "1000000000000000000" },
    ...over,
  };
}

const E18 = 10n ** 18n;
const V3_TOKEN = (
  symbol: string,
  address: Address,
  decimals: number,
  walletRaw: string,
  priceE18: string,
) => ({
  symbol,
  address,
  decimals,
  priceClass: "F" as const,
  walletRaw,
  price: { priceE18, updatedAt: NOW - 20, reason: "OK" },
});

/** Agent 7 on the fund agent's set (A-80): USDC, WMON and WBTC held, with 60 USDC of room under the cap. */
export function portfolioV3Fixture(
  owner: Address,
  over: Partial<PortfolioV3Json> = {},
): PortfolioV3Json {
  return {
    custody: "v3",
    chainId: 143143,
    block: "109670100",
    timestamp: NOW,
    agentId: "7",
    owner: getAddress(owner),
    contracts: {
      agentNft: "0x60cacA6dE327331b321E140Ae19AcbCc4188Be6E",
      accountFactory: FACTORY_V3,
      accountFactoryV2: FACTORY,
      oracle: ORACLE_V3,
      usdc: USDC,
      wmon: WMON,
      executor: EXECUTOR,
    },
    account: ACCOUNT_V3,
    predictedAccount: ACCOUNT_V3,
    allowlist: { enabled: true, listed: true },
    caps: {
      personalUsdcE6: "100000000",
      platformUsdcE6: "2000000000",
      platformTotalUsdcE6: "250000000",
      principalUsdcE6: "40000000",
    },
    mode: "NORMAL",
    depositsClosed: false,
    navUsdcE6: "70000000",
    breaker: {
      navUsdcE6: "70000000",
      perUnitE18: "1050000000000000000",
      peakE18: "1062500000000000000",
      drawdownBps: 118,
    },
    peak7dE18: "1062500000000000000",
    holdings: [
      {
        token: USDC,
        symbol: "USDC",
        decimals: 6,
        amountRaw: "30000000",
        freeRaw: "30000000",
        costBasisUsdcE6: "0",
        priceE18: E18.toString(),
        priceReason: "OK",
        valueUsdcE6: "30000000",
        claimableRaw: "0",
      },
      {
        token: WMON,
        symbol: "WMON",
        decimals: 18,
        amountRaw: (400n * E18).toString(),
        freeRaw: (400n * E18).toString(),
        costBasisUsdcE6: "9500000",
        priceE18: PX.toString(),
        priceReason: "OK",
        valueUsdcE6: "10000000",
        claimableRaw: "0",
      },
      {
        token: WBTC,
        symbol: "WBTC",
        decimals: 8,
        amountRaw: "30000",
        freeRaw: "30000",
        costBasisUsdcE6: "28000000",
        priceE18: (100_000n * E18).toString(),
        priceReason: "OK",
        valueUsdcE6: "30000000",
        claimableRaw: "0",
      },
    ],
    tokens: [
      V3_TOKEN("USDC", USDC, 6, "70000000", E18.toString()),
      V3_TOKEN("WMON", WMON, 18, (5n * E18).toString(), PX.toString()),
      V3_TOKEN("WBTC", WBTC, 8, "0", (100_000n * E18).toString()),
    ],
    usdcPeg: { priceE18: E18.toString(), updatedAt: NOW - 600, reason: "OK" },
    wallet: { monWei: E18.toString() },
    legacy: null,
    ...over,
  };
}

/** The playtest's case (A-80): no v3 account yet, and the older v2 account still holding 100 USDC. */
export function olderAccountFixture(owner: Address): PortfolioV3Json {
  return portfolioV3Fixture(owner, {
    account: null,
    caps: {
      personalUsdcE6: "100000000",
      platformUsdcE6: "2000000000",
      platformTotalUsdcE6: "250000000",
      principalUsdcE6: "0",
    },
    mode: null,
    navUsdcE6: null,
    breaker: null,
    peak7dE18: null,
    holdings: [],
    legacy: {
      account: ACCOUNT,
      usdcE6: "100000000",
      wmonWei: "0",
      claimable: { usdcE6: "0", wmonWei: "0" },
      mode: "NORMAL",
    },
  });
}

/** A portfolio before the owner opens the account. */
export function noAccountFixture(owner: Address, listed = true): PortfolioJson {
  return portfolioFixture(owner, {
    account: null,
    allowlist: { enabled: true, listed },
    caps: {
      personalUsdcE6: "100000000",
      platformUsdcE6: "2000000000",
      platformTotalUsdcE6: "250000000",
      principalUsdcE6: "0",
    },
    balances: { usdcE6: "0", wmonWei: "0" },
    mode: null,
    breaker: null,
    peak7dE18: null,
  });
}

const amount = (asset: "USDC" | "WMON", amount: string, amountRaw: string) => ({
  asset,
  amount,
  amountRaw,
});

export function intentFixture(over: Partial<IntentJson> = {}): IntentJson {
  return {
    intentId: "intent-6f1c2d9e-7b1a-4c3e-9d2f-1a2b3c4d5e6f",
    status: "awaiting_approval",
    sell: amount("USDC", "2.5", "2500000"),
    buy: "WMON",
    expectedOut: amount("WMON", "99.9", "99900000000000000000"),
    minAmountOut: null,
    amountOut: null,
    reason: "Add a little WMON while the price is near its weekly low.",
    reasonCodes: [],
    blockers: [],
    failure: null,
    approvedBy: null,
    txHash: null,
    deadline: null,
    createdAt: iso(NOW - 300),
    expiresAt: iso(NOW + 1500),
    approvedAt: null,
    submittedAt: null,
    settledAt: null,
    ...over,
  };
}

export const SETTLED = intentFixture({
  intentId: "intent-1d2c3b4a-5f6e-4d7c-8b9a-0f1e2d3c4b5a",
  status: "reconciled",
  sell: amount("USDC", "1", "1000000"),
  expectedOut: null,
  amountOut: amount("WMON", "39.94", "39940000000000000000"),
  minAmountOut: amount("WMON", "39.7", "39700000000000000000"),
  reason: "A small first position in WMON.",
  approvedBy: "auto",
  txHash: `0x${"7d".repeat(32)}`,
  createdAt: iso(NOW - 3600),
  settledAt: iso(NOW - 3591),
});

export const BLOCKED = intentFixture({
  intentId: "intent-0a9b8c7d-6e5f-4a3b-2c1d-0e9f8a7b6c5d",
  status: "rejected",
  sell: amount("USDC", "15", "15000000"),
  expectedOut: null,
  reason: "Buy a larger WMON position.",
  reasonCodes: ["TRADE_SIZE_EXCEEDED"],
  blockers: [
    {
      code: "TRADE_SIZE_EXCEEDED",
      message: "The trade is larger than 10% of the account's value.",
      clears: "by_changing_the_trade",
      clearsAt: null,
      hint: "Propose at most 4 USDC.",
    },
  ],
  createdAt: iso(NOW - 1800),
});

const UNARMED: ArmingJson = {
  state: "unarmed",
  armingId: null,
  validUntil: null,
  validUntilDate: null,
  renewalDue: false,
  armedAt: null,
  firstIntentId: null,
  ended: null,
};

/** F-U9: a proposal as the API stores it, waiting for the owner by default. */
export function proposalFixture(over: Partial<ProposalJson> = {}): ProposalJson {
  return {
    proposalId: "prop-00000000-0000-4000-8000-000000000001",
    kind: "proposal",
    status: "pending_owner",
    needsApproval: true,
    strategyEpoch: "1",
    ownerEpoch: "2",
    cycleId: "cycle-fixture",
    template: "target_portfolio@1",
    plan: {
      cashTargetBps: 6_000,
      minTradeUsdcE6: "500000",
      volatilityBrakeBps: 20_000,
      costHurdleBps: 40,
      maxLegBps: 1_000,
    },
    positions: [
      {
        token: WMON.toLowerCase(),
        symbol: "WMON",
        targetWeightBps: 2_000,
        bandBps: 300,
        currentWeightBps: 2_500,
        action: "TRIM",
        thesisCode: "WMON_DEPTH",
        thesis: "WMON keeps its depth while MON's volatility settles under the brake.",
        killCriterion: "MON's 24-hour volatility stays above 150% for 3 days.",
        recheckAt: "2026-10-24",
        trimAboveBps: null,
        confidence: "medium",
        sources: { onchain: 2, market: 2, primary: 0, news: 1, social: 0 },
        verdict: "STANDS",
        reason: "The thesis stands but the account is above its weight.",
      },
      {
        token: WBTC,
        symbol: "WBTC",
        targetWeightBps: 2_000,
        bandBps: 300,
        currentWeightBps: null,
        action: "ADD",
        thesisCode: "WBTC_ADD",
        thesis: "WBTC tracks bitcoin while its pool stays deep enough for this account's legs.",
        killCriterion: "The deepest pool's liquidity halves.",
        recheckAt: "2026-11-01",
        trimAboveBps: 3_000,
        confidence: "medium",
        sources: { onchain: 1, market: 2, primary: 1, news: 0, social: 1 },
        verdict: "WEAKENED",
        reason: "A deep pool and a thesis the skeptic weakened but did not reject.",
      },
    ],
    rationale: {
      decision: "PROPOSE",
      reasonCode: null,
      portfolioView:
        "Two large tokens plus cash fit a Balanced goal; the account trims WMON back under its weight and adds a first WBTC position.",
      evidenceStrength: "mixed",
      whatWouldChangeIt: "WBTC's pool thinning out, or MON's volatility rising past the brake.",
      themeCodes: ["WMON_DEPTH", "WBTC_ADD"],
    },
    evaluation: {
      checkedAt: iso(NOW - 600),
      passed: true,
      findings: [],
      cost: {
        legs: 2,
        turnoverUsdcE6: "10000000",
        estimatedCostUsdcE6: "20000",
        costBps: 20,
        basis: "test",
      },
      approval: "ask_first",
    },
    reasonCode: null,
    explanation: null,
    decidedBy: null,
    decidedAt: null,
    createdAt: iso(NOW - 600),
    expiresAt: iso(NOW - 600 + 86_400),
    ...over,
  };
}

export const REJECTED_PROPOSAL = proposalFixture({
  proposalId: "prop-00000000-0000-4000-8000-000000000002",
  status: "rejected",
  needsApproval: true,
  evaluation: {
    checkedAt: iso(NOW - 7200),
    passed: false,
    findings: [
      {
        code: "ENVELOPE_POSITION",
        field: "positions[1].targetWeightBps",
        message: "WBTC at 46.00% is above the Balanced envelope's 45.00% per position.",
      },
      {
        code: "DEPTH",
        field: "positions[1]",
        message:
          "A 10.00 USDC leg into WBTC would fill 1.20% under the oracle, past the 0.40% hurdle.",
      },
    ],
    cost: null,
    approval: "ask_first",
  },
  createdAt: iso(NOW - 7200),
  expiresAt: null,
  decidedAt: iso(NOW - 7200),
});

export const NO_CHANGE = proposalFixture({
  proposalId: "prop-00000000-0000-4000-8000-000000000003",
  kind: "no_change",
  status: "recorded",
  needsApproval: false,
  template: null,
  plan: null,
  positions: [],
  rationale: {
    decision: "NO_CHANGE",
    reasonCode: "EVIDENCE_THIN",
    portfolioView: "The account sits inside its bands; the only new thesis rests on one source.",
    evidenceStrength: "weak",
    whatWouldChangeIt: "A second, onchain source for the WBTC flows.",
    themeCodes: ["WBTC_ADD"],
  },
  evaluation: null,
  reasonCode: "EVIDENCE_THIN",
  explanation:
    "The account sits inside its bands; the only new thesis rests on one source. What would change it: a second, onchain source for the WBTC flows.",
  createdAt: iso(NOW - 3600),
  expiresAt: null,
});

export function planCardFixture(over: Partial<PlanCardJson> = {}): PlanCardJson {
  return {
    strategyEpoch: "1",
    planChanges: "ASK_FIRST",
    current: {
      paramId: "plan-fixture",
      template: "target_portfolio@1",
      setBy: "owner",
      setAt: iso(NOW - 86_400),
      strategyEpoch: "1",
      positions: [
        { token: WMON.toLowerCase(), symbol: "WMON", targetWeightBps: 2_500, bandBps: 300 },
        {
          token: CHOG,
          symbol: "CHOG",
          targetWeightBps: 500,
          bandBps: 200,
        },
      ],
      cashTargetBps: 7_000,
      targetWmonBps: null,
    },
    pending: proposalFixture(),
    recent: [],
    noChange: null,
    ...over,
  };
}

// ---- F-U10: the activation sweep ----

const actStep = (
  key: string,
  label: string,
  state: ActivationStepJson["state"],
  over: Partial<ActivationStepJson> = {},
): ActivationStepJson => ({
  key,
  label,
  state,
  result: null,
  reason: null,
  chargedUsdcE6: "0",
  ceilingUsdcE6: "0",
  startedAt: null,
  finishedAt: null,
  ...over,
});
const ACT_LABELS = [
  ["account", "Reading your goal and account"],
  ["scan", "Scanning the market"],
  ["market", "Reading pools and prices"],
  ["dives", "Researching in depth"],
  ["challenge", "Checking risk"],
  ["test", "Testing the plan against your limits"],
  ["plan", "Building a plan"],
  ["active", "Active"],
] as const;

/** The checks as a configured, funded, idle agent passes them (the grant to come). */
export const ACTIVATION_CHECKS = [
  {
    code: "GOAL",
    ok: true,
    message: "Goal: Balanced on the Medium tier (Claude Sonnet 5.5).",
    blocking: true,
  },
  { code: "PROVISIONED", ok: true, message: "The agent is set up to run.", blocking: true },
  {
    code: "ACCOUNT",
    ok: true,
    message: "The trading account is open on the fund agent's set.",
    blocking: true,
  },
  { code: "ACCOUNT_MODE", ok: true, message: "The account is in its normal mode.", blocking: true },
  {
    code: "TRADING_BALANCE",
    ok: true,
    message: "The account holds 40.00 USDC to trade with.",
    blocking: true,
  },
  {
    code: "CREDITS",
    ok: true,
    message: "Credits cover the sweep: 4.99 USDC available, at most 3.80 USDC needed.",
    blocking: true,
  },
  {
    code: "GRANT",
    ok: false,
    message:
      "Your wallet registers the agent's trading permission (30 days at most) when you turn trading on.",
    blocking: false,
  },
  { code: "NOT_BUSY", ok: true, message: "The agent is free to start.", blocking: true },
];

/**
 * A sweep at a given point: the steps before `through` done with fixed
 * result lines, the step at `through` in `state`, the rest pending (or
 * skipped once the sweep has ended). Running steps start about 42 seconds
 * before now, so the elapsed text keeps one width across a capture.
 */
export function activationFixture(
  through: (typeof ACT_LABELS)[number][0],
  state: ActivationStepJson["state"],
  over: Partial<ActivationJson> = {},
): ActivationJson {
  const results: Record<string, Partial<ActivationStepJson>> = {
    account: {
      result: "Balanced on the Medium tier; 40.00 USDC to trade with; 4.99 USDC of credits.",
    },
    scan: {
      result: "3 themes worth a closer look.",
      chargedUsdcE6: "210000",
      ceilingUsdcE6: "500000",
    },
    market: { result: "11 of 12 tokens priced across 42 pools; 9 safety screens fresh." },
    dives: {
      result: "2 themes researched: WBTC_ADD, CHOG_ADD.",
      chargedUsdcE6: "1900000",
      ceilingUsdcE6: "2400000",
    },
    challenge: {
      result: "1 of 2 theses stand after the skeptic's review.",
      chargedUsdcE6: "150000",
      ceilingUsdcE6: "300000",
    },
    test: { result: "Your limits and the envelope are set for the plan." },
    plan: {
      result: "A portfolio of 2 positions proposed.",
      chargedUsdcE6: "400000",
      ceilingUsdcE6: "600000",
    },
    active: { result: "The plan is approved; the agent trades toward it within your limits." },
  };
  const at = ACT_LABELS.findIndex(([k]) => k === through);
  const ended = over.status !== undefined && over.status !== "running";
  const startedAt = new Date(Date.now() - 42_000).toISOString();
  const steps = ACT_LABELS.map(([key, label], i) =>
    i < at
      ? actStep(key, label, "done", { ...results[key], startedAt, finishedAt: startedAt })
      : i === at
        ? actStep(key, label, state, {
            // A running stage has its ceiling and no charge or result yet (it settles at its end).
            ...(state === "done"
              ? results[key]
              : state === "running"
                ? { ceilingUsdcE6: results[key]?.ceilingUsdcE6 ?? "0", startedAt }
                : {}),
          })
        : actStep(key, label, ended ? "skipped" : "pending"),
  );
  const charged = steps.reduce((t, x) => t + BigInt(x.chargedUsdcE6), 0n).toString();
  return {
    activationId: "act-00000000-0000-4000-8000-000000000001",
    status: "running",
    tier: { choice: "MEDIUM", label: "Medium", model: "Claude Sonnet 5.5" },
    ceilingUsdcE6: "3800000",
    chargedUsdcE6: charged,
    steps,
    proposalId: null,
    outcome: {
      title: "Building the first plan",
      message:
        "The agent reads the market, researches the most promising tokens, checks the risks and builds a plan for you to approve. Nothing is traded until you approve it.",
      action: "none",
    },
    startedAt: iso(NOW),
    finishedAt: null,
    ...over,
  };
}

/** The sweep ended with a plan waiting for the owner. */
export const ACTIVATION_PLAN_READY = (): ActivationJson => {
  const v = activationFixture("active", "running", {
    status: "plan_ready",
    proposalId: "prop-00000000-0000-4000-8000-000000000001",
    outcome: {
      title: "Your approval is needed",
      message:
        "The sweep ended with a plan. Read it below and approve it to turn automatic trading on; decline it and nothing is traded.",
      action: "approve",
    },
    finishedAt: iso(NOW + 300),
  });
  return {
    ...v,
    steps: v.steps.map((s) =>
      s.key === "active"
        ? { ...s, result: "Waiting for your approval of the plan.", startedAt: null }
        : s,
    ),
  };
};

/** The sweep stopped in the Dives when the credits ran out. */
export const ACTIVATION_OUT_OF_CREDITS = (): ActivationJson => {
  const v = activationFixture("dives", "failed", {
    status: "out_of_credits",
    outcome: {
      title: "The agent ran out of credits",
      message:
        '"Researching in depth" failed: the credits ran out. Nothing was traded; only the steps that ran were charged. Add USDC to the funding address, then try again.',
      action: "add_credits",
    },
    finishedAt: iso(NOW + 240),
  });
  return {
    ...v,
    chargedUsdcE6: "1110000",
    steps: v.steps.map((s) =>
      s.key === "dives"
        ? {
            ...s,
            result: "1 of 2 themes researched.",
            reason: "the credits ran out",
            chargedUsdcE6: "900000",
            ceilingUsdcE6: "2400000",
          }
        : s,
    ),
  };
};

export function activationReadFixture(over: Partial<ActivationReadJson> = {}): ActivationReadJson {
  return {
    agentId: "7",
    available: true,
    activation: null,
    checks: ACTIVATION_CHECKS,
    ceilingUsdcE6: "3800000",
    tier: { choice: "MEDIUM", label: "Medium" },
    ...over,
  };
}

/* F-U11: the window as the control API builds it. Forty-nine hourly readings end at NOW. */
const WIN_E18 = 10n ** 18n;
const winAt = (hoursBeforeNow: number) => iso(NOW - hoursBeforeNow * 3_600);
const winRow = (over: Partial<WindowJson["holdings"][number]> & { symbol: string }) => ({
  token: null,
  decimals: 18,
  amountRaw: WIN_E18.toString(),
  isCash: false,
  valueUsdcE6: "10000000",
  shareBps: 1_000,
  costBasisUsdcE6: "9000000",
  gainUsdcE6: "1000000",
  gainBps: 1_111,
  ...over,
});
export const WINDOW_HOLDINGS: WindowJson["holdings"] = [
  winRow({
    token: USDC,
    symbol: "USDC",
    decimals: 6,
    amountRaw: "58400000",
    isCash: true,
    valueUsdcE6: "58400000",
    shareBps: 5_573,
    costBasisUsdcE6: "58400000",
    gainUsdcE6: null,
    gainBps: null,
  }),
  winRow({
    token: WBTC,
    symbol: "WBTC",
    decimals: 8,
    amountRaw: "31000",
    valueUsdcE6: "34100000",
    shareBps: 3_254,
    costBasisUsdcE6: "31000000",
    gainUsdcE6: "3100000",
    gainBps: 1_000,
  }),
  winRow({
    token: WMON,
    symbol: "WMON",
    amountRaw: (480n * WIN_E18).toString(),
    valueUsdcE6: "12288000",
    shareBps: 1_172,
    costBasisUsdcE6: "13200000",
    gainUsdcE6: "-912000",
    gainBps: -690,
  }),
  winRow({
    token: CHOG,
    symbol: "CHOG",
    amountRaw: (2_000n * WIN_E18).toString(),
    valueUsdcE6: null,
    shareBps: null,
    costBasisUsdcE6: "1500000",
    gainUsdcE6: null,
    gainBps: null,
  }),
];
export const WINDOW_SERIES: WindowJson["series"] = Array.from({ length: 49 }, (_, i) => {
  const wave = Math.round(Math.sin(i / 5) * 180 + i * 9 - (i > 30 && i < 38 ? 260 : 0));
  return {
    at: winAt(48 - i),
    perUnitE18: (WIN_E18 + BigInt(wave) * 10n ** 14n).toString(),
    valueUsdcE6: String(100_000_000 + wave * 10_000 + (i >= 20 ? 20_000_000 : 0)),
    reason: i === 7 || i === 22 || i === 40 ? "trade" : "interval",
  };
});
export const WINDOW_MARKS: WindowJson["marks"] = [
  {
    at: winAt(41),
    intentId: "intent-w1",
    side: "buy",
    symbol: "WBTC",
    amountRaw: "31000",
    decimals: 8,
    usdcE6: "31000000",
    txHash: "0xab",
  },
  {
    at: winAt(26),
    intentId: "intent-w2",
    side: "buy",
    symbol: "WMON",
    amountRaw: (600n * WIN_E18).toString(),
    decimals: 18,
    usdcE6: "16500000",
    txHash: "0xcd",
  },
  {
    at: winAt(8),
    intentId: "intent-w3",
    side: "sell",
    symbol: "WMON",
    amountRaw: (120n * WIN_E18).toString(),
    decimals: 18,
    usdcE6: "3300000",
    txHash: null,
  },
];

export function windowFixture(over: Partial<WindowJson> = {}): WindowJson {
  return {
    agentId: "7",
    account: ACCOUNT,
    custody: "v3",
    asOf: { at: iso(NOW), block: "109670900", live: true },
    totalValueUsdcE6: "104788000",
    holdings: WINDOW_HOLDINGS,
    series: WINDOW_SERIES,
    marks: WINDOW_MARKS,
    closed: [
      { symbol: "AUSD", spentUsdcE6: "5000000", receivedUsdcE6: "5200000", profitable: true },
    ],
    scores: {
      returnSinceStart: { ok: true, bps: 412, since: winAt(48), asOf: iso(NOW) },
      maxDrawdown: { ok: true, bps: 318, peakAt: winAt(19), troughAt: winAt(15) },
      winShare: { ok: true, bps: 10_000, closed: 1, won: 1 },
    },
    hundred: { ok: true, now: "104.12", usdc: "100.00", since: winAt(48) },
    history: { points: 49, from: winAt(48), to: iso(NOW), capped: false },
    ...over,
  };
}

/** A new account: one reading, nothing closed, every score waiting. */
export const WINDOW_WAITING = (): WindowJson =>
  windowFixture({
    asOf: { at: iso(NOW - 600), block: "109670880", live: false },
    totalValueUsdcE6: "40000000",
    holdings: [WINDOW_HOLDINGS[0] as WindowJson["holdings"][number]].map((h) => ({
      ...h,
      amountRaw: "40000000",
      valueUsdcE6: "40000000",
      shareBps: 10_000,
      costBasisUsdcE6: "40000000",
    })),
    series: [
      {
        at: iso(NOW - 600),
        perUnitE18: WIN_E18.toString(),
        valueUsdcE6: "40000000",
        reason: "interval",
      },
    ],
    marks: [],
    closed: [],
    scores: {
      returnSinceStart: {
        ok: false,
        reason: "Not enough data yet: the account needs at least two readings.",
      },
      maxDrawdown: {
        ok: false,
        reason: "Not enough data yet: the account needs at least two readings.",
      },
      winShare: { ok: false, reason: "Not enough data yet: no position has been closed." },
    },
    hundred: { ok: false, reason: "Not enough data yet: the account needs at least two readings." },
    history: { points: 1, from: iso(NOW - 600), to: iso(NOW - 600), capped: false },
  });

/** No trading account: the window is empty. */
export const WINDOW_NO_ACCOUNT = (): WindowJson =>
  windowFixture({
    account: null,
    custody: null,
    asOf: null,
    totalValueUsdcE6: null,
    holdings: [],
    series: [],
    marks: [],
    closed: [],
    scores: {
      returnSinceStart: {
        ok: false,
        reason: "Not enough data yet: the account needs at least two readings.",
      },
      maxDrawdown: {
        ok: false,
        reason: "Not enough data yet: the account needs at least two readings.",
      },
      winShare: { ok: false, reason: "Not enough data yet: no position has been closed." },
    },
    hundred: { ok: false, reason: "Not enough data yet: the account needs at least two readings." },
    history: { points: 0, from: null, to: null, capped: false },
  });

export class FakeTrading {
  portfolio: PortfolioJson;
  arming: ArmingJson = UNARMED;
  /** F-U10: the sweep as the owner reads it; null answers 503, as a stack without the orchestrator would. */
  activation: ActivationReadJson | null = null;
  /** What each later read of the sweep shows, one per `advance()`, once a sweep has started. */
  activationScript: ActivationJson[] = [];
  /** How many sweeps the page started. */
  starts = 0;
  /** F-U9: the plan card; null answers 503 as an agent off the trading set would. */
  planCard: PlanCardJson | null = null;
  /** Every proposal decision the page sent: "approve <id>" or "reject <id>". */
  readonly decisions: string[] = [];
  intents: IntentJson[] = [];
  /** F-U11: the window as the owner reads it. */
  window: WindowJson = windowFixture();
  /** P3-U10: the Research page's read; null answers 503 as a stack without the orchestrator would. */
  research: ResearchJson | null = null;
  /** P3-U10: the terminal's lines, served from the cursor the page sends; `advanceTerminal` adds more. */
  terminalLines: TerminalEventJson[] = [];
  terminalLive = false;
  terminalCycle: TerminalJson["cycle"] = null;
  /** Reads of the terminal that fail, for the reconnecting state; each failure answers 502 once. */
  terminalFailures = 0;
  /** Every terminal read's cursor, in order. */
  readonly terminalReads: number[] = [];
  /** Every pause the page sent. */
  readonly pauses: boolean[] = [];
  /** A-80: when set, the API serves the fund agent's set and this takes the place of `portfolio`. */
  portfolioV3: PortfolioV3Json | null = null;
  /** Extra blocked reasons beyond the intents' own (for example NOT_ARMED). */
  readonly calls: string[] = [];
  private readonly owner: Address;

  constructor(chain: FakeChain, owner: Address, portfolio = portfolioFixture(owner)) {
    this.owner = owner;
    this.portfolio = portfolio;
    chain.onSend = (tx) => this.onSend(tx);
  }

  /** F-U10: the sweep moves to its next scripted view; the plan card gains its proposal at the end. */
  advance() {
    const next = this.activationScript.shift();
    if (!next || !this.activation) return;
    this.activation = { ...this.activation, activation: next };
    if (next.proposalId && this.planCard && !this.planCard.pending)
      this.planCard = {
        ...this.planCard,
        pending: proposalFixture({ proposalId: next.proposalId }),
      };
  }

  arm(state: ArmingJson["state"], over: Partial<ArmingJson> = {}) {
    this.arming = {
      ...UNARMED,
      state,
      armingId: state === "unarmed" ? null : "arming-fixture",
      validUntil: state === "unarmed" ? null : NOW + 29 * 86_400,
      validUntilDate: state === "unarmed" ? null : "2026-11-05",
      armedAt: state === "armed" ? iso(NOW - 7200) : null,
      ...over,
    };
  }

  why(): WhyNotTradedJson {
    const reasons = this.intents
      .filter((i) => i.status === "rejected" || i.status === "failed")
      .flatMap((i) => i.blockers.map((b) => ({ ...b, intentId: i.intentId, at: i.createdAt })));
    return {
      armingState: this.arming.state,
      armingEnded: this.arming.ended
        ? { reason: this.arming.ended.reason, message: this.arming.ended.message }
        : null,
      reasons:
        this.arming.state === "unarmed"
          ? [
              {
                code: "NOT_ARMED",
                message: "The agent is not armed, so each trade waits for the owner's approval.",
                clears: "by_the_owner",
                clearsAt: null,
                hint: "The owner arms the agent.",
                intentId: null,
                at: iso(NOW),
              },
              ...reasons,
            ]
          : reasons,
      waitingForApproval: this.intents.filter((i) => i.status === "awaiting_approval").length,
    };
  }

  private add(path: "balances" | "wallet", token: Address, delta: bigint) {
    const p = this.portfolio;
    const usdc = token.toLowerCase() === USDC.toLowerCase();
    const cur = path === "balances" ? p.balances : p.wallet;
    const key = usdc ? "usdcE6" : "wmonWei";
    const next = { ...cur, [key]: (BigInt(cur[key]) + delta).toString() };
    this.portfolio = { ...p, [path]: next } as PortfolioJson;
  }

  /** A-80: a held token's or the wallet's balance on the fund set moves by `delta`. */
  private v3Add(where: "holdings" | "wallet", token: Address, delta: bigint, value = 0n) {
    const p = this.portfolioV3;
    if (!p) return;
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    if (where === "wallet") {
      this.portfolioV3 = {
        ...p,
        tokens: p.tokens.map((t) =>
          same(t.address, token)
            ? { ...t, walletRaw: (BigInt(t.walletRaw) + delta).toString() }
            : t,
        ),
      };
      return;
    }
    const known = p.holdings.find((h) => same(h.token, token));
    const meta = p.tokens.find((t) => same(t.address, token));
    const line = known ?? {
      token,
      symbol: meta?.symbol ?? "?",
      decimals: meta?.decimals ?? 18,
      amountRaw: "0",
      freeRaw: "0",
      costBasisUsdcE6: "0",
      priceE18: meta?.price.priceE18 ?? null,
      priceReason: "OK",
      valueUsdcE6: "0",
      claimableRaw: "0",
    };
    const amount = BigInt(line.amountRaw) + delta;
    const price = line.priceE18 === null ? null : BigInt(line.priceE18);
    const next = {
      ...line,
      amountRaw: amount.toString(),
      freeRaw: amount.toString(),
      valueUsdcE6:
        price === null ? null : ((amount * price) / 10n ** BigInt(12 + line.decimals)).toString(),
    };
    const holdings = (
      known ? p.holdings.map((h) => (same(h.token, token) ? next : h)) : [...p.holdings, next]
    ).filter((h) => BigInt(h.amountRaw) > 0n);
    const nav = holdings.reduce((t, h) => t + BigInt(h.valueUsdcE6 ?? "0"), 0n);
    this.portfolioV3 = {
      ...p,
      holdings,
      navUsdcE6: nav.toString(),
      caps: {
        ...p.caps,
        principalUsdcE6: (BigInt(p.caps.principalUsdcE6) + value).toString(),
        platformTotalUsdcE6: (BigInt(p.caps.platformTotalUsdcE6) + value).toString(),
      },
    };
  }

  /** A-80: the fund set's factory, account and the older v2 account, as the contracts would apply the wallet's calls. */
  private onSendV3(to: string, data: Hex): boolean {
    const p = this.portfolioV3;
    if (!p) return false;
    if (to === FACTORY_V3.toLowerCase()) {
      decodeFunctionData({ abi: FACTORY_ABI, data });
      this.calls.push("createPersonalAccount:v3");
      this.portfolioV3 = {
        ...p,
        account: ACCOUNT_V3,
        mode: "NORMAL",
        navUsdcE6: "0",
        breaker: {
          navUsdcE6: "0",
          perUnitE18: "1000000000000000000",
          peakE18: "1000000000000000000",
          drawdownBps: 0,
        },
        peak7dE18: "1000000000000000000",
      };
      return true;
    }
    if (to === ACCOUNT_V3.toLowerCase()) {
      const call = decodeFunctionData({ abi: ACCOUNT_ABI, data });
      this.calls.push(`${call.functionName}:v3`);
      if (call.functionName === "deposit") {
        const [token, amount] = call.args as readonly [Address, bigint];
        const meta = p.tokens.find((t) => t.address.toLowerCase() === token.toLowerCase());
        const value =
          token.toLowerCase() === USDC.toLowerCase() || !meta
            ? amount
            : (amount * BigInt(meta.price.priceE18)) / 10n ** BigInt(12 + meta.decimals);
        this.v3Add("holdings", token, amount, value);
        this.v3Add("wallet", token, -amount);
      } else if (call.functionName === "withdraw") {
        const [token, amount] = call.args as readonly [Address, bigint, Address];
        this.v3Add("holdings", token, -amount);
        this.v3Add("wallet", token, amount);
      } else if (call.functionName === "withdrawAll") {
        for (const h of p.holdings) {
          this.v3Add("wallet", h.token, BigInt(h.amountRaw));
          this.v3Add("holdings", h.token, -BigInt(h.amountRaw));
        }
      }
      return true;
    }
    if (p.legacy && to === p.legacy.account.toLowerCase()) {
      const call = decodeFunctionData({ abi: ACCOUNT_ABI, data });
      this.calls.push(`${call.functionName}:older`);
      if (call.functionName === "withdrawAll") {
        this.v3Add("wallet", USDC, BigInt(p.legacy.usdcE6));
        this.v3Add("wallet", WMON, BigInt(p.legacy.wmonWei));
        const l = this.portfolioV3?.legacy;
        if (this.portfolioV3 && l)
          this.portfolioV3 = { ...this.portfolioV3, legacy: { ...l, usdcE6: "0", wmonWei: "0" } };
      }
      return true;
    }
    return false;
  }

  /** The mock wallet's transactions, as the contracts would apply them. */
  private onSend(tx: { from: Address; to: Address; data: Hex }) {
    const to = tx.to.toLowerCase();
    if (this.onSendV3(to, tx.data)) return;
    if (to === FACTORY.toLowerCase()) {
      decodeFunctionData({ abi: FACTORY_ABI, data: tx.data });
      this.calls.push("createPersonalAccount");
      this.portfolio = portfolioFixture(this.owner, {
        ...this.portfolio,
        account: ACCOUNT,
        mode: "NORMAL",
        balances: { usdcE6: "0", wmonWei: "0" },
        breaker: {
          navUsdcE6: "0",
          perUnitE18: "1000000000000000000",
          peakE18: "1000000000000000000",
          drawdownBps: 0,
        },
        peak7dE18: "1000000000000000000",
      });
      return;
    }
    if (to === USDC.toLowerCase() || to === WMON.toLowerCase()) {
      const { functionName } = decodeFunctionData({ abi: ERC20_ABI, data: tx.data });
      // A transfer is a credit deposit, which the fake API's credits handler takes.
      if (functionName !== "transfer") this.calls.push(functionName);
      return;
    }
    if (to === EXECUTOR.toLowerCase()) {
      const { functionName } = decodeFunctionData({ abi: GRANT_ABI, data: tx.data });
      this.calls.push(functionName);
      return;
    }
    if (to === ACCOUNT.toLowerCase()) {
      const call = decodeFunctionData({ abi: ACCOUNT_ABI, data: tx.data });
      this.calls.push(call.functionName);
      if (call.functionName === "deposit") {
        const [token, value] = call.args as readonly [Address, bigint, ...unknown[]];
        this.add("balances", token, value);
        this.add("wallet", token, -value);
        const p = this.portfolio;
        this.portfolio = {
          ...p,
          caps: {
            ...p.caps,
            principalUsdcE6: (BigInt(p.caps.principalUsdcE6) + value).toString(),
            platformTotalUsdcE6: (BigInt(p.caps.platformTotalUsdcE6) + value).toString(),
          },
        };
      } else if (call.functionName === "withdraw") {
        const [token, value] = call.args as readonly [Address, bigint, ...unknown[]];
        this.add("balances", token, -value);
        this.add("wallet", token, value);
      } else if (call.functionName === "claim") {
        const [token] = call.args as readonly [Address, ...unknown[]];
        const usdc = token.toLowerCase() === USDC.toLowerCase();
        const held = BigInt(
          usdc ? this.portfolio.claimable.usdcE6 : this.portfolio.claimable.wmonWei,
        );
        this.add("wallet", token, held);
        this.portfolio = {
          ...this.portfolio,
          claimable: { ...this.portfolio.claimable, [usdc ? "usdcE6" : "wmonWei"]: "0" },
        };
      }
      return;
    }
    // Any other call (a transfer to a funding address) is the credits handler's.
  }

  /** Answers a trading route on an already checked owner session; null when it is not one. */
  answer(
    id: bigint,
    rest: string,
    method: string,
    query: URLSearchParams = new URLSearchParams(),
  ): { status: number; body: unknown } | null {
    const agentId = id.toString();
    if (rest === "research" && method === "GET")
      return this.research
        ? { status: 200, body: { ...this.research, agentId } }
        : {
            status: 503,
            body: { error: "not_configured", message: "The orchestrator is not reachable." },
          };
    if (rest === "terminal" && method === "GET") {
      if (!this.research)
        return {
          status: 503,
          body: { error: "not_configured", message: "The orchestrator is not reachable." },
        };
      const after = Number(query.get("after") ?? "0");
      this.terminalReads.push(after);
      if (this.terminalFailures > 0) {
        this.terminalFailures -= 1;
        return {
          status: 502,
          body: { error: "internal", message: "the orchestrator answered 502" },
        };
      }
      return {
        status: 200,
        body: {
          agentId,
          cycle: this.terminalCycle,
          live: this.terminalLive,
          events: this.terminalLines.filter((e) => e.seq > after),
          last: this.terminalLines.at(-1)?.seq ?? 0,
        },
      };
    }
    if (rest === "research/pause" && method === "POST") {
      if (!this.research)
        return {
          status: 503,
          body: { error: "not_configured", message: "The orchestrator is not reachable." },
        };
      const paused =
        this.pauses.length % 2 === 0
          ? !this.research.schedule.paused
          : this.research.schedule.paused;
      this.pauses.push(paused);
      this.research = { ...this.research, schedule: { ...this.research.schedule, paused } };
      return { status: 200, body: { agentId, paused } };
    }
    if (rest === "portfolio" && method === "GET")
      return { status: 200, body: { portfolio: this.portfolioV3 ?? this.portfolio } };
    if (rest === "window" && method === "GET")
      return { status: 200, body: { window: this.window } };
    if (rest === "plan-card" && method === "GET")
      return this.planCard
        ? { status: 200, body: { agentId, ...this.planCard } }
        : { status: 503, body: { error: "not_deployed", message: "No trading set here." } };
    const decision = /^proposals\/([\w-]+)\/(approve|reject)$/.exec(rest);
    if (decision && method === "POST") {
      const [, proposalId, action] = decision;
      this.decisions.push(`${action} ${proposalId}`);
      const pending = this.planCard?.pending;
      if (!this.planCard || !pending || pending.proposalId !== proposalId)
        return { status: 409, body: { error: "not_waiting", message: "No proposal is waiting." } };
      const decided: ProposalJson = {
        ...pending,
        status: action === "approve" ? "applied" : "declined",
        decidedBy: this.owner,
        decidedAt: iso(NOW),
      };
      // F-U10 (D-291): approving the sweep's plan arms the agent and ends the sweep as active.
      const sweep = this.activation?.activation;
      const arms =
        action === "approve" &&
        sweep?.status === "plan_ready" &&
        sweep.proposalId === proposalId &&
        this.arming.state === "awaiting_first_trade";
      if (arms && this.activation && sweep) {
        this.arm("armed");
        this.activation = {
          ...this.activation,
          activation: {
            ...sweep,
            status: "active",
            steps: sweep.steps.map((s) =>
              s.key === "active"
                ? {
                    ...s,
                    state: "done",
                    result: "The plan is approved; the agent trades toward it within your limits.",
                  }
                : s,
            ),
            outcome: {
              title: "Automatic trading is on",
              message:
                "The agent trades toward its plan within your limits, one capped leg at a time, and keeps researching on its own.",
              action: "none",
            },
          },
        };
      }
      this.planCard = {
        ...this.planCard,
        strategyEpoch: action === "approve" ? "2" : this.planCard.strategyEpoch,
        current:
          action === "approve"
            ? {
                paramId: "plan-approved",
                template: "target_portfolio@1",
                setBy: "owner",
                setAt: iso(NOW),
                strategyEpoch: "2",
                positions: pending.positions
                  .filter((p) => p.action !== "EXIT")
                  .map((p) => ({
                    token: p.token,
                    symbol: p.symbol,
                    targetWeightBps: p.targetWeightBps,
                    bandBps: p.bandBps,
                  })),
                cashTargetBps: pending.plan?.cashTargetBps ?? null,
                targetWmonBps: null,
              }
            : this.planCard.current,
        pending: null,
        recent: [decided, ...this.planCard.recent],
      };
      return { status: 200, body: { agentId, proposal: decided, armed: arms } };
    }
    if (rest === "activation" && method === "GET")
      return this.activation
        ? { status: 200, body: { ...this.activation, agentId } }
        : {
            status: 200,
            body: {
              agentId,
              available: false,
              activation: null,
              checks: [],
              ceilingUsdcE6: "0",
              tier: { choice: "MEDIUM", label: "Medium" },
            },
          };
    if (rest === "activation" && method === "POST") {
      if (!this.activation)
        return {
          status: 503,
          body: { error: "not_configured", message: "The orchestrator is not reachable." },
        };
      if (this.arming.state === "unarmed")
        return {
          status: 409,
          body: {
            error: "activation_grant",
            message:
              "Register the agent's trading permission from your wallet first; the sweep starts once it is on chain.",
            checks: this.activation.checks,
          },
        };
      const blocked = this.activation.checks.find((c) => !c.ok && c.blocking);
      if (blocked)
        return {
          status: 409,
          body: {
            error: `activation_${blocked.code.toLowerCase()}`,
            message: blocked.message,
            checks: this.activation.checks,
          },
        };
      this.starts += 1;
      const first = this.activationScript.shift() ?? activationFixture("scan", "running");
      this.activation = { ...this.activation, activation: first };
      return { status: 202, body: { agentId, activation: first } };
    }
    if (rest === "arming" && method === "GET")
      return {
        status: 200,
        body: {
          arming: this.arming,
          fundingAddress: FUNDING,
          grantCall: {
            to: EXECUTOR,
            data: encodeFunctionData({
              abi: GRANT_ABI,
              functionName: "registerSession",
              args: [id, FUNDING, BigInt(NOW + 30 * 86_400 - 60)],
            }),
            value: "0",
          },
          maxGrantDays: 30,
        },
      };
    if (rest === "arming" && method === "POST") {
      if (!this.calls.includes("registerSession"))
        return {
          status: 409,
          body: {
            error: "grant_invalid",
            message: "No trading permission is registered for this agent yet.",
          },
        };
      this.arm("awaiting_first_trade");
      return { status: 201, body: { agentId, renewed: false, arming: this.arming } };
    }
    if (rest === "disarm" && method === "POST") {
      this.arming = {
        ...UNARMED,
        armingId: "arming-fixture",
        ended: {
          reason: "disarmed",
          message: "The owner disarmed the agent.",
          at: iso(NOW),
          revokedOnchain: false,
        },
      };
      return {
        status: 200,
        body: {
          agentId,
          disarmed: true,
          arming: this.arming,
          revokeCall: {
            to: EXECUTOR,
            data: encodeFunctionData({ abi: GRANT_ABI, functionName: "revokeSession", args: [id] }),
            value: "0",
          },
        },
      };
    }
    if (rest === "intents" && method === "GET")
      return { status: 200, body: { intents: this.intents } };
    const decide = /^intents\/(intent-[0-9a-f-]{36})\/(approve|reject)$/.exec(rest);
    if (decide && method === "POST") {
      const intent = this.intents.find((i) => i.intentId === decide[1]);
      if (!intent)
        return {
          status: 404,
          body: { error: "not_found", message: "No such intent for this agent." },
        };
      if (intent.status !== "awaiting_approval")
        return {
          status: 409,
          body: { error: "not_waiting", message: "This intent is not waiting for approval." },
        };
      const replace = (next: IntentJson) => {
        this.intents = this.intents.map((i) => (i.intentId === next.intentId ? next : i));
        return next;
      };
      if (decide[2] === "reject") {
        const next = replace({ ...intent, status: "cancelled", failure: "Rejected by the owner." });
        return { status: 200, body: { agentId, intent: next } };
      }
      if (this.arming.state === "unarmed")
        return { status: 409, body: { error: "not_armed", message: "Arm the agent first." } };
      const arms = this.arming.state === "awaiting_first_trade";
      if (arms) this.arm("armed", { firstIntentId: intent.intentId });
      const next = replace({ ...intent, status: "approved", approvedBy: "owner" });
      return { status: 200, body: { agentId, intent: next, armed: arms } };
    }
    return null;
  }
}
