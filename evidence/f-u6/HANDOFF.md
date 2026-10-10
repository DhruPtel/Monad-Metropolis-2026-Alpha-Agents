# F-U6 handoff: target portfolio, runner v2 and Test stage v2

Unit: F-U6. Status: done.

## Commits

- `d7146c3` feat(agent): add the target_portfolio@1 rule: positions with a weight, a band, a thesis and an exit plan plus a cash target, sized deterministically one capped leg at a time, sells before buys and always against USDC, with per-token caps, the cash floor, screens, class A, frozen and sell-only tokens, a per-token volatility brake and the cost hurdle, with 19 hand-computed evals and new runner hold codes [F-U6]
- `04e839e` feat(agent): run target portfolios: the plan store keeps either template, the runner v2 reads the fund agent's set and makes one capped leg a minute (sells first, always against USDC) as a v3 intent with its route through the same pre-check as propose_swap, the Test stage v2 checks a draft against the registry, screens, the aggressiveness envelope, the class A caps, depth at the slippage limit, turnover, the cooldown and the evals, the Zoom out may draft a target portfolio, and the plan routes set, check and show one [F-U6]
- `662efe0` feat(web): let the dev console set a target portfolio for an agent on the fund agent's set: a template switch, positions with a token from the registry, a weight, a band, a thesis and an exit plan, the cash target, a check step that shows the Test stage's findings, the plan's summary by position, the goal's aggressiveness envelope, and portfolio legs in the runner's decisions [F-U6]
- `79edb3c` test(agent): prove the runner on a target portfolio on a fork of its own: from 90 USDC it reaches WMON 20% and WBTC 20% through the trade flow, the real signer and Executor v3 one capped leg at a time (a two-hop route among them), sits in band, and sells WBTC first once the guardian moves it to sell-only [F-U6]
- `06814a3` fix(web): reach the portfolio check and set through the console's composed agents source, which lists the orchestrator's methods by name and had dropped the two new ones; assert the toast after the check in the e2e test; re-baseline the agents page with the envelope line, the template switch and the portfolio form at 1440 and 380; type the pending-list script's command [F-U6]
- `daefa2c` docs(plans): log F-U6's completion with every check, record its values as A-74, and add lessons L-190 and L-191 [F-U6]
- This file's commit: docs(plans): save the F-U6 handoff [F-U6]

## Test results

| Check | Result |
| --- | --- |
| format, lint, typecheck, forge fmt, secrets scan | pass |
| forge | 555 passed, 0 failed, 11 skipped (fork suites) |
| vitest, all projects | 2,184 passed in 166 files, 0 failed |
| vitest fork suites, one file at a time | 54 passed in 13 files, incl. the new runner suite on port 8559 |
| `pnpm test:fork` | 50 passed in 9 suites, address book matches |
| console e2e | 114 passed in update mode, 114 passed again on the new baselines |
| live model checks | none belong to this unit; the pending list is unchanged |

The node vitest project exits 1 from the known unhandled rejection in scan.test.ts (401 after a lease ended). Every fork transaction was mined on the tests' own forks; the playtest fork stayed at head 109670015.

## What the owner should check or try

- Agents page in the console (http://127.0.0.1:3001/agents): agent 1 shows the goal's envelope line; the plan section has a template switch. Choose "Target portfolio", add WMON 20% and WBTC 20% with cash 60%, a thesis ID and a kill criterion each, press "Check plan" (the Test's findings, or "passes"), then "Set plan". With the agent armed on Executor v3 (the Trades page's v3 grant) and the account funded there, "Run now" proposes the first leg; the decisions table shows the position's share and target.
- D-344 is built as written: sells first, one capped leg a minute, every hold with its reason in why-not-traded.
- A-74 records the values chosen where the plan was silent; say if any should change.

## Open issues for the next unit

- F-U7 replaces the aggressiveness source (today the saved risk preset) with the goal form's own choice; the envelope and the Test stay as built.
- F-U8 teaches the Zoom out to draft a target portfolio; the decision schema and the Test v2 already accept one.
- No per-token volatility source exists beyond MON's reading; tokens without one are not held back (A-74).

## Push

```
git push
```
