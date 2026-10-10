import {
  type Address,
  type Hex,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  parseAbi,
} from "viem";
import type {
  ArmingJson,
  IntentJson,
  PortfolioJson,
  WhyNotTradedJson,
  PlanCardJson,
  ProposalJson,
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
export const NOW = 1_791_374_400;
const iso = (s: number) => new Date(s * 1000).toISOString();
const PX = 25_000_000_000_000_000n;

const GRANT_ABI = parseAbi([
  "function registerSession(uint256 agentId, address key, uint64 validUntil)",
  "function revokeSession(uint256 agentId)",
]);

export function portfolioFixture(owner: Address, over: Partial<PortfolioJson> = {}): PortfolioJson {
  return {
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
        token: "0x0555e30da8f98308edb960aa94c0db47230d2b9c",
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
          token: "0x00000000000000000000000000000000000c0de5",
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

export class FakeTrading {
  portfolio: PortfolioJson;
  arming: ArmingJson = UNARMED;
  /** F-U9: the plan card; null answers 503 as an agent off the trading set would. */
  planCard: PlanCardJson | null = null;
  /** Every proposal decision the page sent: "approve <id>" or "reject <id>". */
  readonly decisions: string[] = [];
  intents: IntentJson[] = [];
  /** Extra blocked reasons beyond the intents' own (for example NOT_ARMED). */
  readonly calls: string[] = [];
  private readonly owner: Address;

  constructor(chain: FakeChain, owner: Address, portfolio = portfolioFixture(owner)) {
    this.owner = owner;
    this.portfolio = portfolio;
    chain.onSend = (tx) => this.onSend(tx);
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

  /** The mock wallet's transactions, as the contracts would apply them. */
  private onSend(tx: { from: Address; to: Address; data: Hex }) {
    const to = tx.to.toLowerCase();
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
  answer(id: bigint, rest: string, method: string): { status: number; body: unknown } | null {
    const agentId = id.toString();
    if (rest === "portfolio" && method === "GET")
      return { status: 200, body: { portfolio: this.portfolio } };
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
      return { status: 200, body: { agentId, proposal: decided } };
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
