# P7-U1 handoff: StrategyVault core

Unit: P7-U1. Status: done.

Step 0 of the session was already in the tree from the F-T2 session (2d5ca15, the attestor's pool spot source for L-219; 5ef75a6, the capture style sheet holding animations still) and is recorded in LOGS.md under "F-T2 Step 0 of the vault session".

## Commits

- `05a5082` feat(contracts): StrategyVaultV3, the custody core v3 in public-vault mode, the core's hooks, the mock AgentNFT's epoch start, 75 tests [P7-U1]
- `0963fea` docs(contracts): the Slither review and the gas and size report [P7-U1]
- The last commit: docs(plans): the LOGS entries (Step 0 and P7-U1), L-221 and L-222, A-86, and this handoff [P7-U1]

## Test results

| Check | Result |
| --- | --- |
| forge build, forge fmt --check | clean (the vault 61,778 bytes of runtime, inside Monad's limit) |
| forge test | 636 passed, 11 skipped (the fork and testnet tests, as before); the vault's 75 tests among them |
| Vault suites alone | 40 unit and fuzz, 28 modes, 1 invariant run (10 invariants, 48 runs of depth 60), 1 probe, 1 fuzz over every caller, 4 reentrancy |
| Slither | 369 results, 39 in the vault, each justified in evidence/p7-u1/SLITHER.md, none changing code |
| Gas | evidence/p7-u1/GAS.md: deposit up to 552,897; the USDC exit 478,409; the in-kind exit 183,407 median, 1,518,685 with a hostile token; a trade 943,812 |
| pnpm typecheck, lint, format:check | clean |
| vitest node | 1582 passed in 132 files (the pre-existing unhandled rejection in scan.test.ts still makes vitest exit 1 while every test passes) |
| vitest ui, console, web, forks; Playwright | not run: no TypeScript changed and nothing was deployed; no TypeScript reads the vault yet |

Acceptance, as the prompt lists it:

- Shares, deposits, the leader's minimum stake: `test_ADepositMintsAtTheValuePlusTheSpread_AndMatchesThePreview`, `test_TheLeaderSeedMintsOneShareOnePerUsdc`, `test_DepositsOpenNeedsTheLeaderSeed`, `test_ADepositThatWouldPushTheLeaderBelowFivePercentReverts`, `test_TheLeaderCannotExitBelowFivePercent_OthersAreNeverBlocked`, the inflation fuzz, and `invariant_TheLeaderStakeHolds`.
- Lockups (minimum and default 24 hours, hard maximum 7 days, leader changes for new deposits only): `test_BothExitPathsWaitForTheLockup`, `test_ATopUpJoinsTheBucketAndMovesTheUnlockLater`, `test_AnExpiredBucketStartsFresh`, `test_LockupBounds_AndOnlyTheManager`, `test_RaisingTheLockupWaitsAndAppliesToLaterDepositsOnly`, `test_LoweringTheLockupIsInstant_AndTouchesNoExistingLock`, the lapse and stale-after-sale test, the three waiver tests, and the invariant's bound on every lock.
- Share transfers disabled: `test_SharesCannotBeTransferred`; no approve or transferFrom exists.
- `redeemInKind` across every held token with no oracle, Executor, platform or pause: `test_InKindWorksWithEveryOtherContractBroken` (the oracle, the registry, the factory, AgentNFT and the Executor replaced by reverting code with the vault paused), `test_InKindNeedsNoFeed`, `test_InKindPaysTheFloorOfEachSlice_AndOthersClaimsNeverFall`, the pro-rata fuzz, and `invariant_EveryHolderCanAlwaysRedeemInKind`.
- A reverting token skipped and recorded as a claimable credit: `test_ARevertingTokenBecomesACredit_AndTheOthersComeOut`, `test_HostileTokensCannotBlockTheInKindExit`, `test_ReentryDuringAClaimIsRefused`.
- Class F tokens only: `test_TheVaultNeverBuysAClassAToken` (a class A core token refused with `ClassAInVault`, a screened token with `NotBuyable`).
- The timelocks in contract code: `MIN_LOCKUP`, `MAX_LOCKUP`, `NOTICE`, `RISK_TIMELOCK`, `HANDOVER_PERIOD` and `EXECUTION_WINDOW` are constants; `test_FeeProposalBoundsAndTimelock`, the lockup tests, `test_UnpauseWaitsOneLockup_AndOnlyTheManager`.
- Handover on agent sale: `test_ASaleStartsAHandover`, `test_TheIncomingOwnerStakesAndAcceptsAfterTheHandoverPeriod`, `test_AcceptanceNeedsAStakeOfFivePercent`, `test_ASecondSaleDuringAHandoverReleasesTheFirstIncomingStake`, the stake's exemptions and lock, the agent bought back; the handler's `sale` and `stakeAndAccept` in the invariant run.
- Tests, fuzz, invariants, Slither with every finding justified, a gas report: as above.

## Model spend

None: no model was called in this unit. The day's total by `pnpm spend:report --days=1` was 10.378 USD (2026-10-11 UTC) at the start of the session and is unchanged.

## What the owner should check or try

- Read `chains/monad/src/fund/StrategyVaultV3.sol`'s header and A-86: the USDC exit never sells; when USDC above the floor does not cover it, the call names the in-kind path. P7-U4's modal must word `UseInKind(owed, usdcAboveTheFloor)` plainly ("withdraw up to X in USDC now, or everything in kind").
- Run `cd chains/monad && forge test --match-path "test/fund/StrategyVaultV3*.t.sol"` (about 4 seconds) to see the 75 tests, and `--gas-report` for the figures.

## Open issues for the next unit

- P7-U2 needs the Executor to accept a grant for a vault without a fixed expiry (D-241) and to find the vault's address for an agent. AccountFactoryV3 has no vault registration until P7-U4; P7-U2 either adds the minimal `createVault` and `vaultOf` to the factory early (then P7-U4 completes the caps and allowlists) or reads the vault through `isVault()` on an address the factory lists. The handoff of P7-U2 will say which.
- The proportional close over generic routes (FINAL_PLAN 4.7.5) is not built; see the LOGS suggestion.
- The fee rate applies to every depositor at exit once its timelock passes; a rate per depositor at entry is left for when fees are not zero.

Push: `git push`
