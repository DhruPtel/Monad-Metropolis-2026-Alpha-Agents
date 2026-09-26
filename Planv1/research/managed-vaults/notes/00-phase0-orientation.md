# Phase 0: Orientation (shared context for all sub-agents)

## Repositories and versions

| | BoringVault (primary) | hypurrquant HyperVault (secondary) |
|---|---|---|
| Location | `/tmp/claude-1000/-home-dhrupatel-agent-tool-hyperliquid/17f19304-7afe-43f0-8482-f78830d476d3/scratchpad/boring-vault` (read-only clone; not present in the working dir, so cloned) | `/home/dhrupatel/agent_tool/hyperliquid` (the working directory itself) |
| Remote | https://github.com/Veda-Labs/boring-vault | https://github.com/hypurrquant/hyperliquid-vault |
| Commit | `c9c221f97eaac686a98d625ddb0955ba50363815` | `79e41cdccbc6b2d60479d44a3bc04930e4415b9c` |
| Last commit date | 2026-09-17 | 2026-04-21 (single squashed commit "HyperVault — public release") |
| Tags | only `merkle-root-creation-pre-2026-05-25`; no release tags | none |
| Commits | 3,931 | 1 |
| License | **Software Evaluation License 1.0 (SPDX `SEL-1.0`)**, Veda Tech Labs, added 2025-06-05 (commit `24c42f7cc`). Before that, files were `UNLICENSED`. Allows only internal non-commercial evaluation and test-only deployments. **We cannot fork or copy code into production. Patterns only.** | Apache 2.0 (permissive, forkable with notice) |
| Solidity | 0.8.21 (core) | 0.8.28, via_ir, optimizer_runs=1, cancun |
| Audits | 62 PDFs in `audit/` (0xMacro sevenSeas/veda/boring-vault/arctic series, Certora boring-vault 0-3 and boring-swapper 0-1, Sigma Prime boring-vault-0, Spearbit boring-vault-arctic-0). Files carry `Last audited:` header lines naming commit and PDF. Certora specs in `certora/`. | No audit reports in repo. Treat as unaudited. |
| Size (excluding lib/.git) | ~80 MB (mostly audits, leafs, logs); core modules listed below | 7,882 lines across src/test/script |
| Tooling | Foundry | Foundry. **Foundry (forge/anvil) is NOT installed on this machine, so no test suites were run.** |

## BoringVault module map (relevant parts)

Core:
- `src/base/BoringVault.sol` (141 lines): custody + share token.
- `src/base/Roles/ManagerWithMerkleVerification.sol` (289): strategist call gate.
- `src/base/Roles/TellerWithMultiAssetSupport.sol` (711): deposits/withdrawals, share lock, refunds.
- `src/base/Roles/AccountantWithRateProviders.sol` (622): exchange rate, bounds, fees.
- Auth: solmate `Auth` + `RolesAuthority` (in lib), `src/base/Roles/Pauser.sol` (192).
- `src/base/DecodersAndSanitizers/BaseDecoderAndSanitizer.sol` + `Protocols/` (UniswapV3, UniswapV4, UniswapV2, Odos, OneInch, NativeWrapper, ERC4626, BoringSwapper, ...). 119 decoder files total; most are per-vault aggregates.

Variants:
- Tellers: `TellerWithMultiAssetSupport` (base), `TellerWithRemediation`, `TellerWithBuffer`, `TellerWithYieldStreaming`, CrossChain tellers (CCIP, LayerZero) - cross-chain not relevant.
- Accountants: `AccountantWithRateProviders` (base), `AccountantWithFixedRate`, `AccountantWithYieldStreaming`.
- Queues: `src/base/Roles/BoringQueue/BoringOnChainQueue.sol` (740, current), `BoringOnChainQueueWithTracking.sol`, `BoringSolver.sol`; archived `src/archive/DelayedWithdraw.sol`, `src/archive/WithdrawQueue.sol`, `src/archive/atomic-queue/AtomicQueue.sol`.
- Buffer helpers (auto-deploy idle funds): `ERC4626BufferHelper`, `AaveV3BufferHelper`, `MorphoMarketBufferHelper` - low relevance.
- **Swap-specific, highly relevant to our Executor:** `src/base/Periphery/BoringSwapper.sol` (758; swaps via adapters, per-route max slippage and rate limits, PriceValidator oracle checks, pause), `src/base/Periphery/adapters/price/PriceValidator.sol`, `src/base/Periphery/AdapterRegistry.sol`, `FeeRegistry.sol`; micro-managers `src/micro-managers/UManager.sol` (rate-limit modifier), `DexSwapperUManager.sol`, `DexAggregatorUManager.sol`.
- `src/base/Roles/ShareWarden.sol` (transfer blacklist hook), `src/base/Drones/` (sub-accounts), `src/base/Governance/BoringGovernance.sol`, `src/helper/ArcticArchitectureLens.sol`, `src/helper/GenericRateProviderWithStalenessCheck.sol`.
- Tests: 44 entries in `test/` incl. `BoringSwapper.t.sol`, `PriceValidator.t.sol`, `ManagerWithMerkleVerification.t.sol`, `MerkleTreeChecker.t.sol`, `TellerWithMultiAssetSupport.t.sol`, `AccountantWithRateProviders.t.sol`, `BoringQueue.t.sol`, `DelayedWithdrawer.t.sol`, `AtomicQueue.t.sol`, `Pauser.t.sol`, `fuzzing/`, `integrations/`, `micro-managers/`. Merkle leaf generation helpers in `test/resources/MerkleTreeHelper/` and scripts in `script/MerkleRootCreation/` (including `Monad/`).

## hypurrquant map

- `src/vault/UsdcVault.sol` (1138): UUPS proxy impl, ERC-4626 + ERC-7540 async redeem + ERC-7887 cancel.
- `src/vault/VaultStorage.sol` (236), `NavLib.sol` (463), `RedeemLogic.sol` (463), `RedeemQueueLib.sol` (336), `DepositLogic.sol` (91), `HyperCoreBridgeLib.sol` (90), `VaultLens.sol` (430), `src/hypercore/CoreWriterLib.sol` (285), `src/libraries/OrderLib.sol`, `DecimalMath.sol`.
- Tests: `test/unit/UsdcVault.t.sol` (2067), `OperationalTest.t.sol` (847), `PrecompileNAV.t.sol`, `OrderLib.t.sol`, `DecimalMath.t.sol`; mocks in `test/mocks/` (MockPrecompiles, MockCoreDepositWallet, MockUSDC).
- README states: keeper EOA trades on HyperCore via L1 API (offchain signing), NOT through an onchain permission gate. 48h upgrade timelock with guardian veto. Live NAV from precompiles. Perf fee with snapshot at markRedeemReady.

## Monad (chain 143) deployments: Verified

- `deployments/addresses/Monad/Deployers.json`: create3 deployers `0xe80F045f...` and `0x144dc4DF...`.
- `deployments/skeletons/addresses/Monad/vmUSD.json`: BoringVault `0x1C8a336051D2024E318A229d01F9F6CF96efD316`, Manager `0xf05bFFA1...`, AccountantWithYieldStreaming `0x98A45D90...`, TellerWithYieldStreaming `0xB30755C7...`, BoringOnChainQueue `0xAd6b8d86...`, RolesAuthority `0xA1299741...`, Timelock `0x0` (none recorded).
- `mUSDTest.json`: test vault `0xb4563bcD...` ("Test mUSD Vault").
- Live RPC reads at Monad block 108,054,709 (`https://rpc.monad.xyz`, chainId 0x8f = 143): vmUSD vault has code (7,514 bytes), symbol `vmUSD`, totalSupply 34,243,164.83 shares (6 decimals), accountant `getRate()` = 1.017009, `authority()` = the RolesAuthority. Test vault totalSupply 1,372.87.
- vmUSD config (`deployments/skeletons/configurations/Monad/vmUSD.json`): yield-streaming accountant, allowed rate change 9980/10020 (±0.2%), minimum update delay 21,600 s (6 h), platform fee 50 bps, performance fee 0.
- Monad merkle scripts: `script/MerkleRootCreation/Monad/CreateVmUSDMerkleRoot.s.sol`, `CreateTestSwapperMerkleRoot.s.sol`, `CreateTestMusdMerkleRoot.s.sol`. Monad Uniswap V3/V4 addresses in `test/resources/ChainValues.sol` `_addMonadValues()`.
- `SwapperTestVault.json` config on Monad (performance fee 1050 bps, ±0.5% bounds, 6 h delay) suggests Veda is testing BoringSwapper on Monad.

## Scope adjustments

- Sub-agent B additionally covers BoringSwapper + PriceValidator + UManager micro-managers, because these are BoringVault's answer to "Merkle cannot do percentage/oracle/rate limits".
- Sub-agent C covers AccountantWithRateProviders primarily, AccountantWithYieldStreaming briefly (it is what Monad vmUSD uses), and FeeRegistry if relevant.
- Sub-agent D covers TellerWithMultiAssetSupport, BoringOnChainQueue (current), archived DelayedWithdraw/AtomicQueue briefly, and hypurrquant RedeemLogic/RedeemQueueLib.

## Addendum: live vmUSD role reads on Monad (Verified, block ~108.05M, 2026-09-25)

Queried `RolesAuthority 0xA1299741...isCapabilityPublic(target, selector)` via `https://rpc.monad.xyz` (script: scratchpad `roles.py`):

| Target | Function | Public? |
|---|---|---|
| TellerWithYieldStreaming `0xB30755C7...` | `withdraw(address,uint256,uint256,address)` | **yes** |
| Teller | `bulkWithdraw(...)` | no |
| Teller | `deposit(address,uint256,uint256,address)` | yes |
| BoringOnChainQueue `0xAd6b8d86...` | `requestOnChainWithdraw(...)` | yes |
| Queue | `cancelOnChainWithdraw(...)` | yes |
| BoringSolver `0xC1C95a85...` | `boringRedeemSelfSolve(...)` | no (not public; may be role-gated) |

Other reads: BoringVault `owner()` = 0x0 and Accountant `owner()` = 0x0 (ownership renounced, everything goes through the RolesAuthority). RolesAuthority `owner()` = `0x16ba7650...`, a contract whose `getMinDelay()` returns 172,800 s (48 h), consistent with an OpenZeppelin TimelockController (Inferred from selector layout). Teller `isPaused()` = false, `shareLockPeriod()` = 15 s. Vault `hook()` = the Teller.

Implication: in this live deployment a user CAN withdraw instantly through `Teller.withdraw` with no operator in the loop, but only while the Teller and Accountant are unpaused (see `TellerWithMultiAssetSupport.withdraw` which is `requiresAuth`, calls `beforeTransfer` and `_withdraw`). Public capability is a per-deployment config choice, not a code guarantee, and a role holder can pause. So the conclusion "no BoringVault exit is guaranteed operator-free" still holds; "no public withdraw exists in practice" does not.
