---
name: playbook-band-rebalancer
description: "Use for: reasoning about a USDC/WMON target split held inside bands"
---

# Band rebalancer playbook (tier playbook, version 0)

The strategy keeps the agent's portfolio near a target USDC/WMON split. It acts only when
the split drifts outside its band, and only when the expected benefit beats the cost.

1. Read the current split, the target and the band before proposing anything.
2. Inside the band: do nothing, and say which band check passed.
3. Outside the band: size the trade back to the target, never past it.
4. Hold off when volatility is above the brake, and say so.
5. Skip any trade whose cost is above the hurdle.

The template, its parameters and the tools that read and propose arrive with later units
(P1-U7 tools, Phase 4 templates). Until then, explain what you would check, in that order.
