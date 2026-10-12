# P7-U2 Slither review

Slither 0.11.6 on chains/monad (`slither . --filter-paths "dependencies|test|script"`), 2026-10-12: 371 results in all, against 369 after P7-U1. The two new results are in this unit's code and are justified below; every other result on ExecutorV3 and AccountFactoryV3 is the F-U4 and F-U3 review's, moved by the new lines (the detector names a result by its line numbers), with the same justification as then (evidence/f-u4/SLITHER.md, evidence/f-u3/SLITHER.md). None led to a code change.

## New in this unit

| Detector | Impact | Where | Why it stands |
|---|---|---|---|
| missing-inheritance | Informational | StrategyVaultV3 should inherit `IVaultAccountV3` (the Executor's one-function view of a vault, `inHandover`) | The vault implements the function; the interface lives in the Executor's interface file, as `IExecutorAccountV3` does for both account modes, and ProtocolRegistryV3 and RouteAdapter carry the same result for `IAdapterRegistry` and `IRouteAdapter` since F-U4. Inheriting it would change the vault's source and so every deterministic address of the set again, for no change in behaviour |
| naming-convention | Informational | `AccountFactoryV3.VAULT_IMPLEMENTATION` | An immutable in capitals, as every immutable across the repo |

## Changed code, same results

| Detector | Where | Why it stands |
|---|---|---|
| timestamp | `ExecutorV3._checkSession(SwapIntentV3,bool)` | The expiry comparison moved under the no-expiry branch: a vault grant's `validUntil` is NO_EXPIRY and is never compared with the clock; a timed grant's is, as before |
| cyclomatic-complexity | `ExecutorV3._checkIntent` (14), `_checkMarket` (15) | One branch more each: the vault's class refusal (a class A or screened token bought for a vault) and the vault's handover read. Each branch has a test (`ExecutorV3Vault.t.sol`) and the policy mirror repeats the order (`executor-v3.ts`, its test on the fixture's class A and screened cases with `isVault`) |
| reentrancy-no-eth, reentrancy-balance, reentrancy-benign | `ExecutorV3.swap`, `onSwap`, `CustodyCoreV3.executeSwap` | Unchanged designs: `swap` is `nonReentrant`, the account's `executeSwap` is, and `onSwap` works only inside the Executor's own context (F-U4) |
| unused-return, uninitialized-local, calls-loop, incorrect-equality | ExecutorV3 | As in F-U4: the route loop is bounded at three hops, the oracle's reasons are read where their values are not needed, `_valueOf`'s zero check is by design |
| timestamp | `AccountFactoryV3.propose`, `execute` | The factory's timelock, unchanged |

## Not findings, checked by hand

- `registerVaultSession` writes the same grant slot as `registerSession`: one grant per agent, so an owner switches the key's account by registering again; a no-expiry grant is accepted for an intent whose account is the agent's vault alone (`_checkSession`), never for the personal account (`test_AVaultGrantNeverServesThePersonalAccount`).
- `createVault` is the only path that sets `vaultOf` and marks the clone as an account; it needs the agent's current owner and refuses a second vault; the vault's `initialize` runs in the same transaction, as the personal account's does.
- The Executor resolves an intent's account before any grant or market check (`_checkIntent`) with one factory read, so the vault-only rules apply at the earliest check and the mirror can repeat them without the Executor's own state.
- NO_EXPIRY is `2^53 - 1`: no timed grant reaches it (`registerSession` bounds `validUntil` by `MAX_SESSION`), the arming store's bigint column and every JavaScript number hold it exactly, and the platform compares a stored grant with the chain's by equality.
