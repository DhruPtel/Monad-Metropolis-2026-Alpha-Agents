import { randomUUID } from "node:crypto";
import type { Db } from "@alpha-agents/db";
import { stripFrontmatter } from "@alpha-agents/skills/packages";
import { OwnerSkillStore } from "@alpha-agents/skills/store";
import type { AgentIdentity, ReplayAnswer, ReplayHook } from "@alpha-agents/tool-server";
import { canonicalJson } from "../hermes/layers.ts";
import { builtinSet } from "../hermes/materialize.ts";
import type { Store } from "../store.ts";
import { PlaybookOverrideStore } from "./playbook-overrides.ts";
import type { Cycle, CycleStore, StageRun } from "./store.ts";

/**
 * UI-U2: the replay tool's stored inputs. A replay runs one stored stage
 * again, on the exact inputs it saw, with an edited playbook or skill: its
 * prompt is the stored one, its sandbox mounts the edited text, and every
 * tool call answers from the original stage's stored results, keyed by the
 * tool and its input. A call the original stage did not make is refused, so
 * the only paid call in a replay is the model's. Each answered call is
 * recorded under the replay's stage, free, with the provider "replay", and
 * its result stored again so the brief validator checks the replay's brief
 * against the same figures.
 */
export interface StoredInput {
  readonly callId: string;
  readonly server: "data" | "platform" | "chain";
  readonly tool: string;
  readonly input: Record<string, unknown>;
  /** Null when the original call did not succeed or its result was not stored. */
  readonly result: Record<string, unknown> | null;
  readonly truncated: boolean;
}

/** The replay of a lease: the replay cycle and its one stage, or null outside one. */
export interface ReplayState {
  readonly cycle: Cycle;
  readonly stage: StageRun;
  readonly originalStageRunId: string;
}

export const NOT_STORED = (tool: string) =>
  `Not among the stored inputs of the replayed stage: ${tool} was not called with these arguments when the stage first ran. A replay answers only the calls the original stage made, with their stored results; call one of those, or finish the stage with what you have.`;

export class ReplayStore {
  private readonly store: Store;
  private readonly cycles: CycleStore;
  private readonly cache = new Map<string, Promise<readonly StoredInput[]>>();

  constructor(store: Store, cycles: CycleStore) {
    this.store = store;
    this.cycles = cycles;
  }

  /** Every call the original stage made, with its stored result where one succeeded. */
  async storedInputs(stageRunId: string): Promise<readonly StoredInput[]> {
    const rows = await this.store.db
      .selectFrom("platform.tool_calls as c")
      .leftJoin("platform.tool_results as r", "r.call_id", "c.call_id")
      .select([
        "c.call_id",
        "c.server",
        "c.tool",
        "c.input",
        "c.status",
        "r.result",
        "r.truncated",
      ])
      .where("c.stage_run_id", "=", stageRunId)
      .orderBy("c.started_at")
      .execute();
    return rows.map((r) => ({
      callId: r.call_id,
      server: r.server,
      tool: r.tool,
      input: r.input,
      result:
        r.status === "succeeded" && r.result && typeof r.result === "object" && !r.truncated
          ? (r.result as Record<string, unknown>)
          : null,
      truncated: r.truncated ?? false,
    }));
  }

  /** The lease's replay, when its current stage belongs to a REPLAY cycle. */
  async stateOf(leaseId: string): Promise<ReplayState | null> {
    const stage = await this.cycles.currentStage(leaseId);
    if (!stage) return null;
    const cycle = await this.cycles.cycle(stage.cycleId);
    if (!cycle || cycle.kind !== "REPLAY" || !cycle.replayOf) return null;
    return { cycle, stage, originalStageRunId: cycle.replayOf };
  }

  /**
   * The answer for a call inside a replay: the stored result of the same
   * tool on the same input, or a refusal; null outside a replay. The call is
   * recorded under the replay's stage either way, never charged.
   */
  async answer(
    identity: AgentIdentity,
    server: "data" | "platform" | "chain",
    tool: string,
    input: Record<string, unknown>,
  ): Promise<ReplayAnswer | null> {
    const state = await this.stateOf(identity.leaseId);
    if (!state) return null;
    const key = canonicalJson(input);
    const stored = await this.inputsOf(state.originalStageRunId);
    const match = stored.find(
      (s) => s.tool === tool && s.result !== null && canonicalJson(s.input) === key,
    );
    const callId = `call-${randomUUID()}`;
    await this.store.db
      .insertInto("platform.tool_calls")
      .values({
        call_id: callId,
        chain_id: identity.chainId,
        agent_id: identity.agentId,
        lease_id: identity.leaseId,
        server,
        tool,
        input: JSON.stringify(input),
        status: match ? "succeeded" : "refused",
        error_code: match ? null : "NOT_STORED",
        provider: "replay",
        cache_hit: match !== undefined,
        summary: JSON.stringify({ reason: match ? "replay" : "not_stored" }),
        finished_at: new Date(),
        stage_run_id: state.stage.stageRunId,
      })
      .execute();
    if (!match) return { hit: false, message: NOT_STORED(tool) };
    await this.cycles.storeResult(callId, state.stage, tool, match.result);
    return { hit: true, result: match.result as Record<string, unknown> };
  }

  /** The hook the tool servers call before any meter, log or upstream. */
  hook(): ReplayHook {
    return (identity, server, tool, input) => this.answer(identity, server, tool, input);
  }

  private inputsOf(stageRunId: string): Promise<readonly StoredInput[]> {
    let p = this.cache.get(stageRunId);
    if (!p) {
      p = this.storedInputs(stageRunId);
      this.cache.set(stageRunId, p);
      // The original stage is finished, so its inputs never change; a bounded cache is enough.
      if (this.cache.size > 50) {
        const first = this.cache.keys().next().value;
        if (first !== undefined) this.cache.delete(first);
      }
    }
    return p;
  }
}

/** UI-U2: each stage's playbook, by its mounted name. */
export const PLAYBOOK_OF: Readonly<Record<StageRun["stage"], string>> = {
  SCAN: "aa-playbook-scan",
  DIVE: "aa-playbook-dive",
  CHALLENGE: "aa-playbook-challenge",
  TEST: "",
  ZOOM_OUT: "aa-playbook-zoom-out",
};

/** UI-U2: a text a replay may edit, as the console shows it. */
export interface ReplayText {
  readonly kind: "playbook" | "owner";
  readonly name: string;
  readonly title: string;
  /** The SKILL.md body, without the generated frontmatter. */
  readonly skillMd: string;
  readonly version: string;
  /** For a playbook: how many versions the owner saved for this agent. */
  readonly savedVersions: number;
}

export interface ReplayView {
  readonly stage: StageRun;
  readonly cycle: Cycle;
  /** Why the stage cannot be replayed, or null when it can. */
  readonly replayable: string | null;
  readonly inputs: readonly {
    readonly callId: string;
    readonly server: string;
    readonly tool: string;
    readonly input: Record<string, unknown>;
    readonly stored: boolean;
    readonly truncated: boolean;
  }[];
  readonly texts: readonly ReplayText[];
  readonly replays: readonly {
    readonly cycle: Cycle;
    readonly stage: StageRun | null;
    readonly overrides: readonly { readonly kind: string; readonly name: string }[];
  }[];
}

/**
 * The replay tool's view of a stored stage: the stage, its prompt, every call
 * it made with whether the result is stored, the texts the owner may edit
 * (the stage's playbook, with any saved version, and each of the owner's own
 * skills), and the replays made so far.
 */
export interface ReplayViewDeps {
readonly db: Db;
readonly cycles: CycleStore;
readonly replay: ReplayStore | null;
}

export async function replayView(
deps: ReplayViewDeps,
stageRunId: string,
): Promise<ReplayView | null> {
  const stage = await deps.cycles.stageRun(stageRunId);
  if (!stage) return null;
  const cycle = await deps.cycles.cycle(stage.cycleId);
  if (!cycle) return null;
  const ref = { chainId: stage.chainId, agentId: stage.agentId };
  const inputs = deps.replay ? await deps.replay.storedInputs(stageRunId) : [];
  const texts = await replayTexts(deps.db, ref, stage);
  const replays = await Promise.all(
    (await deps.cycles.replaysOf(stageRunId)).map(async (r) => ({
      cycle: r,
      stage: (await deps.cycles.stages(r.cycleId))[0] ?? null,
      overrides: r.replayOverrides.map((o) => ({ kind: o.kind, name: o.name })),
    })),
  );
  return {
    stage,
    cycle,
    replayable:
      stage.modelAlias === null
        ? "The Test stage is deterministic and free; only model stages replay."
        : stage.prompt === null
          ? "This stage ran before replays existed and has no stored prompt. Run a new cycle and replay one of its stages."
          : stage.status === "running" || stage.status === "pending"
            ? "The stage is still running."
            : null,
    inputs: inputs.map((i) => ({
      callId: i.callId,
      server: i.server,
      tool: i.tool,
      input: i.input,
      stored: i.result !== null,
      truncated: i.truncated,
    })),
    texts,
    replays,
  };
}

/** The texts a replay of the stage may edit: its playbook (the saved version, if any) and the owner's skills. */
export async function replayTexts(
db: Db,
ref: { chainId: number; agentId: number },
stage: StageRun,
): Promise<ReplayText[]> {
  const out: ReplayText[] = [];
  const playbookName = PLAYBOOK_OF[stage.stage];
  const playbook = builtinSet().packages.find(
    (p) => p.kind === "playbook" && p.hermesName === playbookName,
  );
  if (playbook) {
    const saved = (
      await new PlaybookOverrideStore(db).versions(
        ref.chainId,
        ref.agentId,
        playbook.hermesName,
      )
    )[0];
    out.push({
      kind: "playbook",
      name: playbook.hermesName,
      title: playbook.manifest.name,
      skillMd: saved ? saved.skillMd : stripFrontmatter(playbook.skillMd),
      version: saved ? `${playbook.manifest.version} +${saved.version}` : playbook.manifest.version,
      savedVersions: saved?.version ?? 0,
    });
  }
  for (const r of await new OwnerSkillStore(db).current(ref.chainId, ref.agentId)) {
    const skillMd = r.files.find((f) => f.path === "SKILL.md")?.content ?? "";
    out.push({
      kind: "owner",
      name: r.hermesName,
      title: r.manifest.name,
      skillMd: stripFrontmatter(skillMd),
      version: r.version,
      savedVersions: 0,
    });
  }
  return out;
}
