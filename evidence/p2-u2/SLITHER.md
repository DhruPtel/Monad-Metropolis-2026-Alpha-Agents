# P2-U2 Slither review

Run on 2026-10-07 with Slither 0.11.6 over `chains/monad`, excluding dependencies, tests and scripts, as in P2-U1 and P2-U3:

```sh
cd chains/monad
slither . --filter-paths 'dependencies|test|script' --exclude-dependencies
forge build   # Slither runs forge clean first
```

122 results across the contracts. 82 are in contracts reviewed before and unchanged in kind (AgentNFT in `evidence/p2-u1/SLITHER.md`, the custody core and oracle adapter in `evidence/p2-u3/SLITHER.md`); their counts grew only by the new interfaces' immutables (naming) and timestamps. The 40 below are new, in the Executor, the ProtocolRegistry, the shared timelock and the two venue adapters. None needed a code change; each is justified.

## High

| Detector | Where | Why it stays |
|---|---|---|
| reentrancy-balance (4) | `Executor.onSwap`: the Executor's own USDC and WMON balances are read before pulling the input and calling the adapter, and compared after | That comparison is the safety check: it proves the Executor kept nothing (`ExecutorKeptFunds`). `onSwap` runs only inside the account's `executeSwap` for the swap in progress (`NotInSwap` otherwise), and `swap` is `nonReentrant`, so nothing can reenter between the reads. A balance changed by any reentry makes the check fail and the whole trade revert, which fails closed. The account itself checks its own balance changes independently |

## Medium

| Detector | Where | Why it stays |
|---|---|---|
| reentrancy-no-eth | `Executor.swap`: `delete _ctx` and the ring buffer written after the account's `executeSwap` | Intended order: the swap context must be open during the account's callback, and the trade is recorded only once it succeeded. `swap` is `nonReentrant`; the account's `executeSwap` is too |
| unused-return (2) | `UniswapV4MonUsdcAdapter.unlockCallback`: `settle()` and `settle{value}()` | PoolManager's `unlock` reverts unless every currency the callback touched is settled to zero, so an under-settled swap cannot complete; the paid amount adds nothing to that check |
| unused-return | `Executor.onSwap` ignores the adapter's `swap` return value | Deliberate: the Executor trusts the account's measured balance change, never the adapter's report |
| unused-return | `Executor._checkMarket` reads only NAV and drawdown from `breakerState()` | The other two values (value per unit, peak) are not needed for the decision |

## Low and informational

| Detector | Where | Why it stays |
|---|---|---|
| missing-zero-check (6) | The venue adapters' constructors | Deployed only by the deployment script, which asserts each adapter's Executor, tokens and pool after deploying (`_deployVenues`); the v4 adapter also checks its pool ID against the pinned one |
| calls-loop | `ProtocolRegistry._register` in the constructor | One call per adapter to read its venue's address for code pinning; the list is the deployment's two adapters |
| reentrancy-benign (3) | `Executor.swap`; the v4 adapter's `_inSwap` flag around `unlock` | The flag exists to accept PoolManager's callback only during our own `unlock`; both functions are `nonReentrant` |
| timestamp (7) | Session expiry, deadlines, the rolling 24-hour window, the timelock | Time is the rule; a leader's seconds of skew do not matter against 120 seconds, 24 hours or 9 days |
| cyclomatic-complexity | `Executor._checkMarket` | One branch per hard limit, in the order packages/policy mirrors; splitting it would hide the order the parity fixture checks |
| naming-convention (14) | Immutables in upper case | The repository's convention |
