# F-U2 gas and sizes

Measured on a fork of Monad mainnet at the pinned block (109670000) with forge's Monad EVM (`network = "monad"`), through real pools, 2026-10-09 (`test/fork/FundFork.t.sol --gas-report`). Monad charges the gas limit a transaction sets, not the gas it uses (L-136), so F-U4 sizes the Executor's limit from these figures with a margin.

## RouteAdapter.swapRoute, real pools

| Route | Venues |
|---|---|
| One hop, USDC to WMON | Uniswap v3 0.3% |
| Two hops, USDC to WMON to cbBTC | PancakeSwap v3 0.05%, PancakeSwap v3 0.05% |
| Two hops, USDC to WMON to WBTC, and back WBTC to MON to USDC | Uniswap v3, Uniswap v4 (native MON); Uniswap v4, PancakeSwap v3 |
| Three hops, AUSD to USDC to WMON to shMON | Uniswap v4, Uniswap v3, Uniswap v3 0.01% |

Across those seven calls: min 97,850 (a refused route), average 454,059, median 502,080, max 776,780 (the three-hop route).

## Reads

| Call | Gas (median) |
|---|---|
| `OracleAdapterV3.price` (one leg; a composite reads two) | 99,279 (max 151,628) |
| `OracleAdapterV3.poolDeviationBps` | 153,542 |
| `TokenRegistry.buyableFor` | 10,662 |
| `ProtocolRegistryV3.pool` | 12,273 |

## Sizes (bytes, runtime)

| Contract | Runtime | Initcode |
|---|---|---|
| TokenRegistry | 19,517 | 24,406 |
| ProtocolRegistryV3 | 19,718 | 29,558 |
| OracleAdapterV3 | 10,235 | 12,040 |
| RouteAdapter | 12,727 | 13,968 |

Every runtime is under EIP-170's 24,576 bytes and far under Monad's 128 KiB.
