# F-U13 handoff: real chains for the new contracts

Unit: F-U13. Status: done. The fourth unit of the four-unit session of 2026-10-12. The mainnet canary rerun completed first; the testnet deployment stopped at its fifth step for funds, and after the owner funded the deployer the same evening it completed and the testnet stack ran the whole owner flow on v3.

## Commits

- `4fdff30` feat(infra): F-U13's real-chain scripts: the testnet v3 deployment with a balance guard before every step, the canary v3 deployment on CanaryAgent, the fork dry runs, the v3 quoters optional, the canary v3 deployment record (9 transactions, 7.43 MON) and the testnet run's start [F-U13]
- `e1af8ee` feat(infra): the canary v3 contracts in the address book, the canary v3 Sourcify verification (12 of 12 exact matches), the canary v3 round trip script with its read-only check passing on mainnet, the deploy script's typing fixed [F-U13]
- `d202651` chore(infra): the canary v3 round trip's evidence from mainnet: 14 transactions, 0.5727 MON, every step settled or refused as designed, keys swept, the account empty [F-U13]
- `b9c0ed3` test(contracts): the canary v3 fork test pinned to block 112870000, the F-U13 Solidity formatted, the deployed TestnetToken source frozen, forge's snapshot output ignored by Prettier [F-U13]
- `aa4615c` docs(plans): the F-U13 LOGS entry (then partial), L-242 to L-247, A-96, the real-chain evidence and the first handoff [F-U13]
- The next commit: feat(infra): the testnet v3 stack on chain and in the address book: the deployment completed from its fifth step (21 transactions, 5.94 MON), all 18 testnet contracts verified on Sourcify, the address book's testnet environment with the new AgentNFT and the nine v3 ids, the end-to-end script on the v3 portfolio, the gas target at 0.9 MON, and the end-to-end run's records [F-U13]
- The last commit: docs(plans): F-U13 done in LOGS and BUILD_PLAN, L-248 and L-249, A-96's testnet readings, the real-chain evidence with the testnet results, and this handoff [F-U13]

## Test results

| Check | Result |
| --- | --- |
| Mainnet canary v3 deployment (`pnpm deploy:canary:v3`) | 9 transactions on chain 143, every one mined and successful, 7.4289 MON (evidence/f-u13/canary-deployment.json) |
| Sourcify, canary (`pnpm verify:canary:v3`) | 12 of 12 exact_match, creation and runtime |
| Mainnet canary v3 round trip (`pnpm canary:mainnet:v3`) | 14 transactions, 0.5727 MON: the account opened, 4.99 USDC deposited, the grant registered, 0.45 USDC bought 18.2313 WMON and sold back for 0.44955 USDC through the signer's v3 path on the v4 pool (reconciled, finalized at 1.4 and 1.8 s), the oversized buy refused TRADE_SIZE_EXCEEDED and the paused swap refused PAUSED with nothing signed, the guardian's pause, the owner's withdrawal while paused, revoke, withdrawAll, the keys swept; 8.0016 MON of the rerun's 10 MON in all (evidence/f-u13/canary-run.json) |
| Testnet v3 deployment (`pnpm deploy:testnet:v3`, two runs) | 21 transactions on chain 10143, every one mined, 5.9361 MON of gas and about 1 MON of pool seed: TALPHA and TBETA with feeds and seeded native MON pools, the new AgentNFT, the fund set, Executor v3 and its set, AccountFactoryV3 and the binding, the AttestationVerifier with SET_VERIFIER proposed (executable 2026-10-21 23:15 UTC); the guard stopped the first run at step 5 with the exact shortfall and address (evidence/f-u13/testnet-deployment.json) |
| Sourcify, testnet (`pnpm verify:testnet:v3`) | 18 of 18 exact_match, creation and runtime |
| Testnet end to end on v3 (`pnpm testnet:up`, `pnpm testnet:e2e`) | the mint on the new AgentNFT (agent 1, 338k gas, indexed in 57 s), the real Pyth Entropy reveal in 75 s (species 28, Fish, pro), provisioning in 3 s, credits in 4 s, a Scan, the PersonalAccountV3 opened (344k) and 0.5 USDC deposited (409k), the grant on Executor v3 (111k), the chain check's 0.02 USDC proposal approved and settled through the signer and Executor v3 on the P2-EC USDC/MON pool at the finalized tag (1.95M limit, 7.5 s from approval, 0.019988 WMON), the over-limit proposal rejected (TRADE_SIZE_EXCEEDED, CONCENTRATION_CAP, GAS_UNFUNDED), disarm, withdrawAll, the account empty; four attempts, the first three stopped by L-249 and L-248, every transaction mined (evidence/f-u13/e2e-run-*.json) |
| `pnpm test:testnet-fork` | 9 passed: the v2 dry run (4) and the v3 dry run (5: both v4 routes through Executor v3, the vault's round trip, the nine-day timelock) |
| `pnpm test:canary-fork` | 4 passed: the v2 dry run (2) and the v3 dry run (2: the v4 and Uniswap v3 round trips, the pause, the withdrawals) at the pinned block 112870000 |
| forge (chains/monad) | build clean, `forge fmt --check` clean, 667 passed, 0 failed, 14 skipped (the fork tests without their fork) |
| vitest | the whole suite 222 files, 2665 passed before the testnet part; the domain, config and scripts projects 27 files, 385 passed after it (the address book's testnet entries, the scripts' helpers) |
| pnpm typecheck, lint, format:check | clean on the final tree |
| Not run | the Playwright suites: no page changed in this unit; UI-U2's runs on the final UI stand |

Acceptance, as the prompt lists it:

1. A fresh testnet deployment of the whole current stack with the pools and feeds testnet needs: done. The new AgentNFT, the fund set, Executor v3 and its set, AccountFactoryV3 with the vault implementation, the AttestationVerifier with its timelocked proposal, two testnet tokens with feeds and seeded pools; every transaction mined; the stack ran end to end on it.
2. A fresh mainnet canary rerun of the current trading contracts under the canary rules: done. Every transaction on chain 143, simulated first, within the rerun's 10 MON, from the canary owner's keys alone, on throwaway contracts; the class F round trip settled and refused as designed. No class A round trip on either chain inside the unit: the verifier's nine-day timelock cannot be warped on a real chain; testnet's proposal executes on 2026-10-21 (A-96).
3. Real-chain differences measured into evidence: evidence/f-u13/REAL_CHAIN.md (gas on both chains, sizes, finality, the pool against Chainlink, the feeds' cadence, the Entropy reveal, the indexer's catch-up, the timelock, what testnet lacks, the v3 gas target).
4. Balances checked against the estimated cost before spending on either chain: the canary's budget checks passed; the testnet guard stopped step 5 and named the shortfall and the address, and the estimate held once the owner funded it.

## Model spend

About 0.60 USD at LiteLLM's cost for the testnet part (the testnet agent's two Scans and the chain check, 16 calls); none for the mainnet canary. The day stands at 5.391 USD; the gateway's daily budget is 15 USD.

## What the owner should check or try

- Testnet, with one of your three playtest wallets on Monad Testnet (chain 10143): `pnpm testnet:up` (the dev stack must be stopped first), open http://localhost:3000, mint (your wallets are on the mint allowlist and the factory's depositor allowlist; you need testnet MON for gas and Circle testnet USDC), watch the reveal, set a goal, deposit about 0.5 USDC, arm, and let the agent trade on the P2-EC USDC/MON pool; `pnpm testnet:gas <agentId>` gives the agent's session key 0.9 MON from the deployer (about 2.1 MON left on it; send more to `0x5C0Fb609931651357dcfd2b985910E3fC5904A4a` for a longer playtest). `pnpm testnet:down` stops it.
- The testnet contracts on https://testnet.monadvision.com: AgentNFT `0xb70a241EA3964099BF930e3617756FA510BA6992`, Executor v3 `0x50BF6cf5f27720f32aEeBdB11EC91821d933ecB6`, AccountFactoryV3 `0xE40652172925dbBc63755E1f55EFb8ae91623d5B`, TokenRegistry `0xDe0997ABe3dd6c79f64FeAfd69CCF3FaE58ed5a0`, AttestationVerifier `0x6fB101B197dFC3F0C694C457e1E1732982EEF0Ef`; the end-to-end run's transactions are linked in evidence/f-u13/e2e-run-2026-10-12T23-39-14-272Z.json.
- The canary on MonadVision: Executor v3 `0xE819fC8229db2b404765f4E70F64bC1fE36220a2` (paused), AccountFactoryV3 `0x2F01ffeB3a6DeE52E190FD6578A9382C60b297c4`, the account `0x1885a9f8a545382CBfc3d7fFC0E01296D968D873` (empty), the fourteen transactions linked in evidence/f-u13/canary-run.json.
- On 2026-10-21 after 23:15 UTC: execute SET_VERIFIER on the testnet TokenRegistry (the deployer's key) to turn class A on there; then a class A round trip can run on testnet.
- `.env` gained two generated throwaway keys, TESTNET_SCREENER_PRIVATE_KEY and TESTNET_ATTESTOR_PRIVATE_KEY (their addresses are in A-96); replace them if you prefer your own.
- A-96 lists the readings to confirm: the rerun's own 10 MON budget, the 4.99 USDC deposit, the v4-only swaps, no class A round trip inside the unit, the testnet placeholders and caps, the testnet database reset and the allowlist, the 0.9 MON gas target.

## Open issues for the next unit

- The class A round trip on testnet waits for the timelock (2026-10-21); the canary's verifier and SET_VERIFIER proposal (about 0.3 MON) would let one run on mainnet nine days after they are sent.
- The USDC/USD feed's 3,900-second bound against its hourly heartbeat gives a stale window each hour on mainnet; PB-U1 should set the bound from the feed's documented heartbeat plus a margin.
- F-U4's per-route gas rule leaves about 0.05 MON a trade on the table at today's prices, since Monad charges the limit; a tighter figure per route is W-2's.
- Executor v3 on the canary stays paused; the canary is throwaway, so nothing depends on it.
- The testnet stack's indexer takes about 10 minutes to index from the AgentNFT's block on a fresh database (the provider's 10-block cap); starting it well before a playtest avoids the wait.

Push: `git push`
