# P7-U1 Slither review

Slither 0.11.6 on chains/monad (`slither . --filter-paths "dependencies|test|script"`), 2026-10-11: 369 results in all, 39 of them in this unit's new contract (src/fund/StrategyVaultV3.sol). None led to a code change. Results in the older contracts are unchanged from the P2-U1 to F-U4 reviews; the core's edits for the vault (the `_mayWithdraw` and `_checkUnpause` hooks, and four helpers made `internal` for the vault's exit) add no new detector result of their own. Every vault result is justified below.

## By detector

| Detector | Impact | Results | Why it stands |
|---|---|---|---|
| incorrect-equality | Medium | 11 | Every strict equality is a zero check by design: no supply (`supply == 0` in the price, the previews and the stake share), no shares held before a mint (the first entry price), no slice to pay (`amount == 0`, which skips a token with nothing for this exit), nothing owed (`assets == 0`, refused rather than burning shares for nothing), no reference yet (`ref == 0 || refTime == 0`, the first priced action sets it), no pending change (`appliesAt == 0`), no live price (`live == 0`, a vault with no shares), no fee (`bps == 0`), and nothing to reduce. Each has a test at the boundary (the seed, the first deposit after it, the empty vault, the lapsed and missing proposals) |
| timestamp | Low | 25 | Lock buckets, the handover period, the pause's wait, the proposals' windows, the reference window and the exit deadline compare times by design, all against bounds of a day and more (the band's window is a day, the deadline the caller's own). A leader's few seconds of skew cannot move any of them; the ten results on functions without a `block.timestamp` of their own (`_burn`, `_mint`, `setDepositsOpen`, `closeVault` and the rest) are the detector following the mode and wind-down reads into the time-based waivers |
| assembly | Informational | 1 | `_reducePrincipal` tells the factory about USDC that left with 50,000 gas and ignores the result, as PersonalAccountV3's `_noteWithdrawal` does: an exit never depends on the factory (`test_InKindWorksWithEveryOtherContractBroken` replaces it with reverting code) |
| missing-inheritance | Informational | 1 | AgentNFT has `epochStartedAt` but does not inherit the vault's local `IAgentNFTEpochs`; AgentNFT is deployed and deterministic (L-185), so it is read through the small interface the vault declares instead of being edited |
| naming-convention | Informational | 1 | The `AGENT_NFT` immutable is in capitals, as across the repo |

## Not findings, checked by hand

- No `receive()`, no payable function, no delegatecall, no generic call path. The only low-level calls are the core's bounded transfer and balance read in the in-kind exit and the bounded note to the factory.
- Every state-changing entry point a depositor, the leader or the Executor can reach is `nonReentrant` (deposit, both exits, claim, the incoming stake, acceptance, both pokes, executeSwap); the reentrancy suite drives each one from a hooked USDC during a deposit, a USDC exit, an in-kind exit and a claim. The manager's own switches (`setDepositsOpen`, `setLockup`, `closeVault`, the proposals) and the tighteners' calls write only their own flags and move nothing.
- No reentrancy-events or reentrancy-benign result on the vault: every event follows the state it reports, and the exits burn before they pay.
- The vault never approves a spender; `pullForSwap` is the core's, once, inside `executeSwap`.
- `redeemInKind` reads no oracle, registry, Executor or factory and its only revert paths are its own checks (zero shares, a bad recipient, too few or locked shares, the leader's 5% while the rule applies); the epoch read that can unlock a locked exit is a `try`, and a failed read counts as a handover.
- The USDC path, deposits and the pokes fail closed on any feed the oracle cannot use (MV-S11); `maxDeposit`, `inKindAmounts`, `freeShares` and `sharePriceE18` never revert.
