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
