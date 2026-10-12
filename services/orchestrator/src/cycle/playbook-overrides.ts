import { createHash, randomUUID } from "node:crypto";
import type { Db } from "@alpha-agents/db";
import type { SkillTextOverride } from "../hermes/materialize.ts";

/**
 * UI-U2: the playbook versions an owner saved for one agent from the replay
 * tool. A built-in playbook's SKILL.md body, edited and saved, becomes
 * version 1, 2, 3 of that playbook for that agent alone; the agent's sandbox
 * mounts the latest version's text in place of the built-in body at every
 * start, under the built-in frontmatter. Other agents' sandboxes never see
 * it, and the built-in package itself never changes.
 */
export interface PlaybookOverride {
  readonly overrideId: string;
  readonly chainId: number;
  readonly agentId: number;
  readonly hermesName: string;
  readonly version: number;
  readonly skillMd: string;
  readonly contentHash: string;
  readonly savedFrom: string | null;
  readonly createdAt: Date;
}

export const skillMdHash = (skillMd: string): string =>
  createHash("sha256").update(skillMd, "utf8").digest("hex");

/** The next patch version of an owner's skill: 1.0.0 to 1.0.1; a version that is not three numbers gets .1 appended. */
export function bumpVersion(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : `${version}.1`;
}

export class PlaybookOverrideStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** The latest saved version of each playbook the agent has one for. */
  async current(chainId: number, agentId: number): Promise<PlaybookOverride[]> {
    const rows = await this.db
      .selectFrom("platform.playbook_overrides")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .orderBy("hermes_name")
      .orderBy("version", "desc")
      .execute();
    const seen = new Set<string>();
    const out: PlaybookOverride[] = [];
    for (const r of rows) {
      if (seen.has(r.hermes_name)) continue;
      seen.add(r.hermes_name);
      out.push(toOverride(r));
    }
    return out;
  }

  /** As the sandbox mounts them. */
  async mounts(chainId: number, agentId: number): Promise<SkillTextOverride[]> {
    return (await this.current(chainId, agentId)).map((o) => ({
      kind: "playbook",
      hermesName: o.hermesName,
      skillMd: o.skillMd,
    }));
  }

  /** Every saved version of one playbook, newest first. */
  async versions(chainId: number, agentId: number, hermesName: string): Promise<PlaybookOverride[]> {
    const rows = await this.db
      .selectFrom("platform.playbook_overrides")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .where("hermes_name", "=", hermesName)
      .orderBy("version", "desc")
      .execute();
    return rows.map(toOverride);
  }

  /**
   * Saves the text as the next version. The same text as the latest version
   * is not saved again: the latest version is returned.
   */
  async save(a: {
    chainId: number;
    agentId: number;
    hermesName: string;
    skillMd: string;
    savedFrom?: string | null;
  }): Promise<{ saved: boolean; version: PlaybookOverride }> {
    const hash = skillMdHash(a.skillMd);
    const latest = (await this.versions(a.chainId, a.agentId, a.hermesName))[0] ?? null;
    if (latest && latest.contentHash === hash) return { saved: false, version: latest };
    const overrideId = `playbook-${randomUUID()}`;
    await this.db
      .insertInto("platform.playbook_overrides")
      .values({
        override_id: overrideId,
        chain_id: a.chainId,
        agent_id: a.agentId,
        hermes_name: a.hermesName,
        version: (latest?.version ?? 0) + 1,
        skill_md: a.skillMd,
        content_hash: hash,
        saved_from: a.savedFrom ?? null,
      })
      .execute();
    const row = await this.db
      .selectFrom("platform.playbook_overrides")
      .selectAll()
      .where("override_id", "=", overrideId)
      .executeTakeFirstOrThrow();
    return { saved: true, version: toOverride(row) };
  }
}

const toOverride = (r: {
  override_id: string;
  chain_id: number;
  agent_id: number;
  hermes_name: string;
  version: number;
  skill_md: string;
  content_hash: string;
  saved_from: string | null;
  created_at: Date;
}): PlaybookOverride => ({
  overrideId: r.override_id,
  chainId: r.chain_id,
  agentId: r.agent_id,
  hermesName: r.hermes_name,
  version: r.version,
  skillMd: r.skill_md,
  contentHash: r.content_hash,
  savedFrom: r.saved_from,
  createdAt: r.created_at,
});
