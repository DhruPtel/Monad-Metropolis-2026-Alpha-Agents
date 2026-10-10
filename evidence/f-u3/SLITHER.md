# F-U3 Slither review

Slither 0.11.6 on chains/monad (`slither . --filter-paths "dependencies|test|script"`), 2026-10-10: 281 results in all, 93 of them in this unit's new code (src/fund/CustodyCoreV3.sol, PersonalAccountV3.sol, AccountFactoryV3.sol, src/interfaces/ICustodyV3.sol). None led to a code change on its own; two detectors confirmed designs already in the code (the bounded return data of the exit's low-level calls, and the reentrancy guard on every path the Executor can reach). Every result is justified below. Results in older contracts are unchanged from the P2-U1 to F-U2 reviews.

## By detector

| Detector | Impact | Results | Why it stands |
|---|---|---|---|
| weak-prng | High | 2 | `_observe` indexes the peak buckets by `today % PEAK_DAYS`. It is a ring buffer of eight days, not randomness: the same rule as the v2 core (P2-U3), and the breaker fixture replays it against packages/policy |
| incorrect-equality | Medium | 17 | Every strict equality is a zero check by design: no units outstanding (`u == 0`), nothing left of a token (`after == 0`, which frees its slot), no value that left (`valueOut == 0`), a refused empty fill (`received == 0`), an empty basis cut, no credit to clamp. Each has a test at the boundary, and the parity fixture holds the model to the same comparisons |
| reentrancy-no-eth | Medium | 2 | `executeSwap` writes the post-trade bookkeeping (basis, held list, peak) after `onSwap`: that is the point of the core's checks, and `executeSwap` is `nonReentrant`, callable only by the factory's Executor, with `pullForSwap` the only thing the callback may do to the account (`test_TheCoreCatchesAMisbehavingExecutor`, the reentrancy suite). `deposit` writes the basis after `recordDeposit`: the factory is the account's own, named at creation, and the deposit is `nonReentrant` |
| uninitialized-local | Medium | 3 | `value` in `deposit`, `left` in `_burnUnits` and `any` in `_resetPeaks` start at zero on purpose and are set on every branch that uses them |
| unused-return | Medium | 1 | `_requireUsdcPeg` reads USDC/USD's value and reason and ignores its update time: the oracle's own staleness check already turned a late round into `STALE` |
| calls-loop | Low | 29 | Every loop runs over the held list, bounded at 16 (`MAX_HELD_TOKENS`), and each call is a balance read or a registry or oracle read of a listed token. Withdrawals read balances through `_readBalance`, which cannot revert, so one token cannot stop the loop that pays the others (`test_ATokenWhoseBalanceReadRevertsNeverBlocksTheOthers`) |
| timestamp | Low | 18 | The attested-price lifetime, the deadline, the peak's day buckets and the oracle's bounds compare times by design; a leader's few seconds of skew cannot matter against bounds of 300 seconds and more |
| missing-zero-check | Low | 1 | `_credit`'s beneficiary is `msg.sender`, the owner, never an argument |
| reentrancy-benign | Low | 1 | The events after the transfer in `withdraw`; the function is `nonReentrant` and the reentrancy suite drives every entry point from a hooked token |
| costly-loop | Informational | 5 | Storage writes per held token when caching prices, settling basis and shrinking the list: at most 16 |
| assembly | Informational | 3 | `_tryTransfer` and `_readBalance` copy at most one word of return data (a return bomb cannot exhaust an exit's gas, `test_AReturnBombTokenIsCreditedOrSkipped_AndTheOthersComeOut`); `_noteWithdrawal` calls the factory with bounded gas and ignores its result, as the v2 core does |
| cache-array-length | Optimization | 2 | `_held.length` in `_isEmpty` and `_navAtLastPrices`: at most 16 reads |
| cyclomatic-complexity | Informational | 1 | `_after` has one branch per post-trade invariant; every branch is covered by a test and by the parity fixture |
| missing-inheritance | Informational | 1 | PersonalAccountV3 implements IRegistryAccount's two functions through the core's virtual declarations; it inherits the interface explicitly |
| naming-convention | Informational | 7 | Immutables in capitals, as across the repo |

## Not findings, checked by hand

- No `receive()`, no payable function, no delegatecall, no generic call path; the only low-level calls are the bounded transfer and balance read in the exit and the bounded note to the factory.
- The core never approves a spender; `pullForSwap` transfers to the Executor directly, once, inside `executeSwap` only.
- Withdrawals read no oracle and no registry (`test_WithdrawalWorksWithEveryOtherContractBroken` replaces the factory, AgentNFT, the oracle, the registry and the Executor with reverting code).
