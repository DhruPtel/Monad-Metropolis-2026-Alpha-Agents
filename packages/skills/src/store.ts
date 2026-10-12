import type { Db } from "@alpha-agents/db";
import type { Hex } from "viem";
import type { UploadedFile } from "./owner.ts";
import type { PackageIssue, SkillPackage } from "./packages.ts";

/**
 * The owner's own skills as the platform keeps them (SK-U1): one row per
 * package version by content hash, the current ones mounted read-only beside
 * the built-in skills at the agent's next sandbox. Imported as
 * `@alpha-agents/skills/store`, apart from the package's main entry, because
 * it needs the database.
 */
export interface OwnerSkillRecord {
  readonly chainId: number;
  readonly agentId: number;
  readonly skillId: string;
  readonly version: string;
  readonly contentHash: string;
  readonly manifestHash: string;
  readonly hermesName: string;
  readonly manifest: SkillPackage["manifest"];
  readonly files: readonly UploadedFile[];
  readonly warnings: readonly PackageIssue[];
  readonly current: boolean;
  readonly uploadedBy: Hex;
  readonly uploadedAt: Date;
  readonly removedAt: Date | null;
}

export type OwnerSkillSave =
  | { readonly ok: true; readonly record: OwnerSkillRecord; readonly already: boolean }
  | { readonly ok: false; readonly issue: PackageIssue };

export class OwnerSkillStore {
  readonly db: Db;
  private readonly now: () => Date;

  constructor(db: Db, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  /** The agent's current skills, oldest upload first. */
  async current(chainId: number, agentId: number): Promise<OwnerSkillRecord[]> {
    const rows = await this.db
      .selectFrom("platform.owner_skills")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .where("current", "=", true)
      .orderBy("uploaded_at", "asc")
      .execute();
    return rows.map(record);
  }

  /** One skill of the agent by id, current or not (the newest row), or null. */
  async find(chainId: number, agentId: number, skillId: string): Promise<OwnerSkillRecord | null> {
    const row = await this.db
      .selectFrom("platform.owner_skills")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .where("skill_id", "=", skillId)
      .orderBy("current", "desc")
      .orderBy("uploaded_at", "desc")
      .executeTakeFirst();
    return row ? record(row) : null;
  }

  /**
   * Records a checked package as the agent's current version of its skill.
   * The same version with another content hash is refused (F1's
   * immutability, as builtin/versions.json refuses it); the same hash again
   * is a no-op that makes the row current; a new version replaces the old
   * as the current one, which stays as history.
   */
  async save(a: {
    chainId: number;
    agentId: number;
    pkg: SkillPackage;
    files: readonly UploadedFile[];
    warnings: readonly PackageIssue[];
    uploadedBy: Hex;
  }): Promise<OwnerSkillSave> {
    const m = a.pkg.manifest;
    return this.db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom("platform.owner_skills")
        .selectAll()
        .where("chain_id", "=", a.chainId)
        .where("agent_id", "=", a.agentId)
        .where("skill_id", "=", m.id)
        .forUpdate()
        .execute();
      const sameVersion = rows.find((r) => r.version === m.version);
      if (sameVersion && sameVersion.content_hash !== a.pkg.contentHash)
        return {
          ok: false,
          issue: {
            rule: "F1",
            severity: "block",
            path: "skill.json:version",
            message: `version ${m.version} is already uploaded with another content hash; bump the version`,
          },
        };
      const at = this.now();
      await trx
        .updateTable("platform.owner_skills")
        .set({ current: false })
        .where("chain_id", "=", a.chainId)
        .where("agent_id", "=", a.agentId)
        .where("skill_id", "=", m.id)
        .execute();
      const same = rows.find((r) => r.content_hash === a.pkg.contentHash);
      if (same) {
        const row = await trx
          .updateTable("platform.owner_skills")
          .set({ current: true, removed_at: null })
          .where("chain_id", "=", a.chainId)
          .where("agent_id", "=", a.agentId)
          .where("skill_id", "=", m.id)
          .where("content_hash", "=", a.pkg.contentHash)
          .returningAll()
          .executeTakeFirstOrThrow();
        return { ok: true, record: record(row), already: true };
      }
      const row = await trx
        .insertInto("platform.owner_skills")
        .values({
          chain_id: a.chainId,
          agent_id: a.agentId,
          skill_id: m.id,
          content_hash: a.pkg.contentHash,
          version: m.version,
          manifest_hash: a.pkg.manifestHash,
          hermes_name: a.pkg.hermesName,
          manifest: JSON.stringify(m),
          files: JSON.stringify(a.files.map((f) => ({ path: f.path, content: f.content }))),
          warnings: JSON.stringify(a.warnings),
          current: true,
          uploaded_by: a.uploadedBy.toLowerCase(),
          uploaded_at: at,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { ok: true, record: record(row), already: false };
    });
  }

  /** Removes a skill from the agent: its rows stop being current; nothing is deleted. Returns false when there was none. */
  async remove(chainId: number, agentId: number, skillId: string): Promise<boolean> {
    const r = await this.db
      .updateTable("platform.owner_skills")
      .set({ current: false, removed_at: this.now() })
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .where("skill_id", "=", skillId)
      .where("current", "=", true)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) > 0;
  }
}

interface Row {
  chain_id: number;
  agent_id: number;
  skill_id: string;
  content_hash: string;
  version: string;
  manifest_hash: string;
  hermes_name: string;
  manifest: Record<string, unknown>;
  files: { path: string; content: string }[];
  warnings: { rule: string; severity: string; path: string; message: string }[];
  current: boolean;
  uploaded_by: string;
  uploaded_at: Date;
  removed_at: Date | null;
}

function record(r: Row): OwnerSkillRecord {
  return {
    chainId: r.chain_id,
    agentId: r.agent_id,
    skillId: r.skill_id,
    version: r.version,
    contentHash: r.content_hash,
    manifestHash: r.manifest_hash,
    hermesName: r.hermes_name,
    manifest: r.manifest as unknown as SkillPackage["manifest"],
    files: r.files,
    warnings: r.warnings.map((w) => ({
      rule: w.rule,
      severity: w.severity === "block" ? "block" : "warn",
      path: w.path,
      message: w.message,
    })),
    current: r.current,
    uploadedBy: r.uploaded_by as Hex,
    uploadedAt: r.uploaded_at,
    removedAt: r.removed_at,
  };
}
