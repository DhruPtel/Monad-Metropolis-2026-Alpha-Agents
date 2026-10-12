# P7-U3 gas: the exits over real tokens (M-31)

Measured by the real-token fork test (`chains/monad/test/fork/StrategyVaultV3Fork.t.sol`, in `pnpm test:fork`) on a fork of Monad mainnet at the pinned block 109670000, 2026-10-12: the whole v3 set deployed as on chain, a vault seeded with 100 USDC by its leader and 100 USDC by each of two depositors, then traded by the session key through the real Executor v3 and RouteAdapter into Circle's USDC and six real tokens (WMON, WBTC, cbBTC, WETH, AUSD, shMON), 25 USDC each, through PancakeSwap v3, Uniswap v3 and hookless Uniswap v4 pools. Seven tokens held. Gas is what the call used inside forge's Monad EVM (`gasleft` around the call); Monad charges the limit a transaction sets (L-136), so the web app's and the signer's limits for these calls should carry a margin over the maxima here.

| Call | Gas | What it did |
|---|---|---|
| `redeem` (the USDC path), seven real tokens held | 1,179,315 | Every held feed read (seven Chainlink reads, one composite), the breaker observed, the band moved, the shares burned, USDC paid |
| `redeemInKind`, seven real tokens held, a depositor | 790,288 | Seven bounded transfers and fourteen balance reads, no feed, with the oracle, the registries, the factory, the Executor, the adapters, AgentNFT and the seven feeds all reverting |
| `redeemInKind`, seven real tokens held, the leader leaving last | 833,830 | As above, plus every token leaving the held list as its balance reaches zero |
| `redeemInKind` in handover, seven real tokens held | 840,326 | With the agent sold: the handover read that waives the lock, then as above |

For the mock-token figures (deposit, the USDC exit, the in-kind exit with a hostile token, the trades through the Executor) see evidence/p7-u1/GAS.md and evidence/p7-u2/GAS.md; the in-kind exit over seven real tokens sits well under the mock suite's hostile-token maximum (1,518,685) and the USDC path under the mock three-token figure plus four feeds (about 100,000 gas each on a fork, F-U2).

## The invariant runs (mocks)

| Suite | Runs | Calls | Time |
|---|---|---|---|
| StrategyVaultV3ExecutorInvariantTest (the real Executor, six class F tokens) | 48 of depth 60 | 2,880 | about 7 s |
| StrategyVaultV3ManyTokensInvariantTest (the mock Executor, fifteen tokens) | 48 of depth 60 | 2,880 | about 9 s |
| StrategyVaultV3InvariantTest (P7-U1, three tokens) | 48 of depth 60 | 2,880 | about 4 s |

No contract's size changed beyond the vault's: StrategyVaultV3 is 61,812 bytes of runtime after the two fixes (A-88), inside Monad's 128 KiB limit.
