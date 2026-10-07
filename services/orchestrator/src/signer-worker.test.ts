import { randomBytes } from "node:crypto";
import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { addressEntry } from "@alpha-agents/domain";
import { FakeChain } from "@alpha-agents/signer/testing";
import { type Hex, bytesToHex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "./api.ts";
import { FundingKeys } from "./credits/funding.ts";
import type { Orchestrator } from "./orchestrator.ts";
import { SignerWorker } from "./signer-worker.ts";
import { Store } from "./store.ts";

/**
 * P2-U4: the signer as an orchestrator worker and its internal API routes.
 * The session key is the agent's funding address (D-243); the routes show
 * the outbox and never a key; test swaps are refused off the local fork.
 */
const dbUp = await databaseAvailable();
const SEED = bytesToHex(randomBytes(32));
const EXECUTOR = addressEntry("local", "executor").address as Hex;

describe.skipIf(!dbUp)("the signer worker (needs Postgres)", { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let worker: SignerWorker;
  const logs: string[] = [];

  beforeAll(async () => {
    t = await createTestDatabase("orch_signer");
    worker = new SignerWorker({
      db: t.db,
      environment: "local",
      rpcUrl: "http://127.0.0.1:1",
      seed: SEED,
      log: (l) => logs.push(l),
      chain: new FakeChain(143143, EXECUTOR),
      everyMs: 20,
    });
  });
  afterAll(async () => {
    await worker?.stop();
    await t?.drop();
  });

  const api = (devActions: boolean, signer: SignerWorker | null = worker) =>
    createApi({
      orchestrator: {} as Orchestrator,
      store: new Store(t.db),
      chainId: 143143,
      devActions,
      signer,
    });

  it("makes each agent's session key its funding address", async () => {
    const keys = new FundingKeys(SEED);
    for (const id of [1, 7, 42]) expect(await worker.signer.createKey(id)).toBe(keys.address(id));
  });

  it("creates a session key through the API and shows only its address", async () => {
    const res = await api(true).request("/v1/agents/9/session-key", { method: "POST" });
    expect(res.status).toBe(201);
    const { address } = (await res.json()) as { address: string };
    expect(address).toBe(new FundingKeys(SEED).address(9));
    const read = await api(false).request("/v1/agents/9/session-key");
    expect(await read.json()).toEqual({ address });
    expect((await api(false).request("/v1/agents/9/session-key", { method: "POST" })).status).toBe(
      404,
    );
  });

  it("serves the outbox with each refusal's reason code, and never the signed bytes", async () => {
    await worker.signer.accept(9, { chainId: 143143, to: EXECUTOR, data: "0xdeadbeef", value: 0n });
    const res = await api(false).request("/v1/signer/outbox?agentId=9");
    const body = (await res.json()) as { transactions: Record<string, unknown>[] };
    expect(body.transactions[0]).toMatchObject({
      status: "failed",
      reasonCode: "FUNCTION_NOT_ALLOWED",
    });
    expect(JSON.stringify(body)).not.toMatch(/raw_?tx/i);
    expect(JSON.stringify(body)).not.toContain(SEED.slice(2));
    expect((await api(false).request("/v1/signer/outbox?agentId=x")).status).toBe(400);
    expect(await (await api(false).request("/v1/signer")).json()).toEqual({
      on: true,
      chainId: 143143,
    });
    expect(await (await api(false, null).request("/v1/signer")).json()).toEqual({
      on: false,
      chainId: null,
    });
    expect((await api(false, null).request("/v1/signer/outbox")).status).toBe(409);
  });

  it("checks a test swap's direction, amount and limit before reading the chain", async () => {
    const post = (body: unknown) =>
      api(true).request("/v1/agents/9/test-swap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post({ direction: "sideways", amount: "1" })).status).toBe(400);
    expect((await post({ direction: "buy", amount: 1 })).status).toBe(400);
    expect((await post({ direction: "buy", amount: "0" })).status).toBe(409);
    expect((await post({ direction: "buy", amount: "1.0000001" })).status).toBe(409);
    expect((await post({ direction: "buy", amount: "1", breakLimit: "NOPE" })).status).toBe(409);
    expect(
      (
        await api(false).request("/v1/agents/9/test-swap", {
          method: "POST",
          body: JSON.stringify({ direction: "buy", amount: "1" }),
        })
      ).status,
    ).toBe(404);
  });

  it("runs passes on its own and stops cleanly", async () => {
    await worker.start();
    await new Promise((r) => setTimeout(r, 80));
    await worker.stop();
    expect(logs.filter((l) => l.includes("signer pass failed"))).toEqual([]);
  });

  it("refuses to run on the beta with the seed", async () => {
    expect(
      () =>
        new SignerWorker({
          db: t.db,
          environment: "beta",
          rpcUrl: "http://127.0.0.1:1",
          seed: SEED,
          log: () => undefined,
        }),
    ).toThrow("KMS keys");
  });
});
