# P2-U2 gas report

Measured on 2026-10-07 with forge 1.8.3 on the Monad EVM.

## Real tokens, real pool (`pnpm executor:local demo`)

Transaction receipts on a fork of Monad at the pinned block, through the Executor, a PersonalAccount, the oracle adapter on the real feeds (dated by LocalFeed, D-237) and the v4 adapter on the real Uniswap v4 MON/USDC 0.05% pool. Receipt figures include the 21,000 transaction base and calldata.

| Action | Gas used |
|---|---|
| `swap`: buy WMON with 5 USDC (swap native MON out, wrap, pay the account) | 1,036,200 |
| `swap`: sell 174.58 WMON (unwrap, swap, USDC straight to the account) | 951,458 |

## Mocks (`forge test --match-contract "ExecutorLimitsTest|ExecutorSessionsTest" --gas-report`)

Gas inside the call, without the transaction base; the mock venue mints its output, so the swap figure is the Executor, the account and the oracle adapter without a real pool.

| Function | Median | Max |
|---|---|---|
| `swap` (accepted) | 916,510 | 954,540 |
| `swap` (refused early) | 46,997 | |
| `registerSession` | 109,123 | |
| `revokeSession` | 48,179 | |
| `bumpConfigEpoch` | 71,441 | |
| `pauseAll` | 51,665 | |
| `tightenPolicy` | 41,261 | |
| `limits` (view) | 37,911 | 60,860 |
| `ProtocolRegistry.adapterFor` (view) | 31,155 | |

Where a swap's gas goes: the 20-slot ring buffer is read for the window (20 cold slots), the oracle adapter is read three times (tradable, price, the account's breaker view), the account values itself before and after and records its peak, and the venue call. The ring buffer and the repeated oracle reads are the obvious places to save gas later; none affects a limit.

## Sizes

| Contract | Runtime bytes |
|---|---|
| Executor | 28,590 |
| ProtocolRegistry | 9,211 |
| Uniswap v4 MON/USDC adapter | 7,589 |
| Uniswap v3 USDC/WMON adapter | 3,394 |

The Executor is over Ethereum's 24,576-byte EIP-170 limit and well under Monad's 128 KB. Every contract here is compiled without the optimizer (Foundry's default, which this repository has used since P1-U3; enabling it would move every deterministic address, AgentNFT's included). Monad bills the gas limit, so the signer (P2-U4) should set a swap's limit from these figures, about 1.1 million.
