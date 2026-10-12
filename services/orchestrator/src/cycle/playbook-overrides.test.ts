import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaybookOverrideStore, bumpVersion } from "./playbook-overrides.ts";

const dbUp = await databaseAvailable();

describe("the next version of an owner's skill (UI-U2)", () => {
  it("bumps the patch number, or appends one to a version that is not three numbers", () => {
    expect(bumpVersion("1.0.0")).toBe("1.0.1");
    expect(bumpVersion("2.10.99")).toBe("2.10.100");
    expect(bumpVersion("3")).toBe("3.1");
  });
});

describe.skipIf(!dbUp)("the playbook versions an owner saves (UI-U2, needs Postgres)", () => {
  let t: TestDatabase;
  let store: PlaybookOverrideStore;

  beforeAll(async () => {
    t = await createTestDatabase("orch_playbook_overrides");
    store = new PlaybookOverrideStore(t.db);
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });

  it("saves each edit as the next version of that playbook for that agent alone, mounts the latest, and never saves the same text twice", async () => {
    expect(await store.current(143143, 1)).toEqual([]);
    const v1 = await store.save({
      chainId: 143143,
      agentId: 1,
      hermesName: "aa-playbook-scan",
      skillMd: "# Scan v1\n",
      savedFrom: "cycle-00000000-0000-0000-0000-000000000001",
    });
    expect(v1).toMatchObject({ saved: true, version: { version: 1, skillMd: "# Scan v1\n" } });
    const same = await store.save({
      chainId: 143143,
      agentId: 1,
      hermesName: "aa-playbook-scan",
      skillMd: "# Scan v1\n",
    });
    expect(same).toMatchObject({ saved: false, version: { version: 1 } });
    const v2 = await store.save({
      chainId: 143143,
      agentId: 1,
      hermesName: "aa-playbook-scan",
      skillMd: "# Scan v2\n",
    });
    expect(v2.version.version).toBe(2);
    await store.save({
      chainId: 143143,
      agentId: 1,
      hermesName: "aa-playbook-dive",
      skillMd: "# Dive v1\n",
    });
    // The latest of each playbook, as the sandbox mounts them; another agent has none.
    expect(await store.mounts(143143, 1)).toEqual([
      { kind: "playbook", hermesName: "aa-playbook-dive", skillMd: "# Dive v1\n" },
      { kind: "playbook", hermesName: "aa-playbook-scan", skillMd: "# Scan v2\n" },
    ]);
    expect(await store.mounts(143143, 2)).toEqual([]);
    expect(
      (await store.versions(143143, 1, "aa-playbook-scan")).map((v) => [v.version, v.savedFrom]),
    ).toEqual([
      [2, null],
      [1, "cycle-00000000-0000-0000-0000-000000000001"],
    ]);
  });
});
