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
