# P2-U3 Slither review

Run on 2026-10-07 with Slither 0.11.6 over `chains/monad`, excluding dependencies, tests and scripts, as in P2-U1:

```sh
cd chains/monad
slither . --filter-paths 'dependencies|test|script' --exclude-dependencies
forge build   # Slither runs forge clean first
```

79 results across 53 contracts. 19 are AgentNFT's and its interfaces', unchanged since `evidence/p2-u1/SLITHER.md` (its one High is reviewed again there, in the P2-U3 Step 0 section, with tests). The other 60 cover the oracle adapter and the custody contracts after this unit. None was fixed by a code change: each is a detector pattern that does not apply, and a source edit would also move every deterministic local address. Each is justified below.

## High

| Detector | Where | Why it stays |
|---|---|---|
| weak-prng (2) | `CustodyCore._observe`: `_peaks[today % PEAK_DAYS]` | Not randomness. `today` is `block.timestamp / 1 days`, and `% 8` picks the day's peak bucket in an 8-slot ring. A leader can shift the timestamp by seconds, which at most files one observation in the neighbouring day's bucket; the peak window is 7 to 8 days either way (D-233) |

## Medium

| Detector | Where | Why it stays |
|---|---|---|
| incorrect-equality (19) | `_perUnit`, `_mintUnits`, `_burnUnits`, `_reducePrincipal`, `_afterWithdraw`, `_wmonPriceIfHeld`, `_observe`, `_breakerMode`, `_breakerModeFor`, `_withdrawAllOf`, `_clampCredit`, `_after`, `OracleAdapter.tradable` | Each compares the account's own quantities with zero (no units, no WMON, nothing withdrawn, an empty account) or an enum with a value. A donation can only make a balance non-zero, which either is valued like any balance (NAV) or is withdrawn by the owner; it cannot reach any path that harms the account. `tradable` compares the adapter's own reason enum with OK |
| reentrancy-no-eth | `CustodyCore.executeSwap`: `_observe` writes the peak and mode after the Executor's callback | Intended: the breaker records the value after the trade. `executeSwap` is `nonReentrant`, so the Executor cannot reach `poke`, a withdrawal, a deposit or another swap during its callback; the only unguarded calls it could make are the tightening ones (`setReduceOnly`, `pause`, `closeDeposits`), which need the owner, guardian or sentinel and only tighten. Unchanged from P2-U1's ordering of `delete _swap` |
| uninitialized-local (2) | `_burnUnits`: `left`; `_resetPeaks`: `any` | Intended defaults: `left` is zero when the account is empty, `any` is false until a bucket is found. Both are read only after the branch that sets them or deliberately leaves the default |

## Low and informational

| Detector | Where | Why it stays |
|---|---|---|
| timestamp (12) | The adapter's staleness and future checks; the breaker's day buckets; the factory's timelock; intent deadlines | Time is the rule: 300 and 3,900 second staleness, day buckets, a 9-day timelock. A leader's seconds of skew do not matter at those scales, and the staleness boundary is strict on purpose (D-151) |
| reentrancy-benign | `executeSwap`: `lastWmonPriceE18` and `delete _swap` around the callback | As above; the cached price is written before the callback from a price read in the same transaction |
| missing-zero-check | `PersonalAccount.initialize`: `owner_` | Unchanged from P2-U1: only the factory calls it, with the agent's owner |
| low-level-calls (2) | `OracleAdapter._feed`, `_pool` | Deliberate: a `staticcall` with a length check lets a reverting or short-answering feed or StateView become a reason code (FEED_REVERTED, POOL_UNREADABLE) instead of a revert or an undecodable answer, so the views never revert (MV-S11, and `testFuzz_ViewsNeverRevert`) |
| assembly | `PersonalAccount._noteWithdrawal` | Unchanged from P2-U1: the bounded, ignored call to the factory |
| naming-convention (19) | Immutables in upper case | The repository's convention since AgentNFT |
