# C. Deposits, withdrawals, liquidity, and exits

Sub-agent C. Repository `morpho-org/vault-v2` at commit `9ee4dbdc`. All line numbers refer to that commit. "Verified" means read in code or tests at this commit. "Inferred" means reasoning, design proposal, or general knowledge. No tests were run (Foundry is not installed).

## 1. Summary

- Vault V2 is a single-asset ERC-4626 vault. Users only ever deposit and receive the one `asset` (Verified, `asset` immutable, `src/VaultV2.sol:197`). Withdrawals are paid from idle balance first, then from a single "liquidity adapter". If both are insufficient the withdrawal reverts. There is no partial fill and no queue (Verified, `exit`, lines 811-829).
- The escape hatch is `forceDeallocate`: permissionless, moves assets from any adapter back to idle, and charges the caller's `onBehalf` a penalty (max 2% per adapter) by burning shares whose assets stay in the vault. Combined with a flashloan it gives "in-kind redemption" into the underlying lending market (Verified, lines 840-849; `test/integration/MorphoMarketV1IntegrationIkrTest.sol:63-94`).
- All four max functions return 0 (Verified, lines 743-761). Preview functions are exact (Verified, lines 701-727; `certora/README.md:33`).
- Caps are checked only in `allocateInternal` (Verified, lines 590-601). Exits never check caps.
- Gates can block exits (`sendSharesGate`, `receiveAssetsGate`) or everything (`receiveSharesGate` if it reverts, because fees call it inside `accrueInterestView`). Gate addresses are timelocked, but a gate contract's internal state is not (Verified, lines 389-411, 682-689; `WhitelistReceiveSharesGate.setIsWhitelisted` has no timelock).
- For our spot vault, the Morpho in-kind pattern does **not** transfer directly: there is no lending market the user can supply to in exchange for the vault's WETH position. The closest equivalent is a native, multi-token in-kind redemption (user receives pro-rata USDC, WMON, WETH, LST). **Recommendation: in-kind redemption is the always-available offline exit path; Hyperliquid-style "USDC first, then proportional sell" is the convenient default path that may fail safely.** (Inferred)

## 2. Deposit, mint, withdraw, redeem end to end

### 2.1 Signatures (Verified, `src/VaultV2.sol`)

| Function | Line | Returns | Rounding |
|---|---|---|---|
| `deposit(uint256 assets, address onBehalf)` | 766 | shares minted | `previewDeposit`: `assets.mulDivDown(supply + virtualShares, totalAssets + 1)` (705) |
| `mint(uint256 shares, address onBehalf)` | 774 | assets pulled | `previewMint`: `mulDivUp` (712) |
| `withdraw(uint256 assets, address receiver, address onBehalf)` | 795 (public) | shares burned | `previewWithdraw`: `mulDivUp` (719) |
| `redeem(uint256 shares, address receiver, address onBehalf)` | 803 | assets sent | `previewRedeem`: `mulDivDown` (726) |
| `forceDeallocate(address adapter, bytes data, uint256 assets, address onBehalf)` | 840 | penalty shares burned | penalty assets `mulDivUp` (845) |

Note the parameter name `onBehalf` instead of ERC-4626 `receiver`/`owner`; ABI positions match ERC-4626 (Verified).

All four previews include pending fee shares in the supply (`newTotalSupply = totalSupply + performanceFeeShares + managementFeeShares`, lines 704, 711, 718, 725) (Verified). `convertToShares`/`convertToAssets` just call `previewDeposit`/`previewRedeem` (lines 731-739) (Verified).

### 2.2 Deposit / mint flow (Verified, lines 766-792)

1. `accrueInterest()` (653-662): loops `adapters[i].realAssets()`, applies `maxRate` bound and fees, sets `_totalAssets`, sets transient `firstTotalAssets` once per transaction.
2. Compute shares (deposit) or assets (mint) with the preview function.
3. `enter(assets, shares, onBehalf)`:
   - `require(canReceiveShares(onBehalf))` (783)
   - `require(canSendAssets(msg.sender))` (784)
   - `safeTransferFrom(asset, msg.sender, this, assets)` (786)
   - `createShares(onBehalf, shares)`; `_totalAssets += assets` (787-788)
   - If `liquidityAdapter != 0`, `allocateInternal(liquidityAdapter, liquidityData, assets)` (791). This re-checks caps on the liquidity adapter's ids, so **a full cap makes deposits revert** (NatSpec lines 110-112). With a relative cap below WAD, big deposits can revert because the cap is computed against `firstTotalAssets` (the pre-deposit value) (NatSpec lines 63-64).

### 2.3 Withdraw / redeem flow (Verified, lines 795-829)

1. `accrueInterest()`, compute shares or assets.
2. `exit(assets, shares, receiver, onBehalf)`:
   - `require(canSendShares(onBehalf))` (812)
   - `require(canReceiveAssets(receiver))` (813); `address(this)` always passes (938)
   - `idleAssets = asset.balanceOf(this)` (815)
   - If `assets > idleAssets && liquidityAdapter != 0`: `deallocateInternal(liquidityAdapter, liquidityData, assets - idleAssets)` (816-818). Only the shortfall is pulled, only from that one adapter.
   - Allowance spend if `msg.sender != onBehalf` (820-823); `type(uint256).max` is infinite.
   - `deleteShares(onBehalf, shares)`, `_totalAssets -= assets`, `safeTransfer(asset, receiver, assets)` (825-827).

### 2.4 When idle plus liquidity adapter is insufficient (Verified)

There is no fallback. The adapter's `deallocate` reverts (e.g. Morpho market lacks liquidity) or the final `safeTransfer` fails for lack of balance. Tests:
- `testWithdrawMoreThanIdleNoLiquidityAdapter` expects revert (`test/integration/MorphoMarketV1IntegrationWithdrawTest.sol:52-57`).
- `testWithdrawThanksToLiquidityAdapter`: idle drained first, remainder from market1 only; market2 untouched (59-76).
- `testWithdrawTooMuchEvenWithLiquidityAdapter` and `testWithdrawLiquidityAdapterNoLiquidity` expect reverts (78-104).
- Same set in `MorphoVaultV1IntegrationWithdrawTest.sol:33-80`.

The user's options then are: wait for an allocator to deallocate, call `forceDeallocate` on a liquid adapter (penalty), or do in-kind redemption via flashloan (section 3). README lines 33-43 state the allocator "is responsible for ensuring that users can withdraw" (Verified).

### 2.5 Non-standard ERC-4626 behavior (Verified)

- `maxDeposit`, `maxMint`, `maxWithdraw`, `maxRedeem` are `pure` and return 0 (lines 743-761). The stated reason: "Gross underestimation because being revert-free cannot be guaranteed when calling the gate." ERC-4626 allows underestimation, so returning 0 is compliant but useless to integrators. README warns about it (README `ERC-4626 compliance`).
- Preview functions are exact (not conservative) including fees; `certora/specs/PreviewFunctions.spec` proves they equal the executed result (`certora/README.md:33`).
- `totalSupply` storage excludes not-yet-minted fee shares (NatSpec line 20).
- Interest is accrued once per transaction via transient `firstTotalAssets` (lines 224, 657, 671), so flashloan-style share price games within one tx see a frozen price.
- `maxRate` defaults to 0 at creation (storage default, line 227; formula line 677). With `maxRate = 0`, `newTotalAssets = min(realAssets, _totalAssets)`: gains are never recognized while losses are recognized immediately (Verified, lines 677-678). For a trading vault this matters a lot for withdrawal fairness (see Open questions).

## 3. forceDeallocate and in-kind redemption

### 3.1 Mechanics (Verified, lines 831-849)

```solidity
function forceDeallocate(address adapter, bytes memory data, uint256 assets, address onBehalf)
    external returns (uint256)
{
    bytes32[] memory ids = deallocateInternal(adapter, data, assets);
    uint256 penaltyAssets = assets.mulDivUp(forceDeallocatePenalty[adapter], WAD);
    uint256 penaltyShares = withdraw(penaltyAssets, address(this), onBehalf);
    emit EventsLib.ForceDeallocate(msg.sender, adapter, assets, onBehalf, ids, penaltyAssets);
    return penaltyShares;
}
```

- **Who can call:** anyone. No role check (Verified). The adapter receives `msg.sig = forceDeallocate.selector` and `sender = msg.sender`, so an adapter could treat it differently (`test/ForceDeallocateTest.sol:55-56`).
- **Deallocation:** `deallocateInternal` (610-629) calls `adapter.deallocate(data, assets, ...)`, requires every returned id to have `allocation > 0` (621), updates allocations, then pulls `assets` from the adapter into the vault. `data` is caller-supplied, so the adapter must validate it (Inferred; Morpho adapters check the market is one they hold).
- **Penalty:** `forceDeallocatePenalty[adapter]` is set per adapter by the curator through a timelock (`setForceDeallocatePenalty`, 568-573), bounded by `MAX_FORCE_DEALLOCATE_PENALTY = 0.02e18` (2%) (`src/libraries/ConstantsLib.sol:12`). Default is 0.
- **How charged:** as a normal `withdraw(penaltyAssets, receiver = address(this), onBehalf)`. Shares of `onBehalf` are burned, `_totalAssets` falls, but the assets are transferred to the vault itself, so real assets do not fall. Net effect is a donation to remaining holders, released subject to `maxRate` (NatSpec 834-836 and 47-48).
- Because it goes through `exit`, it needs `canSendShares(onBehalf)` and, if `msg.sender != onBehalf`, a share allowance at least equal to the penalty shares. With penalty 0, `penaltyShares = 0`, so **anyone can force-deallocate any adapter on behalf of anyone** at zero cost other than gas (Inferred from lines 820-823 with shares = 0; README "the only friction to deallocating an adapter with a 0% penalty is the associated gas cost").
- The receive-assets gate never blocks it, because the receiver is the vault (938; `testForceDeallocateWithBlockedVault`, `test/ForceDeallocateTest.sol:67-88`).
- Optimal amount when fully illiquid: `min(marketLiquidity, A / (1 + penalty))` (NatSpec 837-839; tests use `assets.mulDivDown(WAD, WAD + PENALTY)`).

### 3.2 In-kind redemption via flashloan (Verified in tests)

`MorphoMarketV1IntegrationIkrTest.testInKindRedemption` (lines 63-94):
1. Market fully borrowed, so `withdraw` reverts.
2. User flashloans `d = A/(1+p)` USDC, supplies it to the same Morpho market for themselves.
3. `vault.forceDeallocate(adapter, marketParams, d, user)` pulls `d` out of the market (the liquidity the user just added) into idle; penalty `p*d` shares burned.
4. `vault.withdraw(d, user, user)` pays `d` from idle; user repays the flashloan.
5. End state: user owns a Morpho supply position worth `d`, vault shares near 0.

Net: the user swapped vault shares for a direct position in the underlying market without needing any liquidity and without any role holder. `MorphoVaultV1IntegrationIkrTest` shows the same via MetaMorpho shares, or via the underlying Blue market when MetaMorpho deposits are paused (lines 65-110).

Certora: `ForceDeallocate.spec` rule `canForceDeallocateZero` proves `forceDeallocate(adapter, data, 0, onBehalf)` does not revert given `canSendShares(onBehalf)`, a registered adapter, bounded supply, and a well-behaved adapter (lines 97-125) (Verified). This is a liveness proof for the zero-amount path, not for arbitrary amounts.

### 3.3 Does this pattern let our depositors exit when our platform is offline? (Inferred)

For Morpho: yes, as long as (a) the underlying market accepts supply, (b) a flashloan source exists, (c) `sendSharesGate` admits the user, (d) adapters and token do not revert. No allocator, curator, or keeper is needed.

For our vault: **not directly.** The in-kind trick works because "supplying liquidity to the market" and "the vault's position in the market" are the same fungible claim. Our risk positions are spot tokens held by the vault. There is no market the user can supply USDC to and walk away with the vault's WETH. If we modeled WETH as a V2 adapter whose `deallocate` sells WETH on Uniswap, then `forceDeallocate` becomes a permissionless forced sale:
- It depends on Uniswap liquidity and on an oracle (`realAssets` must price WETH in USDC), which violates our offline requirement.
- The caller controls timing and can sandwich the sale; the 2% cap on penalty would be the main deterrent, and the adapter would need its own oracle-bounded slippage check.
- With penalty 0 anyone could force sales (section 3.1).

What does transfer: (1) the principle that exits must never depend on a privileged role, (2) the penalty-as-donation accounting for any forced or inconvenient exit path, (3) timelocked configuration with sentinel revoke. Our analog of in-kind redemption should be a native `redeemInKind` that transfers pro-rata token balances (section 6).

### 3.4 BluePublicAllocator (Verified, `src/periphery/blue-public-allocator/BluePublicAllocator.sol`)

A permissionless reallocator (must be made an allocator of the vault, line 13). Anyone calls `reallocate` (114-143) or `allocateFromIdle` (145-165) and pays a per-vault penalty in the asset, transferred directly to the vault (124-127). Allocators enable adapters, per-market caps, and which markets can be pulled from (68-110). Relevance for us: a "public, pay-a-penalty, bounded-by-owner-flags" function is a clean pattern if we ever want anyone (not only our keeper) to trigger a bounded rebalance, for example moving the vault toward the USDC floor to fund withdrawals. Warning at lines 30-31: public reallocation can pull liquidity away from idle and block deposits by filling caps.

## 4. Caps

### 4.1 Storage and setters (Verified)

`mapping(bytes32 id => Caps) caps` (233) with `absoluteCap` (uint128), `relativeCap` (WAD, max 1e18), `allocation`. Ids are `keccak256(idData)` and are returned by the adapter on each allocate/deallocate.

| Action | Who | Timelocked | Line |
|---|---|---|---|
| `increaseAbsoluteCap` | anyone after curator submit | yes | 528-535 |
| `decreaseAbsoluteCap` | curator or sentinel | no | 537-545 |
| `increaseRelativeCap` (<= WAD) | anyone after submit | yes | 547-556 |
| `decreaseRelativeCap` | curator or sentinel | no | 558-566 |

Defaults are zero for both. A relative cap of 0 (not WAD) means allocation must be 0, so a curator must raise both caps before an id can be used (Verified from line 598 and test setup `ForceDeallocateTest.sol:23-26`).

### 4.2 Enforcement (Verified, `allocateInternal` 582-603)

For every id returned by the adapter after the change is applied:
- `absoluteCap > 0` (595), `allocation <= absoluteCap` (596)
- `relativeCap == WAD || allocation <= firstTotalAssets * relativeCap / WAD` (597-600), rounded down (`testAllocateRelativeCapCheckRoundsDown`, `AllocateTest.sol:151-164`).

Using `firstTotalAssets` (the value at the first accrual in the transaction) prevents a deposit-allocate-withdraw flashloan from inflating the denominator (`testRelativeCapManipulationProtection`, `AllocateTest.sol:121-149`: reverts in one multicall, passes across separate transactions).

### 4.3 When caps are not checked (Verified)

- `deallocate`, `withdraw`, `redeem`, `forceDeallocate` (RelativeCaps.spec filter lines 17-23 excludes exactly these plus `decreaseRelativeCap`).
- Interest and donations inside adapters can push allocation over caps (NatSpec 56).
- Loss realization lowers `totalAssets` without touching allocations, so relative caps can become exceeded.
- Allocations are only refreshed on allocate/deallocate (NatSpec 52-53). `forceDeallocate(..., 0, ...)` is the permissionless way to refresh.
- README: "Relative caps only constrain allocations, so they can be exceeded because of withdrawals from the vault."

### 4.4 Mapping to our vault (Inferred)

Our "max 40% in any non-USDC asset" and "at least 10% USDC" are relative caps on the Executor's trades. V2's lesson applies directly: **enforce them on the risk-increasing action (buy) and never on exits.** A withdrawal paid from USDC can push WETH above 40% or USDC below 10%; that must not block the withdrawal. After such a withdrawal the Executor should be limited to reduce-only trades until back within bounds. Unlike V2 (which measures against a stored `firstTotalAssets` in the asset), our percentages need an oracle NAV; the flashloan-resistance idea (freeze the denominator at the first touch in the transaction) is still worth copying.

## 5. Gates

### 5.1 What each gate controls (Verified, NatSpec 151-166 and code)

| Gate | Checked in | Effect if false | Effect if it reverts |
|---|---|---|---|
| `receiveSharesGate.canReceiveShares(account)` | `enter` on `onBehalf` (783), `transfer`/`transferFrom` on `to` (858, 872), `accrueInterestView` on fee recipients when fee > 0 (682, 687) | Cannot deposit to, or be sent shares to, that account. Fee recipient simply gets no fees. | Blocks every function that accrues interest, including withdraw and redeem, if any fee is non-zero. NatSpec 156: "Can block all vault interactions". |
| `sendSharesGate.canSendShares(account)` | `exit` on `onBehalf` (812), `transfer`/`transferFrom` on sender (857, 871) | Account cannot withdraw, redeem, transfer, or pay a forceDeallocate penalty. **Blocks exit.** | Same. |
| `receiveAssetsGate.canReceiveAssets(account)` | `exit` on `receiver` (813); vault itself always allowed (938) | That receiver cannot be paid. Can block exit for everyone if it returns false for all. | Same. |
| `sendAssetsGate.canSendAssets(account)` | `enter` on `msg.sender` (784) | Cannot deposit. "Not critical (cannot block users' funds)" (NatSpec 166). | Blocks deposits only. |

Gates receive only the account. They are `view` and see no amount and no timestamp context. Certora `Gates.spec` proves: a user who cannot receive shares never gains them (45-53), a user who cannot send shares never loses them (56-64), and vault-initiated asset transfers respect the asset gates (68-77), excluding the vault and adapters.

### 5.2 Who sets them and timelock protection (Verified)

Curator `submit`s, anyone executes after `timelock[selector]` via `setReceiveSharesGate` / `setSendSharesGate` / `setReceiveAssetsGate` / `setSendAssetsGate` (389-411). A sentinel or curator can `revoke` pending data (372-380). The curator can `abdicate` a selector so it can never be called again (478-482). Timelocks default to 0 at creation (NatSpec 187-189).

Protection model: if `timelock[setSendSharesGate]` exceeds the time a depositor needs to notice a `Submit` event and exit, a malicious gate cannot trap funds. README "Non-custodial guarantees": users "can always withdraw their assets before any critical configuration change takes effect (if the right timelocks are not zero)".

### 5.3 Abuse paths that bypass the timelock (Verified plus Inferred)

1. **Gate internal state is not timelocked.** The timelock covers only the gate address. `WhitelistReceiveSharesGate.setIsWhitelisted` (lines 56-60) is instant for any whitelister, and `roleSetter` can appoint whitelisters instantly (44-54). The file itself warns a depositor who moved shares into another protocol might not get them back if un-whitelisted (lines 11-12). A sendShares or receiveAssets gate with a mutable admin can freeze exits instantly. (Verified for the whitelist gates; the generalization is Inferred.)
2. **Upgradeable or reverting gate.** A gate behind a proxy can change logic without any vault timelock. A reverting `receiveSharesGate` with fees on bricks accrual and therefore all exits (Verified, 682-689).
3. **Gas griefing.** NatSpec 156: consuming too much gas has the same effect.
4. **Zero timelock at creation.** Until timelocks are raised, the curator can set gates instantly (Verified default).

### 5.4 Recommendation for our vault (Inferred)

- Do not have send-shares or receive-assets gating on the exit path at all, or make the relevant setters abdicated (V2 supports `abdicate`). Our non-negotiable offline exit rule makes any exit gate a liability.
- Use only a deposit-side gate (V2's `sendAssetsGate` role) for "leader can close the vault to new deposits". This matches the V2 statement that this gate cannot block funds.
- If a receive-shares allowlist is ever needed (compliance), it must never be consulted on the exit path, and must not be called inside fee accrual in a way that can revert. V2 couples fees to `canReceiveShares`; we should not.

## 6. Our vault: withdrawal design

Context: vault holds USDC (base) plus spot WMON, WETH, maybe one LST. The Executor trades on Uniswap. Everything below is **Inferred** design.

### 6.1 Two exit paths

**Path A: `redeemInKind(shares, receiver)` (always available).**
- Burns `shares`, transfers `balance_i * shares / totalSupply` (rounded down) of every held token `i` to `receiver`.
- No oracle, no DEX, no Executor, no platform, no session key, no allowlist, not pausable by leader, platform, or circuit breaker. Only depends on ERC-20 `transfer`.
- Must use the same `totalSupply` that includes any pending fee shares (V2 lesson, previews at 701-727), so fee accrual must be computable without an oracle, or accrued lazily and settled at the last oracle-good checkpoint.
- Bounded token list (hard maximum, e.g. 5), so gas is bounded. Roughly 30-50k gas per token transfer (Inferred).
- Holds wrapped MON (WMON), not native MON, so every leg is an ERC-20 transfer.
- Hazard: a token that reverts on transfer to this receiver (USDC blacklist, token pause) would block the whole redemption. Mitigations: `receiver` parameter so the user can pick another address; optional explicit `skipTokens` bitmap where the user knowingly forfeits that token's slice to remaining holders (analogous to V2's penalty-as-donation). See Open questions.

**Path B: `redeem(shares, minUsdcOut, deadline, receiver)` Hyperliquid-style (convenient, may revert).**
1. Require fresh oracle (under 5 min, within 2% of pool, matching Executor rules). If the oracle fails, revert and point to Path A. Never fall back to an unchecked price.
2. Compute NAV-based entitlement `owed = shares * NAV / supply` in USDC.
3. If free USDC covers `owed` (see reserve rule below), pay USDC and touch nothing else. Positions unaffected, matching the Hyperliquid spec.
4. Otherwise, **proportional close**: take the user's pro-rata slice of each non-USDC token (`balance_i * shares / supply`), swap each slice to USDC through a fixed, governance-timelocked set of Uniswap pools (never user-supplied calldata or router), each swap with `minOut_i = oracleValue_i * (1 - maxSlippage)` and an exact approval reset afterwards. Add the pro-rata USDC slice. Require `total >= minUsdcOut` and `block.timestamp <= deadline`.
5. The withdrawer bears the execution cost of their own slice. This avoids a cross-subsidy where remaining holders eat slippage on someone else's exit.

Reserve rule for step 3: pay from USDC only while the vault stays at or above a USDC floor (for example the 10% minimum), otherwise use step 4 for the remainder. This preserves the buffer that later small withdrawals rely on, and keeps "withdrawals do not affect positions" true in the common case.

"Leader can choose to always close positions on withdrawal" (product spec) maps to a flag that forces step 4 even when USDC suffices.

### 6.2 Safety controls for Path B

| Risk | Control |
|---|---|
| Oracle stale or manipulated | Freshness and pool-deviation checks, same as Executor. Revert on failure. Deposits and Path B may fail; Path A must not. |
| Sandwich / MEV | Per-leg oracle-bounded `minOut` plus user `minUsdcOut` and `deadline`. Bound per-leg size (e.g. slice larger than X% of pool liquidity must use Path A). Monad mempool/MEV characteristics unknown (Open questions). |
| Uniswap paused, pool drained, or illiquid | Swap reverts or `minOut` fails, whole tx reverts, no state change. User falls back to Path A. Never partially fill with unbounded price. |
| Toxic flow on NAV-priced USDC payouts | Withdrawals paid at oracle NAV let users exploit oracle lag. Mitigate with the deposit lockup, the pool-deviation check, and optionally a small exit fee donated to the vault (V2 penalty pattern). |
| Gas | 1 oracle read per asset plus up to ~3-4 Uniswap swaps; bounded by token list. Estimated a few hundred thousand gas (Inferred; not measured). |
| Reentrancy via tokens or pools | Only whitelisted tokens and pools (V2 token requirements, NatSpec 114-120); `nonReentrant`. |
| Breaching allocation limits | Allowed on exit (V2 caps are soft on exit, section 4.3). Executor becomes reduce-only until restored. |

### 6.3 Comparison

| | Path A in-kind | Path B proportional sell |
|---|---|---|
| Dependencies | ERC-20 transfers only | Oracle, Uniswap, pool liquidity |
| Works with platform offline | Yes | Yes (no keeper), but only while oracle and pools are healthy |
| Fairness | Exact pro-rata, no oracle risk | Depends on oracle NAV (USDC leg) and slippage bounds |
| User experience | Receives several tokens | Receives USDC |
| Cost to remaining holders | None | None if slippage is charged to withdrawer; oracle lag risk on USDC-first leg |
| MEV exposure | None | Bounded by minOut |

**Recommendation:** Path A is the always-available offline path, because it is the only exit that holds under every failure of the things we do not control (oracle, DEX, platform, keys). It is the spot-token analog of V2's in-kind redemption (README "Non-custodial guarantees"). Path B is the default UI path. A periphery "zap" contract can compose Path A plus user-side swaps if the user wants USDC with their own slippage settings, keeping swap logic out of the vault.

## 7. Lockups

Vault V2 has no lockup. It cannot be built with V2 gates alone because gates are `view`, receive only the account, and cannot record deposit timestamps (Verified, `src/interfaces/IGate.sol:5-19`). So the lockup must live in our vault's own share accounting (Inferred).

### 7.1 Proposed design (Inferred)

State per account: `lockedShares`, `unlockAt`. Global: `lockupDuration` (default 1 day), constants `MIN_LOCKUP = 1 days`, `MAX_LOCKUP` (for example 7 days; Hyperliquid protocol vault uses 4 days).

- On deposit to `onBehalf`: if `now >= unlockAt`, set `lockedShares = newShares`, `unlockAt = now + lockupDuration`; else `lockedShares += newShares`, `unlockAt = max(unlockAt, now + lockupDuration)`.
- Free shares = `balance - (now < unlockAt ? lockedShares : 0)`. Withdraw, redeem, in-kind, and transfer may spend only free shares.
- Per-account "bucket" rather than per-deposit lots: O(1) gas, no unbounded arrays. Cost: a top-up extends the lock on the not-yet-unlocked prior deposit by at most `lockupDuration`. Per-deposit lots are fairer but need a bounded ring buffer (e.g. max 8 open lots, merging the oldest).
- **Third-party deposit griefing:** with `deposit(assets, onBehalf)` anyone could extend a victim's lock by depositing dust. Mitigate: if `msg.sender != onBehalf` and the victim has an active lock, revert; or only lock the new shares in a separate bucket. Already-free shares must never become locked by someone else's action.

### 7.2 Leader extension bounds (Inferred)

- Leader can change `lockupDuration` only within `[MIN_LOCKUP, MAX_LOCKUP]` (hard-coded constants).
- A new duration applies only to deposits made after it takes effect; existing `unlockAt` values are never moved forward. This alone makes it impossible to trap existing funds.
- Increases go through a timelock (V2 `submit`/timelock pattern, lines 349-370) at least as long as the new duration, so prospective depositors see it before it binds them. Decreases are immediate.
- Lockups are waived in handover mode (agent sale) and when the circuit breaker pauses trading, since those are the moments depositors most need to leave. (Product decision; Open question.)
- The leader's own 5% minimum stake is a separate restriction on the leader's account, not a lockup.

### 7.3 Share transfers (Inferred)

Simplest safe rule: transfers may spend only free shares; the receiver's lock is unaffected. Do not propagate `unlockAt` to the receiver (that would let a sender extend someone's lock with dust, same griefing as 7.1). This also stops "transfer locked shares to a fresh address to exit early".

### 7.4 ERC-4626 max and preview (Inferred, based on ERC-4626 rules)

- `previewWithdraw`/`previewRedeem` must ignore lockups and limits (ERC-4626 says previews do not account for per-user limits); V2's previews ignore gates (Verified, 701-727).
- `maxRedeem(owner)` should return free shares; `maxWithdraw(owner)` = `previewRedeem(freeShares)` (and, for Path B, capped by what can be paid). This is more useful than V2's constant 0, which V2 chose only because gate calls may revert (Verified, 743-761). Our vault has no exit gates, so accurate max values are feasible. If the oracle is down, return 0 for the USDC path rather than reverting, since ERC-4626 max functions must not revert.
- `maxDeposit`/`maxMint` return 0 when the leader has closed deposits or the vault is in handover or paused, else `type(uint256).max` (or a cap).

## 8. Open questions

1. `maxRate` defaults to 0 (Verified, lines 227, 677). For a volatile spot vault, a rate cap on share-price increases would underpay withdrawers during rallies and overpay after drawdowns relative to real value. Should our NAV use a cap at all? Probably not for spot (Inferred), but this needs a decision with the fees and HWM work.
2. USDC blacklisting or pausing: how should in-kind redemption behave if one token cannot be transferred? Options: receiver choice, opt-in forfeit of that leg, or a claimable balance per user per token (pull pattern, more state).
3. Monad MEV environment: is there a public mempool, private order flow, or block-builder auction? This determines how tight Path B slippage must be.
4. Uniswap deployments on Monad: which versions (v3/v4), pool fee tiers, and depth for WMON, WETH, and the LST? Do v4 hooks introduce reentrancy or pause risk?
5. Oracle source on Monad (Chainlink, Pyth, Redstone?) and its failure behavior (revert vs stale value). Path B and deposits depend on it; Path A must not.
6. Does fee accrual need an oracle? If the performance fee needs NAV and NAV is unavailable, can in-kind redemptions proceed with fees accrued up to the last good checkpoint without letting exiters dodge fees?
7. Exact lockup semantics wanted by product: per-account bucket (cheap) vs per-deposit lots (fairer)? Should lockups be waived in handover and circuit-breaker pause?
8. Deployed Monad bytecode vs this commit (from Phase 0) is not verified, which matters only if we reuse V2 directly.
9. Should Path B also be callable by a permissionless keeper for others (like `BluePublicAllocator`), or only by the share owner? Third-party calls on behalf of users need allowances (V2 requires share allowance, lines 820-823).
10. Tests were described, not executed (Foundry not installed).
