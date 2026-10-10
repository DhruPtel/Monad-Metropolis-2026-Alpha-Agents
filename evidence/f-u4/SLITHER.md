# F-U4 Slither review

Slither 0.11.6 on chains/monad (`slither . --filter-paths "dependencies|test|script"`), 2026-10-10: 311 results in all, 27 of them in this unit's new code (src/fund/ExecutorV3.sol and src/interfaces/IExecutorV3.sol; script/ExecutorSetDeployer.sol is deployment tooling outside the filter). None led to a code change; two detectors confirm designs already in the code and under test (the balance checks after the adapter's call, and the ring buffer written after the account's call). Every result is justified below. Results in older contracts are unchanged from the P2-U1 to F-U3 reviews.

## By detector

| Detector | Impact | Results | Why it stands |
|---|---|---|---|
| reentrancy-balance | High | 1 | `onSwap` reads the Executor's own balances before `pullForSwap` and `swapRoute` and compares after: that comparison is the point (`ExecutorKeptFunds`). `onSwap` runs only inside `swap`, which is `nonReentrant`, from the account named in the context, and the venue that reenters either entry is refused (the safety and reentrancy suites) |
| reentrancy-no-eth | Medium | 1 | `swap` writes the ring buffer and clears the swap context after `executeSwap` returns: the trade is recorded only once it is made, and `swap` is `nonReentrant`, so no second intent can read a half-written ring |
| incorrect-equality | Medium | 1 | `_valueOf` returns zero for a zero amount or a zero price before dividing: a guard, not a comparison with an externally set value |
| uninitialized-local | Medium | 1 | `pool` in `_checkRoute` is set inside the try that reads the registry; the catch refuses the intent before `pool` is read |
| unused-return | Medium | 4 | `_sidePrice` and `_checkHopPrice` take the price and the reason from the oracle and drop the update time, which the oracle's own staleness check already turned into a reason; `_accountValues` drops `perUnit` and `peak`, which only the breaker uses; `onSwap` ignores the adapter's reported output on purpose and judges the fill by the account's balance change (`test_AVenueReportingMoreThanItDeliversIsRefusedByWhatArrived`) |
| calls-loop | Low | 5 | The route loop runs over at most three hops (`MAX_HOPS`), each a registry or oracle read of a registered pool |
| timestamp | Low | 5 | Grants, deadlines and the rolling window compare times by design; a leader's few seconds of skew cannot matter against a 120-second deadline bound and a 24-hour window |
| reentrancy-benign | Low | 1 | The event after `executeSwap` in `swap`; the function is `nonReentrant` |
| cyclomatic-complexity | Informational | 2 | `_checkIntent` and `_checkMarket` have one branch per limit, in the documented order; every branch is covered by a test and by the 236-case parity fixture |
| missing-inheritance | Informational | 2 | `IAdapterRegistry` and `IRouteAdapter` are the Executor's narrow views of ProtocolRegistryV3 and RouteAdapter (F-U2 contracts whose bytecode this unit does not change); the ABI matches, which the fork test exercises against the real contracts |
| naming-convention | Informational | 4 | Immutables in capitals, as across the repo |

## Not findings, checked by hand

- No `receive()`, no payable function, no delegatecall, no low-level call: the Executor calls only the account (`executeSwap`, `pullForSwap`), the registries and the oracle (views), and the adapter the registry names (`swapRoute`), all typed.
- The Executor never approves a spender: it transfers the input to the adapter inside `onSwap` and checks afterwards that its balances of both tokens are what they were.
- Every intent names its account, and the account must be the factory's account for the intent's agent and its current owner; the recipient of every fill is that account (the RouteAdapter takes the recipient from the Executor, never from the caller).
- Policy loosening and unpausing go through RiskTimelock (9 days); tightening and pausing are instant for the admin or the guardian; the class A caps can never be set above the account's own.
