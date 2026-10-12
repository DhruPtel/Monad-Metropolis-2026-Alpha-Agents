import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OwnerKeyStore } from "./owner-keys.ts";
import { openSecret, sealSecret } from "./sealed.ts";

const SECRET = "test-platform-secret-0123456789abcdef";
const OWNER = "0x683eE842A16f85e69883F433745263BFe8D55f76" as const;
const KEY = "dune-key-not-real-abcdefghijklmnop";
const dbUp = await databaseAvailable();

describe("the sealed envelope (D-203, BK-U1)", () => {
  it("round-trips, hides the plaintext, and refuses a tampered or foreign ciphertext", () => {
    const sealed = sealSecret(KEY, SECRET);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain(KEY);
    expect(sealed).not.toContain("mnop");
    expect(openSecret(sealed, SECRET)).toBe(KEY);
    expect(sealSecret(KEY, SECRET)).not.toBe(sealed);
    expect(() => openSecret(sealed, "another-secret-0123456789abcdefghij")).toThrow();
    const parts = sealed.split(".");
    parts[3] = `${parts[3]?.slice(0, -2)}AA`;
    expect(() => openSecret(parts.join("."), SECRET)).toThrow();
    expect(() => openSecret("v0.a.b.c", SECRET)).toThrow(/not a platform ciphertext/);
    expect(() => sealSecret(KEY, "short")).toThrow(/32\+ characters/);
  });
});

describe.skipIf(!dbUp)("the owner's keys at rest (BK-U1, needs Postgres)", () => {
  let t: TestDatabase;
  let store: OwnerKeyStore;
  beforeAll(async () => {
    t = await createTestDatabase("owner_keys");
    store = new OwnerKeyStore(t.db, () => new Date("2026-10-12T09:00:00Z"));
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await t.db.deleteFrom("platform.owner_keys").execute();
  });

  it("stores the key sealed, lists it by its hint alone, opens it for the tool servers, and deletes it outright", async () => {
    expect(await store.list(143143, 1)).toEqual([]);
    const saved = await store.save({
      chainId: 143143,
      agentId: 1,
      provider: "dune",
      key: KEY,
      secret: SECRET,
      addedBy: OWNER,
    });
    expect(saved).toEqual({
      provider: "dune",
      present: true,
      hint: "••••mnop",
      addedAt: "2026-10-12T09:00:00.000Z",
    });
    const row = await t.db.selectFrom("platform.owner_keys").selectAll().executeTakeFirstOrThrow();
    expect(row.ciphertext).not.toContain(KEY);
    expect(openSecret(row.ciphertext, SECRET)).toBe(KEY);
    expect(JSON.stringify(await store.list(143143, 1))).not.toContain(KEY);
    expect(await store.open(143143, 1, "dune", SECRET)).toBe(KEY);
    // Another agent has nothing; a replaced key opens to the new one.
    expect(await store.open(143143, 2, "dune", SECRET)).toBeNull();
    await store.save({
      chainId: 143143,
      agentId: 1,
      provider: "dune",
      key: `${KEY}-two`,
      secret: SECRET,
      addedBy: OWNER,
    });
    expect(await store.open(143143, 1, "dune", SECRET)).toBe(`${KEY}-two`);
    expect((await store.list(143143, 1))[0]?.hint).toBe("••••-two");
    expect(await store.remove(143143, 1, "dune")).toBe(true);
    expect(await store.remove(143143, 1, "dune")).toBe(false);
    expect(await store.open(143143, 1, "dune", SECRET)).toBeNull();
    expect(await t.db.selectFrom("platform.owner_keys").selectAll().execute()).toEqual([]);
  });
});
