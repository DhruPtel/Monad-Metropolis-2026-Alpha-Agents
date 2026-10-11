# F-U11 handoff: portfolio window

Unit: F-U11. Status: done.

## Commits

- `25ee348` feat(trading): the value per unit on every snapshot (migration 0026), the window oldest first, and the pure window rules (the series, the three scores, the $100 figure, the markers, the closed positions, the holdings) [F-U11]
- `3e44943` feat(api): the orchestrator's live account read (`GET /v1/agents/:id/account`) and the control API's owner-only `GET /v1/agents/:id/window` [F-U11]
- `d6f9c4c` fix(api): the window test names the public token addresses as constants; two scan findings recorded by fingerprint (L-203) [F-U11]
- `d1c56b3` feat(web): the design system pieces on /design: the chart tokens, the asset makeup table, the allocation donut, the performance chart, the score tiles, the $100 tile [F-U11]
- `4f34be3` feat(web): the window page at /agents/[id]/window, linked from the portfolio page and the My Agents card; the portfolio page's anchors [F-U11]
- `509c14c` test(agent): the runner's fork test records snapshots around its trades and checks the window built from them [F-U11]
- `bc74fe7` test(web): the window's e2e specs and captures at 1440 and 380 with accessibility checks; the fake API's window route; the portfolio page scrolls to the section its hash names once loaded; the re-done captures [F-U11]
- `c3d03eb` test(web): re-capture three login specimens moved by a fraction of a pixel by the six chart swatches above them [F-U11]
- `2d84d6d` fix(web): the window component test's element cast, which the full typecheck refused [F-U11]
- The last commit: docs(plans): the LOGS and LESSONS entries, A-79 and this handoff [F-U11]

## Test results

| Check | Result |
| --- | --- |
| format, lint, typecheck, forge fmt, secrets scan | pass |
| forge | 572 passed, 0 failed, 8 skipped |
| vitest node | 1,480 passed in 120 files (the exit code 1 is the known unhandled rejection in scan.test.ts) |
| vitest forks, one file at a time | 54 passed in 13 files, the runner's fork test now recording snapshots around its trades and checking the window |
| vitest ui, console and web | 758 passed in 45 files |
| `pnpm test:fork` | 50 passed in 9 suites, the address book matching |
| web e2e | the three touched specs 58 passed and 4 failed in the first update run (two faults of my own, fixed), the window spec 14 passed on its new baselines, the full suite 237 passed with the 2 live specs skipped and 3 login specimens re-captured after a sub-pixel shift (44 passed on the new baselines); six new captures and fifteen re-done, checked by eye |
| console e2e | not run: nothing in the console changed |
| live checks | none needed; no model was called |

Heavy suites ran one at a time with dev:all stopped (its supervisor signalled, L-85) and memory checked first; the runner's fork test sent every transaction on its own fork (port 8559) and every leg settled; nothing was sent to the playtest fork, whose head stayed at 109670015. dev:all is running again with this unit's code (migration 0026 ran at the services' start).

**Model spend of this session: 0 USD.** No model was called in F-U11. `pnpm spend:report --days=1` shows the last call at 03:07 UTC (the end of F-U10's second live sweep) and the day unchanged at 5.31 USD against the gateway's 15 USD budget.

## What the owner should check or try

- On the playtest fork, agent 1's window: `/agents/1/window`, from the "Performance" button on its My Agents card or "Performance window" at the top of its portfolio page. The holdings read live through the orchestrator (the tag says "Read live from the chain"); if the orchestrator is down the latest snapshot stands in and the tag says so.
- The chart and the scores start from the first reading after the services restarted with this unit, since earlier snapshots carry no value per unit. An hour after that first reading the scores show; until then every tile says "not enough data yet" and why. A deposit or a withdrawal in that time moves the account's value but not the chart.
- Hover the chart for the reading under the pointer; press "Table" for the same readings as a table; a buy is a marker pointing up and a sale one pointing down.
- /design has every piece in every state under "Portfolio window".
- A-79 records the values chosen where the plan was silent; say if any should change.

## Open issues for the next unit

- The window reads at most 4,000 snapshots (about 40 days at the 15-minute interval plus trades) and says when the oldest are cut off; a rollup or thinning of old interval readings is the next step for long-lived accounts.
- The closed positions are counted but not listed; a small table under the win share would show what each cost and brought.
- A snapshot right after a deposit or a withdrawal would show the account's value step at once (the per-unit line needs none).
- The commit gate let a commit through once more when its exit code was piped (L-203, the fourth repeat); a pre-commit hook running the scan would make the gate refuse by itself.

Push: `git push`
