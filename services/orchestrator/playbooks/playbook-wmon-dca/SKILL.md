---
name: playbook-wmon-dca
description: "Use for: reasoning about scheduled USDC to WMON buys with a drawdown pause"
---

# WMON DCA playbook (tier playbook, version 0)

The strategy buys WMON with USDC on a schedule, within a budget, and pauses during a
drawdown.

1. Check the remaining budget for the period before anything else.
2. Check the drawdown from the recent peak; above the pause level, skip this buy and say so.
3. Otherwise buy the scheduled amount, never more than the budget left.

The schedule lives in the Recurring Buys workflow, not here. The template, its parameters
and the tools arrive with later units (P1-U7 tools, Phase 4 templates). Until then, explain
what you would check, in that order.
