/**
 * The built-in workflows at launch (FINAL_PLAN 4.6.2) as spec fixtures. The Risk
 * Sentinel is a service (P4-U2), not a workflow, so it is not here. Schedules and
 * thresholds are placeholders until the templates' parameter schemas (Q-28).
 */
const base = {
  schema_version: 1,
  version: "1.0.0",
  preconditions: [],
  timeoutSeconds: 900,
  compensation: "cancel_pending_intents",
} as const;

export const BUILT_IN_WORKFLOWS: readonly unknown[] = [
  {
    ...base,
    id: "rebalancer",
    name: "Rebalancer",
    trigger: { type: "schedule", cron: "0 12 * * *" },
    account: "personal",
    required_skills: ["usdc-wmon-band-rebalancer"],
    required_tools: ["chain.get_portfolio@1", "chain.get_limits@1"],
    steps: [
      { id: "read-portfolio", kind: "tool", tool: "chain.get_portfolio@1", timeoutSeconds: 30 },
      { id: "read-limits", kind: "tool", tool: "chain.get_limits@1", timeoutSeconds: 30 },
      { id: "propose", kind: "intent", tool: "intent.propose_rebalance@1", timeoutSeconds: 60 },
    ],
    guardrails: { maxIntentsPerRun: 1 },
    approval: { mode: "notify" },
  },
  {
    ...base,
    id: "recurring-buys",
    name: "Recurring Buys",
    trigger: { type: "schedule", cron: "0 9 * * 1" },
    account: "personal",
    required_skills: ["wmon-dca-accumulator"],
    required_tools: ["chain.get_portfolio@1", "chain.get_prices@1"],
    steps: [
      { id: "check-budget", kind: "tool", tool: "chain.get_portfolio@1", timeoutSeconds: 30 },
      { id: "check-drawdown", kind: "tool", tool: "chain.get_prices@1", timeoutSeconds: 30 },
      { id: "buy", kind: "intent", tool: "intent.propose_swap@1", timeoutSeconds: 60 },
    ],
    guardrails: { maxIntentsPerRun: 1 },
    approval: { mode: "auto" },
  },
  {
    ...base,
    id: "parameter-change-review",
    name: "Parameter change review",
    trigger: { type: "event", event: "StrategyUpdateAccepted" },
    account: "personal",
    required_skills: [],
    required_tools: ["platform.get_goals_and_limits@1"],
    steps: [
      {
        id: "read-bounds",
        kind: "tool",
        tool: "platform.get_goals_and_limits@1",
        timeoutSeconds: 30,
      },
      {
        id: "record",
        kind: "intent",
        tool: "intent.propose_strategy_update@1",
        timeoutSeconds: 60,
      },
    ],
    guardrails: { maxIntentsPerRun: 1 },
    approval: { mode: "require_approval" },
    compensation: "notify_owner",
  },
];
