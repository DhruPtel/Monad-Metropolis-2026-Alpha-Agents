import type { CycleJson, StageDetail, StageJson } from "./cycles";

/**
 * The replay tool (UI-U2): a stored research stage run again on the exact
 * inputs it saw, with the stage's playbook or one of the owner's skills
 * edited in place. The orchestrator's replay view as the page reads it, and
 * the small rules the page renders with, kept here so they are tested
 * without a browser.
 */
export interface ReplayText {
  readonly kind: "playbook" | "owner";
  readonly name: string;
  readonly title: string;
  readonly skillMd: string;
  readonly version: string;
  readonly savedVersions: number;
}

export interface ReplayInput {
  readonly callId: string;
  readonly server: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly stored: boolean;
  readonly truncated: boolean;
}

export interface ReplayViewJson {
  readonly agentId: string;
  readonly stage: StageJson & { readonly prompt: string | null };
  readonly cycle: Omit<CycleJson, "stages">;
  /** Why the stage cannot be replayed, or null when it can. */
  readonly replayable: string | null;
  readonly canStart: boolean;
  readonly inputs: readonly ReplayInput[];
  readonly texts: readonly ReplayText[];
  readonly replays: readonly {
    readonly cycle: Omit<CycleJson, "stages">;
    readonly stage: StageJson | null;
    readonly overrides: readonly { readonly kind: string; readonly name: string }[];
  }[];
}

export interface ReplayOverride {
  readonly kind: "playbook" | "owner";
  readonly name: string;
  readonly skillMd: string;
}

/** The texts the owner changed, as the replay mounts them; an unchanged text is not sent. */
export function changedTexts(
  texts: readonly ReplayText[],
  edits: Readonly<Record<string, string>>,
): ReplayOverride[] {
  return texts
    .filter((t) => edits[t.name] !== undefined && edits[t.name] !== t.skillMd)
    .map((t) => ({ kind: t.kind, name: t.name, skillMd: edits[t.name] ?? t.skillMd }));
}

/** The inputs a replay answers from: the calls whose results are stored, counted by tool. */
export function storedInputSummary(inputs: readonly ReplayInput[]): {
  stored: number;
  writes: number;
  byTool: readonly { tool: string; count: number }[];
} {
  const counts = new Map<string, number>();
  let stored = 0;
  for (const i of inputs) {
    if (!i.stored) continue;
    stored += 1;
    counts.set(i.tool, (counts.get(i.tool) ?? 0) + 1);
  }
  return {
    stored,
    writes: inputs.length - stored,
    byTool: [...counts].map(([tool, count]) => ({ tool, count })),
  };
}

export interface ComparisonRow {
  readonly label: string;
  readonly before: string;
  readonly after: string;
  readonly changed: boolean;
}

const usdc4 = (e6: string) => `${(Number(e6) / 1e6).toFixed(4)} USDC`;

const briefLine = (s: Pick<StageDetail, "briefs">): string =>
  s.briefs.length === 0
    ? "none"
    : s.briefs
        .map((b) => `${b.kind} ${b.status}`)
        .reverse()
        .join(", ");

const recordLine = (s: Pick<StageDetail, "record">): string =>
  s.record
    ? `${s.record.outcome}${
        s.record.decision ? `, ${String((s.record.decision as { kind?: unknown }).kind ?? "")}` : ""
      }${
        Array.isArray(s.record.candidates) && s.record.candidates.length > 0
          ? `, ${s.record.candidates.length} candidate${s.record.candidates.length === 1 ? "" : "s"}`
          : ""
      }`
    : "none";

const refusedCalls = (s: Pick<StageDetail, "toolCalls">): number =>
  s.toolCalls.filter((c) => c.status === "refused").length;

/**
 * The old and new output side by side: what each run ended with, what it
 * cost, how many model and tool calls it made, its briefs and its record.
 * The replay's tool calls are all free, so its cost is the model's alone.
 */
export function compareStages(before: StageDetail, after: StageDetail | null): ComparisonRow[] {
  const row = (label: string, b: string, a: string | null): ComparisonRow => ({
    label,
    before: b,
    after: a ?? "not run yet",
    changed: a !== null && a !== b,
  });
  return [
    row(
      "Ended",
      `${before.status} (${before.stopReason ?? "none"})`,
      after ? `${after.status} (${after.stopReason ?? "none"})` : null,
    ),
    row("Cost", usdc4(before.chargedUsdcE6), after ? usdc4(after.chargedUsdcE6) : null),
    row(
      "Model calls",
      `${before.modelCalls} on ${before.model ?? "no model"}`,
      after ? `${after.modelCalls} on ${after.model ?? "no model"}` : null,
    ),
    row(
      "Tool calls",
      `${before.toolCalls.length}${refusedCalls(before) ? ` (${refusedCalls(before)} refused)` : ""}`,
      after
        ? `${after.toolCalls.length}${refusedCalls(after) ? ` (${refusedCalls(after)} refused)` : ""}`
        : null,
    ),
    row("Briefs", briefLine(before), after ? briefLine(after) : null),
    row("Record", recordLine(before), after ? recordLine(after) : null),
  ];
}
