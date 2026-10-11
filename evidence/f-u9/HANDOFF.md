# F-U9 handoff: portfolio proposals, the evaluator and the plan card

Unit: F-U9, with P0-SPEND (the model spending guardrails) and the F-U7 and F-U8 follow-ups. Status: done.

## Commits

P0-SPEND:

- `14b642d` feat(infra): add pnpm spend:report, which reads LiteLLM's own spend logs by day, caller, model, local task purpose and the costliest hours and calls, and record where 28.93 USD went since October 4 [P0-SPEND]
- `3a73559` feat(agent): cap every task's model spend at 10 USD (D-369): the gate, the cycle, the Scan and no-op tasks, the live run, the selection check and the pending list [P0-SPEND]
- `3f76935` chore(infra): give the LiteLLM gateway a proxy-wide budget of 15 USD a day [P0-SPEND]
- `e6815a1` feat(agent): turn scheduled research off by default in local development (SCHEDULED_RESEARCH) [P0-SPEND]
- `2b25d22` docs(plans): add the model spending rule to CLAUDE.md [P0-SPEND]
- `fe59ec0` fix(infra): type the spend report for the root check and print its days and hours as dates [P0-SPEND]

F-U9:

- `a65820a` fix(agent): name an excluded token by its symbol in the goal's brief (the F-U7 follow-up) [F-U9]
- `293e15e` test(web): refresh the console's skills fixture to the twelve built-in packages (the F-U8 follow-up) [F-U9]
- `7932161` feat(agent): store the Zoom out's decision as a portfolio proposal or a "no change" (migration 0024), with the evaluator, the cost estimate, the approval rule and the narrator's entries [F-U9]
- `3837f7a` feat(api): the plan card and the owner's proposal actions, re-checked at approval, owner only and tied to the epochs [F-U9]
- `5a8d92d` feat(web): the plan card on the portfolio page, built in the design system first, with the e2e fake and spec [F-U9]
- `c821d24` fix(web): name the fixtures' token addresses through constants and record two false positives by fingerprint [F-U9]
- `b8076b5` test(agent): prove on a fork that the owner's approval sets the runner's target through a real Test v2 re-check [F-U9]
- `bedcea1` fix(agent): the live run's drain call asks for research-low (L-196); A-77 and lessons L-194 to L-196 [F-U9]
- `7ce86f7` fix(agent): the live run starts discovery and watches its run instead of holding a request open (L-197) [F-U9]
- `20d3017` fix(agent): the live run accepts the registry's latest discovery pass [F-U9]
- `e9c4ff0` fix(agent): the live watcher reads the registry's run rows without a chain filter [F-U9]
- `4b78567` fix(agent): the live run deploys the fund set and Executor v3 on its fork (L-198) [F-U9]
- `2002c33` test(web): the decline flow as its own test, the database's table check, and the re-baselined captures [F-U9]
- `3b0c555` docs(plans): log P0-SPEND and F-U9, the pending list's results, the live reports and the selection evidence [F-U9]
- `441c054` docs(plans): save the F-U9 handoff [F-U9]
- The last commit: fix(agent): stop the live run's 15-second Scan cadence after the scheduler check, read the spend meters after a settle, and correct the session's spend to the spend report's figure (L-199) [F-U9]

## Test results

| Check | Result |
| --- | --- |
| format, lint, typecheck, forge fmt, secrets scan | pass |
| forge | 555 passed, 0 failed, 11 skipped (fork suites) |
| vitest, all projects | 2,216 passed in 171 files, 0 failed |
| vitest fork suites, one file at a time | 54 passed in 13 files, the runner's suite now approving a proposal with a real Test v2 re-check before it trades |
| `pnpm test:fork` | 50 passed in 9 suites, address book matches |
| console e2e | 114 passed in update mode, 114 again on the new baselines |
| web e2e | update mode in halves (104; 110 and 32), then 104 and 114 on the new baselines, the 2 live specs skipped; 4 new and 4 re-done captures checked by eye at 1440 and 380 |
| spending guardrails | the gate's cap test and the capped cycle test pass; the gateway answers `max_budget 15`; a one-token call through it cost 0.000015 USD |
| live run (`pnpm test:orchestrator:live`, sixth attempt) | 52 of 54 checks passed for 4.085 USD on the Low tier: the trade flow armed and settled through the v3 set, the full cycle ran and its Zoom out's NO_CHANGE was stored for the plan card; the two failures are the first Dive ending at its turn cap on the Low tier |
| pending list (`pnpm test:live:pending`) | step 1 PASS (free), step 3 PASS (15 of 15, 0.065 USD), step 2 as above after five fixed attempts |

The node vitest project exits 1 from the known unhandled rejection in scan.test.ts (401 after a lease ended). Nothing was sent to the playtest fork; its head stayed at 109670015. dev:all was stopped for the heavy suites and is running again with this unit's code, scheduled research off.

**Model spend of this session: 16.76 USD**, from `pnpm spend:report` (the figure of record): 12.70 USD on October 10 UTC from 21:48 and 4.06 USD on October 11 UTC to 00:22, all on the live checks' own keys, in six attempts of the live run (about 2.8 to 4.1 USD each from the second on) plus 0.07 USD for the dry run and the selection check. The scripts' own meters had reported 6.13 USD: the gateway's spend logs lag the calls, and each attempt also ran 7 to 11 scheduled Scans at the 15-second cadence the scheduler check sets (L-199, now stopped after the check and the meters read after a settle). No single task exceeded the 10 USD cap and the gateway's 15 USD day was not reached (12.70 on October 10 UTC).

## What the owner should check or try

- `pnpm spend:report --days=14` and evidence/p0-spend/REPORT.md: where the 28.93 USD went (27.69 to the live checks' keys, 20.20 on October 9 in eight live runs). The gateway now refuses everything past 15 USD a day; every task stops at 10 USD; scheduled research is off locally unless you start dev:all with SCHEDULED_RESEARCH=on; the CLAUDE.md rule is in place. Say if 15 USD a day should be another figure.
- The portfolio page of an agent you own on the fund agent's set: "The agent's plan" shows the proposal waiting (every position's action, weights, thesis and exit plan, the sources by class, the skeptic's verdict, the evidence strength, the checks and the estimated cost), with Approve and Decline; a rejected one shows its findings and no buttons; "Why the plan did not change" shows the Zoom out's reason. The /design page has the specimens.
- Approving sets the plan the runner follows and bumps the strategy epoch (waiting intents of the old epoch die); the goal's "Apply and tell me" applies a passing proposal at once and the activity feed says so; the first plan after arming always waits for you.
- A-77 records the values chosen where the plan was silent (the cost estimate's basis, the expiry, the approval rule, what the card shows when nothing waits); say if any should change.
- The Low tier's Dives ran to their turn cap in the live cycle and its Zoom out chose no change on a fresh account: the Medium tier, or more Dive turns on the Low tier, is the first thing to try before Playtest T (F-T1 tuning, Q-60).

## Open issues for the next unit

- A live proposal shown on the plan card from a real cycle is still to be seen (pending list row 6): the sixth live run's cycle decided no change; the proposal path is proven by the scripted cycle, the API tests, the component and e2e tests and the fork test.
- F-U10 (the activation sweep) builds the first plan from the sweep and its approval arms the agent (D-291); the proposal store, the evaluator and the plan card are ready for it.
- Scheduled Scans outside a cycle ended without complete_stage twice in the second live run (16 Haiku calls each); P3-U10 revises the scheduled Scan, and scheduled research is off locally until then.
- The console's cycles page shows a proposal's record only as the Zoom out's stage record; a console view of the proposals table is a suggestion.

## Push

```
git push
```
