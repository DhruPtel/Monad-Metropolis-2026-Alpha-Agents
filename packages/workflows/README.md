# @alpha-agents/workflows

The workflow spec schema (FINAL_PLAN 4.6.1) and `validateWorkflowSpec`, shared by the runner, the audit service and the creator portal. Every list and time is bounded, steps call registry tools only, intent steps call registry intents only, schedules have fixed minutes, and unknown fields fail, so a hostile or unbounded spec is rejected. `BUILT_IN_WORKFLOWS` holds Rebalancer, Recurring Buys and Parameter change review as fixtures.
