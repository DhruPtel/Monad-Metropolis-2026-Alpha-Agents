# F-U4 gas and sizes

Measured with forge's Monad EVM (`network = "monad"`), 2026-10-10. Two sources: the Executor v3 unit suites on mock tokens, mock feeds behind the real OracleAdapterV3 and the real RouteAdapter over mock pools (`forge test --match-path "test/fund/ExecutorV3*.t.sol" --gas-report`), and the fork test on Monad's real tokens, feeds and pools at the pinned block (`pnpm test:fork`, test/fork/ExecutorV3Fork.t.sol, which logs the gas of each trade). Monad charges the gas limit a transaction sets, not the gas it uses (L-136), so F-U5's signer sizes each trade's limit from the maxima below with a margin (A-69).

## Trades on the real pools (the fork test)

The account held 400 USDC and 100 USDC each of WMON, cbBTC and WBTC (four tokens, every one with a real Chainlink feed) and traded 20 USDC of value from the session key. Gas is what `ExecutorV3.swap` used, measured around the call.

| Route | Pools | Gas |
|---|---|---|
| 1 hop: USDC to WMON | PancakeSwap v3 0.05% | 2,128,234 |
| 2 hops: WBTC to MON to USDC | Uniswap v4 native MON 0.05%, PancakeSwap v3 0.05% | 2,224,895 |
| 2 hops: cbBTC to WMON to USDC | PancakeSwap v3 0.05% twice | 2,257,394 |
| 3 hops: cbBTC to WMON to USDC to AUSD | PancakeSwap v3 0.05% twice, Uniswap v4 0.005%; AUSD joins the held list | 2,974,751 |

Most of a trade's gas is valuation, not swapping: the account values every held token once inside `executeSwap`, and the Executor reads `breakerState`, `capValues` and `navUsdc` around it, each another valuation; a real feed costs about 100,000 gas per token (150,000 for a composite, from F-U2's report). So the cost grows with the number of held tokens more than with the number of hops: four tokens cost about 2.1 million for one hop, and each extra hop adds about 100,000 to 400,000 (a v4 hop with native MON wraps and unwraps). A sixteen-token portfolio would cost roughly 7 to 8 million per trade on real feeds. A combined account view that returns NAV, capped value and the bases in one valuation would cut three of the four valuations; recorded as a suggestion for a later unit, since it changes the custody core's bytecode.

## Where real pools sit against their feeds at the pinned block

Logged by `test_TheSetIsBoundAndTheTradedPoolsSitOnTheirFeeds` (USDC per whole token, 1e18): the spot the oracle reads from each pool, and the feed.

| Pool | Spot | Feed | Spot against feed |
|---|---|---|---|
| Uniswap v3 USDC/WMON 0.3% | 0.034382569 | 0.034368200 | +0.04% |
| PancakeSwap v3 USDC/WMON 0.05% | 0.034437777 | 0.034368200 | +0.20% |
| Uniswap v4 MON/USDC 0.05% | 0.034376117 | 0.034368200 | +0.02% |
| PancakeSwap v3 cbBTC/WMON 0.05% | 85,184.84 | 84,958.65 | +0.27% |
| Uniswap v4 AUSD/USDC 0.005% | 0.99997589 | 0.99995065 | +0.003% |
| Uniswap v4 WBTC/MON 0.05% | 84,994.13 | 84,873.55 | +0.14% |
| Uniswap v3 shMON/WMON 0.01% | 0.055941458 | 0.055978883 | -0.07% |

Every pool is within the oracle's 2%, and the direction of a route matters against the 0.5% floor: buying cbBTC with USDC through the two PancakeSwap pools pays 0.20% more for WMON and 0.27% more for cbBTC plus 0.10% of fees, so the fill lands under the floor and the Executor refuses it (`SLIPPAGE_TOO_HIGH`, asserted in the fork test), while the sale through the same two pools gains both and fills. A route's floor is one bound of 0.5% under the feeds (D-352) while each of its pools may sit up to 2% from them in either direction, so a multi-hop buy can be refused while every pool is "within 2%"; F-U5's `get_quote` should quote the route before proposing it, and the agent proposes where the quote meets the floor.

## The unit suites (mocks)

| Call | Min | Median | Max | Note on the maximum |
|---|---|---|---|---|
| `ExecutorV3.swap` (limits, tokens, safety, sessions, reentrancy) | 34,260 | 1,140,581 | 2,630,996 | A three-hop trade with eight tokens held, in the parity replay |
| `ExecutorV3.swap` (parity replay alone) | 49,281 | 1,576,004 | 2,414,057 | |
| `ExecutorV3.registerSession` | 42,124 | 109,145 | 109,145 | |
| `ExecutorV3.bind` | 30,923 | 89,213 | 89,213 | |
| `PersonalAccountV3.executeSwap` (inside the Executor's swap) | 736 | 545,975 | 1,142,188 | Eight tokens held; F-U3 measured 2,127,872 with sixteen |

The minima are refusals before any read. Mock feeds cost a few thousand gas each where a real one costs about 100,000, which is why the fork's numbers are higher than the mocks' at the same number of tokens.

## Gas limits for the signer (A-69)

From the maxima above, a trade's gas limit is

    limit = 1,000,000 + 150,000 x hops + 400,000 x tokens held after the trade

which gives 2,750,000 for one hop with four tokens (measured 2,128,234, a 29% margin), 3,300,000 for two hops with five (measured 2,257,394, 46%), 3,850,000 for three hops with six (measured 2,974,751, 29%) and 7,850,000 for three hops with sixteen. The values live in packages/domain (`EXECUTOR_V3_GAS`, `executorV3SwapGasLimit`); F-U5's signer reads them, and the live measurements of F-U5's trades on the fork can tighten them.

## Sizes (bytes, runtime)

| Contract | Runtime (forge) | Runtime on the fork | Note |
|---|---|---|---|
| ExecutorV3 | 38,831 | 39,165 | Over EIP-170's 24,576 and inside Monad's 128 KiB, like the v2 Executor (28,590) and PersonalAccountV3 (41,205) |
| RouteAdapter (the Executor's) | 12,727 | 12,727 | The F-U2 contract, bound to Executor v3 |
| ProtocolRegistryV3 (the Executor's) | 19,718 | 19,718 | Eight core pools, the adapter active from construction |
| OracleAdapterV3 (over it) | 10,235 | 10,235 | |

The optimizer settings are unchanged, since changing them moves every deterministic address the address book records.
