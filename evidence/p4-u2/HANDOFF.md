# P4-U2 handoff: the Risk Sentinel service

Unit: P4-U2. Status: done.

## Commits

- `bde6692` feat(agent): the Risk Sentinel (D-138): a deterministic service on its own sentinel key that watches every held token's feed, screen and liquidity, the account's fall from its 7-day peak, and the agent's credits, gas, signer, chain, Executor, permission and owner; it pokes the account so the breaker trips, sets reduce-only, pauses new risk or closes deposits through the key (the only four calls it knows), sets the agent state RESTRICTED or INCIDENT with the breach's reason, lets a restricted agent run again when credits return, and never unpauses, loosens, moves funds or touches a withdrawal; every action recorded once per condition with its reason and transaction, shown in the terminal (migration 0028); the routes, the feed drill and an operator's clearing; the rules proven with records, the service over Postgres, and the drills on a fork of their own [P4-U2]
- `72db221` feat(api): the Risk Sentinel's actions served to the owner alone through the orchestrator [P4-U2]
- `169e33c` feat(web): the sentinel card on /design [P4-U2]
- `56b1429` feat(web): the sentinel card on the owner's Research page, with the fake API's sentinel read and the e2e [P4-U2]
- `370f0a5` feat(web): the console's sentinel tools on the cycles page: the conditions and actions, a pass now, the feed drill, and an operator's clearing after review [P4-U2]
- `ab2ac03` test(infra): the migration test lists the sentinel's tables in their alphabetical place [P4-U2]
- The last commit: docs(plans): the LOGS entry, L-210, L-211, A-83, the refreshed captures and this handoff [P4-U2]

## Test results

| Check | Result |
| --- | --- |
| pnpm typecheck | clean |
| pnpm lint, pnpm format:check, forge fmt --check | clean |
| vitest node | 1539 passed, 125 files; the pre-existing unhandled rejection in scan.test.ts (see the P3-U10 handoff) still makes vitest exit 1 while every test passes |
| vitest ui, console, web | 796 passed, 49 files |
| Playwright web (1440 and 380, axe on the research page) | 262 passed of 264 (2 skipped as before) |
| Playwright console | 114 passed |
| vitest forks | 59 passed, 15 files, the sentinel's four drills among them; every transaction mined |

The unit's own tests: the rules (6), the service over Postgres with a fake key (5), the terminal's sentinel lines (1), the control API's route (in the research tests), the card (3), the Research page's e2e with the card (in the research spec), and the drills on a fork of their own (4: the key is the factory's sentinel; a 12% fall sets reduce-only with the owner's withdrawal still working; a 22% fall pauses, withdrawals work and the key cannot unpause; a stalled feed is an incident and clears without loosening).

## Model spend

None for this unit: no model was called. The session's day total stays at 6.674 USD (`pnpm spend:report --days=1`), all of it Step 0's calibrated sweep.

## What to check or try

1. Start the stack (`pnpm dev:all`): the orchestrator logs "risk sentinel on: key 0x9965…A4dc (tighten-only, D-138), every 30 s". The key is anvil account 5, the factory's sentinel on the local fork.
2. Open the console's cycles page (`/cycles`): the "Risk sentinel" card shows nothing in force and no action for agent 1. Press "Run a pass now": still nothing (the account is in order), and "Last look" moves.
3. The drawdown drill: in the "Research loop" card set "Move MON/USD by" to -2500 and press "Move the market", then "Run a pass now" on the sentinel card. With WMON held, the account falls from its 7-day peak; the sentinel's poke trips the breaker to reduce-only and the card lists DRAWDOWN_12 with "12.x% below the 7-day peak" and the transaction. Move by -2500 again and run a pass: DRAWDOWN_22, the account PAUSED, DRAWDOWN_12 noted as cleared.
4. Open `/agents/1/research` as the owner: the "Risk sentinel" card shows the conditions in force and the same actions with their reasons; the terminal shows "Sentinel set the account to reduce-only (sales only): …" lines inside the cycle that was open at the time, if any. The portfolio page shows the account's mode.
5. Withdraw from the portfolio page: it works in both modes (exits are never touched). Lifting the mode is your own wallet transaction (`unpause`); the web app has no button for it yet (a suggestion in LOGS).
6. The feed drill: press "Stall the MON feed" then "Run a pass now": STALE_FEED is recorded (the tightening skipped, since the account is already paused), the agent state becomes INCIDENT (the Research page says the loop is not running). Press "Restore the feed" and run a pass: the stale feed is noted as cleared; the state stays INCIDENT until "Clear the agent state" (an operator's review).
7. Remove the credits (the console's credits tools) and run a pass: ZERO_CREDITS sets RESTRICTED; add credits back and run a pass: the agent runs again (D-129).

## Open issues for the next unit

- An "Unpause after review" action for the owner on the portfolio page, beside the sentinel's reasons.
- Notifications for sentinel actions (P4-U7).
- The sentinel's gas check uses the signer's swap cost; an agent without a signer is not checked for gas.
- A "cleared" note during a feed outage means the condition could not be seen, not that it resolved (L-211).

Push: `git push`
