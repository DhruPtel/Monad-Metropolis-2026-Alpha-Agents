# F-U3 gas and sizes

Measured with forge's Monad EVM (`network = "monad"`) over the custody v3 suites (`forge test --match-path "test/fund/*V3*.t.sol" --gas-report`), 2026-10-10, on mock tokens, mock feeds behind the real OracleAdapterV3 and a mock Executor that pays the fill from its own stash. Monad charges the gas limit a transaction sets, not the gas it uses (L-136), so F-U4 sizes the Executor's limit from the maxima below with a margin, and F-U5 the signer's deposit and withdrawal limits.

## PersonalAccountV3

| Call | Min | Median | Max | Note on the maximum |
|---|---|---|---|---|
| `deposit` | 981 | 475,259 | 1,909,124 | A 16th token joining the list, every held feed read |
| `executeSwap` | 736 | 486,721 | 2,127,872 | A trade with 16 tokens held: every feed read, every balance read twice, the basis moved (`test_ATradeAcrossSixteenHeldTokensFits` holds it under 3,000,000) |
| `withdraw` | 1,238 | 228,634 | 277,065 | A token leaving the list, with the empty check over the held list |
| `withdrawAll` | 855 | 48,702 | 2,605,169 | 16 tokens paid out, or a hostile token burning its 1,000,000-gas allowance |
| `claim` | 1,074 | 28,808 | 215,247 | |
| `poke` | | | | As `navUsdc` plus one bucket write; a fresh attestation adds one verifier call |
| `navUsdc` (view) | 28,927 | 172,939 | 407,616 | 16 tokens, feeds included |
| `pullForSwap` | 1,687 | 44,554 | 44,554 | |
| `setScreenedOptIn` | 5,428 | 10,628 | 13,428 | |

The minima are refusals before any read. Each class F token adds one oracle read (about 100,000 gas on a fork for a direct feed, 150,000 for a composite, from F-U2's report) to every priced action, which is where a 16-token trade's cost comes from; withdrawals read no feed.

## AccountFactoryV3

| Call | Min | Median | Max |
|---|---|---|---|
| `createPersonalAccount` | 41,629 | 335,991 | 335,991 |

The minimum is a refused second creation.

## Sizes (bytes, runtime)

| Contract | Runtime (forge) | Runtime on the fork | Initcode |
|---|---|---|---|
| AccountFactoryV3 | 11,645 | 11,645 | 57,846 (it carries PersonalAccountV3's initcode) |
| PersonalAccountV3 | 40,960 | 41,205 | 41,841 |

PersonalAccountV3 is above EIP-170's 24,576 bytes and inside Monad's 128 KiB limit (the Executor v2, at 28,590, already is); it deploys once per factory, and every account is a 45-byte clone of it. The fork's figure includes the metadata the deployment appended. The optimizer settings are unchanged, since changing them moves every deterministic address the address book records.
