import { describe, expect, it } from "vitest";
import {
  AccountRecordSchema,
  AgentRecordSchema,
  DomainEventSchema,
  IntentRecordSchema,
  RECORD_SCHEMAS,
} from "./index.ts";

const ADDR = "0x1111111111111111111111111111111111111111";
const HASH = `0x${"ab".repeat(32)}`;

const fixtures = {
  AgentRecord: {
    environment: "fork",
    agentId: "7",
    tier: "medium",
    owner: ADDR,
    tokenBoundAccount: ADDR,
    ownerEpoch: "1",
    configEpoch: "3",
    state: "RUNNING",
  },
  AccountRecord: {
    environment: "mainnet-beta",
    agentId: "7",
    kind: "strategy_vault",
    address: ADDR,
    mode: "HANDOVER",
  },
  IntentRecord: {
    environment: "testnet",
    intentId: "4f0b8a0e-6c1d-4f1e-9a54-3d2f0c9b7e21",
    agentId: "7",
    clientRequestId: "req-0001-abcd",
    intent: {
      kind: "swap",
      schemaVersion: 1,
      account: "personal",
      sell: "USDC",
      buy: "WMON",
      sellAmountRaw: "25000000",
      reason: "Buy the dip",
      clientRequestId: "req-0001-abcd",
    },
    status: "rejected",
    rejections: ["TRADE_SIZE_EXCEEDED", "TURNOVER_CAP"],
    createdAt: 1_790_000_000,
  },
  DomainEvent: {
    environment: "fork",
    type: "UsageSettled",
    occurredAt: 1_790_000_000,
    agentId: "7",
    amountUsdcE6: "1250000",
    periodId: 12,
    usageHash: HASH,
  },
} as const;

describe("records carry the environment label", () => {
  it.each(Object.keys(RECORD_SCHEMAS) as (keyof typeof RECORD_SCHEMAS)[])(
    "%s validates its fixture",
    (name) => {
      expect(RECORD_SCHEMAS[name].safeParse(fixtures[name]).success).toBe(true);
    },
  );

  it.each(Object.keys(RECORD_SCHEMAS) as (keyof typeof RECORD_SCHEMAS)[])(
    "%s requires an environment",
    (name) => {
      const without = Object.fromEntries(
        Object.entries(fixtures[name]).filter(([key]) => key !== "environment"),
      );
      expect(RECORD_SCHEMAS[name].safeParse(without).success).toBe(false);
      expect(
        RECORD_SCHEMAS[name].safeParse({ ...fixtures[name], environment: "mainnet" }).success,
      ).toBe(false);
    },
  );

  it("parses identifiers and amounts to exact bigints", () => {
    const agent = AgentRecordSchema.parse(fixtures.AgentRecord);
    expect(agent.agentId).toBe(7n);
    const ev = DomainEventSchema.parse(fixtures.DomainEvent);
    expect(ev.type === "UsageSettled" && ev.amountUsdcE6).toBe(1_250_000n);
  });

  it("keeps account modes consistent with the account kind", () => {
    const base = { environment: "fork", agentId: "7", address: ADDR };
    expect(
      AccountRecordSchema.safeParse({ ...base, kind: "funding_address", mode: null }).success,
    ).toBe(true);
    expect(
      AccountRecordSchema.safeParse({ ...base, kind: "funding_address", mode: "NORMAL" }).success,
    ).toBe(false);
    expect(
      AccountRecordSchema.safeParse({ ...base, kind: "personal_account", mode: null }).success,
    ).toBe(false);
    expect(
      AccountRecordSchema.safeParse({ ...base, kind: "personal_account", mode: "HANDOVER" })
        .success,
    ).toBe(false);
    expect(
      AccountRecordSchema.safeParse({ ...base, kind: "personal_account", mode: "REDUCE_ONLY" })
        .success,
    ).toBe(true);
  });

  it("allows the unknown status for a timed-out submission", () => {
    expect(
      IntentRecordSchema.safeParse({ ...fixtures.IntentRecord, status: "unknown", rejections: [] })
        .success,
    ).toBe(true);
  });
});
