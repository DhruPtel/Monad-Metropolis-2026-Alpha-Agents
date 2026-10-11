# P7-U1 gas and sizes

Measured with forge's Monad EVM (`network = "monad"`) over the vault suites (`forge test --match-path "test/fund/StrategyVaultV3*.t.sol" --gas-report`), 2026-10-11, on mock tokens, mock feeds behind the real OracleAdapterV3, a harness factory in AccountFactoryV3's place and a mock Executor that pays the fill from its own stash. Monad charges the gas limit a transaction sets, not the gas it uses (L-136), so P7-U2 sizes the signer's and the web app's limits from the maxima below with a margin.

## StrategyVaultV3

| Call | Min | Median | Max | Note on the maximum |
|---|---|---|---|---|
| `deposit` | 1,022 | 422,845 | 552,897 | Three tokens held (USDC, A, B): every held feed read, the breaker observed, the band moved, the lock written, the factory told |
| `redeem` (the USDC path) | 1,370 | 224,184 | 478,409 | Three tokens held, a fee computed, the band moved |
| `redeemInKind` | 1,026 | 183,407 | 1,518,685 | A hostile held token burning its 1,000,000-gas allowance (the honest maximum over five tokens is about 520,000) |
| `stakeAsIncomingLeader` | 958 | 399,155 | 596,317 | As a deposit, plus the release of an earlier incoming stake |
| `acceptManagement` | 596 | 67,807 | 116,273 | |
| `claim` | 1,075 | 20,656 | 153,167 | A credited token leaving the held list |
| `executeSwap` | 759 | 510,533 | 943,812 | The core's trade over three held tokens, with the vault's epoch and class checks |
| `poke` | 560 | 108,176 | 352,063 | Three feeds read, one bucket written |
| `pokeReference` | 531 | 119,510 | 391,667 | As `poke` plus the reference moved |
| `setDepositsOpen` | 4,467 | 52,179 | 52,179 | |
| `setLockup` | 36,805 | 53,535 | 70,535 | An increase stored as a pending change |
| `applyLockup`, `applyFee` | 9,311 | 9,514 | 43,146 | The minimum is a refused early apply |
| `proposeFee` | 4,510 | 53,160 | 70,160 | |
| `cancelLockupProposal`, `cancelFeeProposal` | 51,256 | 65,584 | 70,659 | |
| `closeVault` | 4,227 | 46,244 | 54,838 | |
| `pause`, `setReduceOnly`, `closeDeposits` | 46,348 | 67,021 | 73,314 | |
| `unpause`, `openDeposits` | 4,335 | 49,130 | 57,335 | |
| `withdraw`, `withdrawAll` | 12,127 | 12,489 | 29,489 | Always a refusal: nobody takes a vault's tokens out directly |
| `transfer` | 753 | 753 | 753 | Always a refusal: shares do not move at launch |
| `navUsdc` (view) | 10,952 | 102,740 | 256,681 | Up to five tokens, feeds included |
| `maxDeposit` (view) | 961 | 96,190 | 96,190 | Never reverts |
| `inKindAmounts` (view) | 15,220 | 41,630 | 41,630 | Three tokens; reads no oracle |
| `convertToShares`, `convertToAssets` (views) | 16,307 | 30,466 | 56,617 | At the last cached prices |
| `freeShares` (view) | 1,869 | 30,482 | 54,392 | Reads the epoch for the handover waiver |
| `initialize` | 933 | 221,818 | 221,818 | Through the harness factory's `createVault`; the minimum is the refused second call |

The minima are refusals before any read. Each class F token held adds one oracle read (about 100,000 gas on a fork for a direct feed, 150,000 for a composite, from F-U2's report) to every priced action; the in-kind exit reads no feed, and its cost is one bounded transfer and two balance reads per held token.

## Sizes (bytes)

| Contract | Runtime | Initcode | Margin to Monad's 128 KiB |
|---|---|---|---|
| StrategyVaultV3 | 61,778 | 62,771 | 69,294 |
| PersonalAccountV3 | 41,232 | 42,120 | 89,840 |
| AccountFactoryV3 | 11,645 | 58,125 (it carries PersonalAccountV3's initcode) | 119,427 |

StrategyVaultV3 is above EIP-170's 24,576 bytes and inside Monad's 128 KiB limit, as PersonalAccountV3 and the Executor v3 already are; it deploys once per factory, and every vault is a 45-byte clone of it (P7-U4 adds the vault implementation to AccountFactoryV3's deployment, which then carries both initcodes). The optimizer settings are unchanged, since changing them moves every deterministic address the address book records.
