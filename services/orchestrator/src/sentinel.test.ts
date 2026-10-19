import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import type { Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type Breach,
  DEFAULT_RULES,
  Sentinel,
  type SentinelChain,
  type SentinelDeps,
  type SentinelObservation,
  SentinelStore,
  assess,
  baselineFrom,
  stateFor,
  tightens,
} from "./sentinel.ts";
import { setAgentState } from "./sentinel-wiring.ts";
import { CHAIN, indexAgent } from "./testing.ts";

/**
 * The Risk Sentinel (P4-U2): every rule as a pure function over an
 * observation, then the service over Postgres with a fake sentinel key that
 * records what it was asked, so the once-per-condition rule, the
 * tighten-only rule and the agent states are proven without a chain.
 */
const T0 = new Date("2026-10-11T12:00:00Z");
const ACCOUNT = "0x00000000000000000000000000000000000ac003" as Hex;
const WMON = "0x00000000000000000000000000000000000000aa" as Hex;
const WBTC = "0x00000000000000000000000000000000000000ab" as Hex;

const held = (over: Partial<SentinelObservation["held"][number]> = {}) => ({
  token: WMON,
  symbol: "WMON",
  priceReason: "OK",
  priceAgeSeconds: 30,
  screenVerdict: "passed" as const,
  registryStatus: "listed" as const,
  liquidityUsd: 1_000_000,
  ...over,
});

const observation = (over: Partial<SentinelObservation> = {}): SentinelObservation => ({
  at: T0,
  account: ACCOUNT,
  mode: "NORMAL",
  depositsClosed: false,
  drawdownBps: 300,
  navReadable: true,
  held: [held()],
  creditsRestricted: false,
  gasWei: 10n ** 18n,
  gasNeededWei: 10n ** 16n,
  signerAlive: true,
  chainAgeSeconds: 5,
  executorPaused: false,
  adapterAllowed: true,
  arming: { validUntil: 2_000_000_000n, ownerEpoch: 1n },
  ownerEpoch: 1n,
  agentState: "RUNNING",
  ...over,
});

const codes = (o: SentinelObservation, baseline = baselineFrom(observation())) =>
  assess(o, DEFAULT_RULES, baseline).map((b) => `${b.code}:${b.action ?? "-"}:${b.state ?? "-"}`);

describe("what the sentinel sees as a breach", () => {
  it("nothing while everything is in order", () => {
    expect(codes(observation())).toEqual([]);
    expect(codes(observation({ account: null, mode: null, held: [] }))).toEqual([]);
  });

  it("a stale or unusable feed of a held token, or an account that cannot be valued: reduce-only and an incident", () => {
    expect(codes(observation({ held: [held({ priceReason: "STALE" })] }))).toEqual([
      "STALE_FEED:REDUCE_ONLY:INCIDENT",
    ]);
    expect(codes(observation({ held: [held({ priceAgeSeconds: 4_000 })] }))).toEqual([
      "STALE_FEED:REDUCE_ONLY:INCIDENT",
    ]);
    expect(codes(observation({ navReadable: false, drawdownBps: null }))).toEqual([
      "STALE_FEED:REDUCE_ONLY:INCIDENT",
    ]);
    const b = assess(
      observation({ held: [held({ priceReason: "FEED_REVERTED", priceAgeSeconds: null })] }),
      DEFAULT_RULES,
      null,
    )[0] as Breach;
    expect(b.reason).toBe("WMON: feed reverted");
  });

  it("a drawdown of 12% sets reduce-only and 22% pauses, never both", () => {
    expect(codes(observation({ drawdownBps: 1_199 }))).toEqual([]);
    expect(codes(observation({ drawdownBps: 1_200 }))).toEqual(["DRAWDOWN_12:REDUCE_ONLY:-"]);
    expect(codes(observation({ drawdownBps: 2_200 }))).toEqual(["DRAWDOWN_22:PAUSE:-"]);
    expect(assess(observation({ drawdownBps: 2_350 }), DEFAULT_RULES, null)[0]?.reason).toBe(
      "23.5% below the 7-day peak",
    );
  });

  it("a held token that failed its re-screen or went sell-only, and one whose liquidity halved or fell under the floor", () => {
    expect(codes(observation({ held: [held({ screenVerdict: "refused" })] }))).toEqual([
      "RESCREEN_FAILED:REDUCE_ONLY:-",
    ]);
    expect(codes(observation({ held: [held({ registryStatus: "sell_only" })] }))).toEqual([
      "RESCREEN_FAILED:REDUCE_ONLY:-",
    ]);
    expect(codes(observation({ held: [held({ liquidityUsd: 500_000 })] }))).toEqual([
      "LIQUIDITY_DROP:REDUCE_ONLY:-",
    ]);
    expect(codes(observation({ held: [held({ liquidityUsd: 600_000 })] }))).toEqual([]);
    expect(
      codes(observation({ held: [held({ token: WBTC, symbol: "WBTC", liquidityUsd: 20_000 })] })),
    ).toEqual(["LIQUIDITY_DROP:REDUCE_ONLY:-"]);
    // A token the baseline never saw is judged against the floor alone.
    expect(
      codes(observation({ held: [held({ token: WBTC, symbol: "WBTC", liquidityUsd: 400_000 })] })),
    ).toEqual([]);
  });

  it("no credits restricts; low gas, a stopped signer, a stale chain, a paused Executor, an expired mandate and a new owner are incidents", () => {
    expect(codes(observation({ creditsRestricted: true }))).toEqual(["ZERO_CREDITS:-:RESTRICTED"]);
    expect(codes(observation({ gasWei: 1n }))).toEqual(["GAS_LOW:-:INCIDENT"]);
    // With no credits the gas is not the question.
    expect(codes(observation({ gasWei: 1n, creditsRestricted: true }))).toEqual([
      "ZERO_CREDITS:-:RESTRICTED",
    ]);
    expect(codes(observation({ signerAlive: false }))).toEqual(["SIGNER_DOWN:-:INCIDENT"]);
    expect(codes(observation({ signerAlive: null }))).toEqual([]);
    expect(codes(observation({ chainAgeSeconds: 601 }))).toEqual(["CHAIN_STALE:-:INCIDENT"]);
    expect(
      assess(
        observation({ chainAgeSeconds: 601 }),
        { ...DEFAULT_RULES, chainMaxAgeSeconds: null },
        null,
      ),
    ).toEqual([]);
    expect(codes(observation({ executorPaused: true }))).toEqual(["ADAPTER_OFF:-:INCIDENT"]);
    expect(codes(observation({ adapterAllowed: false }))).toEqual(["ADAPTER_OFF:-:INCIDENT"]);
    expect(codes(observation({ arming: { validUntil: 1_000n, ownerEpoch: 1n } }))).toEqual([
      "MANDATE_EXPIRED:-:INCIDENT",
    ]);
    expect(codes(observation({ ownerEpoch: 2n }))).toEqual(["OWNER_CHANGED:-:INCIDENT"]);
    expect(codes(observation({ arming: null, ownerEpoch: 2n }))).toEqual([]);
  });

  it("the strongest state wins, and a tightening is only a tightening from a looser mode", () => {
    expect(
      stateFor(
        assess(observation({ creditsRestricted: true, signerAlive: false }), DEFAULT_RULES, null),
      ),
    ).toBe("INCIDENT");
    expect(stateFor(assess(observation({ creditsRestricted: true }), DEFAULT_RULES, null))).toBe(
      "RESTRICTED",
    );
    expect(stateFor([])).toBeNull();
    expect(tightens("REDUCE_ONLY", "NORMAL", false)).toBe(true);
    expect(tightens("REDUCE_ONLY", "REDUCE_ONLY", false)).toBe(false);
    expect(tightens("REDUCE_ONLY", "PAUSED", false)).toBe(false);
    expect(tightens("PAUSE", "REDUCE_ONLY", false)).toBe(true);
    expect(tightens("PAUSE", "PAUSED", false)).toBe(false);
    expect(tightens("CLOSE_DEPOSITS", "NORMAL", true)).toBe(false);
    expect(tightens("REDUCE_ONLY", null, null)).toBe(false);
  });
});

const dbUp = await databaseAvailable();
describe.skipIf(!dbUp)("the sentinel service over Postgres", () => {
  let t: TestDatabase;
  let store: SentinelStore;
  const ref = { chainId: CHAIN, agentId: 1 };
  const calls: string[] = [];
  const log: string[] = [];
  let seen: SentinelObservation | null = observation();
  let mode: SentinelObservation["mode"] = "NORMAL";
  const chain: SentinelChain = {
    address: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
    setReduceOnly: async (a) => {
      calls.push(`setReduceOnly ${a}`);
      mode = "REDUCE_ONLY";
      return "0xa1";
    },
    pause: async (a) => {
      calls.push(`pause ${a}`);
      mode = "PAUSED";
      return "0xa2";
    },
    closeDeposits: async (a) => {
      calls.push(`closeDeposits ${a}`);
      return "0xa3";
    },
  };
  const service = (over: Partial<SentinelDeps> = {}, clock: { now: Date } = { now: T0 }) =>
    new Sentinel({
      chainId: CHAIN,
      store,
      rules: DEFAULT_RULES,
      chain,
      agents: async () => [1],
      observe: async () => (seen ? { ...seen, mode, at: clock.now } : null),
      setState: (r, to, reason) => setAgentState(t.db, r, to, reason),
      restState: async () => "RUNNING",
      now: () => clock.now,
      log: (l) => log.push(l),
      ...over,
    });
  const state = async () =>
    (
      await t.db
        .selectFrom("platform.agent_states")
        .select("state")
        .where("agent_id", "=", 1)
        .executeTakeFirstOrThrow()
    ).state;

  beforeAll(async () => {
    t = await createTestDatabase("sentinel");
    store = new SentinelStore(t.db);
    await indexAgent(t.db, 1, null);
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    calls.length = 0;
    log.length = 0;
    seen = observation();
    mode = "NORMAL";
    await t.db.deleteFrom("platform.sentinel_actions").execute();
    await t.db.deleteFrom("platform.sentinel_watch").execute();
    await t.db.deleteFrom("platform.agent_state_changes").execute();
    await t.db
      .insertInto("platform.agent_states")
      .values({ chain_id: CHAIN, agent_id: 1, state: "RUNNING" })
      .onConflict((oc) => oc.columns(["chain_id", "agent_id"]).doUpdateSet({ state: "RUNNING" }))
      .execute();
  });

  it("takes a baseline and records nothing while all is well", async () => {
    expect(await service().tick()).toEqual([]);
    expect((await store.watch(ref)).baseline).toMatchObject({
      liquidityUsd: { [WMON]: 1_000_000 },
    });
    expect(await store.actions(ref)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("tightens once per condition, in order, and notes the condition clearing without loosening", async () => {
    const clock = { now: T0 };
    const s = service({}, clock);
    await s.tick();
    seen = observation({ drawdownBps: 1_250 });
    clock.now = new Date(T0.getTime() + 30_000);
    expect(await s.tick()).toEqual([{ agentId: 1, code: "DRAWDOWN_12", action: "REDUCE_ONLY" }]);
    expect(calls).toEqual([`setReduceOnly ${ACCOUNT}`]);
    expect((await store.actions(ref))[0]).toMatchObject({
      code: "DRAWDOWN_12",
      action: "REDUCE_ONLY",
      status: "done",
      txHash: "0xa1",
      reason: "12.5% below the 7-day peak",
    });
    // The same condition on the next pass: nothing more.
    clock.now = new Date(T0.getTime() + 60_000);
    expect(await s.tick()).toEqual([]);
    expect(calls).toHaveLength(1);
    // Deeper: the pause, once.
    seen = observation({ drawdownBps: 2_300 });
    clock.now = new Date(T0.getTime() + 90_000);
    expect(await s.tick()).toMatchObject([
      { code: "DRAWDOWN_22", action: "PAUSE" },
      { code: "DRAWDOWN_12", action: "NOTE" },
    ]);
    expect(calls).toEqual([`setReduceOnly ${ACCOUNT}`, `pause ${ACCOUNT}`]);
    // Back to a small drawdown: the condition is noted as cleared; the mode stays PAUSED and no call loosens it.
    seen = observation({ drawdownBps: 100 });
    clock.now = new Date(T0.getTime() + 120_000);
    expect(await s.tick()).toEqual([{ agentId: 1, code: "DRAWDOWN_22", action: "NOTE" }]);
    expect(mode).toBe("PAUSED");
    expect(calls).toHaveLength(2);
    expect((await store.actions(ref))[0]).toMatchObject({
      action: "NOTE",
      reason: "the condition cleared; the account's mode stays until its owner reviews it",
    });
    expect((await store.watch(ref)).active).toEqual({});
    // A new reduce-only condition on a paused account: recorded, nothing sent (nothing to tighten).
    seen = observation({ held: [held({ screenVerdict: "refused" })] });
    clock.now = new Date(T0.getTime() + 150_000);
    expect(await s.tick()).toEqual([
      { agentId: 1, code: "RESCREEN_FAILED", action: "REDUCE_ONLY" },
    ]);
    expect(calls).toHaveLength(2);
    expect((await store.actions(ref))[0]).toMatchObject({
      status: "skipped",
      detail: { modeNow: "PAUSED" },
    });
  });

  it("a breach the breaker already answered (a trade's record or the owner) counts as done", async () => {
    const clock = { now: T0 };
    const s = service({}, clock);
    await s.tick();
    mode = "REDUCE_ONLY";
    seen = observation({ drawdownBps: 1_300 });
    clock.now = new Date(T0.getTime() + 30_000);
    expect(await s.tick()).toEqual([{ agentId: 1, code: "DRAWDOWN_12", action: "REDUCE_ONLY" }]);
    expect(calls).toEqual([]);
    expect((await store.actions(ref))[0]).toMatchObject({
      status: "done",
      detail: { alreadyTightened: true },
    });
  });

  it("sets the agent state once for the strongest breach, and lets a restricted agent run again when its credits return", async () => {
    const clock = { now: T0 };
    const s = service({}, clock);
    seen = observation({ creditsRestricted: true });
    expect(await s.tick()).toMatchObject([
      { code: "ZERO_CREDITS", action: "RESTRICT" },
      { code: "STATE", action: "RESTRICT" },
    ]);
    expect(await state()).toBe("RESTRICTED");
    seen = observation({ creditsRestricted: true, agentState: "RESTRICTED", signerAlive: false });
    clock.now = new Date(T0.getTime() + 30_000);
    expect(await s.tick()).toMatchObject([
      { code: "SIGNER_DOWN", action: "INCIDENT" },
      { code: "STATE", action: "INCIDENT" },
    ]);
    expect(await state()).toBe("INCIDENT");
    // The signer is back but credits are still out: an incident is never lowered to restricted by the sentinel.
    seen = observation({ creditsRestricted: true, agentState: "INCIDENT" });
    clock.now = new Date(T0.getTime() + 60_000);
    expect(await s.tick()).toEqual([{ agentId: 1, code: "SIGNER_DOWN", action: "NOTE" }]);
    expect(await state()).toBe("INCIDENT");
    // From a RESTRICTED the sentinel set for credits, credits back means running again (D-129).
    await setAgentState(t.db, ref, "RESTRICTED", "test");
    seen = observation({ agentState: "RESTRICTED" });
    clock.now = new Date(T0.getTime() + 90_000);
    expect(await s.tick()).toMatchObject([
      { code: "ZERO_CREDITS", action: "NOTE" },
      { code: "ZERO_CREDITS", action: "RESUME" },
    ]);
    expect(await state()).toBe("RUNNING");
    const changes = await t.db
      .selectFrom("platform.agent_state_changes")
      .select(["from_state", "to_state", "reason"])
      .orderBy("change_id")
      .execute();
    expect(changes).toEqual([
      { from_state: "RUNNING", to_state: "RESTRICTED", reason: "sentinel:ZERO_CREDITS" },
      { from_state: "RESTRICTED", to_state: "INCIDENT", reason: "sentinel:SIGNER_DOWN" },
      { from_state: "INCIDENT", to_state: "RESTRICTED", reason: "test" },
      { from_state: "RESTRICTED", to_state: "RUNNING", reason: "sentinel:credits_restored" },
    ]);
  });

  it("without a sentinel key the tightening is recorded as skipped and the state still set; an unreadable agent is left alone", async () => {
    const s = service({ chain: null });
    seen = observation({ held: [held({ priceReason: "STALE" })] });
    expect(await s.tick()).toMatchObject([
      { code: "STALE_FEED", action: "REDUCE_ONLY" },
      { code: "STATE", action: "INCIDENT" },
    ]);
    expect((await store.actions(ref))[1]).toMatchObject({
      status: "skipped",
      detail: { noKey: true },
    });
    expect(await state()).toBe("INCIDENT");
    expect(log.some((l) => /no sentinel key/.test(l))).toBe(true);
    seen = null;
    expect(await s.tick()).toEqual([]);
  });
});
