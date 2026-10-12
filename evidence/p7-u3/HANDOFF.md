# P7-U3 handoff: vault invariant and spike suite over many tokens

Unit: P7-U3. Status: done.

## Commits

- `aece61f` test(contracts): the vault invariant and spike suite over many tokens: the Executor-path handler over six class F tokens, the many-token handler over fifteen, the real-token spikes on Monad's seven core tokens, the two bugs the runs found fixed (L-224, L-225, A-88) and the address book's moved factory and implementations [P7-U3]
- The last commit: docs(plans): the P7-U3 LOGS entry, L-224, L-225, A-88, the Slither review, the gas report and this handoff [P7-U3]

## Test results

| Check | Result |
| --- | --- |
| forge build, forge fmt --check | clean (StrategyVaultV3 61,812 bytes of runtime) |
| forge test | 663 passed, 12 skipped (the fork and testnet tests, the new vault fork test among them when no fork is named) |
| The invariant suites | StrategyVaultV3ExecutorInvariantTest: 10 invariants, 48 runs of depth 60 (2,880 calls), plus its probe; StrategyVaultV3ManyTokensInvariantTest: 8 invariants, 48 runs of depth 60, plus its probe; StrategyVaultV3InvariantTest (P7-U1): 10 invariants |
| pnpm test:fork (forge fork tests, the address book check) | 54 passed, 0 failed on a fresh fork of the pinned block (the four real-token vault spikes among them), the address book check PASS for executor_v3 (41,210 bytes), account_factory_v3 (13,026) and strategy_vault_v3_implementation (61,812), twice on separate forks |
| pnpm typecheck; the domain tests | clean; 171 passed |
| Slither | 373 results against 371 after P7-U2; the two new ones are zero checks by design in `_deposit` and `acceptManagement`, justified in evidence/p7-u3/SLITHER.md |
| Gas (M-31) | evidence/p7-u3/GAS.md: on seven real tokens the USDC exit 1,179,315 gas, the in-kind exit 790,288 for a depositor and 833,830 for the leader leaving last, 840,326 in handover (M-31). |

Acceptance, as the prompt lists it:

- Depositors can always redeem in kind: `invariant_EveryoneLeavesInKindWithEverythingElseReverting` in both handler suites (the vault paused, every other contract reverting, after every call of every run), and `test_EveryoneLeavesRealTokensInKindWithEverythingElseReverting` on Monad's real tokens with the seven Chainlink feeds dead too (M-13).
- No sequence of calls moves value between depositors: `invariant_NoValueMovesBetweenDepositors` in both suites (shares change only through own flows; no flow lowers the price per share for the others, checked after every deposit and exit inside the handlers), `test_FlowsMoveNoValueBetweenDepositorsOnRealTokens`.
- The leader cannot extract depositors' funds: `invariant_TheLeaderStakeHolds`, `invariant_NoLimitOrBackstopWasBroken` (every trade inside the limits, no trade from anyone but the session key, nothing left outside a swap), the intruders' calls, and `test_TheLeaderCannotExtractDepositorsFunds` on real tokens.
- Lockups and handover hold: `invariant_LockupsHold` (a lock ends within seven days; a locked holder cannot leave early), `invariant_HandoverHolds` (nobody manages, deposits and trades refused, everyone free to leave), `test_HandoverHoldsOnRealTokens`.
- The backstops hold: the per-trade checks in the Executor-path handler (10% size, the oracle floor, 40% and the vault's 45%, the USDC floor, the window, the turnover, the loss bound), `invariant_TheExecutorAndTheRouterKeepNothing`, `invariant_TheVaultsBalancesAreExactlyItsFlowsAndTrades`, and the real-fill refusals in `test_TheLeaderCannotExtractDepositorsFunds`.
- Across many tokens, on separate forks with real tokens: six class F tokens through the real Executor, fifteen through the mock, and Monad's seven core tokens on the pinned-block fork (`pnpm test:fork`'s fork on port 8546).

## Model spend

None: no model was called in this unit.

## What the owner should check or try

- `cd chains/monad && forge test --match-path "test/fund/StrategyVaultV3*Invariant.t.sol"` runs the three invariant suites and their probes in about 30 seconds; `pnpm test:fork` runs the real-token spikes and the address book check on a fork of its own.
- Two contract rules changed (A-88): a gift to an empty vault goes to its first depositor, and deposits open only once at least one USDC's worth of shares exist. The vault UI (P7-U4) should word the seed requirement plainly.

## Open issues for the next unit

- P7-U4: the factory's per-vault cap, allowlist flags and `depositsEnabled`; the vault UI; the live run on a separate fork.
- The reduce-only exception for the guardian or the sentinel during a handover is not built.
- A nightly invariant run against a fork with a handful of runs would extend the proofs to real pools.

Push: `git push`
