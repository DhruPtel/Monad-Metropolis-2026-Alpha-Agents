# B. Accounting and share price (Morpho Vault V2)

Sub-agent B. Repo `/home/dhrupatel/agent_tool/vaults` at commit `9ee4dbdc`. All paths are relative to the repo root.
Line numbers refer to that commit. Foundry is not installed, so tests are described, not run.

Labels: **Verified** = read in code at the cited location. **Inferred** = my reasoning or general knowledge, not directly stated in code.

---

## 1. Summary (short)

- Vault V2 keeps a stored `_totalAssets` and recomputes "real" assets lazily: idle base-asset balance plus the sum of each adapter's self-reported `realAssets()`. Gains are recognized only up to a per-second cap (`maxRate`), losses are recognized fully and immediately. Accrual happens at most once per transaction (`firstTotalAssets`, a transient variable). **Verified.**
- Share price uses 1 virtual asset and `virtualShares = 10^max(0, 18 - decimals)`. Every conversion rounds in favor of the vault. Donations cannot move the price in the same block and cannot move it at all when `_totalAssets == 0`. **Verified.**
- Fees: performance fee (max 50%) on "distributed interest" per accrual, management fee (max 5%/yr) on total assets per second, both minted as new shares. **No high-water mark**: the reference point is the previous `_totalAssets`, which drops with losses, so recovery of a loss is charged performance fee again. **Verified.**
- For our multi-token spot vault, the accounting skeleton (virtual shares, rounding, once-per-tx accrual, fee share minting) transfers directly. The valuation model does not: Morpho trusts adapters to report monotonic-ish lending balances and smooths only upside; we need oracle prices that move both ways fast, and we must not let an oracle failure block withdrawals.

---

## 2. How total assets are computed

### 2.1 State

`src/VaultV2.sol` lines 224-227 (**Verified**):

```solidity
uint256 public transient firstTotalAssets;
uint128 public _totalAssets;
uint64 public lastUpdate;
uint64 public maxRate;
```

- `_totalAssets`: last recorded total assets (header comment line 26). Changed by accrual (line 656), deposit/mint (`enter`, line 788: `_totalAssets += assets`), withdraw/redeem (`exit`, line 826: `_totalAssets -= assets`). **Verified.**
- `lastUpdate`: timestamp of last accrual (line 661), initialized in the constructor (line 304). **Verified.**
- `maxRate`: per-second cap on growth, WAD units, default 0. **Verified** (no initializer; storage default).
- `firstTotalAssets`: transient (EIP-1153), reset to 0 at the end of every transaction. **Verified** (keyword `transient`, line 224).

### 2.2 `accrueInterestView()` (lines 670-699), the core

```solidity
if (firstTotalAssets != 0) return (_totalAssets, 0, 0);          // 671: already accrued this tx
uint256 elapsed = block.timestamp - lastUpdate;                 // 672
uint256 realAssets = IERC20(asset).balanceOf(address(this));    // 673: idle base asset
for (uint256 i = 0; i < adapters.length; i++) {
    realAssets += IAdapter(adapters[i]).realAssets();           // 674-676: adapter self-reports
}
uint256 maxTotalAssets = _totalAssets + (_totalAssets * elapsed).mulDivDown(maxRate, WAD); // 677
uint256 newTotalAssets = MathLib.min(realAssets, maxTotalAssets);                          // 678
uint256 interest = newTotalAssets.zeroFloorSub(_totalAssets);                              // 679
```

**Verified.** Consequences:

1. **Real assets** = idle balance of the single base `asset` + sum over all registered adapters of `realAssets()`. Nothing else is valued. There is no oracle anywhere in the vault; each adapter is trusted to report its position in units of the base asset (header lines 23-25). **Verified.**
2. **Gains** are recognized as `min(realAssets, _totalAssets * (1 + maxRate * elapsed))`. Simple (not compounded) growth since last accrual, so frequent accrual compounds slightly. **Verified** (formula), compounding remark **Inferred**.
3. **Losses**: if `realAssets < _totalAssets`, `newTotalAssets = realAssets` and the full loss hits the share price at once. There is no separate `realizeLoss` function in this version; loss realization is just the `min` in accrual (header lines 30-33). **Verified.**
4. `totalAssets()` (lines 260-263) returns `newTotalAssets` from `accrueInterestView()`, so the public view is always "what accrual would produce now", even though storage is lazy. `AccrueInterestTest.testTotalAssets` checks `totalAssets()` equals `_totalAssets` after `accrueInterest()`. **Verified.**
5. `accrueInterest()` (lines 653-662) writes `_totalAssets`, sets `firstTotalAssets` if it is 0, mints fee shares, updates `lastUpdate`, emits `AccrueInterest(old, new, perfShares, mgmtShares)`. **Verified.**

### 2.3 How the vault values assets in adapters

| Adapter | `realAssets()` | Notes |
|---|---|---|
| `MorphoMarketV1AdapterV2` (`src/adapters/MorphoMarketV1AdapterV2.sol` 276-283) | sum over `marketIds` of `expectedSupplyAssets(id)` (251-260): supply shares converted with `toAssetsDown` using `AdaptiveCurveIrmLib.expectedMarketBalances`, i.e. includes interest accrued up to now without touching Morpho | Rounds down. Reverts if the IRM lib reverts, which would block accrual (header 20-21). `burnShares` (162-167, timelocked) is the manual loss-realization tool; comment line 37 warns reactive depositors may exit first. |
| `MorphoVaultV1Adapter` (`src/adapters/MorphoVaultV1Adapter.sol` 111-116) | `allocation() != 0 ? previewRedeem(balanceOf(this)) : 0` | Uses the underlying ERC4626's own `previewRedeem`. Returns 0 when the vault's recorded allocation is 0, which makes share donations to the adapter invisible (see 3.3). |

**Verified.** The vault trusts adapters completely: "Adapters are responsible for reporting to the vault how much their investments are worth at any time" (header line 23). `test/mocks/AdapterMock.sol` 69-71 models this as `deposit + interest - loss`. **Verified.**

Per-market `allocation` in caps is not the same as `realAssets`: it is only updated on allocate/deallocate (header lines 51-52, `allocateInternal` 582-603, `deallocateInternal` 610-630). `RealizeLossTest.testAllocationLoss*` shows allocation catching up to a loss only when (de)allocate is called. **Verified.**

### 2.4 When gains and losses are recognized: once per transaction

- Every state-changing entry point that depends on price calls `accrueInterest()` first: `deposit` 767, `mint` 775, `withdraw` 796, `redeem` 804, `allocateInternal` 585, `setMaxRate` 644, the four fee setters (489, 501, 512, 522); `forceDeallocate` reaches it through `withdraw` (849). `test/AccruingFunctionsTest.sol` asserts the `AccrueInterest` event for each of these. **Verified.**
- After the first accrual in a transaction, `firstTotalAssets != 0` and `accrueInterestView` short-circuits to `(_totalAssets, 0, 0)` (line 671). So the price is frozen for the rest of the transaction except for the explicit `+=`/`-=` in enter/exit. **Verified.**
- Purpose (header 32-33, 38, 62-66): flash-loan based shorting and flash-loan cap bypass are prevented because "interests and losses are only accounted once per transaction". `RealizeLossTest.testTouchThenLoss` (touch, then loss, then `totalAssets()` in one tx) shows the loss is not seen; `testLossThenTouch` shows it is. `AccrueInterestTest.testFirstTotalAssets` shows the value is not updated by a second deposit or a withdraw in the same tx. **Verified.**
- Edge case: when total assets are 0, `firstTotalAssets` stays 0 so accrual can re-run in the same tx (header 67-68). With `elapsed = 0` a re-run can only lower total assets, never raise them. **Verified** (header), reasoning on re-run **Inferred**.
- Deallocate does not call `accrueInterest` (610-630) but `forceDeallocate` does via `withdraw`. **Verified.**

---

## 3. Share price protection

### 3.1 Virtual shares and decimal offset, exact code

Constructor (lines 300-311, **Verified**):

```solidity
uint256 assetDecimals = IERC20(_asset).decimals();
uint256 decimalOffset = uint256(18).zeroFloorSub(assetDecimals);   // max(0, 18 - d)
decimals = uint8(assetDecimals + decimalOffset);                    // share decimals = max(18, d)
virtualShares = 10 ** decimalOffset;
```

Conversions (lines 702-727, **Verified**), with `S = totalSupply + feeShares`, `A = newTotalAssets`, `V = virtualShares`:

| Function | Formula | Rounding | Favors |
|---|---|---|---|
| `previewDeposit(assets)` → shares | `assets * (S + V) / (A + 1)` | down | vault |
| `previewMint(shares)` → assets | `shares * (A + 1) / (S + V)` | up | vault |
| `previewWithdraw(assets)` → shares | `assets * (S + V) / (A + 1)` | up | vault |
| `previewRedeem(shares)` → assets | `shares * (A + 1) / (S + V)` | down | vault |
| `convertToShares` / `convertToAssets` (731-739) | = `previewDeposit` / `previewRedeem` | down | vault |

`MathLib.mulDivDown` (line 9) is `(x*y)/d`; `mulDivUp` (line 14) is `(x*y + d - 1)/d`. No 512-bit intermediate, hence the liveness requirement that totals stay below ~1e35 (header line 127). **Verified.**

So the vault behaves as if it always holds 1 extra wei of asset and `V` extra shares. For USDC (6 decimals): `V = 1e12`, share decimals = 18, an empty vault mints `1e12` shares per 1 USDC-wei (1 USDC = 1e18 shares). For WETH-based (18 decimals): `V = 1`. **Verified** (`ExchangeRateTest.testVirtualShares`, `testDecimals`).

Formal checks: `certora/specs/ExchangeRate.spec` rules `optimalRoundingOn{Deposit,Withdraw,Mint,Redeem}` prove rounding is tight (one unit less favorable would lower share price), `sharePriceIsIncreasing` proves no function lowers `(_totalAssets+1)/(totalSupply+V)` except management fees and loss realization (under stated assumptions); `RoundTrip.spec` proves no deposit/redeem, mint/withdraw etc. round trip gains; `PreviewFunctions.spec` proves `preview*` equals the actual result. `Invariants.spec` line 93: `0 < virtualShares <= 10^18`. **Verified** (spec text; not run).

### 3.2 First-depositor inflation attack

Classic attack: attacker deposits dust, donates a large amount to inflate price, victim's deposit rounds to 0 shares. Vault V2 has three layers:

1. **Virtual asset/shares** (above): standard OpenZeppelin mitigation. Header lines 40-42 still say the vault "might need to be seeded". **Verified.**
2. **Donations are not recognized in the same block**: `elapsed = 0` → `maxTotalAssets = _totalAssets` (line 677). `AccrueInterestTest.testAccrueInterestDonationNoSkip` asserts `totalAssets()` is unchanged after a donation with no time skip. **Verified.**
3. **Donations to an empty vault are never recognized**: if `_totalAssets == 0`, `maxTotalAssets = 0` for any `elapsed`. **Verified** (line 677). With a 1-wei seed and `maxRate = MAX_MAX_RATE` (about 6.34e10 per second, `ConstantsLib.sol` line 9), `(1 * elapsed * 6.34e10) / 1e18` stays 0 for about 183 days. **Inferred** (arithmetic).

Residual risk named by Morpho: adapter rounding dust losses can deflate price in a nearly empty vault (header 43-46), hence "seed with a sufficient amount". **Verified.**

### 3.3 Donations

- Base-asset donations to the vault count in `realAssets` (line 673) but only up to `maxRate` (header line 39). `testAccrueInterestDonationSkip` asserts `totalAssets == min(deposit + donation, deposit * (1 + MAX_MAX_RATE * elapsed))`. **Verified.**
- Donations of MetaMorpho shares to the adapter while allocation is 0 are ignored (`MorphoVaultV1Adapter.realAssets` returns 0). `test/integration/MorphoVaultV1IntegrationDonationTest.sol` `testSharesDonationResistanceIfNoAllocation`. **Verified.**
- `MorphoMarketV1AdapterV2` tracks its own `supplyShares`, so shares donated on Morpho are "lost forever" (line 30). **Verified.**
- Morpho acknowledges donations and forceDeallocate penalties raise the rate and attract opportunistic depositors who dilute interest; mitigation is lowering `maxRate` (header 47-48). **Verified.**

---

## 4. Smoothing / rate limit: `maxRate`

- Set by an **allocator**, not timelocked: `setMaxRate` (640-650) requires `isAllocator[msg.sender]` and `newMaxRate <= MAX_MAX_RATE` (200% APR per second, `ConstantsLib.sol` line 9), accrues first. **Verified.**
- Default is 0, which means a freshly created vault recognizes **no gains at all** until an allocator sets it. **Verified** (default storage + line 677). Integration tests set it explicitly (e.g. `AccrueInterestTest.setUp`). **Verified.**
- What happens to excess gains: they are **not lost and not paid to anyone immediately**. They stay in `realAssets` as an unrecognized buffer. Each later accrual can recognize up to `_totalAssets * maxRate * elapsed` more. Verified in `test/integration/MorphoVaultV1IntegrationInterestTest.sol` `testAccrueInterest`: `expected = min(expectedSupplyAssets, assets + assets*elapsed*MAX_MAX_RATE)`. **Verified.**
- Side effects of the buffer (**Inferred**):
  - Exiting holders do not get their share of the buffer; entering holders buy at a discount and receive part of it later. This is exactly the "opportunistic depositor" dilution Morpho warns about.
  - The buffer absorbs later losses silently: if `realAssets` falls but stays above `_totalAssets`, no loss is recognized.
  - Performance fee is charged only on the distributed part (comment lines 667-668), so the manager's fee is also smoothed.
- There is **no smoothing of losses**. Asymmetric by design. **Verified.**

---

## 5. Fees

### 5.1 Storage, caps, recipients, governance

- `performanceFee`, `performanceFeeRecipient`, `managementFee`, `managementFeeRecipient` (lines 249-252). WAD units; management fee is per second. **Verified.**
- Caps (`ConstantsLib.sol`): `MAX_PERFORMANCE_FEE = 0.5e18` (50%), `MAX_MANAGEMENT_FEE = 0.05e18 / 365 days` (5%/yr). **Verified.**
- Setters (484-526) are all `timelocked()` (curator submits, anyone executes after the timelock), enforce `fee != 0 => recipient != 0`, and **accrue before changing** so a new fee is never applied retroactively. **Verified.** Invariants `performanceFeeRecipientSetWhenPerformanceFeeIsSet`, `performanceFeeBound`, `managementFeeBound` (`Invariants.spec` 39-48). **Verified** (spec text).
- One recipient per fee type, arbitrary address. **Verified.**

### 5.2 Calculation (lines 681-696, **Verified**)

```solidity
performanceFeeAssets = interest > 0 && performanceFee > 0 && canReceiveShares(performanceFeeRecipient)
    ? interest.mulDivDown(performanceFee, WAD) : 0;
managementFeeAssets = elapsed > 0 && managementFee > 0 && canReceiveShares(managementFeeRecipient)
    ? (newTotalAssets * elapsed).mulDivDown(managementFee, WAD) : 0;
newTotalAssetsWithoutFees = newTotalAssets - performanceFeeAssets - managementFeeAssets;
performanceFeeShares = performanceFeeAssets.mulDivDown(totalSupply + virtualShares, newTotalAssetsWithoutFees + 1);
managementFeeShares  = managementFeeAssets.mulDivDown(totalSupply + virtualShares, newTotalAssetsWithoutFees + 1);
```

- **Minting**: fees are paid by minting shares (`createShares`, line 658-659 → 913-918), not by moving assets. The divisor is total assets minus both fees, so after minting both, each recipient's shares are worth about its fee assets (dilution method). `AccrueInterestTest.testAccrueInterestFees` checks `previewRedeem(recipientBalance) ≈ feeAssets` within 100 wei. **Verified.**
- `totalSupply` storage is stale between accruals (header line 20); previews add pending fee shares (e.g. line 704). **Verified.**
- Management fee is on total assets, not on interest, so it can lower the share price and is charged even during losses (comments 665-666). **Verified.**
- If the recipient fails the receive-shares gate, that period's fee is **skipped, not deferred** (conditions at 682, 687, while `lastUpdate` still advances at 661). **Verified** (code), "skipped forever" **Inferred** from `lastUpdate` advancing.
- Fees round down (comment 667). **Verified.**

### 5.3 High-water mark: there is none

The performance fee base is `interest = newTotalAssets - _totalAssets` (floored at 0) per accrual. After a loss, `_totalAssets` is written down (line 656), so the next recovery is charged as new "interest". **Verified** (code), consequence **Inferred**.

What plays the HWM-like role (**Inferred**):
- `_totalAssets` is a flow-adjusted watermark: deposits and withdrawals move it 1:1 (788, 826), so flows are never charged. But it is a *last-value* mark, not a *peak* mark.
- `maxRate` limits how fast fees can be crystallized (fee only on distributed interest).
- For lending, losses are rare (bad debt), so Morpho accepts this. For a volatile trading vault it would charge fees on round-trips (price down 10%, back up 10% → fee on the recovery), which is not acceptable for us.

Morpho also has an audited "FeeWrapper" configuration (`audits/2025-12-04-fee-wrapper-spearbit.pdf`): a parent VaultV2 with a single `MorphoVaultV1Adapter` pointing at a child vault, so fees are taken at the parent layer. **Verified** (audit scope page); details **Inferred**.

---

## 6. Our vault: multi-token spot, oracle-valued

### 6.1 What `totalAssets` would need to be

Base asset USDC (6 decimals). Proposed (**Inferred**, design):

```
NAV = USDC.balanceOf(vault)
    + sum over token t in {WMON, WETH, LST}: balanceOf_t(vault) * price_t(USDC per t) / 10^(dec_t)
```

- Valued from **external oracle feeds**, not pool spot price. Balances are read live (like line 673).
- Two ways to fit Morpho's shape (**Inferred**):
  - (a) Monolithic: vault holds all tokens directly, NAV function loops over a fixed token list. Simplest, matches "Executor moves assets only inside the vault".
  - (b) Morpho-style adapters: one "spot holding adapter" per token whose `realAssets()` returns oracle value, and `allocate` / `deallocate` = swap USDC to token and back. Then `forceDeallocate` becomes a permissionless swap-out, which is dangerous because the caller controls `data` (route, min-out) unless the adapter prices it against the oracle. Also Morpho's allocation tracking is in base units and only updated on (de)allocate, so percentage caps drift with price. I would not reuse the adapter abstraction for spot tokens at launch.
- Oracle availability (Chainlink, Pyth, Redstone, Chronicle on Monad) and exact feeds for WMON and the LST are open questions.

### 6.2 New risks versus Morpho

| Risk | Why it is new | Severity (Inferred) |
|---|---|---|
| **Stale price arbitrage** | Push oracles update on deviation threshold + heartbeat. When the market has moved but the feed has not, a user can deposit cheaply when the feed lags below market, or withdraw at an inflated NAV when it lags above market. Max extraction per round ≈ (deviation threshold) × (non-USDC fraction, up to 90% under our limits). | High, recurring |
| **Known price update front-running** | Pull oracles (Pyth-style) let the user choose which signed price to push, within the staleness window, and push it in the same tx as their deposit. Also: any visible pending update is a free option. | High if pull oracle used naively |
| **Oracle manipulation** | If NAV uses pool spot or short TWAP, an attacker (or the manager via the Executor) can move the pool, then deposit/withdraw or crystallize fees. Monad pools for WMON/LST may be thin. | High for spot, lower for Chainlink-style |
| **Manager self-dealing via NAV** | Manager can pump an illiquid pool to inflate NAV and mint performance fee, or time deposits of the leader stake. | Medium |
| **Sandwiching the Executor's own trades** | MEV bots sandwich Uniswap swaps up to the 0.5% slippage bound: max loss ≈ 0.5% × 10% of NAV per trade. Depositing before a trade and withdrawing after gains little because a swap at fair price leaves NAV unchanged (minus slippage). | Low-medium |
| **Two-way volatility** | Morpho's model assumes slow, mostly-up growth. Spot prices move ±10% in a day. `maxRate` smoothing on upside would create a large unrecognized buffer and a systematic free option for new depositors. | High if maxRate copied |
| **Oracle failure bricks withdrawals** | Morpho requires "Adapters should not revert on realAssets" (header line 124) because accrual runs in every withdraw. If our NAV reverts on a stale feed, withdrawals stop, violating our non-negotiable rule. | Critical to design around |
| **LST pricing** | Exchange-rate oracles can diverge from market price during depegs; using the exchange rate lets exiters take more than market value. | Medium |
| **Rounding with multiple decimals** | 18-decimal tokens × prices into 6-decimal USDC lose precision; must round NAV down for withdrawals and up for deposits. | Low |

### 6.3 Mitigations (Inferred, proposals)

1. **Conservative pricing per direction (bid/ask NAV).** Compute two NAVs per tx: `NAV_low` (use `min(oracle, TWAP)` per token, minus a haircut) for redeem/withdraw, and `NAV_high` (`max(oracle, TWAP)`, plus haircut) for deposit/mint. The spread stays with remaining holders. This generalizes Morpho's "round in favor of the vault" from 1 wei to an oracle-uncertainty band. Haircut per token ≈ feed deviation threshold (for example 0.5% ETH, larger for MON/LST).
2. **In-kind (pro-rata) redemption as the oracle-free exit.** `redeemInKind(shares)` pays `shares/supply` of every token balance. Needs no oracle, cannot be manipulated, cannot be bricked by a stale feed, and matches Hyperliquid's "proportional share of positions". This is our analog of Morpho's `forceDeallocate` "in-kind redemption" (lines 832-851) and is the cleanest way to satisfy "depositors can always withdraw directly". Cash (USDC) redemption can use oracle NAV and be limited to the idle USDC.
3. **Staleness and deviation guards.** Reject deposits (not withdrawals) when any feed is older than the heartbeat or deviates from the pool TWAP by more than the band (Executor already uses 5 minutes and 2%). For withdrawals, fall back to in-kind, never revert.
4. **Entry/exit fees.** Small fee (for example 0.1% to 0.3%) accruing to the vault, sized to cover oracle lag. Morpho's `forceDeallocatePenalty` (max 2%, `ConstantsLib.sol` line 12) is precedent for a penalty that stays in the vault.
5. **Asynchronous deposits (ERC-7540 style) or deposit lockup.** Strongest fix for stale-price arbitrage: request now, settle at a later oracle round the user cannot choose. Our 1-day deposit lockup (product spec) blocks round-trips but not one-way exits after a known move; async settlement covers both.
6. **Oracle choice.** Chainlink-style push feeds as primary NAV source, pool TWAP (30 min or more) only as a sanity band. Never pool spot. If a pull oracle is used, require the price timestamp to be at or after the request time (no cherry-picking).
7. **Do not copy `maxRate` for price moves.** For volatile assets it creates a buffer that new depositors capture. A maxRate-like cap is still useful for **fee crystallization** (cap how much performance fee can be minted per period) and for **rejecting absurd NAV jumps** (circuit breaker style: if NAV moves more than X% since last accrual, deposits pause).
8. **Once-per-transaction NAV.** Copy `firstTotalAssets`: compute NAV once per tx with transient storage so a flash-swap cannot change NAV mid-tx between a deposit and a withdraw. **Transfers directly.**
9. **Seed deposit plus virtual shares.** Keep `virtualShares = 1e12` for USDC and seed the vault (leader stake of 5% naturally does this). **Transfers directly.**
10. **MEV.** Tight oracle-bounded `minAmountOut`, private submission if available on Monad, the existing 10%-per-trade cap.

### 6.4 Which Morpho patterns transfer

| Pattern | Transfers? | Notes |
|---|---|---|
| Virtual shares `10^(18-d)` + 1 virtual asset | Yes, directly | Same code. |
| Rounding table (down on deposit/redeem, up on mint/withdraw) | Yes, directly | Extend with bid/ask NAV. |
| Once-per-tx accrual via transient `firstTotalAssets` | Yes, directly | Also freezes oracle NAV per tx. |
| Accrue before any fee / parameter change | Yes, directly | Prevents retroactive fees. |
| Fee share minting formula (divide by assets minus fees) | Yes | Base changes to HWM (section 7). |
| Timelocked fee changes with caps | Yes | Our caps: perf 10%, maybe 20% max. |
| Lazily computed `totalAssets()` view equal to post-accrual state | Yes | Keep previews exact (PreviewFunctions spec). |
| Donation resistance via `maxRate` and zero growth from zero | Partly | Empty-vault rule transfers; rate cap does not fit volatile prices. Donations of non-USDC tokens would raise NAV instantly under oracle pricing; count only tracked balances or accept donations as gifts. |
| Adapter self-reported `realAssets` | No | We need oracle pricing and guards; the adapter trust model does not cover price risk. |
| Losses recognized immediately, gains smoothed | No | Prices move both ways; use symmetric mark-to-market with bid/ask. |
| `forceDeallocate` in-kind exit with penalty | Concept yes | Implement as pro-rata in-kind redemption. |
| Relative caps vs `firstTotalAssets` | Partly | Our 40%/10% limits must use live oracle values in the Executor, not stale allocations. |

---

## 7. Layering a 10% performance fee above a high-water mark later

Design (**Inferred**, proposal):

- Store `hwmPricePerShare` (WAD, USDC per share, using `NAV_low` or a mid NAV, never `NAV_high`).
- At each accrual (or on a fixed crystallization schedule, e.g. weekly and on manager handover):
  ```
  price = (NAV + 1) / (supply + V)
  if price > hwm:
      gain = (price - hwm) * (supply + V)          // assets
      feeAssets = gain * 10%
      feeShares = feeAssets * (supply + V) / (NAV - feeAssets + 1)   // Morpho's formula, line 693-694
      mint feeShares to manager; hwm = post-fee price
  ```
- Accrue before any deposit/withdraw so flows never count as gains (Morpho does this at lines 767, 775, 796, 804).
- Comparison with Morpho: same minting math, different base. Morpho's base is `_totalAssets` from the last accrual (last value, resets down on loss). Ours is a peak share price that never goes down, so drawdowns must be recovered before new fees. Morpho's `maxRate` indirectly limits fee crystallization speed; we should add an explicit cap (for example, fee shares per period at most X% of supply) and crystallize on a conservative NAV and TWAP to prevent oracle-spike fee minting.
- Fairness caveat: a single global HWM lets depositors who enter during a drawdown ride the recovery fee-free, and makes depositors who enter at the peak pay nothing extra. Per-depositor HWM (equalization, or Hyperliquid-style fee on each depositor's own profit at withdrawal) is fairer but needs cost-basis tracking, which breaks if shares are transferable. Option: make shares non-transferable (Morpho gates: `sendSharesGate`/`receiveSharesGate`, lines 929-935) if we choose per-depositor fees.
- Morpho skips the fee if the recipient cannot receive shares (682). For us, the recipient should be the agent's owner at crystallization time; on NFT sale, crystallize first so the old owner receives fees earned under their management. **Inferred.**
- Management fee: not in our product spec. If added, Morpho's per-second `newTotalAssets * elapsed * rate` pattern transfers directly.

---

## 8. Tests and specs reviewed (what they show)

| File | What it checks |
|---|---|
| `test/ExchangeRateTest.sol` | After a donation made visible via `writeTotalAssets`, each of deposit/mint/withdraw/redeem matches `x * (S+V)/(A+1)` or inverse; `virtualShares` and `decimals` formulas. |
| `test/AccrueInterestTest.sol` | View equals state after accrual; exact fee share amounts; maxRate upper bound; donation not visible without time skip, capped with skip; `firstTotalAssets` set once per tx. |
| `test/AccruingFunctionsTest.sol` | allocate, forceDeallocate, deposit, mint, withdraw, redeem, all fee setters, setMaxRate emit `AccrueInterest`. |
| `test/RealizeLossTest.sol` | Loss reduces `totalAssets` immediately; loss after a touch in the same tx is not seen; allocation catches up on allocate/deallocate/forceDeallocate. |
| `test/MathTest.sol` | mulDivDown/Up, zeroFloorSub, min fuzz. |
| `test/ViewFunctionsTest.sol` | max* return 0; convert/preview formulas including pending fee shares. |
| `test/integration/MorphoVaultV1IntegrationDonationTest.sol` | Share donation to adapter with zero allocation is ignored. |
| `test/integration/MorphoVaultV1IntegrationInterestTest.sol` | Real interest from Morpho Blue recognized as `min(real, maxRate cap)`. |
| `test/integration/*BadDebtTest.sol` | Bad debt (market removal, liquidation with zero-price oracle) reduces `totalAssets` and `previewRedeem` immediately. |
| `certora/specs/ExchangeRate.spec` | Share price non-decreasing except mgmt fee and loss; optimal rounding per entry point. |
| `certora/specs/RoundTrip.spec` | No profitable round trip between preview functions. |
| `certora/specs/PreviewFunctions.spec` | Previews equal actual results and do not revert when actions succeed. |
| `certora/specs/TotalAssetsChange.spec` | Deposit/mint/withdraw/redeem/forceDeallocate change `_totalAssets` by exactly the amount (assuming no accrual); others do not change it. |

All **Verified** by reading test/spec source; none were executed.

---

## 9. Open questions

1. Which oracle providers and feeds exist on Monad (chain 143) for MON, WETH and candidate LSTs, with what heartbeat and deviation thresholds? This sets the bid/ask haircut and fee sizes.
2. Does Monad have a public mempool or private order flow, which affects sandwich and oracle-update front-running risk?
3. Pool depth for WMON/USDC, WETH/USDC and LST pools on Uniswap on Monad: is a 30-minute TWAP meaningful as a sanity band?
4. Do we want cash withdrawals at oracle NAV at all, or in-kind only (plus optional swap helper) for the permissionless path? In-kind is safest but worse UX.
5. Global HWM versus per-depositor HWM for the 10% fee, and whether shares are transferable.
6. Should the leader's 5% stake be excluded from performance fee (it is the leader's own money)?
7. How to value tokens that are sent to the vault but not in the allowed list (ignore, or sweepable)?
8. Is the deployed Monad `VaultV2Factory` bytecode this exact commit (Phase 0 left unverified)? Matters only if we reuse V2 directly.
9. Morpho does not say how `maxRate` is set in practice (who, how often, typical values). Not answerable from code.
