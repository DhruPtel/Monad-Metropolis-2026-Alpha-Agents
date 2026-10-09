import type { TaskResultField } from "@alpha-agents/ui";

const seconds = (ms: unknown) => `${(Number(ms) / 1000).toFixed(1)} s`;
const TIER_NAME: Record<string, string> = { base: "Base", medium: "Medium", pro: "Pro" };

/** The rows a no-op result shows, in plain words. */
export function noopFields(result: Record<string, unknown> | null): TaskResultField[] {
  if (!result) return [];
  const t = (result.timingsMs ?? {}) as Record<string, unknown>;
  return [
    { label: "Reply", value: String(result.replied ?? "") || "None" },
    {
      label: "Tier",
      value: `${TIER_NAME[String(result.tier)] ?? String(result.tier)}, ${String(result.slots)} slots, ${String(result.playbook)}`,
    },
    {
      label: "Model calls",
      value: `${String(result.modelCallsOk)} of ${String(result.modelCalls)} succeeded`,
    },
    { label: "Sandbox", value: result.sandboxStopped ? "Stopped" : "Still running" },
    {
      label: "Time",
      value: `Sandbox ${seconds(t.sandbox)}, Hermes ${seconds(t.hermesBoot)}, run ${seconds(t.run)}`,
    },
    { label: "Config", value: String(result.configHash ?? "").slice(0, 12) },
  ];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const usdc = (e6: unknown) => `${(Number(e6 ?? 0) / 1e6).toFixed(4)} USDC`;
const STOP: Record<string, string> = {
  COMPLETED: "Completed with complete_stage",
  BILLING: "Stopped: credits ran out",
  DEADLINE: "Stopped at the deadline",
  NO_STAGE_RECORD: "Ended without complete_stage",
  FAILED: "Failed",
};

/** The rows a Scan result shows (P1-U7): its stage record, tool calls, spend and timing. */
export function scanFields(result: Record<string, unknown> | null): TaskResultField[] {
  if (!result) return [];
  const t = (result.timingsMs ?? {}) as Record<string, unknown>;
  const stage = result.stage as {
    outcome?: string;
    schemaValid?: boolean;
    candidates?: { asset: string; thesisCode: string; confidenceBps: number }[];
  } | null;
  const calls = (result.toolCalls ?? []) as { tool: string; status: string }[];
  const count = (tool: string) =>
    calls.filter((c) => c.tool === tool && c.status === "succeeded").length;
  return [
    { label: "Outcome", value: STOP[String(result.stopReason)] ?? String(result.stopReason) },
    {
      label: "Stage record",
      value: stage
        ? `${String(stage.outcome)}, ${stage.schemaValid ? "schema-valid" : "invalid"}`
        : "None",
    },
    {
      label: "Candidates",
      value:
        stage?.candidates && stage.candidates.length > 0
          ? stage.candidates
              .map((c) => `${c.asset} ${c.thesisCode} (${(c.confidenceBps / 100).toString()}%)`)
              .join(", ")
          : "None",
    },
    {
      label: "Tool calls",
      value: `${plural(count("web_search"), "search", "searches")}, ${plural(count("read_url"), "page", "pages")} read, ${plural(calls.length, "call", "calls")} in all`,
    },
    { label: "Tool spend", value: usdc(result.toolChargeUsdcE6) },
    { label: "Model calls", value: String(result.modelCalls ?? 0) },
    { label: "Sandbox", value: result.sandboxStopped ? "Stopped" : "Still running" },
    {
      label: "Time",
      value: `Sandbox ${seconds(t.sandbox)}, Hermes ${seconds(t.hermesBoot)}, run ${seconds(t.run)}`,
    },
  ];
}

const CHAIN_STOP: Record<string, string> = {
  COMPLETED: "Read every tool and proposed a swap",
  INCOMPLETE: "Ended without every read and a proposal",
  DEADLINE: "Stopped at the deadline",
  FAILED: "Failed",
};

/** The rows a chain check shows (P2-U5): the chain tools it called and the intents it made. */
export function chainCheckFields(result: Record<string, unknown> | null): TaskResultField[] {
  if (!result) return [];
  const t = (result.timingsMs ?? {}) as Record<string, unknown>;
  const calls = (result.toolCalls ?? []) as {
    tool: string;
    status: string;
    errorCode: string | null;
  }[];
  const intents = (result.intents ?? []) as {
    intentId: string;
    status: string;
    reasonCodes: string[];
  }[];
  return [
    { label: "Outcome", value: CHAIN_STOP[String(result.stopReason)] ?? String(result.stopReason) },
    {
      label: "Chain tools",
      value:
        calls.length === 0
          ? "None"
          : calls
              .map(
                (c) => `${c.tool} ${c.status === "succeeded" ? "ok" : (c.errorCode ?? c.status)}`,
              )
              .join(", "),
    },
    {
      label: "Intents",
      value:
        intents.length === 0
          ? "None"
          : intents
              .map(
                (i) =>
                  `${i.status.replace("_", " ")}${i.reasonCodes.length ? ` (${i.reasonCodes.join(", ")})` : ""}`,
              )
              .join("; "),
    },
    { label: "Model calls", value: String(result.modelCalls ?? 0) },
    { label: "Time", value: `run ${seconds(t.run)}, total ${seconds(t.total)}` },
  ];
}

const RESEARCH_STOP: Record<string, string> = {
  COMPLETED: "Used every research source",
  INCOMPLETE: "Ended without every source answering",
  DEADLINE: "Stopped at the deadline",
};

/** The rows a research check shows (P3-U9): each research tool it called, its charge and cache hit. */
export function researchCheckFields(result: Record<string, unknown> | null): TaskResultField[] {
  if (!result) return [];
  const t = (result.timingsMs ?? {}) as Record<string, unknown>;
  const calls = (result.toolCalls ?? []) as {
    tool: string;
    status: string;
    errorCode: string | null;
    chargeUsdcE6: string;
    cacheHit: boolean;
  }[];
  const charged = calls.reduce((n, c) => n + Number(c.chargeUsdcE6), 0) / 1_000_000;
  return [
    {
      label: "Outcome",
      value: RESEARCH_STOP[String(result.stopReason)] ?? String(result.stopReason),
    },
    {
      label: "Research tools",
      value:
        calls.length === 0
          ? "None"
          : calls
              .map(
                (c) =>
                  `${c.tool} ${c.status === "succeeded" ? (c.cacheHit ? "ok (cached)" : "ok") : (c.errorCode ?? c.status)}`,
              )
              .join(", "),
    },
    { label: "Charged for tools", value: `${charged.toFixed(4)} USDC` },
    { label: "Model calls", value: String(result.modelCalls ?? 0) },
    { label: "Time", value: `run ${seconds(t.run)}, total ${seconds(t.total)}` },
  ];
}
