# F-U2 Slither review

Slither 0.11.6 on chains/monad (`slither . --filter-paths "dependencies|test|script"`), 2026-10-09: 190 results in 80 contracts, 68 of them in this unit's new code (src/fund, IFund.sol, IUniswapV3.sol). One led to a code change; the rest are justified below. Results in older contracts are unchanged from the P2-U1 to P2-U3 reviews.

## Fixed

| Detector | Where | Change |
|---|---|---|
| unused-return | `RouteAdapter.unlockCallback` ignored `PoolManager.settle()`'s return | The adapter now requires PoolManager to count exactly the amount the hop owes as paid, else `SettledShort(paid, owed)`. A token that takes a fee on transfer fails there by name (`test_AFeeOnTransferTokenFailsAtTheV4SettleByName`) |

## Justified

| Detector | Results | Why it stands |
|---|---|---|
| arbitrary-send-eth | `RouteAdapter._swapV4` | The only native transfers are `WMON.deposit{value}` to the immutable WMON contract; native MON never goes to a caller-chosen address |
| incorrect-equality | `OracleAdapterV3.poolPrice` | `priceE18 == 0` refuses a pool whose price rounds to zero: an exact check is the point |
| uninitialized-local | `addScreened.none`, `_sqrtPrice.ok/ret`, `_checkPool.codeHash` | Zero on purpose: an empty feed config for class A, a failed read when the venue is unknown, and `codeHash` set on every branch that does not revert |
| unused-return | `_checkPool`'s `getSlot0` | Only the price is needed: an initialized pool has a nonzero price |
| calls-loop | 16 in the registries and the adapter | Every loop is bounded: at most 3 hops per route (`MAX_HOPS`), at most 256 seeds or entries (`MAX_TOKENS`, `MAX_POOLS`), and each call is to a listed token, pool or venue |
| reentrancy-benign | 4 in `RouteAdapter` | The writes after external calls are the active-pool marker and `_inUnlock`, cleared after each hop. `swapRoute` is `nonReentrant` and callable only by the Executor; v3 callbacks are accepted only from the pool being swapped and v4's only inside its unlock (`test_ARouteCannotReenterTheAdapter`, `test_OnlyThePoolBeingSwappedMayCallBack`) |
| timestamp | 7 in the oracle and `TokenRegistry._checkFreshScreen` | Staleness bounds and the six-hour screen rule compare times by design; a leader's few seconds of skew cannot matter against bounds of 300 seconds and more |
| costly-loop | 6 in `RouteAdapter` | Storage writes of the active-pool marker per hop: at most three hops |
| cyclomatic-complexity | `_checkPool` (12), `swapRoute` (19), `TokenRegistry._validateChange` (17) | Each branch is a distinct check; every one is covered by a test |
| low-level-calls | `OracleAdapterV3.readLeg`, `_sqrtPrice` | `staticcall` so a reverting or short-answering feed or pool becomes a reason (FEED_REVERTED, POOL_UNREADABLE) instead of a revert, as the launch oracle does |
| naming-convention | 21 immutables | Immutables are written in capitals across the repo |
