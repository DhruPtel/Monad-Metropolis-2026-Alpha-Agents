# F-U7 handoff: the goal as one aggressiveness choice, a brief and a model tier

Unit: F-U7. Status: done.

## Commits

- `b7822f8` feat(agent): make the goal one aggressiveness choice that produces the brief the agent reads and the envelope the Test enforces, with the model tier Low, Medium or High (Haiku 4.5, Sonnet 5.5, Opus 5.5), the screened-lane opt-in and excluded tokens; drop the template, the risk preset and the WMON fields; migrate saved goals to Conservative with their limits and settings carried over; rename the WMON share limit to the one-token limit; serve the brief and the envelope to the agent; run the Scan on the Low tier's alias; rebuild the Goal page and the goal summaries [F-U7]
- `ebd904d` test(web): answer the goal form in the e2e fake by awaiting the control API's builder (it became async with the registry's tokens, and the fake had served the pending promise as an empty form) with three registry tokens; exclude WBTC and allow it again in the Goal page spec; expect the portfolio's goal summary as "Goal: Balanced"; re-baseline the Goal page and the design page at 1440 and 380 [F-U7]
- `c004aa9` docs(plans): log F-U7's completion with every check, record its values as A-75, add lesson L-192 and the goal brief's live check to the pending list [F-U7]
- This file's commit: docs(plans): save the F-U7 handoff [F-U7]

## Test results

| Check | Result |
| --- | --- |
| format, lint, typecheck, forge fmt, secrets scan | pass |
| forge | 555 passed, 0 failed, 11 skipped (fork suites) |
| vitest, all projects | 2,187 passed in 166 files, 0 failed |
| vitest fork suites, one file at a time | 54 passed in 13 files; the keeper suite failed once in a batch of five and passed alone right after (untouched by this unit) |
| `pnpm test:fork` | 50 passed in 9 suites, address book matches |
| console e2e | 114 passed, no baseline changed |
| web e2e | update mode: 102 passed, 2 failed on the old summary text, fixed, then 122 passed; confirm runs: 104 and 108 passed, the 2 live specs skipped; 9 baselines re-done and checked by eye at 1440 and 380 |
| live model checks | none possible (the account still refuses); row 3 of the pending list covers the tiers and the brief through steps 1 and 2 |

The node vitest project exits 1 from the known unhandled rejection in scan.test.ts (401 after a lease ended). Nothing was sent to the playtest fork; its head stayed at 109670015. dev:all was stopped for the heavy suites and is running again with this unit's code.

## What the owner should check or try

- Goal page in the web app (http://127.0.0.1:3000/agents/<id>/goal, as the agent's owner): one Aggressiveness choice with each level's envelope on its card, "The agent reads:" with the brief, the two-asset fallback line, the Screened lane choice, the Excluded tokens picker (a Select over the registry, a tag and Remove), the stricter limits with "Most in one token", the Model tier (Low, Medium, High) with the sweep maximum per tier in the cost note, the intensity, the budget, the reserve and the plan changes. Save and see the summary "Goal: <level> (...)" on the card and the portfolio.
- Saved goals from before this unit now read as Conservative with their limits carried over (D-345); the strategy epoch did not move. Saving the form bumps it as before (D-281).
- A-75 records the values chosen where the plan was silent (the fallback's bands per level, 2.00 USDC as the sweep maximum shown at Low, the Scan on Low, the legacy mapping); say if any should change.
- The dev console's agents page names the level in its plan section; the Test stage v2 enforces the level's envelope.

## Open issues for the next unit

- F-U8 revises the playbooks and skills: the band rebalancer skill's data keeps its preset names (Aggressive reads its Growth); the research prompts should read the brief and the envelope now served in the goals-and-limits answer.
- The brief names an excluded token by its address; a symbol beside it in the owner's view is a suggestion in LOGS.
- The live checks remain pending on the account (evidence/live-pending.md, rows 1 to 3).

## Push

```
git push
```
