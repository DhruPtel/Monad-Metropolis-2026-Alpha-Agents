# Live checks waiting on the Anthropic account

One command runs them all, in order, once the account accepts calls (see evidence/p0-api/DIAGNOSIS.md for what the owner must do first):

```
pnpm test:live:pending
```

Each step starts its own stack and never touches the playtest fork on 8545.

| # | Check | Unit it belongs to | What it proves | Command |
| --- | --- | --- | --- | --- |
| 1 | Anthropic request shapes | P0-API | Every alias and every research stage's real request (system prompt, prompt, 30 tools) is counted by the free endpoint; a token count per stage is recorded | `pnpm test:anthropic:dry-run` |
| 2 | Live orchestrator run | P1-U5 to P1-U7, P2-U5, P2-U6, P3-U9, P3-U4, F-U1 | Mint to provisioning; credits and metering; the no-op task through E2B, the gate and a real model; the chain check; the trade flow on a fork; the research check (X, Dune, chain lookups); the token check (discovery, listing, screening by a real agent); a full research cycle on its aliases | `pnpm test:orchestrator:live` |

Still waiting from earlier units, all covered by step 2: F-U1's live token check (first refused 2026-10-10 03:55 UTC), F-U2, F-U3 and F-U4's Step 0 live token check, and F-U5's live E2B run (refused 15:35 and 16:55 UTC).

Added by later units: each unit that needs a live check appends a row here and, where it is a new flow, a step to `scripts/live-pending.js`.

| # | Check | Unit | What it proves | Command |
| --- | --- | --- | --- | --- |
| 3 | Goal brief and model tiers | F-U7 | The Scan on `research-low` and the reasoning stages on `research-low`, `research-medium` and `research-high`, each with the goal's brief and envelope in the prompt, counted by the dry run and answered by the real models in the live run | covered by steps 1 and 2 (`pnpm test:live:pending`) |
| 4 | Research cycle on playbooks 2.0 | F-U8 | A real model follows the Scan, Dive, Challenge and Zoom out 2.0: per-token Dives with the fundamentals checklist and the safety screen, claims tagged by what their sources give, position calls that match the draft, and a target portfolio that passes the Test v2 | covered by step 2 (`pnpm test:live:pending`) |
| 5 | Skill selection for the two new skills | F-U8 | Hermes loads aa-token-risk-screen for a screen question and aa-portfolio-construction with the Zoom out playbook for a portfolio draft, from the task alone (Q-07) | `pnpm test:skills:selection` (step 3 of `pnpm test:live:pending`) |
| 6 | A live proposal with positions on the plan card | F-U9, F-U10 | A real agent's cycle ends with a PROPOSE decision carrying at least one position, shown on the web app's plan card with its reasons, verdicts and cost. Still to be seen: the sixth F-U9 live run's cycle (Low tier) chose no change on a fresh account, and both F-U10 activation sweeps on the Medium tier (2026-10-11, evidence/f-u10) proposed a plan of cash only after the skeptic rejected every thesis, which the owner approved and the runner held on; the proposal path with positions is proven by the scripted cycle, the API tests and the fork test | `pnpm test:activation:live` (the Medium tier) after F-T1's tuning of the Dive and Challenge prompts (Q-60), or `pnpm test:orchestrator:live` |

## Results so far (2026-10-10, after the account accepted calls again)

| Step | Result | Model spend |
| --- | --- | --- |
| 1 Anthropic request shapes | PASS, every alias and stage counted (evidence/p0-api/dry-run-2026-10-10T21-48-52-902Z.json) | 0.000 USD |
| 3 Skill selection | PASS, 15 of 15 cases on every repeat on `research-low`, the two F-U8 skills chosen from the task alone (evidence/p3-u7/selection.json) | 0.065 USD |
| 2 Live orchestrator run | Five attempts: the first failed at the scheduler (L-195) and the drain check (L-196); the second at a discovery request held open past the fetch timeout (L-197); the third and fourth at the discovery watcher (the registry answers from its own pass, keyed by chain 143); the fifth passed 36 checks and failed at arming because its fork lacked the v3 set (L-198); the sixth passed 52 of 54 checks (mint, credits, the no-op task, the drain, the scheduler's Scans, the research check, discovery with 27 tokens and 42 pools, the token check with a fresh screen, the chain check, the trade flow armed by the owner's first approval with the swap settled, and a full research cycle on the Low tier whose Zoom out recorded NO_CHANGE for the plan card); the two failures are the first Dive ending at its turn cap on the Low tier (evidence/p1-u7/live-2026-10-10T23-56-57.040Z.json) | 0.025, 0.025, 0.025, 1.864 and 4.085 USD |

