# Report 3: Spike Plan and Open Questions

This plan tests the StrategyVault design in Report 2 on a Monad mainnet fork. Nothing here has been run. Foundry is not installed in the research environment, and the research phase was read-only.

## 0. Setup

**Environment.**

| Step | Detail |
|---|---|
| Tooling | Install Foundry (`curl -L https://foundry.paradigm.xyz \| bash && foundryup`). Solidity 0.8.28, `evm_version = cancun` (transient storage needed for once-per-transaction NAV) |
| Fork | `anvil --fork-url https://rpc.monad.xyz --fork-block-number <pinned>`. Tests use `vm.createSelectFork(vm.envString("MONAD_RPC"), PINNED_BLOCK)` so results are reproducible. `eth_getLogs` on the public RPC is limited to a 100-block range (**Verified**), so pin a block and avoid log scans in setup |
| Base | OpenZeppelin `ERC4626` (MIT) with `_decimalsOffset() = 12`, plus our StrategyVault, a minimal Executor, and a mock `AgentNFT` exposing `ownerOf`, `ownershipEpoch`, `epochStartedAt` |

**Addresses.** All were **Verified** to have code on 2026-09-25 (see Report 2 header).

- **Tokens:**
  - USDC `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`
  - WMON `0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A`
  - WETH `0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242`
- **Chainlink feeds:**
  - ETH/USD `0x1B1414782B859871781bA3E4B0979b9ca57A0A04`
  - MON/USD `0xBcD78f76005B7515837af6b50c7C52BCf73822fb`
  - USDC/USD `0xf5F15f188AbCb0d165D1Edb7f37F7d6fA2fCebec`
- **Uniswap:**
  - SwapRouter02 `0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900`
  - v3 USDC/WMON 0.3% pool `0x659bd0bc4167ba25c62e05656f78043e7ed4a9da`
  - v3 USDC/WETH 0.3% pool `0x25ef1a210ff55bcee9f8fee979aaff6bd1be5bf1`
- **Funding test accounts:** use `deal(USDC, user, amount)`. If `deal` fails on the USDC proxy's storage layout, impersonate a large holder with `vm.prank`.

**Common fixture.**

1. The leader (mock NFT owner) deposits a 5% seed.
2. The manager opens deposits.
3. Alice and Bob deposit.
4. The Executor makes a few trades to reach a mixed portfolio.
5. Warp past the 1-day lockup where a test needs it.

## 1. Spike steps

Each step lists the test outline and the success condition. Tests marked with `(fuzz)` should use `bound()` fuzzing, and those marked `(invariant)` should also exist as Foundry `invariant_` tests with a handler that performs random deposits, exits, swaps, oracle moves, and NFT transfers.

### 1.1 Deposit USDC and receive shares at the expected price

- **Test:** `test_deposit_mintsExpectedShares` `(fuzz amount, portfolio mix)`.
  1. Start from the fixture with a mixed portfolio.
  2. Read `navUsdc()`, `totalSupply()`, `previewDeposit(x)`.
  3. `deposit(x, alice)`.
- **Success:**
  - `shares == previewDeposit(x)`.
  - `shares == floor(x × (supply + 1e12) / (NAV_buy + 1))`.
  - Price per share after is at least price per share before (rounding and spread favor the vault).
  - Alice's shares are locked until `now + 1 day`.
  - Deposit reverts when a feed is stale or deposits are closed.
- **Also:** `test_roundTrip_noProfit` `(fuzz)`: deposit, then immediately (after lockup warp with prices unchanged) redeem, returns at most the deposit. This ports Morpho's `RoundTrip.spec`.

### 1.2 First-depositor inflation attack fails

- **Test:** `test_inflationAttack` `(fuzz donation)`.
  1. Deploy a fresh vault.
  2. The attacker becomes the first depositor with 1 wei USDC (as leader, since leader seeding is required first).
  3. The attacker donates a large amount of USDC or WMON directly to the vault.
  4. The victim deposits `v`.
- **Success:**
  - The victim receives shares worth at least `v × (1 − 1e-6)` on `previewRedeem`.
  - The attacker's loss from the donation is at least their gain.
  - `depositsOpen` cannot be set until the leader seed meets the minimum.
- **Variant:** run with the leader seed in place and confirm that a donation only raises everyone's price.

### 1.3 Executor swaps within limits; assets stay in the vault

- **Tests:**
  - `test_executorSwap_usdcToWmon`, `test_executorSwap_wmonToUsdc`: through `Executor.swap` with valid epochs.
  - `test_executorSwap_limits` `(fuzz size)`: trades above 10% NAV, above 40% post-trade concentration, below the 10% USDC floor, above 0.5% slippage versus oracle, an expired deadline, or the 21st trade in 24 hours revert in the Executor. Direct calls that bypass the Executor with looser parameters revert on the vault backstops.
- **Success:**
  - After each swap, the vault's allowance to the router is 0 for every token.
  - The Executor's, session key's, and router's balances of all tokens are unchanged.
  - The sum of vault token values changed only by the swap's slippage plus fee, within bounds.
  - Events carry the oracle prices.

### 1.4 Every non-withdrawal path out fails

- **Test:** `test_noEscapePaths`. For each actor (manager, Executor, session key, admin, guardian, random), try:
  - `executeSwap` with a non-allowlisted pool or a malicious "pool" contract that keeps the input;
  - a recipient other than the vault (not expressible in the interface, so check via a crafted router);
  - `transfer` or `transferFrom` of vault shares (disabled);
  - `approve` via any selector;
  - `multicall` with a delegatecall to an external target (must be self-only, as Morpho's `Immutability.spec` proves);
  - `addToken` of an attacker token with a fake feed before the timelock;
  - `setExecutor` before the timelock;
  - adding an exit gate (no such setter should exist; assert the ABI has none).
- **Success:**
  - All revert.
  - Vault token balances are unchanged.
  - An invariant handler additionally asserts: vault balances only decrease through exits (to the exiting user) or swaps (with a matching increase in another allowlisted token worth at least `(1 − backstopSlippage)` of the input).

### 1.5 Withdraw when USDC covers it; withdraw when it does not

- **Tests:**
  - `test_redeem_usdcCovers`: portfolio with USDC above the floor plus the amount owed.
    - Success: payout equals `previewRedeem(shares)` at `NAV_sell`, non-USDC balances are unchanged, and the USDC balance stays at or above 10% of the remaining NAV.
  - `test_redeem_proportionalClose`: USDC near the floor.
    - Success: each non-USDC balance falls by exactly `balance × shares / supply` (plus or minus 1 wei). Payout is at least `minAssetsOut`. Each leg's output is at least `slice × price × (1 − maxExitSlippage)`. Remaining holders' price per share (at `NAV_sell`) is unchanged within rounding plus the spread gain.
  - `test_redeem_alwaysProportional`: the flag is on and USDC suffices, and proportional close still occurs.
  - `test_redeem_venueFails`: `vm.mockCallRevert` on the pool, or drain its liquidity with a large swap first.
    - Success: the call reverts with no state change, and `redeemInKind` then succeeds.
  - `test_redeem_thinPoolGuard`: a WETH slice larger than 2% of pool liquidity (easy today with about 5.7k USDC in the pool) reverts with `UseInKind`.
  - `test_redeemInKind` `(fuzz shares, portfolio)`.
    - Success: the user receives `floor(balance_t × shares / supply)` of each token, and remaining holders' per-share token amounts do not decrease.

### 1.6 Withdraw with the Executor and platform disabled

- **Test:** `test_offlineExit`. Simulate every external failure at once:
  1. `vm.etch` the Executor with `revert()` bytecode.
  2. Revoke the session key.
  3. `vm.mockCallRevert` every Chainlink feed.
  4. Mock every Uniswap pool and the router to revert.
  5. Mock `AgentNFT` to revert.
  6. The guardian calls `pause()`.
- **Success:**
  - `redeemInKind` succeeds for every depositor whose lock has ended.
  - If a lock is active, the `AgentNFT` failure is treated as handover, so the lock is waived and the exit also succeeds.
  - The final depositor can empty the vault, leaving only virtual-share dust.
- This is the most important test. It should also exist as an invariant: "for any reachable state and any account with free shares, `redeemInKind` does not revert, given standard token behavior."

### 1.7 Enforce the leader's 5% minimum

- **Tests:**
  - `test_leaderCannotDropBelow5` `(fuzz)`: the leader redeems or redeems in kind so that `leaderShares < 5% × supply` afterwards. It reverts. A smaller redeem that keeps 5% succeeds.
  - `test_depositCannotDiluteLeader`: Alice's deposit would push the leader below 5%. It reverts. `maxDeposit(alice)` equals the exact headroom, and a deposit of exactly `maxDeposit` succeeds.
  - `test_othersExitRaisesLeaderShare`: Bob's exit is never blocked by the 5% rule.
  - `test_windDownReleasesLeader`: after `closeVault()` plus `MAX_LOCKUP`, the leader can exit fully.

### 1.8 Enforce the lockup, then withdraw after it ends

- **Tests:**
  - `test_lockup`: deposit, then `redeem` and `redeemInKind` at `t + 1 day − 1` revert (`maxRedeem == 0`). At `t + 1 day` they succeed.
  - `test_lockupTopUp`: a second deposit extends only up to `now + d`.
  - `test_lockupGriefing`: Bob deposits dust `onBehalf` of locked Alice. It reverts.
  - `test_lockupIncrease`: the manager submits 3 days. Execution before `3 days + NOTICE` reverts. After execution, existing `unlockAt` values are unchanged and only new deposits get 3 days. `decreaseLockup` is instant.
  - `test_lockupBounds`: values below 1 day or above 7 days revert.
  - `test_lockupWaived`: pause, handover, and wind-down each waive the lock.
- **Success:** as described. ERC-4626 `maxRedeem` and `maxWithdraw` match the free shares and never revert.

### 1.9 Handover mode: the old manager cannot trade

- **Test:** `test_handover`.
  1. Transfer the mock AgentNFT, which increments the epoch and sets `epochStartedAt`.
  2. Check that:
     - `inHandover()` is true;
     - the old owner's `setDepositsOpen` and `submitLockupIncrease` revert;
     - an old owner's pending action, even if matured, reverts on execution (epoch mismatch);
     - `Executor.swap` with the old `ownershipEpoch` reverts;
     - a risk-increasing swap with the new epoch reverts (reduce-only);
     - `deposit` reverts;
     - depositors' locked shares can exit;
     - the new owner's `acceptManagement()` before `HANDOVER_PERIOD` reverts, and after the period without a 5% stake reverts;
     - `stakeAsIncomingLeader` then `acceptManagement` succeeds, and trading resumes with the new epoch.
- **Variant:** transfer outside the escrow gives the same result, because detection does not depend on escrow calls.

### 1.10 Stale or manipulated oracle at deposit and at withdrawal

- **Tests:**
  - `test_staleOracle_deposit`: warp so `updatedAt` is older than 5 minutes (or mock `latestRoundData`). `deposit` reverts and `maxDeposit` returns 0.
  - `test_staleOracle_withdraw`: `redeem` (USDC path) reverts with `OracleUnavailable`. `redeemInKind` succeeds, and `maxWithdraw` returns 0 without reverting.
  - `test_oracleOffBand`: mock the feed 3% away from the pool TWAP. Deposits and USDC redemptions revert.
  - `test_lagArbitrage` `(fuzz lag within band)`:
    1. The market moves 1.5% (push the pool with a large swap; the feed is not updated).
    2. The attacker deposits at the stale feed, waits the lockup, the feed catches up, and the attacker redeems.
    3. Success: attacker profit is at most (lag minus spread) times the risk share, and is 0 when the lag is within the spread. Record the measured extraction as the basis for tuning `s`.
  - `test_poolManipulation`: a flash swap moves the pool 20% within one transaction, then deposit and redeem in the same transaction. NAV does not move, because it comes from Chainlink and is cached once per transaction. The deposit reverts on the TWAP band check.
  - `test_executorSandwich`: front-run an Executor swap by 0.4%. The swap still succeeds within bounds. At 0.6% it reverts on the oracle floor.

### 1.11 Extra checks worth doing in the same spike

| Check | Why |
|---|---|
| Gas for `redeemInKind` with 3 to 5 tokens, and for proportional close with 2 to 3 legs | Monad cost model; confirm whether charging is by gas limit |
| Uniswap v4 USDC/WETH and USDC/LST depth (StateView `0x77395f3b2e73ae90843717371294fa97cc419d64`) | Decide whether WETH and an LST are viable at launch |
| Chainlink heartbeat and deviation per feed (read `latestRoundData` over a window of blocks) | Sets `MAX_STALENESS` and spread `s` |
| Port Morpho invariants as Foundry invariants: `totalSupply == Σ balances`, previews equal results, no profitable round trip, price per share non-decreasing across non-trade calls, timelock earliest time, abdication permanence | Report 1 section 7.4 |

## 2. Open questions (the code could not answer these)

| # | Question | Why it matters | How to resolve |
|---|---|---|---|
| 1 | Does the deployed Monad `VaultV2Factory` (`0x8B2F…bb0c`) match commit `9ee4dbdc`? | Only matters if we later use Morpho V2 directly | Compare runtime bytecode against a local build of the matching tag |
| 2 | What are the heartbeat and deviation thresholds of the Monad Chainlink feeds (MON/USD, ETH/USD, USDC/USD, LST/MON), and what are the SVR variants' semantics? | Sets staleness limits and the directional spread | Chainlink docs plus onchain observation (1.11) |
| 3 | Real DEX depth on Monad, especially Uniswap v4 and other venues, for WETH and each LST candidate | Measured v3 USDC/WETH depth is about 5.7k USDC, which may rule WETH out at launch | Spike measurement. Decide the launch asset list |
| 4 | Does Monad have a public mempool, private order flow, or builder auction? | Sandwich and oracle-update front-running exposure | Monad docs and infra providers |
| 5 | Is Monad gas charged on the gas limit? | Exit cost and UI gas settings | Monad docs plus fork measurement (anvil may not reproduce it; test on testnet) |
| 6 | Per-depositor versus global HWM for the 10% fee, and whether the leader's own stake pays the fee | Fairness and complexity | Product decision |
| 7 | Should the escrow transfer the old leader's stake to the buyer, or must the buyer post a fresh 5%? | Handover capital requirement | Product and escrow design |
| 8 | Behavior when a token in the vault becomes untransferable (USDC blacklist or pause, LST upgrade) | In-kind exit completeness | Accept `skipMask` forfeit semantics, or build a per-user claimable balance |
| 9 | Should `alwaysProportional` and lockup changes also require a notice period for existing depositors? | Hyperliquid lets the leader change them. We apply lockups only to new deposits | Product decision |
| 10 | Is GPL-2.0-or-later acceptable if we copy any Morpho code, and does our Executor become a derivative if it links to a GPL vault? | Licensing of our stack | Legal review. Default plan: re-implement patterns on MIT code |
| 11 | Does Morpho's own UI or curation ecosystem add value that would justify a separate Morpho-native product later (USDC lending vault)? | Roadmap | Business decision |
| 12 | How do we price an LST: market price (LST/MON feed times MON/USD) or redemption rate? | Depeg exposure | Use market price; confirm feed type per LST |
| 13 | What should the circuit breaker's 7-day peak NAV be computed on (oracle mid, `NAV_sell`) and where should it live (Executor, vault, or both)? | Avoid false triggers from oracle noise | Spike with historical prices |
| 14 | Who in Morpho's design sets `maxRate` in practice, and what values are typical? | Not needed for our design (we drop `maxRate`), but useful context | Not answerable from code |
