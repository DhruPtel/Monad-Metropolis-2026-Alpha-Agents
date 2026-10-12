# P7-U3 Slither review

Slither 0.11.6 on chains/monad (`slither . --filter-paths "dependencies|test|script"`), 2026-10-12: 373 results in all, against 371 after P7-U2. The two new results are on the vault code this unit changed and are justified below; the P7-U1 and P7-U2 reviews cover every other result on StrategyVaultV3, and the rest of the set is unchanged (the normalized result lists of the two runs differ only in the lines named here).

## New in this unit

| Detector | Impact | Where | Why it stands |
|---|---|---|---|
| incorrect-equality | Medium | `StrategyVaultV3._deposit`: `shares == 0` | A zero check by design: `_sharesFor` now mints the first deposit into an empty vault at the virtual rate alone (A-88), so a deposit too small for one share is refused as ZeroAmount instead of minting nothing. The value is compared with zero, never with a computed amount |
| incorrect-equality | Medium | `StrategyVaultV3.acceptManagement`: `stake == 0 \|\| stake * BPS < LEADER_STAKE_BPS * totalSupply` | A zero check by design: the incoming stake is read once into `stake` (zero for anyone but the incoming leader) so that an incoming owner who left before accepting (L-224) is refused as LeaderStakeTooLow with the stake named |

## Changed code, same results

| Detector | Where | Why it stands |
|---|---|---|
| timestamp | `StrategyVaultV3._burn`: `total < shares` | The detector lists the comparisons of a function whose values it taints with the clock (the stakes grow with exit fees, whose timing is the lockup's). `_burn` compares the holder's whole balance (`sharesOf`) with the shares burned and then spends the leader's stake, the incoming stake and the ordinary shares in that order (L-224); the two comparisons it listed before (`b < rest`, `stake >= shares`) are gone with the rewrite |
| timestamp | `StrategyVaultV3.setDepositsOpen`: `totalSupply < MIN_SUPPLY_TO_OPEN` | The seed requirement (A-88, L-225) listed beside the wind-down and leader stake checks the P7-U1 review covers; a comparison with a constant |
| timestamp | `StrategyVaultV3.redeem`: `shares < minSharesOut`, `shares == 0` | The USDC path's bounds, unchanged in meaning; the detector's listing moved with the rewrite of the shares arithmetic |

## Not findings, checked by hand

- `_sharesFor` with a zero supply returns `assets * VIRTUAL_SHARES` and ignores the vault's balance: a gift sent before the first deposit belongs to the first depositor (A-88), never to a later one buying below value through the virtual offset (L-225). `convertToShares` uses the same function, so the preview equals the result (checked in the Executor-path handler after every deposit).
- `MIN_SUPPLY_TO_OPEN` (1e18 shares, one USDC's worth at the virtual rate) gates `setDepositsOpen` only; the leader's own stake, an incoming stake and a deposit while open are unaffected, and the gate is checked by `test_DepositsOpenNeedAtLeastOneUsdcOfShares`.
- `_burn` can never underflow: `sharesOf` is the sum of the three balances it spends, and the order (stake, incoming stake, ordinary) means `balanceOf[who] -= rest` runs only with `rest` at most the ordinary balance.
- No reentrancy result changed: the invariant suites' M-13 check runs with every other contract reverting and the vault paused, and the reentrancy suite of P7-U1 still passes on the rewritten `_burn`.
