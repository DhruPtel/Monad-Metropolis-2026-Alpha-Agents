# P2-U3 gas report

Measured on 2026-10-07 with forge 1.8.3 on the Monad EVM.

## Real tokens, real adapter (`pnpm oracle:local demo`)

Transaction receipts on a fork of Monad at the pinned block (port 8548), with Circle's USDC, WMON, the oracle adapter deployed by `pnpm deploy:account-factory` and the v4 pool; the two Chainlink feeds are the settable copies the demo puts at their addresses (D-234), so a feed read costs about what a proxy read does, without the proxy's extra hop. Receipt figures include the 21,000 transaction base and calldata.

| Action | Gas used | Notes |
|---|---|---|
| `deposit`, real USDC, first deposit | 373,675 | The depeg guard (USDC/USD), no MON/USD read (the account holds no WMON yet), units minted, cap bookkeeping |
| `deposit`, real WMON, first WMON | 336,978 | The depeg guard and MON/USD, units minted at the value per unit |
| `poke` | 205,425 to 221,757 | MON/USD read, NAV, the day's bucket and 8 bucket reads; the higher figure writes a new bucket, a trip adds the mode change |
| `withdrawAll`, real USDC and WMON | 283,120 | No oracle read; units burned at the last price, then cleared with the 8 buckets when the account empties |

## Mock tokens and feeds (`forge test --match-path test/custody/Breaker.t.sol --gas-report`)

Gas inside the call, without the transaction base.

| Function | Median | Max |
|---|---|---|
| `deposit` | 300,370 | 373,003 |
| `poke` | 148,359 | 172,789 |
| `executeSwap` | 178,182 | 468,940 |
| `navUsdc` (view) | 88,774 | 123,257 |
| `breakerState` (view) | 73,832 | 129,832 |
| `unpause` | 8,641 | 18,359 |

Compared with P2-U1, a first USDC deposit costs about 130,000 more with real tokens: the depeg guard's two feed calls and the units' storage. `executeSwap` now reads one price (with the pool check) instead of calling the oracle per value.

## Sizes

| Contract | Runtime bytes |
|---|---|
| OracleAdapter | 7,076 |
| AccountFactory | 12,557 |
| PersonalAccount implementation | 23,514 |

The PersonalAccount implementation is 23,514 bytes: under Monad's 128 KB limit, and also under Ethereum's 24,576-byte EIP-170 limit by 1,062 bytes. The StrategyVault (P7-U1) reuses the core, so anything that needs EIP-170 headroom there should plan for it. Monad bills the gas limit, so the signer (P2-U4) and the deposit UI (P2-U7) should set limits from these figures.
