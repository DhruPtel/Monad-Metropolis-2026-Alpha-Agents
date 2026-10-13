# P-SWEEP handoff: the stuck activation sweep and the research universe

Status: done.

## Commits
- 76615c4 fix(agent): the activation sweep runs within its own ceiling, a stalled sweep ends with its reason, and research reads Monad's and Base's whole token universe [P-SWEEP]
- the second commit: fix(contracts-scripts) the deployed feed bounds, the records (LOGS, L-260, L-261, A-101, D-384) and this handoff [P-SWEEP]

## Cause and fix
Every activation sweep stopped after its Scan because each stage was checked against the goal's daily research budget (1.00 USDC at Light) instead of the sweep's own 3.80 USDC ceiling, so the Dive (1.20) never fit (L-260). The sweep now budgets against its ceiling (A-101), and a sweep stuck queued or running for over an hour ends as STALLED with a readable reason.

## Live sweep on testnet (agent 2, activation act-773b84aa, after restarting the testnet stack)
| Step | Result | Charged USDC |
|---|---|---|
| Scan | 4 themes | 0.174 |
| Pools and prices | 3 of 3 priced | 0 |
| Dives | LARGE_CAP_CORE_LANE, MON_SUPPLY_UNLOCK | 0.549 |
| Challenge | both theses stand | 0.085 |
| Test | limits and envelope set | 0 |
| Zoom out | no plan: limits bind on a 6 USDC account | 0.218 |
Total 1.026 of the 3.80 ceiling.

## Universe (D-384)
150 tokens recorded for that cycle: 3 buyable, 47 Monad mainnet research only, 100 Base research only, each with why it was or was not researched.

## Tests
typecheck, lint, format clean; full vitest 2,661 passed; the six fork files CL-U1 had broken pass after L-261's fix. Playwright not run (the hosted testnet stack occupies 3000; no page changed).

## Check
On the hosted app, turn on automatic trading for an agent with a Light goal: the sweep should run to the plan. Each cycle's universe is on the Research page.

## Open
- With 6 USDC to trade, the plan binds on limits; deposit more to see a proposal.
- The Dives chose market themes; the token-level depth is Part B's report.

## Model spend
About 0.81 USD at the gateway's cost.

```
git push
```
