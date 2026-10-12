# P7-U2 handoff: vault trading through Executor v3, with backstops

Unit: P7-U2. Status: done.

## Commits

- `09cc31f` feat(contracts): the vault trades through Executor v3: the factory's one vault per agent, the vault grant without expiry, the vault-only refusals, the handover read, 16 Executor tests and 3 backstop tests [P7-U2]
- `46fe562` feat(agent): the vault is the agent's trading account: the reader, the mirror, the buyability, the arming flow and the control API, the devenv helpers, the address book's redeployed set, the fork test on port 8566, and NO_EXPIRY as 2^53 - 1 [P7-U2]
- The last commit: docs(plans): the P7-U2 LOGS entry, L-223, A-87, the Slither review, the gas report and this handoff [P7-U2]

## Test results

| Check | Result |
| --- | --- |
| forge build, forge fmt --check | clean (ExecutorV3 41,210 bytes, AccountFactoryV3 13,026) |
| forge test | 655 passed, 11 skipped (the fork and testnet tests, as before); the 19 new tests among them |
| Slither | 371 results, 2 new, each justified in evidence/p7-u2/SLITHER.md, none changing code |
| Gas | evidence/p7-u2/GAS.md: a vault swap through the Executor 1,423,634 median, 2,070,084 at most; `registerVaultSession` 110,502; `createVault` 374,448 |
| pnpm typecheck, lint, format:check | clean |
| vitest node | 1587 passed and 1 skipped in 132 files (the pre-existing unhandled rejection in scan.test.ts's fake sandbox still makes vitest exit 1 while every test passes) |
| vitest forks, one file at a time | 67 passed in 17 files, one file at a time with the dev services stopped, every transaction mined (the vault fork test among them) |
| The vault fork test (port 8566) | 3 passed: the vault read as the agent's account; two swaps through the real signer and Executor v3 under the no-expiry grant; a USDC exit after the lockup, an in-kind exit for the previewed floors, and the leader's in-kind exit with every other contract replaced by reverting code |
| Playwright web and console | not run: no page changed in this unit |

Acceptance, as the prompt lists it:

- The vault trades only through Executor v3 under every hard limit: `test_AnAllowedSwapForTheVaultSucceeds_WithinEveryLimit`, `test_TheHardLimitsHoldForTheVault`, `test_TheCountersAreKeptPerAccount`, `test_OnlyTheExecutorTrades` (P7-U1), `test_TheExecutorMovesNothingOutsideASwap`, `test_ClearingTheExecutorStopsVaultTrading`; the fork test's two swaps.
- The vault-side backstops and post-trade checks: `StrategyVaultV3Backstops.t.sol` (every misbehaving Executor caught, the 12%, 45% and 1% thresholds, a fair trade moving no value between depositors), `test_TheVaultsOwnBackstopsStandBehindTheExecutor`.
- Class F tokens only: `test_TheVaultNeverBuysAClassAOrAScreenedToken` (the Executor's ASSET_NOT_ALLOWED before any price), the mirror's test on the fixture's class A and screened cases, the buyability's reason for a vault.
- Session grants per D-241: `test_TheVaultGrantHasNoExpiry_AndTheOwnerAloneRegistersIt` (trades 400 days later), `test_TheVaultGrantEndsOnlyOnASaleAChangeOrRevocation`, `test_AVaultGrantNeverServesThePersonalAccount`, `test_ATimedGrantServesTheVaultToo_AndExpires`; the arming tests for the marker, the grant check, no date and no renewal; the control API's grant call for an agent with a vault.
- Handover in the Executor (MV-S13, M-24): `test_NothingTradesForAVaultInHandover_UntilTheNewOwnerAccepts`.
- The agent's target portfolio and runner work for a vault exactly as for a personal account: the reader resolves the agent's account to its vault and every tool, the mirror, the trade flow, the signer and the snapshots read that account; the fork test drives the trade flow for the vault end to end with no code of theirs changed.

## Model spend

None: no model was called in this unit. The day's total by `pnpm spend:report --days=1` is unchanged from the session's start (10.378 USD for 2026-10-11 UTC).

## What the owner should check or try

- Before the next `pnpm dev:all`, run `pnpm deploy:executor-v3`: the Executor's code changed, so the v3 set and the factory land at the new recorded addresses beside the F-U4 set, which the address book no longer names. Agent 1's existing v3 account belongs to the old factory (0x5ebF58520f9bAa847959DcF69716030a1583BCDb); your wallet withdraws from the account's own address; open a new account or a vault through the new factory.
- Create a vault for an agent from the console or a script (`createTestVault` in packages/devenv), seed it, open deposits, and arm the agent: the Goal page's arming sends the grant without expiry, and the agent's plan trades the vault.

## Open issues for the next unit

- P7-U3 (the invariant and spike suite) should drive the Executor path on the vault with the real Executor over many real tokens on forks, and the handover and backstop invariants there.
- P7-U4 adds the per-vault cap, the depositor allowlist flags and `depositsEnabled` to the factory's vault path, and reads the vault's holdings and snapshots for the UI (the trading package's portfolio readers still read `personalAccountOf`).
- The parity fixture has no vault case; a `isVault` flag in the generator and the forge replay would make the mirror's vault rule parity-checked (A-87).
- The Executor refuses every trade for a vault in handover; the plan's reduce-only exception for the guardian or the sentinel is not built.

Push: `git push`
