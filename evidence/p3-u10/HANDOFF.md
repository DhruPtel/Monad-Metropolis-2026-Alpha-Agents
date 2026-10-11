# P3-U10 handoff: the autonomous research loop, the Research page and the agent terminal

Unit: P3-U10. Status: done.

## Commits

- `09e5bd9` feat(agent): the review cycle kind (the Zoom out alone, for the daily review and the triggers that need no Scan), a cycle's wish for a fresh overview carried to the prompt and required at the stage's end, and the research loop's tables: the schedule per agent and every trigger the watcher fires (migration 0027); a scripted review cycle with its overview [P3-U10]
- `fcab0b3` feat(agent): the autonomous research loop (D-283): the scheduler runs cycles for activated agents at their intensity's cadence under the day's budget and waits with the reason when it is short; the watcher's free triggers start a review or a Scan, each once and two hours apart; the loop replaces D-216's scheduled Scans and stays off locally unless SCHEDULED_RESEARCH is on; the research routes with the dev console's fast cadence, triggers by hand and a pass now [P3-U10]
- `043c4af` feat(agent): the agent terminal's event builder and the terminal route [P3-U10]
- `dccfc37` feat(agent): the Research page's read and the fork-only market mover, proven on a fork of its own with the watcher's price trigger [P3-U10]
- `d36e4a9` feat(api): the research loop and the agent terminal served to the owner alone through the orchestrator [P3-U10]
- `e98022d` feat(web): the research loop's components on /design and the activation panel's terminal slot [P3-U10]
- `633e73b` feat(web): the Research page for the owner, the terminal inside the activation panel, the links from the portfolio, and the e2e at 1440 and 380 [P3-U10]
- `aab6489` feat(web): the console's playtest tools for the research loop on the cycles page [P3-U10]
- `ac950c9` fix(web): the terminal treats a stack without the orchestrator as nothing to follow [P3-U10]
- `c8b401b` docs(plans): the two calibrated live sweep reports of Step 0 [F-T1]; plus the style, validator-test, spec and page fixes made during the gate (`ac950c9`, the Prettier and lint fix, `test(agent)` for A-81's validator case, the token-scale height, the connect state, the spec and fake fixes, the fixed clock) and the last commit: docs(plans): the LOGS entries, L-206 to L-209, A-82, the refreshed captures and this handoff [P3-U10]

## Test results

| Check | Result |
| --- | --- |
| pnpm typecheck | clean |
| pnpm lint, pnpm format:check, forge fmt --check | clean |
| vitest node | 1527 passed, 124 files; one pre-existing unhandled rejection in scan.test.ts (present before this session, see below) |
| vitest ui, console, web | 789 passed, 48 files |
| Playwright web (1440 and 380, axe on the research page, the activation panel and the design page) | 262 passed (6.2m) |
| Playwright console | 114 passed (1.7m) |
| vitest forks | 55 passed, 14 files; every transaction mined |

The unit's own tests: the loop's decisions and triggers (25, with fast clocks and over Postgres), the terminal's events and guardrails (6), the control API's routes (2), the components (8), the web e2e (6 tests per width, with captures), the market mover and the price trigger on a fork (1).

The scan test's unhandled rejection (`Streamable HTTP error ... unauthorized` from the fake sandbox's MCP client after its lease ended) is in the F-U11 fix's check log from before this session; every test passes and no file of this unit touches it. It is left for its own fix (a suggestion in LOGS).

## Model spend

None for this unit: no model was called. The session's day total after Step 0's calibrated sweep is 6.674 USD (`pnpm spend:report --days=1`).

## What to check or try

1. Start the stack with the loop on for the session: `SCHEDULED_RESEARCH=on pnpm dev:all`. The orchestrator logs "the research loop is on (P3-U10)". Without the variable it logs that the loop is off, and nothing researches on its own.
2. Open the console's cycles page (`/cycles`): the "Research loop" card shows the schedule as the orchestrator sees it. Press "Fast cadence", then "Run a pass now": for a RUNNING agent (agent 1 once its sweep's plan is approved) the scheduler queues a Scan, and the cycles table shows it.
3. Open `/agents/1/research` as the owner: the terminal follows the open cycle line by line; the schedule, the budget and the triggers sit below it, then the cycles with each stage's cost, the overview, the themes, the snapshot and why the plan did not change.
4. From the console, set "Move MON/USD by" to -800 and press "Move the market", then "Run a pass now": the watcher fires PRICE_MOVE (Balanced: 7%) and the scheduler answers it with a triggered Scan; the trigger shows on both pages. A second move within the spacing shows "waiting its turn".
5. Pick "MODE_CHANGED" and press "Fire trigger", then "Run a pass now": a review (the Test and the Zoom out alone) runs; the terminal shows it.
6. Press "Pause research" on the Research page: the schedule reads "Paused" and the next pass queues nothing; "Resume research" puts it back.
7. On `/agents/1/portfolio`, turn automatic trading on: the terminal appears inside the activation step panel once the sweep's cycle opens.

## Open issues for the next unit

- The loop's cycles charge the agent's credits like any cycle; the daily budget is the only cap, so a fast-cadence playtest spends in minutes what a day would.
- The terminal polls every two seconds while a cycle is open; a push stream can replace it without changing the page.
- P4-U2's Sentinel actions should appear in the terminal as events of their own kind.

Push: `git push`
