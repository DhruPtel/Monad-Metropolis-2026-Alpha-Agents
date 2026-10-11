# F-T2 handoff: investing plumbing

Unit: F-T2. Status: done.

Step 0 recorded: D-371 (the owner's schedule from F-U12; the beta on Monday, October 12, the submission on Tuesday, October 13; P5-U1, P7-U7 and CF-U1 after the beta) and BUILD_PLAN 4.0.1 revision 5. The unit's values are in A-85.

## Commits

- `7ce0abd` docs(plans): D-371, the owner's schedule from F-U12 [F-T2]
- `6f6efd5` feat(agent): one rule set for plans: the Test stage, the evaluator and the console check call checkTargetPortfolio; each verdict's fingerprint; STATE_CHANGED names what changed; the shared fixture on every side [F-T2]
- `c5b514c` feat(agent): the background registrar with its gas and rate bounds and measured gas, the sell-only reason, the signer after a fork reset, the 50% class A cap on a fork with four class A tokens, the live check screening four class A tokens [F-T2]
- `e554c70` fix(agent): one conversion of a Zoom out's decision for the Test and the evaluator (L-220), the checksummed fixture case, the live check's --unit [F-T2]
- The last commit: docs(plans): A-85, the LOGS entry, L-217 to L-220, the sweep's evidence and this handoff [F-T2]

## Test results

| Check | Result |
| --- | --- |
| pnpm typecheck | clean |
| pnpm lint, pnpm format:check, forge fmt --check | clean |
| forge test | 561 passed, 11 skipped |
| vitest node | 1580 passed, 131 files |
| vitest ui, console, web | 801 passed, 50 files |
| vitest forks, one at a time | 72 passed, 16 files, every transaction mined; the devenv guard "never touched the playtest fork" trips while the dev stack's sentinel mines blocks on 8545 and passed with the dev services stopped |
| Playwright console | 114 passed |
| Playwright web | 263 passed, 2 skipped as before, 1 failed on an unchanged capture: the portal's `configure-activating.png` differs by 14 pixels in the Activating badge's pulsing dot (twice); this unit changed nothing in the web app |
| The live sweep | every check passed (evidence/f-t2/live-2026-10-11T22-01-45.483Z.json); see below |

Acceptance, as the prompt lists it:

- A plan the Test accepts passes the evaluator on unchanged state, and the shared fixture passes on both sides: `plan-rules.test.ts` runs the fixture's seven cases on the rule set, on the stage's verdict and on the evaluator (through the proposal service's own conversion), the evaluator adding STATE_CHANGED "nothing changed" beside a refusal and naming "the owner opted out of the screened lane on chain" when that changed between the reads. The live sweep's plan passed both.
- Every token that passes the screen is registered in the screened lane without a sweep, and a failed re-screen switches it to sell-only: the registrar's `sweep` (unit test with a bounded pass, a refused listed token, a skipped unscreened one and a gas-refused one), the background pass in the orchestrator, the pass-now route, and the fork test's registrations with their gas.
- The sell-only refusal names only the right reason: the mirror's test on the parity fixture's sell-only case, opted in and out.
- A dev stack restart produces no nonce conflict: the signer's test restores the fake chain below two reconciled transactions, restarts the signer and signs at nonce 0 again with the earlier rows' nonces freed; the realign note on the row says so.
- The 50% class A cap holds on a fork: the class A fork test's fifth case, four screened class A tokens on a 100 USDC account, classABasis exactly 50.0 of 100.0, one more USDC refused with CLASS_A_TOTAL_CAP alone, a sale still going through.
- All checks passed one heavy suite at a time with free -h checked first; every fork transaction mined; the playtest fork left as found by this unit; git status clean after the last commit.

## The live sweep

`pnpm test:activation:live --open-universe --unit=F-T2`, an Aggressive goal on the Medium tier with the opt-in on, on a stack of its own (fork 8551, orchestrator 4251).

| What | Result |
| --- | --- |
| Class A tokens screened and registered at once | GHO, CHAOS, SAKURA, LV (all passed this time; CHAOS was refused on the first sweep an hour earlier) |
| Buyable | 8 of 11 tokens: AUSD, CHAOS, GHO, WBTC, WETH, WMON, cbBTC, shMON. SAKURA and LV not buyable: "no attested price right now: the attestor's sources do not agree or are not fresh" (L-219). USDC is the cash |
| Researched | GHO (SCREENED_ALT_LIQUIDITY) and WMON (MON_INTRADAY_STRENGTH) |
| Proposed | WMON at 30%, cash 70% |
| The evaluator | accepted: "the plan passed every limit"; the owner's approval passed the re-check, the agent armed and RUNNING, the runner's first leg (8.955 USDC to WMON) settled on the fork's real pools |
| Why mostly cash, in the agent's words | GHO: "Pegged stablecoin with no return; one pool, concentrated holders; USDC covers the floor." AUSD: "Not dived; stablecoin with no thesis." CHAOS: "Not dived; no thesis, class A." WBTC, WETH, cbBTC: "Not dived; no thesis this cycle." shMON: "Not dived; overlaps MON exposure already held." SAKURA, LV: "Not buyable now: no attested price; also not dived." USDC: "Cash holding, never bought; stays as the 70% reserve." |
| Charged, spent | 0.88 of 3.80 USDC; 0.70 USD of model spend |

The first F-T2 sweep (evidence/f-u12/live-2026-10-11T21-49-33.082Z.json, before the conversion fix) ended with the evaluator refusing a three-position plan (WBTC, WETH, WMON) the Test had accepted, and its captured findings named the bug: "A position's token is its lowercase address", three times, beside STATE_CHANGED "Nothing the Test read has changed". The cost hurdle was never the cause (L-220).

## Model spend

1.40 USD, the two live sweeps (0.70 and 0.70 by the gateway's own figures); `pnpm spend:report --days=1` reads 10.376 USD for 2026-10-11 after them, 8.967 before. The gate's 10 USD cap per task and the gateway's 15 USD daily budget held.

## What the owner should check or try

- On the dev stack the registrar's background pass now lists every passing token with at least 50,000 USD of liquidity in the screened lane on the playtest fork, three a pass every five minutes; the console's token page shows the lane, and `POST /v1/tokens/registrar/sweep` runs a pass now. Class A trades there still wait for `pnpm deploy:attestor`.
- Set an Aggressive goal with the opt-in on and turn automatic trading on: the sweep's plan now passes the evaluator; when one does not, the plan card's findings say what changed since the Test.
- A restart of the dev stack after a fork restore no longer stalls agent 1's signer.

## Open issues for the next unit

- The attestor's pool source misprices one-sided pools (L-219): SAKURA and LV stayed unbuyable in the live sweep for that reason. Take the pool's own spot as the source and keep the round trip as a check, or let GeckoTerminal's price decide.
- The devenv guard "never touched the playtest fork" cannot tell the playtest stack's own blocks (the sentinel's pokes every 30 seconds) from a test touching the fork; run it with the dev services stopped, or compare only transactions from test accounts.
- The portal's Activating capture includes a pulsing dot; the capture style sheet could freeze it.
- The Zoom out still ends mostly in cash on an Aggressive goal (one position at 30%); research tuning was out of scope.

Push: `git push`
