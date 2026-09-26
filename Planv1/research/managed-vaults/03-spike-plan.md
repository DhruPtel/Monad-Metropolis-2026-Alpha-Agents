# Report 3: Spike plan, tests to port, open questions

Scope: prove only the new or changed behavior from Report 2 (`02-platform-mapping.md`, section 2.2). Everything already decided and unchanged (base Executor limits, Morpho-style timelocks, proportional sale path) is covered by earlier spike plans.

## Setup

- Foundry is **not installed** on the research machine; install it before starting (`foundryup`).
- Fork: `anvil --fork-url https://rpc.monad.xyz --chain-id 143`. Pin a block number in every test (the research reads used block about 108,054,709).
- Monad addresses to use, taken from `BV/test/resources/ChainValues.sol` `_addMonadValues` and confirmed to have code on chain 143 on 2026-09-25 (Verified): USDC `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`, WMON `0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A`, Uniswap V3 router `0xfE31F71C1b106EAc32F1A19239c9a9A72ddfb900`, Uniswap V4 Universal Router `0x0D97Dc33264bfC1c226207428A79b26757fb9dc3`, V4 PoolManager `0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e`, Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`. Chainlink USDC/USD `0xf5F15f188AbCB0d165D1Edb7f37F7d6fA2fCebec` (8 decimals, live). A MON/USD feed is not referenced in either repository (open question 1).
- Oracle failure cases: `vm.mockCall` / `vm.mockCallRevert` on the feed address, the technique `HQ/test/mocks/MockPrecompiles.sol` uses for precompiles.
- Token failure cases: `vm.mockCallRevert(USDC, abi.encodeWithSelector(IERC20.transfer.selector), ...)` to simulate a blacklist or pause without needing Circle's admin keys.
- Structure invariant tests like `BV/test/fuzzing/` (actor handlers, pre/post snapshots). Handlers: depositor, leader, Executor session key, emergency role, oracle mover, pool price mover, agent sale.
- Clean-room: do not copy BoringVault files into the spike repository (SEL-1.0).

## 1. Spike steps

| # | Spike | Test outline | Success condition |
|---|---|---|---|
| S1 | In-kind exit survives a failing token (change 1) | Fund vault with USDC and WMON on the fork. Mock USDC `transfer` to revert for one user. Call `redeemInKind(shares, skipTokens=[USDC])`. Repeat with USDC reverting for everyone, and with WMON reverting. Variant: pull-based credit design. | User receives WMON share; forfeited or credited USDC is accounted exactly; other holders' pro-rata claims are unchanged or increased; call never reverts because of a skipped token. Gas measured for both designs. |
| S2 | In-kind exit is unconditionally available (change 2) | Handler invariant: after any sequence of pause, circuit-breaker trip, oracle revert, oracle stale, Executor set to none, handover mode, session key revoked, deposits closed, config proposals pending, `redeemInKind` by any unlocked holder succeeds. | Invariant holds over at least 10,000 runs. Inverse of `invariant_tellerPaused_methodsRevert` and `test_pause_blocksReadyRedeem`. |
| S3 | Share supply integrity (change 3) | Invariant: `totalSupply` changes only in deposit, exit and fee functions; no address other than the share owner (or approved spender) can reduce a balance. Try every admin, leader, emergency and Executor function with fuzzed arguments. | No path found that mints without assets or burns another user's shares. |
| S4 | In-contract delays (change 4) | Propose a new Executor, oracle, route, fee and lockup max. Try to accept before `delay`, after `delay`, after the emergency role cancels. Confirm `delay > MAX_LOCKUP` is enforced at construction and on every change. Try to shorten the delay itself. | Nothing takes effect early; emergency can cancel or set Executor to none but cannot add risk; delay cannot be reduced below `MAX_LOCKUP` plus margin. |
| S5 | Vault-side post-trade invariants (change 5) | Deploy a deliberately buggy Executor that (a) mints shares via reentrancy attempt, (b) leaves an allowance, (c) moves a third token, (d) breaks the 10% USDC floor, (e) exceeds 40% WMON. | Every case reverts at the vault check even though the Executor itself passed. |
| S6 | BoringSwapper-style swap path in the Executor (change 6) | On the fork, swap USDC to WMON through Uniswap V3 `exactInput` and a V4 single-hop swap. Adapter parses calldata; test mismatched recipient, reversed path, extra hop, wrong amount, non-zero value. Measure realized output delta against the oracle with 0.5% slippage; move the pool price with a large swap first to trigger the slippage revert. | Valid intents succeed; each mismatch reverts in pre-flight; post-trade allowance is zero; the vault never approves the router; Executor holds zero tokens after each call (port of `invariant_zeroAllowanceOnAssets` and `invariant_tellerDoesntHoldTokens`). |
| S7 | Exact rolling trade counter (change 7) | Ring buffer of 20 timestamps. Warp through: 20 trades in 1 s, 21st rejected; 21st allowed exactly 24 h after the 1st; trades straddling window edges; epoch bump and config change mid-window; many trades in one Monad block. | Count never exceeds 20 in any 24 h interval (checked by brute force over the recorded history); config and epoch changes do not reset it. Explicit regression test for the `block.timestamp % period` failure mode from `BV/src/micro-managers/UManager.sol`. |
| S8 | Reference-price circuit breaker (change 8) | Mock the WMON oracle: slow drift, 5% instant jump, 30% crash, flapping. Exercise deposit, USDC exit, `poke()`, in-kind exit. | Deposits and USDC exits revert outside the band and resume on their own once `refPrice` catches up, with no admin action; `refPrice` never moves faster than `maxMoveBps * elapsed / window`; in-kind exit is unaffected in every case. Record how many honest operations would be blocked under historical MON volatility. |
| S9 | Leader stake (change 9) | Deposits that would dilute the leader below 5%; leader exit that would drop below 5%; leader share transfer attempt; other depositors exiting; agent sale. | Diluting deposits revert or are capped (per chosen policy); leader cannot exit below 5% while others remain; transfers cannot move leader-stake shares; other users' exits never revert on the ratio. |
| S10 | Lockup mechanics (change 10) | Deposit, extend lockup, deposit again, attempt exits at each boundary; third party deposits dust to a victim; leader extends after deposits exist; try to set lockup above `MAX_LOCKUP`. | Unlock time fixed at deposit; extension affects only later deposits; no third-party relock; cap enforced; in-kind respects the lockup only if the team signs off (open question 3). |
| S11 | Fail closed on reads (change 11) | Mock oracle revert, zero price, stale timestamp, negative answer, decimals mismatch; make `balanceOf` on a held token revert. | Deposits and USDC exits revert with a specific error; no shares are minted at an understated NAV; in-kind path is unaffected (except the S1 skip case). |
| S12 | Deposit hygiene (change 12) | `minSharesOut` breached by an oracle move between quote and execution; TVL cap reached; per-asset spread math (USDC vs WMON); `depositsOpen = false` while exits continue. | Each guard works independently; closing deposits never blocks any exit. Port of `testSharePremiumLogicERC20Deposit`. |
| S13 | Handover mode | Simulate an agent NFT sale through the escrow: handover flag set in the same transaction, route table switches to reduce-only, ownership epoch increments, old session key signs a buy intent, new owner tries to trade before the delay. | Old intents revert on epoch; only non-USDC to USDC routes allowed during handover; new owner's first trade only after `delay >= MAX_LOCKUP`; depositors can use every exit throughout. |
| S14 | Operators cannot redirect proceeds (change 13) | Session key or relayer triggers a USDC exit and an in-kind exit for a user with a different `receiver`. | Reverts unless `receiver == owner`. Port of hypurrquant receiver = controller tests. |
| S15 | Post-deploy state assertion (risk 16) | Script that reads every role, delay, oracle, route, fee and cap from the deployed contracts and compares against the intended config. | Script fails on any mismatch. BoringVault's Monad config drift is the motivating example. |

## 2. Tests to port

Port the idea, not the code (BoringVault is SEL-1.0).

| Source | Test | What it proves there | What we prove |
|---|---|---|---|
| `BV/test/fuzzing/invariants/BaseInvariants.sol` | `invariant_noFreeAssets` | Deposit then withdraw never returns more than deposited | Round trip via USDC path and via in-kind never returns more oracle value than deposited, including across oracle updates within the lockup |
| same | `invariant_dustFavorsTheHouse` | Rounding favors the vault | Every mint and burn rounds for the vault; sum of in-kind payouts never exceeds balances |
| same | `invariant_vaultSolvency_1Asset`, `vaultSolvencyMulti` | Assets back all shares | For each token, balance covers every holder's pro-rata claim |
| same | `invariant_tellerPaused_methodsRevert` | Paused methods revert | Inverse: in-kind succeeds under every pause (S2) |
| same | `invariant_deniedUsers_balanceNonDecreasing/NonIncreasing` | Deny list freezes balances | Inverse: no admin or manager action reduces a user's shares (S3) |
| same | `invariant_totalSupplyLEqCap` | Cap holds | TVL cap holds; leader stake at least 5% after each deposit and leader exit (S9, S12) |
| same | `invariant_tellerDoesntHoldTokens`, `invariant_zeroAllowanceOnAssets` | No stray balances or allowances | Executor holds nothing and leaves zero allowance after every intent (S6) |
| same | `invariant_highwaterMarkNeverDecreases`, `invariant_feesCanOnlyDecreaseViaClaimFees` | Fee state monotonic | Later fee phase: per-user entry price and fee shares behave monotonically |
| `BV/test/TellerWithMultiAssetSupport.t.sol` | `testMultipleDepositsWithShareLockPeriod`, `testShowDepositAndTransferLogic`, `testHookLogic` | Lock resets and blocks transfers | Per-deposit unlock, no third-party relock, extension only for new deposits (S10) |
| same | `testUserPermitDepositWithFrontRunning` | A front-run permit does not DoS the deposit | Same for our permit deposit |
| same | `testSharePremiumLogicERC20Deposit` | Per-asset haircut math | Per-asset spread (S12) |
| `BV/test/TellerWithBuffer.t.sol` | `testWithdrawFailureWhenBufferIsTooSmall` | Clean revert when liquidity short | USDC path reverts on a thin pool while in-kind still succeeds in the same state |
| `BV/test/BoringQueue.t.sol` | `testQueueRescueTokenReverts` | Rescue cannot take escrowed shares | Any rescue or sweep function cannot move vault assets or shares |
| `BV/test/BoringSwapper.t.sol`, `BV/test/PriceValidator.t.sol` | Adapter mismatch, slippage, rate limit, pause cases | Typed swap guards | Executor adapter and realized-delta checks (S6) |
| `BV/test/ManagerWithMerkleVerification.t.sol` | totalSupply-unchanged revert | Supply post-check | Vault post-trade supply check (S5) |
| `BV/test/micro-managers/DexSwapperUManager.t.sol` | Rate-limit tests (single timestamp only) | Shows the coverage gap | Our S7 time-warp tests are the corrected version |
| `HQ/test/unit/UsdcVault.t.sol` | `test_redeem_stillWorksWhenFeeRecipientBlacklisted` | Exit independent of fee recipient | Exits never depend on the fee recipient or leader address; extend to token blacklist (S1) |
| same | `test_pause_blocksReadyRedeem` | Pause blocks claims | Inverse for us (S2) |
| same | `test_requestRedeem_revertsIfOwnerNotController`, operator receiver rule | Delegation cannot redirect | S14 |
| same | `test_userDeposits_capBypass_blocked`, `test_maxDeposit_respectsUserCap_includesLocked`, `test_depositCap_userLimit` | Caps cannot be bypassed | If we add per-user caps |
| same | `test_performanceFee_*`, fee snapshot tests, `test_audit_M04_minDelay` | Fee only on profit; snapshot; minimum delays | Later fee phase; delay minimums (S4) |
| `HQ/test/unit/UsdcVault.t.sol` | `testFuzz_convertRoundTrip` | Conversion round trip | Virtual-offset choice; donation attack cost at 6 and 18 decimals |
| `HQ/test/mocks/MockPrecompiles.sol` | `vm.mockCall` at fixed addresses | Deterministic external reads | Oracle failure matrix (S8, S11) |

## 3. Open questions

| # | Question | Why the code cannot answer it |
|---|---|---|
| 1 | Which MON/USD oracles exist on Monad (Chainlink, Pyth, Redstone, Chronicle), with what heartbeat and deviation thresholds? This sets the spread, the breaker band and freshness limits. | Neither repo references a MON feed; Veda's swapper script only wires USDC and mUSD feeds. |
| 2 | Is a Uniswap V3 or V4 TWAP on Monad deep enough to serve as the second source for deviation checks? | Needs pool depth data. |
| 3 | Should the lockup apply to `redeemInKind`? Research recommends yes (fixed at deposit, hard max) to stop oracle-lag arbitrage through in-kind exits; this must be signed off because it touches the non-negotiable rule. | Product decision. |
| 4 | Skip-list forfeit versus pull-based credit for failing tokens in `redeemInKind` (S1)? | Tradeoff between simplicity and user protection. |
| 5 | Leader stake policy: reject or cap diluting deposits? Does the stake move with the agent NFT on sale or must the new owner post it? | Product decision; no precedent in either repo. |
| 6 | Hyperliquid fee details: is the leader's 10% charged per withdrawal, on all-time depositor PnL, with loss carry-forward? Should in-kind exits pay it? | External product behavior, not in either repo. |
| 7 | Who else holds OWNER_ROLE, STRATEGIST (7), STRATEGIST_MULTISIG (10), pause roles (14, 16) and deny role (50) on Monad vmUSD, and what is role 35? | Public RPC rejected full-range `eth_getLogs`; needs an indexer or archive node. |
| 8 | Is `0x16ba7650...` an OpenZeppelin TimelockController, and who are its proposers and executors? | Only `getMinDelay()` was read. |
| 9 | Why does live vmUSD show `platformFee = 0` when the repo config says 50 bps, and a 48 h timelock where the config says none? | Deployment process is not in the repo. |
| 10 | Does Veda know about the `UManager.enforceRateLimit` behavior? Are micro-managers still used in production? | Audit PDFs were not searched; no fix or comment in code. |
| 11 | Does anvil forking of Monad reproduce Monad execution closely enough (gas, reserve balance rules, block timestamp granularity with sub-second blocks)? | Needs an experiment; relevant to S7 and deadline tests. |
| 12 | Does Circle's USDC on Monad include blacklist and pause functions, and who controls them? | Token source not inspected in this research. |
| 13 | Loss carry-forward for the performance fee: include or not? | Product decision; hypurrquant has none. |
| 14 | Virtual share offset size for 6-decimal USDC and 18-decimal WMON valuation. | Needs a donation-attack cost estimate. |
| 15 | What exit size relative to Monad pool depth would make the USDC path revert often enough to justify a queue? | Needs pool and flow data. |
| 16 | Certora specs for BoringSwapper (`BV/certora/`) were not read; do they encode invariants worth mirroring for the Executor? | Out of time for this pass. |
