# F-U11 (fix after playtest) handoff: the portfolio page on the fund agent's set

Unit: F-U11, fix after the playtest. Status: done.

## Diagnosis, for an agent on the v3 path before the fix

| Part of the web app | Read or wrote |
| --- | --- |
| Portfolio read, open account, deposit, withdraw, positions, allocation chart, caps, claimables | the v2 PersonalAccount through the control API's v2 reader and the v2 factory (USDC and WMON only, the v2 caps) |
| My Agents card's trading summary | the v2 account (the same read) |
| Holdings list (D-315) | the v2 account, as "Trading account" |
| Automatic trading card (the activation checks and the sweep) | the v3 account through the orchestrator |
| Plan card | the v3 set through the orchestrator |
| Performance window | the v3 set through the orchestrator (the live reading), else the latest snapshot |
| Custody path (control API and chain tools) | v2 while an agent had only a v2 account (D-367), so the two halves could not agree once the page had opened one |

## Commits

- `1cbd15e` feat(trading): the path is v3 wherever the fund set is deployed (A-80); the v3 portfolio reading; the holdings reader's older account; the playtest-fork wallet guard; the allowlist command on both factories [F-U11]
- `4c8ebec` feat(api): the portfolio route serves the v3 reading where the set is deployed, with the v2 account as an older account [F-U11]
- `3124cdd` fix(api): the v3 test fixture's addresses as constants; two scan findings recorded (L-205) [F-U11]
- `ba12d94` feat(web): the fund overview, the older account card and the holdings panel's older account on /design [F-U11]
- `8bf6361` feat(web): the portfolio page on the fund set: every section on the v3 account, any registered token in and out, the older account's withdraw-all, the My Agents card [F-U11]
- `b8f3231` test(web): the fund-set portfolio e2e at 1440 and 380 with accessibility checks; the fake's fund-set portfolio; the older account card's note; the re-done captures [F-U11]
- `39cf966` fix(infra): the allowlist command's helper typed for the repository's typecheck [F-U11]
- The last commit: docs(plans): the LOGS entry, L-204, L-205, A-80 and this handoff [F-U11]

## Test results

| Check | Result |
| --- | --- |
| format, lint, typecheck, forge fmt, secrets scan | pass |
| vitest node | 1,489 passed in 122 files (the exit code 1 is the known unhandled rejection in scan.test.ts) |
| vitest forks, one file at a time | 54 passed in 13 files; the two fork tests of D-367's v2 clause now assert A-80 |
| vitest ui, console and web | 773 passed in 47 files |
| web e2e | the three touched specs 28 passed in update mode; the full suite 246 passed with the 2 live specs skipped and 4 capture mismatches from the card note corrected after the captures (re-captured; 110 passed on the new baselines); six new captures and six re-done, checked by eye |
| forge test, `pnpm test:fork` | not rerun: no contract or address changed since they passed earlier today |
| live checks | none; no model was called |

Heavy suites ran one at a time with dev:all stopped and memory checked. The playtest fork received one transaction, the admin's allowlist addition (head 109670022 to 109670023); the owner's nonce stayed at 6. dev:all is running again with this fix's code.

## What to click to continue the playtest

1. Open `/agents/1/portfolio`. The page now shows "Open a trading account" for the fund agent's set, and below it the "Older trading account" card with the 100 USDC.
2. In the older account card press "Withdraw all to your wallet" and confirm in your wallet (one transaction). The card then says nothing is left, and your wallet holds the 100 USDC again.
3. Press "Open trading account" and confirm in your wallet. Your wallet is already on the v3 factory's allowlist (added as the admin, your nonce untouched).
4. In "Deposit", keep USDC, press "Max" (100 USDC, the per-account cap) or type an amount, press "Deposit", and confirm the two wallet transactions (the exact approval, then the deposit). The positions show USDC with its share, and the caps read from the v3 factory.
5. Set the goal if it is not set, then in "Automatic trading" press "Turn on automatic trading" and follow the sweep as before. The checks now read the v3 account's balance.
6. Open "Performance window" at the top: the first snapshot after this deposit starts its history.

Push: `git push`
