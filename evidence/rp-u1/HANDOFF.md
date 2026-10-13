# RP-U1 handoff: the research report

Status: done.

## Commits
- f77240e feat(agent): the research report: a report step at the end of every cycle, checked sentence by sentence, stored per cycle and served to the owner [RP-U1]
- the second commit: the truncated reply recovery, the root-project test fix, the records (LOGS, L-262, L-263, A-102) and this handoff [RP-U1]

## The live report
https://vivarium-testnet.vercel.app/agents/2/research/reports/cycle-dda23a23-df0b-44ea-91c7-f577a58c1a74
(owner only: log in with the wallet that owns agent 2). Written by research-medium for 0.162 USDC of its 0.20 ceiling; one researched token (WMON), 4 objections, 150 tokens in the universe, 18 sources; the checks removed nothing.

## Tests
typecheck, lint, format clean; full vitest 2,704 passed (two failures explained in LOGS, both passing on their own after the fix); the report's structure, guardrails, sources, writer on Postgres, owner-only routes, view and PDF path are covered. Playwright and a browser-made PDF were not run (the hosted stack's dev server, the owner login).

## Check
- Add https://vivarium-testnet.vercel.app to Privy's allowed origins if not done, log in, open Research: the report list, then the report; press Download as PDF.
- Turn on automatic trading for an agent: the sweep's card shows 4.00 USDC on Medium, and Read the research report appears when it ends.

## Open
- The Dives choose market themes as often as tokens; a sweep with token themes gives fuller token sections.
- Reports are written on Sonnet 5.5 whatever the tier (A-102).

## Model spend
0.262 USD at the gateway's cost (two report calls).

```
git push
```
