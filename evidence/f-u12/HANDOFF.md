# F-U12 handoff: the price attestor, class A live and the open universe

Unit: F-U12. Status: done.

Owner decision recorded: D-370 (F-U12 is required, not optional); the unit's values in A-84; BUILD_PLAN 4.0.1 row 19 and the cut order updated.

## Commits

- `5559b10` feat(contracts): the class A attestation verifier (D-337) and the price attestor service; pnpm deploy:attestor; the testnet attestor and screener keys declared [F-U12]
- `cae1883` feat(agent): the screened lane, automatically (D-342, D-351): the registrar, the lanes mirrored, buyability in every token tool, the envelope and the Scan playbook's limits [F-U12]
- `ee37ba9` feat(agent): the universe considered: every cycle records each token with its buyability, the themes' decisions and the Zoom out's drops; the panel on the Research page, /design and the terminal [F-U12]
- `811339c` feat(web): the screened-lane opt-in recorded on chain from the Goal page; the brief and the goals tool follow the chain; "Unpause after review" on the Research page [F-U12]
- `dfe3469` feat(agent): the clocks follow the chain; playbook-zoom-out 2.2.0 and playbook-scan 2.1.0 locked [F-U12]
- `4b871f6` test(agent): class A live on a fork of its own (port 8565); the v3 reader's pool price and deviation limit; the Executor mirror's attested side and hop; the class A floor [F-U12]
- `87a5f9a` feat(agent): the live activation check's --open-universe; the registrar mirrors what it wrote; the Zoom out names every buyable, dived or held token it leaves out (playbook 2.3.0) [F-U12]
- `3e17d13` fix(agent): the registrar's mirror and the universe's table reads keyed by the token registry's chain id (L-216) [F-U12]
- `71f4fe0` test(agent): the live check reports the evaluator's findings; the fourth run's evidence [F-U12]
- `47700cc` fix(agent): the portfolio construction skill's data mirrors the 40% cap (1.0.1) [F-U12]
- The last commit: docs(plans): D-370, A-84, the LOGS entry, L-212 to L-216, the refreshed captures and this handoff [F-U12]

## Test results

| Check | Result |
| --- | --- |
| pnpm typecheck | clean |
| pnpm lint, pnpm format:check, forge fmt --check | clean |
| forge test | 561 passed, 11 skipped (the verifier's 6 among them, with the vault never buying class A) |
| vitest node | 1561 passed, 130 files; the pre-existing unhandled rejection in scan.test.ts still makes vitest exit 1 while every test passes |
| vitest ui, console, web | 801 passed, 50 files |
| vitest forks | 63 passed, 16 files, one at a time; every transaction mined; the class A test (4) among them |
| Playwright web (1440 and 380, axe) | 263 passed, 2 skipped as before; the goal, research and design captures refreshed; a one-pixel flake on the new mobile capture fixed by capturing the opt-in step before the send, the goal spec then passing twice |
| Playwright console | 114 passed; the pages spec's captures refreshed for the playbook versions |
| The live sweep (`pnpm test:activation:live --open-universe`) | every check passed on the fourth run (evidence/f-u12/live-2026-10-11T20-09-34.502Z.json); see below |

Acceptance, as the prompt lists it:

- A class A token (GHO) passing the screen becomes buyable for an opted-in owner and trades on a fork at an attested price within 1% and within the caps: the fork test's second case and the live sweep's universe (GHO screened, buyable).
- The caps hold with a wrong price and the attestor refuses on disagreement: the fork test's third case (a price 1.5% above the market fills within the cap and the 15% cap still refuses the oversize buy; 1.5% below is refused as slippage; twice the market is refused as pool deviation before anything is sent; sources 10% apart are refused by the attestor).
- The opt-in recorded on chain from the Goal page: the goal spec's e2e (the call sent is `setScreenedOptIn(true)` from the owner's wallet) and the live sweep (recorded on the account).
- Tools show buyability and why: `lane`, `status`, `buyable`, `whyNot` on every token item, lookup match, screen result and price entry (token-tools, chain-tools and buyability tests).
- The panel shows the full picture: the universe store, the terminal lines, the panel's unit test, the Research page e2e, and the live sweep's universe (8 tokens, 7 buyable, each not-proposed token with its reason).
- Every check passed one heavy suite at a time with free -h checked first; every fork transaction mined; the playtest fork left as found; git status clean after the last commit.

## The live sweep

Four runs, each on a stack of its own (fork 8551, orchestrator 4251), an Aggressive goal on the Medium tier with the opt-in on:

| Run | Result |
| --- | --- |
| 17:50 UTC | Every check but two: the token table showed no lane for GHO right after its registration (L-216, fixed), and the proposal evaluator rejected the plan (WBTC 5%, cash 95%) that the Zoom out's own Test had accepted. The universe was recorded: 8 tokens, 7 buyable, GHO buyable. 0.71 USD |
| 18:09 UTC | Lost to a host suspension of about 1.6 hours during the Scan; on resume the Scan was capped at its deadline and the run timed out. 0.13 USD |
| 19:56 UTC | Every check but the plan's: GHO listed at once after the fix; the evaluator rejected a three-position plan (WBTC 30%, WETH 25%, WMON 15%) the stage had accepted. 0.79 USD |
| 20:09 UTC | Every check passed: the verifier through the timelock, the opt-in recorded, GHO screened and listed, the sweep in order within its ceilings (0.89 of 3.80 USDC), the universe with GHO buyable and "not proposed: not dived; stablecoin without a return thesis", a cash-only plan with every token's reason, approved, the agent armed and RUNNING, the runner holding (BELOW_MIN_TRADE). 0.69 USD |

Tokens considered on the fourth run: AUSD, GHO (screened, class A), WBTC, WETH, WMON, cbBTC, shMON (buyable) and USDC (cash); none proposed (cash only), each with its reason in the universe.

## Model spend

2.29 USD by `pnpm spend:report --days=1` (6.674 to 8.966 USD on 2026-10-11), all in the four live sweeps; no other model call in this unit. The gate's 10 USD cap per task and the gateway's 15 USD daily budget held.

## What the owner should check or try

- On the dev stack: set an Aggressive goal with "Opt into screened tokens", press "Record the opt-in on chain" on the Goal page (the chain's state shows beside it), turn automatic trading on, and watch the "Universe considered" panel on the Research page and the terminal's "Universe:" and "Not buyable:" lines.
- To let class A trade on the playtest fork, run `pnpm deploy:attestor` (it sets the verifier through the registry's 9-day timelock by warping the fork's clock; the keeper refreshes the feeds). Until then every class A token shows "no verifier is set" as its reason.
- The console's token page shows each token's lane and status; a screen that passes registers the token in the screened lane at once (the registrar's action is logged with its transaction).
- After a Sentinel pause, the Research page's sentinel card offers "Unpause after review", sent from the owner's wallet.

## Open issues for the next unit

- The proposal evaluator rejected two live plans the Zoom out's Test had accepted (runs 1 and 3). The likely rule is the cost hurdle, applied only at the evaluator; the Test stage could apply it too, or the Zoom out could be told the route costs. The evaluator's findings are now in the live report (`proposalChecks`). Research tuning was out of scope.
- The 50% total class A cap is proven in forge; the fork test proves the 15% position cap live with one class A token.
- The Executor mirror's refusal of a sell-only token lists NOT_OPTED_IN beside TOKEN_SELL_ONLY for an opted-in account.
- On the dev stack's restart the signer logged `duplicate key value violates unique constraint "signer_outbox_nonce"` for agent 1 while realigning its nonce on the playtest fork (pre-existing behaviour after a restart; it retries).
- Testnet: the attestor and screener keys are declared (`TESTNET_ATTESTOR_PRIVATE_KEY`, `TESTNET_SCREENER_PRIVATE_KEY`); the verifier's deployment there is F-U13's.

Push: `git push`
