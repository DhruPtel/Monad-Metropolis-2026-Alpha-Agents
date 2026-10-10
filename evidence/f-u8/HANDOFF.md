# F-U8 handoff: research v2, per-token Dives, position calls and playbooks 2.0

Unit: F-U8. Status: done.

## Commits

- `f152fd9` feat(agent): research v2 briefs: a Scan theme is a token, a held position or a market change with the token's address; a Dive's brief is per token with what it is, why now, the eight-item fundamentals checklist, evidence for and against, the risks, the safety screen's verdict, a thesis with its kill criterion, horizon and confidence or none, and a fair weight; the Zoom out's rationale weighs the whole portfolio, rates the evidence (weak evidence never proposes) and makes one call per position (ADD, HOLD, TRIM or EXIT) that complete_stage checks against the proposal and the plan in force; the validator refuses a claim tagged above what its sources give (the P3-U7 tagging slips); the stage prompts and the research context carry the token [F-U8]
- `2ed220e` feat(agent): playbooks 2.0 and the research skills for genuine fundamental analysis: the Scan reads the registry, the recent pools, the market and the open positions and flags tokens, position reviews or market changes shaped by the aggressiveness level; the Dive is per token with the eight-item fundamentals checklist, the source hierarchy with each claim tagged by what its sources give and dated, the safety screen, and a thesis with its kill condition, horizon, confidence and fair weight; the Challenge attacks the fundamentals and the fit with the account; the Zoom out calls ADD, HOLD, TRIM or EXIT per position, weighs the whole portfolio against the goal, says plainly when the evidence is weak and drafts a target portfolio; new built-in skills token-risk-screen and portfolio-construction; deep-dive-research 1.1.0; the band rebalancer's data keyed by level; the audit lets placeholder addresses in evals pass; versions locked [F-U8]
- `8b69654` docs(plans): log F-U8's completion with every check, record its values as A-76, add lesson L-193, add the research cycle v2 and the skill selection to the pending live checks with the selection as the runner's third step [F-U8]
- This file's commit: docs(plans): save the F-U8 handoff [F-U8]

## Test results

| Check | Result |
| --- | --- |
| format, lint, typecheck, forge fmt, secrets scan | pass |
| forge | 555 passed, 0 failed, 11 skipped (fork suites) |
| vitest, all projects | 2,195 passed in 167 files, 0 failed |
| vitest fork suites, one file at a time | 54 passed in 13 files |
| `pnpm test:fork` | 50 passed in 9 suites, address book matches |
| console e2e | 114 passed, no baseline changed |
| web e2e | not run: no web change in this unit |
| live model checks | none possible (the account still refuses); rows 4 and 5 of the pending list cover the research cycle on the playbooks 2.0 and the selection of the two new skills |

The node vitest project exits 1 from the known unhandled rejection in scan.test.ts (401 after a lease ended). Nothing was sent to the playtest fork; its head stayed at 109670015. dev:all was stopped for the heavy suites and is running again with this unit's code.

## What the owner should check or try

- Read the four playbooks and the two new skills under packages/skills/builtin: the research brief structure per token, the fundamentals checklist with the tool for each item, the source hierarchy and the tagging rule, the aggressiveness shaping, and the Zoom out's per-position calls and plain statement when evidence is weak. Say if any wording should change; a change needs a version bump and `pnpm skills:lock`.
- Dev console, Cycles page: a cycle's briefs show the v2 fields as written (the Dive's `fundamentals`, `screen` and `fairWeightBps`; the Zoom out's `portfolioView`, `evidenceStrength` and `positions`). A real cycle needs the account to accept calls (pending row 4).
- `pnpm test:live:pending` once the account accepts calls: step 2 runs a research cycle on the playbooks 2.0; step 3 checks that Hermes picks the two new skills from a task alone.
- A-76 records the values chosen where the plan was silent (the brief shapes, the class rule's table, the weak-evidence rule, the portfolio skill's defaults per level, the audit's placeholder rule); say if any should change.

## Open issues for the next unit

- F-U9 turns a Zoom out's `target_portfolio@1` proposal into a plan card with positions, theses and implied trades; the RATIONALE's position calls and `portfolioView` are the card's text.
- P3-U10's per-position triggers (a kill criterion met, a recheck date, a liquidity drop, a failed re-screen) have their fields in the plan's exits and the briefs.
- The console's skills fixture still lists P3-U7's ten packages; the live page lists twelve.
- The live checks remain pending on the account (evidence/live-pending.md, rows 1 to 5).

## Push

```
git push
```
