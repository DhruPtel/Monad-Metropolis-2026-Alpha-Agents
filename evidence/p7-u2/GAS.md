# P7-U2 gas and sizes

Measured with forge's Monad EVM (`network = "monad"`) over the Executor vault suite (`forge test --match-path test/fund/ExecutorV3Vault.t.sol --gas-report`), 2026-10-12, on mock tokens, mock feeds behind the real OracleAdapterV3, the real ExecutorV3, RouteAdapter and ProtocolRegistryV3 over mock pools, and the real AccountFactoryV3 deploying the vault. Monad charges the gas limit a transaction sets, not the gas it uses (L-136); the signer's rule for a swap (A-69: 1,000,000 plus 150,000 per hop plus 400,000 per held token) still covers the vault path with room, as the fork test's two swaps show.

## ExecutorV3 (the vault path)

| Call | Min | Median | Max | Note |
|---|---|---|---|---|
| `swap` for the vault | 49,267 | 1,423,634 | 2,070,084 | One to two hops with up to three tokens held; the vault's own checks add the registry's record of the token bought, the factory's `vaultOf` and the vault's `inHandover` read |
| `registerVaultSession` | 41,737 | 110,502 | 144,502 | The minimum is a refusal (no vault, a stranger, a zero key) |
| `registerSession` | 83,277 | 117,277 | 117,277 | Unchanged |
| `revokeSession` | 54,845 | 54,845 | 54,845 | |
| `bumpConfigEpoch` | 71,397 | 71,397 | 71,397 | |
| `pauseAll` | 51,709 | 51,709 | 51,709 | |
| `limits` (view) | 25,114 | 26,554 | 27,994 | |

## StrategyVaultV3 under the real Executor

| Call | Min | Median | Max | Note |
|---|---|---|---|---|
| `executeSwap` | 13,334 | 474,746 | 737,982 | The core's checks and the vault's epoch, handover and class checks |
| `deposit` | 433,577 | 444,212 | 454,847 | One to three tokens held |
| `redeem` (USDC) | 333,038 | 333,038 | 333,038 | |
| `redeemInKind` | 241,082 | 241,567 | 269,744 | Three tokens held |
| `stakeAsIncomingLeader` | 513,423 | 513,423 | 513,423 | |
| `acceptManagement` | 116,273 | 116,273 | 116,273 | |

## AccountFactoryV3

| Call | Min | Median | Max |
|---|---|---|---|
| `createVault` | 41,674 | 374,448 | 374,448 |
| `createPersonalAccount` | 336,013 | 336,013 | 336,013 |
| `addDepositor` | 60,633 | 60,633 | 60,633 |

The `createVault` minimum is a refused second creation or a stranger's.

## Sizes (bytes, runtime, from the deployment on the test fork)

| Contract | Runtime | Change from F-U4 and F-U3 |
|---|---|---|
| ExecutorV3 | 41,210 | +1,984 (the vault grant, the vault path) |
| AccountFactoryV3 | 13,026 | +1,381 (`createVault`, `vaultOf`, `predictVault`); its initcode now carries both implementations |
| PersonalAccountV3 implementation | 41,232 | +27 (the core's hooks, P7-U1) |
| StrategyVaultV3 implementation | 61,778 | new (P7-U1) |

Every contract is inside Monad's 128 KiB limit. The optimizer settings are unchanged; the new code moved every deterministic address of the v3 set, which the address book records (packages/domain/src/address-book.ts).
