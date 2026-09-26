# Sub-agent C: Accounting, exchange rate, and fees

Scope: how BoringVault (Veda) and hypurrquant HyperVault value shares and charge fees, and what that means for our StrategyVault valuation and future performance fee.

Repo versions: see `00-phase0-orientation.md` (BoringVault `c9c221f9`, hypurrquant `79e41cdc`). BoringVault is under SEL-1.0, so everything below is a pattern reference only, never code to copy.

Paths: `BV/` = BoringVault clone root, `HQ/` = `/home/dhrupatel/agent_tool/hyperliquid`.

Labels: **Verified** = read in code (or read onchain), **Inferred** = my reasoning, not directly shown by code. Portability: **Portable** / **Adaptable** / **Chain-specific**.

---

## 1. Summary

| Question | BoringVault answer | hypurrquant answer |
|---|---|---|
| Where does share price come from? | A number pushed onchain by a trusted role (`updateExchangeRate(uint96)`), computed offchain. Vault balances never enter the price. | Computed live on every call from chain state (EVM USDC balance + HyperCore precompile reads). |
| Guard on bad prices | Minimum delay between updates plus upper/lower bound per update. A violating update is **stored anyway and the accountant pauses**. | Deposits revert if perp oracle vs mark, or spot vs perp oracle, diverge by more than 5%. No guard on redeem pricing. |
| What pause blocks | Every `...Safe` rate read, so Teller deposits, Teller withdrawals, queue requests, and fee claims. No exit remains. | `deposit`, `requestRedeem`, `redeem` (`whenNotPaused`). No exit remains. |
| Fees | Platform fee (time-based, on min(shares now, shares at last update) at the lower of old/new rate) plus performance fee over a **global** high-water mark, accrued in base units as a liability, paid by the vault via `claimFees`. | 10% performance fee (max 30%) on **per-user** profit vs cost basis, charged at redeem, fee rate frozen at `markRedeemReady`. No management fee. |
| Offline exit | None. `BoringVault.exit` is `requiresAuth`, only the Teller can call it. **Conflicts** with our non-negotiable rule. | None. Only async USDC redeem through a keeper. **Conflicts** as well. |

Headline recommendation: **keep onchain oracle valuation computed once per transaction** (our current design) and **do not** publish a manager-pushed exchange rate. Borrow two Accountant ideas as a circuit breaker that applies only to deposits and USDC withdrawals: (a) a stored reference share price that only moves at a bounded, time-scaled rate, and (b) reject (not pause) when live value leaves the band. `redeemInKind` never reads the breaker, the oracle, or the reference price. Details in section 6.

---

## 2. BoringVault: AccountantWithRateProviders

File: `BV/src/base/Roles/AccountantWithRateProviders.sol` (622 lines, last audited 0xMacro veda-92).

### 2.1 AccountantState, field by field (Verified, lines 37-50, constructor 155-192)

| Field | Type | Meaning | Written by |
|---|---|---|---|
| `payoutAddress` | address | Where `claimFees` sends fees | constructor, `updatePayoutAddress` |
| `highwaterMark` | uint96 | Highest exchange rate that has been charged performance fee | constructor (= starting rate), `_calculateFeesOwed` (raised when new rate > HWM), `resetHighwaterMark` (lowered to current rate) |
| `feesOwedInBase` | uint128 | Accrued unpaid fees, denominated in base asset | `_calculateFeesOwed` (+=), `claimFees` (zeroed) |
| `totalSharesLastUpdate` | uint128 | `vault.totalSupply()` at last update | every `updateExchangeRate`, `resetHighwaterMark` |
| `exchangeRate` | uint96 | Current published rate: base units per 1 share | `updateExchangeRate` via `_setExchangeRate` |
| `allowedExchangeRateChangeUpper` | uint16 bps | Max ratio new/old, e.g. 10020 = +0.2% | constructor, `updateUpper` (must be >= 1e4) |
| `allowedExchangeRateChangeLower` | uint16 bps | Min ratio new/old, e.g. 9980 = -0.2% | constructor, `updateLower` (must be <= 1e4) |
| `lastUpdateTimestamp` | uint64 | Time of last update | `updateExchangeRate`, `resetHighwaterMark` |
| `isPaused` | bool | Pause flag | `pause`, `unpause`, auto-set by a violating update |
| `minimumUpdateDelayInSeconds` | uint24 | Min seconds between updates (max 14 days) | constructor, `updateDelay` |
| `platformFee` | uint16 bps/year | Max 20% (`MAX_PLATFORM_FEE = 0.2e4`) | constructor, `updatePlatformFee` |
| `performanceFee` | uint16 bps | Max 50% (`MAX_PERFORMANCE_FEE = 0.5e4`) | constructor, `updatePerformanceFee` |

Packed into 3 slots (comment line 64). Separately, `rateProviderData[ERC20] => {isPeggedToBase, rateProvider}` (lines 56-71).

### 2.2 Who publishes the rate and how often

- `updateExchangeRate(uint96)` is `requiresAuth`, natspec says "Callable by UPDATE_EXCHANGE_RATE_ROLE" (line 332). **Verified.**
- Deploy script wires role 11 `UPDATE_EXCHANGE_RATE_ROLE` to that selector: `BV/script/ArchitectureDeployments/DeployArcticArchitectureWithConfig.s.sol` lines 149, 1109-1111. **Verified.** The holder is an address chosen per deployment (an offchain bot); the script does not grant it in the lines read. **Inferred:** it is Veda's rate bot.
- The new rate is computed **offchain**. Nothing in the contract reads vault balances or prices to compute it. **Verified** (no balance reads in the file).
- Frequency: nothing forces updates. `minimumUpdateDelayInSeconds` is a floor, not a heartbeat. Updating sooner than the delay does not revert, it pauses (below). **Verified.** Monad vmUSD config uses 21,600 s (6 h). **Verified** (`deployments/skeletons/configurations/Monad/vmUSD.json`).
- Admin setters (`updateDelay`, `updateUpper`, `updateLower`, fees, payout, `setRateProviderData`, `resetHighwaterMark`) are wired to `OWNER_ROLE` (script lines 1074-1100). **Verified.**

### 2.3 Bounds and what happens on violation

```solidity
// _beforeUpdateExchangeRate, lines 516-523
if (state.isPaused) revert AccountantWithRateProviders__Paused();
...
shouldPause = currentTime < state.lastUpdateTimestamp + state.minimumUpdateDelayInSeconds
    || newExchangeRate > currentExchangeRate.mulDivDown(state.allowedExchangeRateChangeUpper, 1e4)
    || newExchangeRate < currentExchangeRate.mulDivDown(state.allowedExchangeRateChangeLower, 1e4);

// updateExchangeRate, lines 342-352
if (shouldPause) {
    // Instead of reverting, pause the contract. ...
    state.isPaused = true;
} else {
    _calculateFeesOwed(state, newExchangeRate, currentExchangeRate, currentTotalShares, currentTime);
}
newExchangeRate = _setExchangeRate(newExchangeRate, state);
state.totalSharesLastUpdate = uint128(currentTotalShares);
state.lastUpdateTimestamp = currentTime;
```

Verified behavior:
1. An out-of-bounds or too-early update **does not revert**. It sets `isPaused = true`, **stores the new rate anyway**, skips fee accrual (so HWM is not raised), and updates `lastUpdateTimestamp`.
2. Updating while already paused reverts (line 517). So after a violation, only an unpause lets the rate move again.
3. Confirmed by test `BV/test/AccountantWithRateProviders.t.sol::testResetHighwaterMark`: `updateExchangeRate(1.5e18)` from 1.0 pauses but the stored rate becomes 1.5 (then `resetHighwaterMark` reverts because rate > HWM, and the test calls `unpause()` before the next update).
4. The bound is **per update, not per unit of time** (Inferred from the formula). With ±0.2% and a 6 h delay, the rate can move at most about ±0.8% per day in unpaused operation; a vault that is not updated for a week still only gets ±0.2% on the next update. Any larger true move forces a pause and a human unpause.
5. `previewUpdateExchangeRate` (lines 451-486) lets the bot check in advance whether an update will pause. **Verified.**

### 2.4 What pause affects, and who can unpause

- `getRate()` (line 399) **still returns the stored rate while paused**, including a bad rate. `getRateSafe()` and `getRateInQuoteSafe()` revert when paused (lines 407-443). **Verified.**
- Teller uses only the safe variant: deposit `shares = depositAmount.mulDivDown(ONE_SHARE, accountant.getRateInQuoteSafe(depositAsset))` (`TellerWithMultiAssetSupport.sol::_erc20Deposit` line 587) and withdraw `assetsOut = shareAmount.mulDivDown(accountant.getRateInQuoteSafe(withdrawAsset), ONE_SHARE)` (`_withdraw` line 606). So an accountant pause blocks **both deposits and withdrawals** even if the Teller itself is not paused. **Verified.**
- `BoringOnChainQueue.previewAssetsOut` also uses `getRateInQuoteSafe` (line 546), so new withdraw requests stop. **Verified.** (Solving of existing requests is Sub-agent D's area.)
- `claimFees` reverts while paused (line 367). **Verified.**
- `pause` and `unpause` are `requiresAuth`, wired to `PAUSER_ROLE` (script lines 1105-1108); a separate `Pauser` contract (`BV/src/base/Roles/Pauser.sol`) can fan out pause/unpause to many pausables via GENERIC_PAUSER / GENERIC_UNPAUSER / PAUSE_ALL / UNPAUSE_ALL roles (script lines 926-941, 1252-1257). **Verified.** Who holds those roles for vmUSD is not in the repo (open question).
- Because `BoringVault.exit` is `requiresAuth` (`BV/src/base/BoringVault.sol` line 98-101) and only the Teller holds `BURNER_ROLE`, **a paused accountant means no user can exit at all.** **Verified** (role grants at script lines 1506-1507). This directly **conflicts** with our offline exit rule. The design deliberately chooses "freeze everything" as the safe state; ours must choose "freeze buys and priced exits, keep in-kind exit open".

Portability: rate-with-bounds pattern **Portable** (plain EVM), but license forbids copying.

### 2.5 Fee formulas (Verified, lines 541-621)

Let `S_now = vault.totalSupply()`, `S_last = totalSharesLastUpdate`, `R_old = exchangeRate` (before update), `R_new` = proposed rate, `dt = now - lastUpdateTimestamp`, `ONE = 10^shareDecimals`.

```
S_use          = min(S_now, S_last)                         // _calculatePlatformFee, lines 550-554
assetsForFee   = S_use * min(R_old, R_new) / ONE            // lines 559-561
platformFee    = assetsForFee * platformFeeBps / 1e4 * dt / 365 days   // lines 562-563

if R_new > HWM:                                              // _calculateFeesOwed, 607-618
    yieldEarned    = (R_new - HWM) * S_use / ONE             // _calculatePerformanceFee, 576-577
    performanceFee = yieldEarned * performanceFeeBps / 1e4
    HWM = R_new                                              // always raised, even if perf fee is 0
feesOwedInBase += platformFee + performanceFee
```

Observations:
- Using `min(S_now, S_last)` and `min(R_old, R_new)` makes the platform fee conservative: a flash deposit right before an update cannot inflate the fee base, and a rate jump is not charged platform fee for the whole period. **Verified** (formula), **Inferred** (intent).
- Performance fee uses a **single global HWM on the share price**. Everyone pays on the global rise above HWM regardless of their entry price. **Verified.**
- HWM is raised even when `performanceFee == 0`, "so we can start taking them without back charging" (comment lines 614-616). **Verified.**
- `resetHighwaterMark()` (lines 309-324, OWNER_ROLE): only allowed when `exchangeRate <= highwaterMark` (i.e. after a drawdown). It accrues platform fees up to now, then sets `HWM = exchangeRate`. Effect: the manager can forgive the drawdown and start charging performance fee on the recovery. This is a manager-favorable lever that hurts depositors who were in the drawdown. **Verified** (code), **Inferred** (effect).
- Fees are **not subtracted from the rate onchain**. `feesOwedInBase` is a separate liability. **Inferred:** the offchain bot must compute `rate = (NAV - feesOwed) / shares`, otherwise depositors who exit before `claimFees` are overpaid. The contract cannot enforce this.
- The performance fee is charged at the moment the rate is posted, based on a bot-supplied number. The only protection against an inflated rate earning fees is the ±bound and the pause. **Inferred.**

### 2.6 claimFees and fee-asset conversion (Verified, lines 363-392)

- Must be called **by the BoringVault itself** (`msg.sender != address(vault)` reverts). In practice the strategist calls `vault.manage(accountant, claimFees(asset))`, whitelisted via `BaseDecoderAndSanitizer.claimFees` (`BV/src/base/DecodersAndSanitizers/BaseDecoderAndSanitizer.sol` line 22) and a Merkle leaf. The vault must also have approved the accountant (it uses `safeTransferFrom(msg.sender, payoutAddress, ...)`).
- Conversion: if `feeAsset == base`, pay `feesOwedInBase`. Else convert decimals, then if `isPeggedToBase` pay 1:1, else `feesOwedInFeeAsset = feesInBaseUsingFeeAssetDecimals * 10^feeDecimals / rateProvider.getRate()`. Rounds down (payer favorable). Natspec at lines 287-297 warns that 18 to 6 decimal conversion truncates tiny amounts to 0.
- Zeroes the whole `feesOwedInBase` in one go. Blocked while paused.

### 2.7 Multi-asset rates (Verified, lines 418-443)

```
getRateInQuote(quote):
  if quote == base: return exchangeRate
  r = changeDecimals(exchangeRate, baseDecimals, quoteDecimals)
  if isPeggedToBase: return r
  return 10^quoteDecimals * r / rateProvider.getRate()   // rateProvider: price of quote in base
```

So multi-asset support only converts the **share price** into another deposit/withdraw currency. The share price itself is still one bot-pushed number. The per-asset rate provider is read live (not bounded, not paused) unless the provider has its own checks. **Verified.** `setRateProviderData` is OWNER_ROLE with no timelock in the contract (timelock, if any, is at the RolesAuthority owner level). **Verified** (lines 299-303).

### 2.8 GenericRateProviderWithStalenessCheck (Verified, `BV/src/helper/GenericRateProviderWithStalenessCheck.sol`)

- Wraps any static-arg view call (`target.selector(args...)`) as `getRate()`, plus a second call `lastUpdateSelector` whose return word at `lastUpdateOffset` is a timestamp.
- Reverts `StalePrice` if `lastUpdate + maxStaleness < block.timestamp` (line 118); reverts on negative signed answers; rescales decimals; forces 18 output decimals (lines 73-75, because `PriceValidator` assumes 1e18).
- No deviation, no min/max answer, no sequencer check, no L2 grace. **Verified** (absent from file).
- Portability: **Portable** idea (generic adapter with a freshness check). Confirms our "oracle freshness" decision; our Executor/vault oracle adapter needs more (deviation between two sources, bounds) than this provides.

---

## 3. AccountantWithYieldStreaming (Monad vmUSD) and AccountantWithFixedRate

### 3.1 Yield streaming (`BV/src/base/Roles/AccountantWithYieldStreaming.sol`)

How it works (all Verified):
- The strategist (STRATEGIST_ROLE in tests, e.g. `BV/test/AccountantWithYieldStreaming.t.sol` lines 122-128) calls `vestYield(yieldAmount, duration)` with duration between `minimumVestingTime` and `maximumVestingTime` (defaults 1 day and 7 days, lines 59-65). The yield vests linearly.
- `getRate()` (lines 369-380) = `(lastSharePrice * supply / ONE + vestedSoFar) * ONE / supply`, so the price rises smoothly each second instead of jumping.
- `vestYield` checks `dailyYieldBps = (yield * 1 day / duration) * 1e4 / (TWAS * lastVirtualSharePrice)` against `maxDeviationYield` (default 500 bps/day, lines 193-201). TWAS (time-weighted average supply, `_getTWAS`, lines 428-443) stops a strategist from flash-shrinking or flash-growing supply to game the check.
- `vestYield` **overwrites** the remaining vest (`=`, not `+=`, comment lines 172-174).
- `postLoss(lossAmount)` applies losses **immediately**: first eats unvested gains, then cuts the share price; if the cut exceeds `maxDeviationLoss` (default 100 bps) the accountant **pauses but still records the loss** (lines 255-262). Same "store and pause" philosophy as the base.
- Every Teller deposit and withdraw calls `accountant.updateExchangeRate()` first (`BV/src/base/Roles/TellerWithYieldStreaming.sol` lines 40, 57, 83), and `_updateExchangeRate` reverts if paused (line 481). So pause again blocks all entries and exits.
- The base `updateExchangeRate(uint96)` is overridden to revert (lines 286-288). **Therefore the `allowedExchangeRateChangeUpper/Lower` bounds are never evaluated for this accountant.** The vmUSD config values 9980/10020 are stored but inert. **Verified** (no call to `_beforeUpdateExchangeRate` in the file). Its only guards are `maxDeviationYield`, `maxDeviationLoss`, the vesting min/max, and `minimumUpdateDelayInSeconds` between strategist posts.
- Deposit rounding: `shares = depositAmount * ONE / (rate + 1)` (Teller line 62). The `+1` biases against the depositor to cover rounding in the vested price. **Verified.**

What it prevents (Inferred): the classic "deposit just before a rate bump, withdraw after" sandwich. With a stepwise rate, whoever sees the bot's pending update can capture yield they did not earn; with streaming, a newcomer only earns the part that vests while they are in. Losses are not streamed (they are immediate), so exiters cannot front-run a loss by waiting for it to trickle in.

Live Monad state (Verified, eth_call to `0x98A45D90E81849a5743241d3ff765F9Fd788206a` at block 108,055,592, timestamp 1790388402):

| Read | Value |
|---|---|
| `accountantState()` | HWM 1.017010, feesOwed 0.000004, totalSharesLastUpdate 34,243,170.94, exchangeRate 1.017010, upper 10020, lower 9980, isPaused false, delay 21600, **platformFee 0, performanceFee 0** |
| `vestingState()` | lastSharePrice 1.017010, vestingGains 2,111.56, vest window 43,200 s (12 h) |
| `maxDeviationYield` / `maxDeviationLoss` | 500 / 100 bps |
| `minimumVestingTime` / `maximumVestingTime` | 21,600 s / 604,800 s (minimum lowered from the 1-day default) |

Note: the config file says `platformFee: 50`, but onchain it is 0. Either changed after deploy or deployed differently (open question). Streamed yield is about 4,223 mUSD/day on about 34.8M, roughly 1.2 bps/day. **Inferred** from the numbers.

Portability: **Adaptable**. The idea (smooth a trusted reported gain over time, apply losses instantly, cap by TWAS) fits a yield vault fed by a reporter. It does not fit our live-oracle vault directly, because our gains appear through prices, not reports.

### 3.2 AccountantWithFixedRate (`BV/src/base/Roles/AccountantWithFixedRate.sol`, Verified)

- Share price capped at exactly `10^decimals` (1.0) (`_setExchangeRate`, lines 202-214). Anything above is split into fees and `yieldEarnedInBase` that a `yieldDistributor` withdraws via `claimYield` (lines 115-145). Below 1.0 no fees are charged.
- HWM cannot be reset (line 105). Platform fee is forfeited if fees would exceed yield (lines 249-255).
- Relevance to us: low. It is a stable-value receipt token design. **Not applicable.**

### 3.3 FeeRegistry (`BV/src/base/Periphery/FeeRegistry.sol`, Verified)

- Per-swapper swap fees (atomic and limit) by token-group pair, capped by `maxFeeBps`, plus fee recipients. Read by `BoringSwapper` (`BoringSwapper.sol` lines 507, 612-616, 668). `BoringSwapper.claimFees` sends accumulated swap fees to the registry recipient.
- **Not a vault fee** (not management or performance). It is a platform take on swaps executed by the swapper. **Inferred relevance:** if we ever charge a platform fee on Executor swaps, a per-pair capped registry is a clean pattern (Adaptable), but it would be a cost to depositors and must be counted in slippage limits. Out of scope for the vault's accounting.

---

## 4. hypurrquant HyperVault: live NAV

### 4.1 totalAssets (Verified, `HQ/src/vault/UsdcVault.sol::totalAssets` lines 278-282)

```solidity
function totalAssets() public view returns (uint256) {
    uint256 gross = _evmBalance() + _coreNAV() + _inflightBuffer();
    uint256 fees = accruedFees;
    return gross > fees ? gross - fees : 0;
}
```

| Component | Source | Label |
|---|---|---|
| `_evmBalance()` | `usdc.balanceOf(vault)` (includes USDC reserved for ready redeems, and accrued fees) | Portable |
| `_coreNAV()` | `NavLib.coreNAV` (lines 285-316): HyperCore spot USDC (precompile 0x801, /100 to 6 dp) + perp account value (0x80F, negative subtracted, floor 0) + primary spot token and each tracked spot token valued at `spotPx` (0x808) | Chain-specific (precompiles); the "sum of balance x price over an allowlisted list" idea is Adaptable |
| `_inflightBuffer()` | USDC sent to HyperCore but not yet visible there, counted for up to 50 blocks (lines 310-318) | Chain-specific (async bridge). Not needed on Monad where everything is in one EVM state |
| minus `accruedFees` | Performance fees already charged but still in the vault | Portable. **Improves** our design (see 4.5) |

Every precompile read is a gas-capped `staticcall` that returns `(false, 0)` on failure (`NavLib` lines 56-146), and `coreNAV` then **silently counts 0** for that leg (lines 296-315). **Verified.** Comment at `UsdcVault.unpause` (lines 703-706) shows they chose this to avoid DoS. **Inferred risk:** a failed read understates NAV, so a deposit in that block mints too many shares (dilutes holders) and `markRedeemReady` reserves too little (hurts the redeemer). `checkPriceSanity` only reverts on missing oracle/mark price, not on a failed balance read. For us this is a clear lesson: **fail closed on buys and priced exits** (revert), which our brief already requires ("If a pool or oracle fails, the call reverts"). **Confirms** our decision.

### 4.2 Reserved balances for pending redeems (Verified)

- `requestRedeem` moves shares into the vault (still counted in `totalSupply`) and snapshots cost basis (`RedeemLogic.executeRequestRedeemWithAccounting` lines 132-150).
- `markRedeemReady` (keeper) computes `estimatedAssets = convertToAssets(shares)` at live NAV, requires free EVM USDC `evmBalance - reservedEvmBalance >= estimatedAssets`, stores it in `_reservedAssetsPerRequest`, adds to `reservedEvmBalance`, and snapshots the fee rate (`UsdcVault.markRedeemReady` lines 516-530; `RedeemLogic.executeMarkRedeemReady` 156-175).
- At `redeem`, the user gets exactly the reserved amount minus fee; the shares are burned then (`UsdcVault.redeem` lines 576-615).
- **Inferred accounting wrinkle:** between `markRedeemReady` and `redeem`, the ready shares are still in `totalSupply` and their USDC is still in `totalAssets`, but their payout is frozen. If NAV moves in that window, the live price seen by new depositors is a blend of a frozen claim and a moving one, so it is slightly wrong (after a drop, depositors overpay; after a rise, they underpay). A cleaner pattern is to burn or exclude ready shares and their reserved assets from price math at the moment the payout is fixed. **Relevant to us** only if we add any async redeem; our synchronous design avoids it.
- **Inferred:** `markRedeemReady` has no price-sanity check and the keeper chooses its timing, giving the keeper a timing option over each redeemer's price. Our synchronous USDC withdrawal priced in the user's own transaction avoids this.

### 4.3 Virtual offset and rounding (Verified)

- `VIRTUAL_SHARES = 1e6`, `VIRTUAL_ASSETS = 1e6` (lines 76-77) for a 6-decimal share and asset, i.e. one virtual USDC backing one virtual share at price 1.0.
- `convertToShares`: `assets * (supply + 1e6) / (totalAssets + 1e6)`, **Floor** (line 336). `convertToAssets`: `shares * (totalAssets + 1e6) / (supply + 1e6)`, **Floor** (line 341). Same formula in `DepositLogic.executeDeposit` (lines 57-61) and in batch mark-ready (`RedeemLogic` 219-221). Both directions round against the user. Zero-share deposits revert (`DepositLogic` line 64).
- Cost-basis movements use **Ceil** in the user's favor on purpose, to avoid over-charging fees on dust: `NavLib.migrateCostBasisOnTransfer` line 196, partial consume principal `RedeemLogic` line 295. Reserved-asset partial release uses Floor (line 294).
- Portability: **Portable**. **Confirms** our "virtual shares and rounding in the vault's favor". Note the subtlety they got right: rounding for fee *basis* should favor the user, otherwise rounding turns into a fee overcharge.
- **Inferred:** 1e6/1e6 is a weak offset (like OpenZeppelin `_decimalsOffset = 0`). It makes a first-depositor donation attack unprofitable but not free for victims. We could use a larger virtual share count (for example 10^3 to 10^6 extra share decimals) at negligible cost.

### 4.4 Deposit gating on price divergence (Verified, `NavLib.checkPriceSanity` lines 363-392, called from `deposit` line 381 and `depositToHyperCore` line 432)

- Reverts `PriceManipulationSuspected` if perp oracle or mark is 0, or `|mark - oracle| / oracle > 5%` (`MAX_PRICE_DIVERGENCE_BPS = 500`, line 69).
- Also for the primary spot and every tracked spot with a configured `spotPerpRef`: `|spotPx - perpOracle| / perpOracle > 5%` reverts. Missing spot or ref price silently skips the check (lines 405-409).
- Applied to **deposits only**, not to redeem pricing (`markRedeemReady` has no check). **Verified.**
- Portability: the specific prices are **Chain-specific**, the idea "compare the price we value with against an independent reference and refuse buys when they disagree" is **Adaptable** and matches our "oracle deviation checks". For us the two sources could be a push oracle (Chainlink, Pyth, Redstone) vs a Uniswap v3 TWAP on Monad. **Confirms** our design; **Improves** it by suggesting the same check guards the vault's valuation for deposits, not only Executor trades.

### 4.5 Accrued fees excluded from NAV (Verified, lines 271-282, and `claimFees` lines 895-908)

Fees charged on a redeem stay in the vault as `accruedFees` until the admin calls `claimFees`, and are subtracted from `totalAssets` meanwhile (audit 3rd-round Finding #4 per comment). `claimFees` only pays from free balance (`evmBalance - reservedEvmBalance`). **Portable. Improves** our design: whenever we add fees, any fee liability must come out of NAV the instant it is recognized. The BoringVault Accountant, by contrast, leaves this to the offchain bot (2.5).

### 4.6 Performance fee: per-user cost basis (Verified)

- Default 10% (`initialize` line 238), max 30% (`MAX_PERFORMANCE_FEE_BPS = 3000`, line 50). Rate changes are proposed and activate only after a 24 h timelock, and activation is permissionless (`setConfig` lines 807-815, `applyPendingPerformanceFee` 838-848).
- `userDeposits[user]` = USDC principal (cost basis). Increased on deposit (`DepositLogic` line 67). On share transfer, basis moves pro rata with Ceil (`UsdcVault._update` lines 256-261, `NavLib.migrateCostBasisOnTransfer`).
- `requestRedeem`: `principalSnapshot = userDeposits * shares / balance` (Floor), moved to `lockedPrincipal`.
- `markRedeemReady` freezes the payout (`reserved`) and the fee rate (`RedeemQueueLib.markReady` sets `feeBpsSnapshot`, lines 105-117) at the moment the user can no longer cancel.
- `redeem`: per request, `fee = max(0, released - principal) * feeBpsSnapshot / 10000` (`RedeemLogic` lines 303-309). Not averaged across requests. Payout `= released - fee`; fee added to `accruedFees`.
- `emergencyRedeem` (admin) caps payout at principal, i.e. waives upside rather than charging fee (lines 370-376).
- `realizedPnL[user]` is tracked and emitted but **never used in the fee formula**. So there is **no loss carry-forward**: a user who exits at a loss, re-deposits, and recovers pays fee on the recovery. **Verified** (fee formula) / **Inferred** (consequence).
- Stale natspec: lines 884-887 say the fee uses "the live performanceFeeBps (not a snapshot at markRedeemReady)", but the code uses the snapshot. **Verified** mismatch; code is authoritative.
- This is a per-user "above your own cost" fee, which is a per-user high-water mark with the mark set at entry and never raised by unrealized peaks. **Inferred.** Our understanding of Hyperliquid vaults (leader takes 10% of each depositor's profit, settled when the depositor withdraws) matches this per-user model. **Inferred** (external product knowledge, not in either repo).

---

## 5. Per-user vs global high-water mark (for the future 10% fee)

| Aspect | Global HWM (BoringVault Accountant) | Per-user cost basis (hypurrquant) |
|---|---|---|
| Where | `_calculateFeesOwed`, `highwaterMark` field | `userDeposits`, `principalSnapshot`, `RedeemLogic.executeRedeemByShares` |
| When charged | Every rate update above HWM, on all shares | Only when a user redeems, only on that user's gain |
| Fairness | Unfair across cohorts: a newcomer who enters during a drawdown gets the recovery up to the HWM fee-free, while a holder who entered below the HWM and profits after it is passed pays the same rate as everyone. `resetHighwaterMark` lets the owner lower the HWM after a drawdown, so holders who entered at the top then pay fees on gains that only restore their principal. | Fair per depositor. Matches Hyperliquid. No loss carry-forward across exits. |
| State cost | 1 slot | 1 to 2 mappings; basis must follow share transfers |
| Needs a price at exit? | No. Fees are crystallized at checkpoints; exit just burns shares. | **Yes.** Profit = payout value - basis, so the exit must be valued. |
| Fit with `redeemInKind` | Compatible: in-kind exit burns shares, fee was already taken at checkpoints (or is taken as minted fee shares). | **Conflicts** if computed at in-kind exit with a live oracle, because in-kind exit must not need an oracle. |

Recommendation (Inferred, design proposal for later phase):
- Track per-user basis in **share-price terms** (weighted average entry share price, or equivalently a per-user HWM price), not in USDC. Charge the fee **in shares** at exit: `feeShares = shares * max(0, P - P_entry) / P * 10%`, where `P` is the share price.
- For USDC withdrawals, `P` is the live oracle price already computed in that transaction.
- For `redeemInKind`, use the **last stored reference price** (section 6), never a live oracle call. It is a storage read, so it cannot fail or be paused. If no valid reference exists, charge on the stored value anyway (never block). Accept small leakage when the reference lags.
- Fee shares go to the leader (which also helps the "leader keeps at least 5%" rule). Mint them at exit time so NAV is unchanged and no fee liability sits in NAV. If fees are ever held as assets, exclude them from NAV (hypurrquant 4.5).
- Freeze the fee rate per position the way hypurrquant does, and put fee increases behind a timelock longer than the maximum lockup (our existing timelock rule already implies this).
- Decide explicitly whether to add loss carry-forward (hypurrquant has none).

---

## 6. Comparison with our design and the valuation decision

### 6.1 Mechanism table

| Mechanism | Source | Status | Portability | vs our decisions |
|---|---|---|---|---|
| Trusted pushed exchange rate | BV `AccountantWithRateProviders.updateExchangeRate` | Verified | Portable (license: pattern only) | **Conflicts** with "managers steer but never take" if the pusher is the manager; we reject it as the primary price. |
| Per-update rate bounds + min delay | BV `_beforeUpdateExchangeRate` | Verified | Portable | **Improves**: adopt as a time-scaled circuit breaker on buys and USDC exits only. |
| Violation stores rate and pauses everything | BV `updateExchangeRate`, `postLoss` | Verified | Portable | **Conflicts** with offline exit. We must reject the specific operation, not freeze exits. |
| Pause blocks all exits | BV Teller `_withdraw` via `getRateInQuoteSafe`, `BoringVault.exit` requiresAuth | Verified | n/a | **Conflicts** with non-negotiable `redeemInKind`. |
| Platform fee on min(shares), min(rate) | BV `_calculatePlatformFee` | Verified | Portable | **Missing** from ours (fees deferred). Good pattern if we ever add a management fee. |
| Global HWM perf fee, resettable | BV `_calculateFeesOwed`, `resetHighwaterMark` | Verified | Portable | Weaker than per-user for Hyperliquid parity; reset is manager-favorable. Do not adopt reset. |
| Fee liability not netted onchain | BV `feesOwedInBase` | Verified / Inferred risk | n/a | Avoid. |
| Rate providers per asset, pegged flag | BV `getRateInQuote`, `rateProviderData` | Verified | Portable | **Confirms** per-asset oracle adapters; our NAV needs this for WMON. |
| Staleness-checked generic provider | BV `GenericRateProviderWithStalenessCheck` | Verified | Portable | **Confirms** freshness checks; lacks deviation checks we need. |
| Yield streaming (vest gains, instant losses, TWAS cap) | BV `AccountantWithYieldStreaming` | Verified | Adaptable | Idea useful for reported yield; not needed for price-based NAV. Principle "losses instantly, gains cautiously" **Improves** breaker design (asymmetric). |
| Deposit premium / queue discount | BV Teller `sharePremium` (max 10%), Queue `maxDiscount` (max 30%) | Verified | Portable | **Confirms** our buy/sell spread. |
| Share lock after deposit | BV Teller `shareLockPeriod` (max 3 days) | Verified | Portable | **Confirms** our lockup as anti-arbitrage. |
| Live NAV from chain state | HQ `totalAssets`, `NavLib.coreNAV` | Verified | Chain-specific reads, Adaptable idea | **Confirms** our oracle-based valuation. |
| Failed read counts as zero | HQ `NavLib` safe reads | Verified | n/a | Anti-pattern for priced paths; our "revert on oracle failure" **Confirms** the better choice. |
| 5% oracle/mark divergence gate on deposits | HQ `NavLib.checkPriceSanity` | Verified | Adaptable | **Confirms** deviation checks; **Improves** by applying to vault deposits too. |
| Accrued fees excluded from NAV | HQ `totalAssets` | Verified | Portable | **Improves** (for later fee phase). |
| Virtual offset 1e6/1e6, floor both ways | HQ `convertToShares/Assets` | Verified | Portable | **Confirms**; consider a larger offset. |
| User-favorable Ceil on fee basis | HQ `migrateCostBasisOnTransfer`, partial principal | Verified | Portable | **Improves**: rounding rule refinement. |
| Per-user cost basis fee, fee rate frozen, 24 h fee timelock | HQ `RedeemLogic`, `RedeemQueueLib.markReady`, `setConfig` | Verified | Portable | **Improves**; basis in share-price terms needed for in-kind compatibility. |
| Reserved balance for ready redeems | HQ `reservedEvmBalance` | Verified | Adaptable | Only relevant if we add async redeems; note the frozen-claim pricing wrinkle. |
| Inflight bridge buffer | HQ `_inflightBuffer` | Verified | Chain-specific | Not applicable on Monad. |
| No in-kind exit | both repos | Verified | n/a | **Conflicts**; our `redeemInKind` is strictly stronger for users. |

### 6.2 Should we publish a bounded exchange rate instead of live oracle valuation?

Tradeoffs:

| Criterion | Pushed bounded rate (Accountant) | Live oracle NAV once per tx (ours) |
|---|---|---|
| Manipulation of the price input | Resistant to DEX/oracle manipulation in the moment (rate is not read from markets). Vulnerable to the pusher. | Exposed to oracle manipulation and staleness; mitigated by freshness, two-source deviation, spread, lockup. |
| Donation / balance games | Immune (price ignores balances). | Exposed; mitigated by virtual shares and counting only allowlisted assets. |
| Trust | The pusher can move value between entering and exiting users within the bound every 6 h, and earn performance fee on an inflated rate. Needs a trusted, independent bot. | No party sets the price. Trust is in oracles, which we already need for the Executor. |
| Fit with an AI-agent manager | The agent's owner is the manager and is paid by the price (fee, own 5% stake). Letting them push the rate is a conflict of interest. A platform bot could push instead, but that makes the platform a price-setter for every vault and a single point of failure. | Neutral. |
| Liveness | Needs a bot every period; any true move above the bound pauses the accountant until a human unpauses. | Live whenever oracles are fresh. Oracle outage blocks buys and USDC exits (by design) but not in-kind exit. |
| Accuracy for a trading vault | Poor: price moves in 0.2% steps at most every 6 h. MON can move 10% in an hour; the rate would be wrong most of the time, rewarding whoever enters or exits against the stale rate. | Accurate to oracle precision at each transaction. |
| Offline exit | Pause blocks every exit (in BoringVault). Could be separated, but the rate is irrelevant to in-kind anyway. | In-kind exit never touches price. |

Conclusion: **keep live oracle valuation.** A bounded published rate suits yield vaults with slow, reportable returns (Veda's use case); it is a poor fit for an actively traded two-asset vault run by a party who benefits from the price. Answer to "can the agent's owner be trusted to push a rate?": **no**, it breaks "managers steer but never take". Answer for a platform bot: possible, but it adds a new trusted role and still gives stale prices, so it is worse than oracles for our case.

### 6.3 Recommended hybrid: oracle NAV plus an Accountant-style circuit breaker

Proposal (Inferred design, built only from patterns above):

1. **Valuation (unchanged):** compute NAV once per transaction from `balanceOf` of each allowlisted asset times a fresh oracle price, with a second-source deviation check (HQ 4.4 idea, BV freshness idea). Revert on any failure (never count as zero).
2. **Reference price:** store `refPrice` (share price) and `refTime`. After each successful deposit or USDC withdrawal, and via a permissionless `poke()`, move `refPrice` toward the live share price, but by at most `maxMoveBps * elapsed / window` (time-scaled, unlike BV's per-update bound which traps large true moves until an admin unpauses).
3. **Breaker:** a deposit or USDC withdrawal **reverts** (not pauses) if `|live - refPrice| / refPrice > band`. No stored pause flag, so there is nothing to unpause and no admin in the loop; once the reference catches up, operations resume on their own.
4. **Asymmetric pricing inside the band** (optional, borrowed from "losses instantly, gains cautiously"): price deposits at `max(live, refPrice)` and USDC withdrawals at `min(live, refPrice)`, on top of the buy/sell spread. Someone who pushes the oracle down to buy cheap, or up to sell dear, then gets the worse of the two prices. Cost: honest users pay a little extra during real fast moves.
5. **Scope:** the breaker applies to deposits and USDC withdrawals (and to the proportional sell path used when USDC is below 10%). **`redeemInKind` never reads `refPrice`, the oracle, or the breaker.** It only uses balances and share math. This is required by the non-negotiable rule.
6. **Spread sizing (Inferred):** push oracles update on a deviation threshold (for example 0.5%) or heartbeat, so the price can be stale by up to that threshold. Someone who knows an update is coming can trade against the stale price. The buy/sell spread should be at least roughly the oracle deviation threshold, and the 1-day lockup stops same-block round trips (like BV `shareLockPeriod`).
7. **Fees later:** per-user entry price, fee paid in shares at exit, using the live price for USDC exits and the stored `refPrice` for in-kind exits (section 5).

Why not copy BV's "store and pause": for us, a stuck pause would stop all buys and USDC exits until a human acts, and pushing everyone into in-kind exits during a real crash. Rejecting only the specific call while the reference catches up gives the same protection without an admin key.

---

## 7. Open questions

1. Who holds `UPDATE_EXCHANGE_RATE_ROLE`, `PAUSER_ROLE`, and the Pauser unpause roles for Monad vmUSD? Not in the repo; needs onchain `RolesAuthority` event scan.
2. vmUSD config says `platformFee: 50` but onchain `platformFee = 0`. Changed after deploy, or never set? (Onchain read is Verified; the reason is not.)
3. Does Veda's rate bot subtract `feesOwedInBase` before posting the rate? The contract does not enforce it; no offchain code is in the repo.
4. In BoringOnChainQueue, does solving an existing request still work while the accountant is paused (amount fixed at request time)? Sub-agent D's area; affects whether any exit survives a BV pause.
5. What oracles exist on Monad for WMON/USD with what heartbeat and deviation thresholds (Chainlink, Pyth, Redstone, Chronicle)? This sets our spread and breaker band.
6. What band and catch-up speed should the breaker use? Needs historical MON volatility (for example 1-hour and 1-day moves) to avoid blocking honest users too often.
7. Per-user fee: add loss carry-forward (hypurrquant does not)? How exactly does Hyperliquid compute the leader's 10% (per withdrawal, per depositor all-time PnL, or with carry-forward)? Not answerable from these repos.
8. Should in-kind exits pay the performance fee at the stored reference price, or be fee-free? Fee-free creates an incentive to exit in kind to avoid fees; charging at a stored price keeps it oracle-free.
9. Virtual offset size: 1e6/1e6 (hypurrquant) vs a larger share offset. Needs a quick donation-attack cost estimate for our decimals (USDC 6, WMON 18).
10. Neither repo has tests we could run (Foundry not installed), so fee formulas above are from reading code and one BV test file, not execution.
