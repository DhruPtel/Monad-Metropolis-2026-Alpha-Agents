import { randomUUID } from "node:crypto";
import { depositEntry } from "@alpha-agents/accounting";
import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "./credits/ledger.ts";
import { CreditService } from "./credits/service.ts";
import { MemoryGateway } from "./gateway-admin.ts";
import {
  MAX_ENTRY_CHARS,
  Narrator,
  type NarratorModel,
  type ScanFacts,
  formatUsdc,
  numbersIn,
  percentOfBps,
  templateEntry,
  validateNarration,
} from "./narrator.ts";
import { Redactor } from "./secrets.ts";
import { Store } from "./store.ts";
import { CHAIN, must } from "./testing.ts";

const FACTS: ScanFacts = {
  agent: "Agent #7",
  activity: "scan",
  outcome: "DONE",
  stopReason: "COMPLETED",
  candidates: [{ asset: "WMON", thesisCode: "DEX_VOLUME_UP", confidencePercent: "55" }],
  searches: [
    { query: "monad dex volume", results: 5, status: "succeeded" },
    { query: "monad news", results: 4, status: "succeeded" },
  ],
  pagesRead: [{ host: "news.example", status: "succeeded" }],
  counts: { searches: 2, pagesRead: 1, refusedCalls: 0, notesSaved: 1, candidates: 1 },
  toolSpendUsdc: "0.022",
  creditsLeftUsdc: "4.978",
};

describe("narration numbers", () => {
  it("reads numbers canonically", () => {
    expect(numbersIn("Spent 0.0220 USDC on 1,234 calls; 55% and 007.")).toEqual([
      "0.022",
      "1234",
      "55",
      "7",
    ]);
    expect(numbersIn("2,3 and 4,")).toEqual(["2", "3", "4"]);
    expect(formatUsdc(22_000n)).toBe("0.022");
    expect(formatUsdc(4_978_000n)).toBe("4.978");
    expect(formatUsdc(0n)).toBe("0");
    expect(formatUsdc(5_000_000n)).toBe("5");
    expect(percentOfBps(5500)).toBe("55");
    expect(percentOfBps(6050)).toBe("60.5");
    expect(percentOfBps(1)).toBe("0.01");
  });

  it("accepts an entry whose numbers all come from the facts", () => {
    const text =
      "Agent #7 ran 2 web searches and read 1 page, then flagged WMON (DEX_VOLUME_UP, 55% confidence). Tools cost 0.022 USDC; 4.978 USDC left.";
    expect(validateNarration(text, FACTS)).toEqual({ ok: true });
  });

  it("rejects a deliberately wrong number", () => {
    const wrong = "Agent #7 ran 3 web searches; tools cost 0.022 USDC.";
    expect(validateNarration(wrong, FACTS)).toEqual({
      ok: false,
      reason: "numbers not in the facts: 3",
    });
    // A rounded amount is an invented number too.
    expect(validateNarration("Tools cost 0.02 USDC.", FACTS)).toMatchObject({ ok: false });
    expect(validateNarration("Credits left: 4,978 USDC.", FACTS)).toMatchObject({ ok: false });
  });

  it("rejects empty, long, multi-line and linked entries", () => {
    expect(validateNarration("  ", FACTS)).toMatchObject({ ok: false, reason: "empty" });
    expect(validateNarration("a".repeat(MAX_ENTRY_CHARS + 1), FACTS)).toMatchObject({
      ok: false,
    });
    expect(validateNarration("One.\nTwo.", FACTS)).toMatchObject({ ok: false });
    expect(validateNarration("See https://news.example now.", FACTS)).toMatchObject({
      ok: false,
    });
  });

  it("writes template entries that always validate and fit", () => {
    const many: ScanFacts = {
      ...FACTS,
      candidates: Array.from({ length: 5 }, (_, i) => ({
        asset: i % 2 ? "USDC" : "WMON",
        thesisCode: `A_VERY_LONG_THESIS_CODE_NUMBER_${i}_XYZ`,
        confidencePercent: String(10 + i),
      })),
    };
    for (const facts of [
      FACTS,
      many,
      { ...FACTS, outcome: "NO_CANDIDATES" as const, candidates: [] },
      { ...FACTS, outcome: "NOT_COMPLETED" as const, stopReason: "DEADLINE", candidates: [] },
    ]) {
      const text = templateEntry(facts);
      expect(text.length).toBeLessThanOrEqual(MAX_ENTRY_CHARS);
      expect(validateNarration(text, facts)).toEqual({ ok: true });
    }
  });
});

const dbUp = await databaseAvailable();

class ScriptedModel implements NarratorModel {
  readonly prompts: string[] = [];
  private readonly answers: (string | Error)[];
  constructor(answers: (string | Error)[]) {
    this.answers = answers;
  }
  async complete(_system: string, user: string): Promise<string> {
    this.prompts.push(user);
    const next = this.answers.shift() ?? "";
    if (next instanceof Error) throw next;
    return next;
  }
}

describe.skipIf(!dbUp)("the narrator (needs Postgres)", { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let store: Store;
  let ledger: Ledger;
  let credits: CreditService;
  const redactor = new Redactor();
  let task = 0;

  beforeAll(async () => {
    t = await createTestDatabase("orch_narrator");
    store = new Store(t.db);
    ledger = new Ledger(t.db);
    credits = new CreditService({
      store,
      ledger,
      gateway: new MemoryGateway(),
      chainId: CHAIN,
      environment: "fork",
      keyOf: () => null,
      redactor,
      log: () => undefined,
    });
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);
  beforeEach(async () => {
    for (const table of [
      "platform.activity_entries",
      "platform.tool_calls",
      "platform.stage_records",
      "platform.thesis_notes",
      "platform.agent_tasks",
      "platform.ledger_lines",
      "platform.ledger_entries",
    ] as const)
      await t.db.deleteFrom(table).execute();
  });

  const narrator = (model: NarratorModel) =>
    new Narrator({
      store,
      gateway: new MemoryGateway(),
      credits,
      namespace: "unit",
      litellmUrl: "http://127.0.0.1:9",
      secret: "s".repeat(40),
      redactor,
      log: () => undefined,
      model,
    });

  /** A finished Scan for agent 7: two searches, one page, a note and a stage record. */
  const scan = async (funded: boolean): Promise<string> => {
    task += 1;
    const taskId = `task-${task}`;
    const lease = `lease-${task}`;
    await store.insertTask(taskId, { chainId: CHAIN, agentId: 7 }, "scan");
    await store.setTaskLease(taskId, lease);
    if (funded)
      await ledger.post(
        depositEntry(
          { environment: "fork", entryId: randomUUID(), occurredAt: 1, agentId: 7 },
          5_000_000n,
          0n,
        ),
        { chainId: CHAIN, agentId: 7, idempotencyKey: `dep-${task}`, source: {} },
      );
    const call = (
      tool: string,
      input: unknown,
      summary: unknown,
      charge: string,
      status = "succeeded",
    ) =>
      t.db
        .insertInto("platform.tool_calls")
        .values({
          call_id: `c-${task}-${Math.random()}`,
          chain_id: CHAIN,
          agent_id: 7,
          lease_id: lease,
          server: tool === "complete_stage" || tool === "write_thesis" ? "platform" : "data",
          tool,
          input: JSON.stringify(input),
          status: status as "succeeded",
          charge_usdc_e6: charge,
          summary: JSON.stringify(summary),
        })
        .execute();
    await call("web_search", { query: "monad dex volume" }, { results: 5 }, "10000");
    await call("web_search", { query: "monad news" }, { results: 4 }, "10000");
    await call("read_url", { url: "https://news.example/a" }, { hosts: ["news.example"] }, "2000");
    await call(
      "read_url",
      { url: "http://169.254.169.254/" },
      { hosts: ["169.254.169.254"] },
      "0",
      "refused",
    );
    await call("write_thesis", { stage: "SCAN", sourceCount: 1 }, { results: 1 }, "0");
    await t.db
      .insertInto("platform.thesis_notes")
      .values({
        note_id: `note-${task}`,
        chain_id: CHAIN,
        agent_id: 7,
        lease_id: lease,
        stage: "SCAN",
        title: "SECRET_NOTE_TITLE",
        notes: "SECRET_NOTE_BODY",
        sources: "[]",
      })
      .execute();
    await t.db
      .insertInto("platform.stage_records")
      .values({
        stage_id: `stage-${task}`,
        chain_id: CHAIN,
        agent_id: 7,
        lease_id: lease,
        stage: "SCAN",
        outcome: "DONE",
        candidates: JSON.stringify([
          { asset: "WMON", thesisCode: "DEX_VOLUME_UP", confidenceBps: 5500 },
        ]),
      })
      .execute();
    return taskId;
  };

  it("builds facts from the action log and ledger only", async () => {
    const taskId = await scan(true);
    const facts = must(await narrator(new ScriptedModel([])).factsFor(taskId, "COMPLETED"));
    expect(facts).toMatchObject({
      agent: "Agent #7",
      outcome: "DONE",
      counts: { searches: 2, pagesRead: 1, refusedCalls: 1, notesSaved: 1, candidates: 1 },
      toolSpendUsdc: "0.022",
      creditsLeftUsdc: "5",
      candidates: [{ asset: "WMON", thesisCode: "DEX_VOLUME_UP", confidencePercent: "55" }],
    });
    expect(JSON.stringify(facts)).not.toMatch(/SECRET_NOTE/);
  });

  it("stores a narration that passes the validator", async () => {
    const taskId = await scan(true);
    const model = new ScriptedModel([
      "Agent #7 ran 2 web searches and read 1 page; it flagged WMON at 55% confidence. Tools cost 0.022 USDC.",
    ]);
    const entry = must(await narrator(model).narrateTask(taskId, "COMPLETED"));
    expect(entry).toMatchObject({ renderedBy: "narrator", rejections: [] });
    expect(entry.text).toContain("0.022 USDC");
    expect(model.prompts[0]).not.toMatch(/SECRET_NOTE/);
  });

  it("rejects a wrong number, retries with the reason, and stores the corrected entry", async () => {
    const taskId = await scan(true);
    const model = new ScriptedModel([
      "Agent #7 ran 3 web searches; tools cost 0.022 USDC.",
      "Agent #7 ran 2 web searches; tools cost 0.022 USDC.",
    ]);
    const entry = must(await narrator(model).narrateTask(taskId, "COMPLETED"));
    expect(entry).toMatchObject({
      renderedBy: "narrator",
      rejections: ["numbers not in the facts: 3"],
    });
    expect(entry.text).toContain("2 web searches");
    expect(model.prompts[1]).toContain("rejected (numbers not in the facts: 3)");
  });

  it("falls back to the template after two rejections, when the model fails, and when restricted", async () => {
    const twice = await scan(true);
    const bad = must(
      await narrator(new ScriptedModel(["Spent 9 USDC.", "Spent 9 USDC."])).narrateTask(
        twice,
        "COMPLETED",
      ),
    );
    expect(bad.renderedBy).toBe("template");
    expect(bad.rejections).toHaveLength(2);
    expect(validateNarration(bad.text, bad.facts)).toEqual({ ok: true });

    const down = await scan(true);
    const failed = must(
      await narrator(new ScriptedModel([new Error("connection refused")])).narrateTask(
        down,
        "COMPLETED",
      ),
    );
    expect(failed.renderedBy).toBe("template");
    expect(failed.rejections[0]).toMatch(/narrator unavailable/);

    await t.db.deleteFrom("platform.ledger_lines").execute();
    await t.db.deleteFrom("platform.ledger_entries").execute();
    const broke = await scan(false);
    const model = new ScriptedModel(["never asked"]);
    const restricted = must(await narrator(model).narrateTask(broke, "COMPLETED"));
    expect(restricted.renderedBy).toBe("template");
    expect(model.prompts).toEqual([]);
  });

  it("writes one entry per task", async () => {
    const taskId = await scan(true);
    const n = narrator(
      new ScriptedModel(["Agent #7 ran 2 web searches.", "Agent #7 read 1 page."]),
    );
    const first = must(await n.narrateTask(taskId, "COMPLETED"));
    const second = must(await n.narrateTask(taskId, "COMPLETED"));
    expect(second.entryId).toBe(first.entryId);
    const rows = await t.db.selectFrom("platform.activity_entries").selectAll().execute();
    expect(rows).toHaveLength(1);
  });
});
