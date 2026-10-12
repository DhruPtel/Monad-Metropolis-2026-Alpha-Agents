# F-U13 handoff: real chains for the new contracts

Unit: F-U13. Status: partial. The fourth unit of the four-unit session of 2026-10-12. The mainnet canary rerun is done; the testnet deployment stopped after its fourth step because the deployer cannot pay for the fifth.

## Commits

- `4fdff30` feat(infra): F-U13's real-chain scripts: the testnet v3 deployment with a balance guard before every step, the canary v3 deployment on CanaryAgent, the fork dry runs, the v3 quoters optional, the canary v3 deployment record (9 transactions, 7.43 MON) and the testnet run's start [F-U13]
- `e1af8ee` feat(infra): the canary v3 contracts in the address book, the canary v3 Sourcify verification (12 of 12 exact matches), the canary v3 round trip script with its read-only check passing on mainnet, the deploy script's typing fixed [F-U13]
- `d202651` chore(infra): the canary v3 round trip's evidence from mainnet: 14 transactions, 0.5727 MON, every step settled or refused as designed, keys swept, the account empty [F-U13]
- `b9c0ed3` test(contracts): the canary v3 fork test pinned to block 112870000, the F-U13 Solidity formatted, the deployed TestnetToken source frozen, forge's snapshot output ignored by Prettier [F-U13]
- The last commit: docs(plans): the F-U13 LOGS entry, L-242 to L-247, A-96, the real-chain evidence and this handoff [F-U13]

## Test results

| Check | Result |
| --- | --- |
| Mainnet canary v3 deployment (`pnpm deploy:canary:v3`) | 9 transactions on chain 143, every one mined and successful, 7.4289 MON; the fund set, Executor v3 and its set, AccountFactoryV3 and the binding on CanaryAgent (evidence/f-u13/canary-deployment.json) |
| Sourcify (`pnpm verify:canary:v3`) | 12 of 12 exact_match, creation and runtime (evidence/f-u13/canary-verification.json) |
| Mainnet canary v3 round trip (`pnpm canary:mainnet:v3`) | 14 transactions, 0.5727 MON: the account opened, 4.99 USDC deposited, the grant registered, 0.45 USDC bought 18.2313 WMON and sold back for 0.44955 USDC through the signer's v3 path on the v4 pool (reconciled, finalized at 1.4 and 1.8 s), the oversized buy refused TRADE_SIZE_EXCEEDED and the paused swap refused PAUSED with nothing signed, the guardian's pause, the owner's withdrawal while paused, revoke, withdrawAll, the keys swept; 8.0016 MON of the rerun's 10 MON in all (evidence/f-u13/canary-run.json) |
| Testnet v3 deployment (`pnpm deploy:testnet:v3`) | steps 1 to 4 on chain 10143 (15 transactions, 3.18 MON of gas, about 1 MON of pool seed): TALPHA and TBETA with feeds and seeded native MON pools, the new AgentNFT at 0xb70a241ea3964099bf930e3617756fa510ba6992, the fund set; step 5 stopped by the guard: "needs about 5.2413 MON at the maximum fee and the deployer holds 4.0950 MON" |
| `pnpm test:testnet-fork` | 9 passed: the v2 dry run (4) and the v3 dry run (5: both v4 routes through Executor v3, the vault's round trip, the nine-day timelock) |
| `pnpm test:canary-fork` | 4 passed: the v2 dry run (2) and the v3 dry run (2: the v4 and Uniswap v3 round trips, the pause, the withdrawals) at the pinned block 112870000 |
| forge (chains/monad) | build clean, `forge fmt --check` clean, 667 passed, 0 failed, 14 skipped (the fork tests without their fork) |
| vitest, whole | 222 files, 2665 passed |
| pnpm typecheck, lint, format:check | clean |
| Not run | the Playwright suites: no page changed in this unit; UI-U2's runs on the final UI stand. The testnet stack's end-to-end run on v3: blocked on the deployment. |

Acceptance, as the prompt lists it:

1. A fresh testnet deployment of the whole current stack with the pools and feeds testnet needs: partial. The tokens, feeds, pools, AgentNFT and fund set are on testnet; Executor v3 and its set, AccountFactoryV3 and the binding, the attestor's verifier and its timelocked proposal, and the vaults (through the factory) wait for about 3 MON on the deployer. Every transaction sent was mined.
2. A fresh mainnet canary rerun of the current trading contracts under the canary rules: done. Every transaction on chain 143, simulated first, within the rerun's 10 MON, from the canary owner's keys alone, on throwaway contracts; the class F round trip settled and refused as designed. No class A round trip: the verifier's nine-day timelock cannot be warped on a real chain (A-96).
3. Real-chain differences measured into evidence: evidence/f-u13/REAL_CHAIN.md.
4. Balances checked against the estimated cost before spending on either chain: the canary's deployment budget and per-transaction budget checks passed; the testnet guard stopped step 5 and said how much and to which address.

## Model spend

None: no model was called in this unit. The day's spend stands at 4.791 USD (the earlier live runs); the gateway's daily budget is 15 USD.

## What the owner should check or try

- Send MON to the testnet deployer `0x5C0Fb609931651357dcfd2b985910E3fC5904A4a` on Monad testnet (chain 10143): at least 3 MON for steps 5 to 7 (about 6.9 MON against the 4.095 it holds); 5 MON recommended so the keeper's reveals (0.35 MON on hand), the test wallet's gas (0.42 MON), the feed writer (0.14 MON) and the screener's and attestor's stamps (0 MON each) are covered for the end-to-end run. Then `pnpm deploy:testnet:v3` (it continues from step 5), `pnpm testnet:up` and `pnpm testnet:e2e`.
- The canary on MonadVision: Executor v3 `0xE819fC8229db2b404765f4E70F64bC1fE36220a2` (paused), AccountFactoryV3 `0x2F01ffeB3a6DeE52E190FD6578A9382C60b297c4`, the account `0x1885a9f8a545382CBfc3d7fFC0E01296D968D873` (empty), the fourteen transactions linked in evidence/f-u13/canary-run.json. Sourcify shows every contract's source.
- `.env` gained two generated throwaway keys, TESTNET_SCREENER_PRIVATE_KEY and TESTNET_ATTESTOR_PRIVATE_KEY (their addresses are in A-96); replace them if you prefer your own.
- A-96 lists the readings to confirm: the rerun's own 10 MON budget, the 4.99 USDC deposit, the v4-only swaps, no class A round trip on the canary, the testnet placeholders and caps.

## Open issues for the next unit

- The testnet deployment's steps 5 to 7, the testnet end-to-end run on v3, the address book's testnet v3 block, and `pnpm verify:testnet` on the F-U13 record: once the deployer is funded.
- The canary's verifier and SET_VERIFIER proposal (about 0.3 MON) would let a class A round trip run nine days later.
- The USDC/USD feed's 3,900-second bound against its hourly heartbeat gives a stale window each hour; PB-U1 should set the bound from the feed's documented heartbeat plus a margin.
- Executor v3 on the canary stays paused; the canary is throwaway, so nothing depends on it.

Push: `git push`
