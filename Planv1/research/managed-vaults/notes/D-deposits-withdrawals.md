# Sub-agent D: Deposits, withdrawals, queues, locks, and tests

Repos and versions: see `00-phase0-orientation.md` (BoringVault `c9c221f9`, SEL-1.0 license, patterns only; hypurrquant `79e41cdc`, Apache 2.0, unaudited). No tests were run (Foundry not installed). All claims come from reading source.

Abbreviations: BV = BoringVault repo (`.../scratchpad/boring-vault`), HQ = hypurrquant repo (`/home/dhrupatel/agent_tool/hyperliquid`). Labels: **V** = Verified from code, **I** = Inferred. Portability: **Portable**, **Adaptable**, **Chain-specific**. Comparison: **Confirms**, **Improves**, **Missing** (they reveal something we lack), **Conflicts** (with a non-negotiable).

---

## 1. Headline answers

1. **No BoringVault withdrawal path works without operator involvement in a default deployment. (V)** Every exit ends in `TellerWithMultiAssetSupport._withdraw`, which reverts if the Teller is paused, if the asset's `allowWithdraws` is false, or if the Accountant is paused (via `getRateInQuoteSafe`). `withdraw` is never made public by the deploy script; only tests do that. The public path is queue request plus solve, and even "self-solve" depends on roles the operator grants, on the queue not being paused, on idle liquidity of the chosen asset in the vault, and on the rate not having fallen more than the discount since the request. Admins can also pause, stop an asset, set withdraw capacity to zero, deny-list a user, or (with `TellerWithRemediation`, or simply by holding the vault's `BURNER_ROLE`) burn or redirect a user's shares. **This conflicts directly with our non-negotiable unpausable, oracle-free `redeemInKind`.**
2. **hypurrquant also has no permissionless exit. (V)** `redeem` needs a keeper `markRedeemReady` and is `whenNotPaused`; the only admin fallback (`emergencyRedeem`) is `ADMIN_ROLE` and caps payout at cost basis. If the keeper disappears, funds on HyperCore are stuck until admin acts.
3. **Share lock** (BV, max 3 days) exists to stop deposit-then-withdraw arbitrage against an offchain, stepwise exchange rate, and doubles as the window in which the operator can refund a deposit. Its most useful lesson for us: **only the depositor should be able to set their own lock; third-party `deposit(..., to)` must not relock a victim's shares.** (V, BV gates that overload behind a role for exactly this reason.)
4. **Queue recommendation:** do **not** build a withdrawal queue for launch. With spot-only USDC plus wrapped MON, synchronous USDC-or-sell withdrawals plus unpausable `redeemInKind` cover every case. Keep the storage and events queue-ready (request hash pattern, per-request snapshot) and add an ERC-7540-style async queue only when we add assets that cannot be transferred or split in kind (LP positions, lending positions with withdrawal delays, vesting tokens, cross-chain positions) or when our sell path routinely exceeds pool depth. Details in section 8.
5. **Leader stake (>= 5%) is enforced by neither repo. (V)** We must build it ourselves (section 9.5).

---

## 2. BoringVault Teller: deposits

File: `src/base/Roles/TellerWithMultiAssetSupport.sol` (711 lines, "Base V0.2"). The vault itself (`src/base/BoringVault.sol`) only exposes `enter` (MINTER_ROLE) and `exit` (BURNER_ROLE), both `requiresAuth`; the Teller holds both roles (deploy script `_grantRoleIfNotGranted(MINTER_ROLE, teller)` and `BURNER_ROLE`, `script/ArchitectureDeployments/DeployArcticArchitectureWithConfig.s.sol` lines 1506-1507). (V)

### 2.1 Entry points

| Function | Who can call (default deploy) | Checks | Sets share lock? | Label |
|---|---|---|---|---|
| `deposit(asset, amount, minimumMint, referral)` | Public only if config `allowPublicDeposits` is true (deploy script line ~1172) | `requiresAuth`, `nonReentrant`, `_beforeDeposit` (not paused, `allowDeposits`), deny lists, cap, `minimumMint` | Yes, on `msg.sender` | V, Portable |
| `deposit(asset, amount, minimumMint, to, referral)` | Role-gated; NatSpec: "Intended for router-like integrations; this selector should remain role-gated" | Same | Yes, on `to` | V |
| `depositWithPermit(...)` | Public if `allowPublicDeposits` | Same plus `_handlePermit` (try permit, fall back to existing allowance, so a front-run permit does not DoS the deposit) | Yes | V, Portable |
| `bulkDeposit(asset, amount, minimumMint, to)` | `SOLVER_ROLE` (granted to BoringSolver) | Same, but no lock and no deposit hash | No | V |
| Native deposits (`NATIVE` sentinel `0xEeee...`) | via `deposit` | wraps `msg.value` into `nativeWrapper`, refunds as wrapped | Yes | V, Portable |

### 2.2 Share math and premium

`_erc20Deposit`:
```solidity
shares = depositAmount.mulDivDown(ONE_SHARE, accountant.getRateInQuoteSafe(depositAsset));
shares = asset.sharePremium > 0 ? shares.mulDivDown(1e4 - asset.sharePremium, 1e4) : shares;
if (shares < minimumMint) revert TellerWithMultiAssetSupport__MinimumMintNotMet();
if (cap != type(uint112).max) {
    if (shares + vault.totalSupply() > cap) revert TellerWithMultiAssetSupport__DepositExceedsCap();
}
vault.enter(from, depositAsset, depositAmount, to, shares);
```
- Price comes from the Accountant's stored rate (offchain-updated), not from live balances. Rounds down (vault-favorable). (V)
- `sharePremium` (per asset, max `MAX_SHARE_PREMIUM = 1_000` = 10%) is a per-asset haircut on minted shares. It is the BV equivalent of our **buy side of the buy/sell spread**, applied per deposit asset. (V) **Confirms** our spread idea; **Improves** it by making the spread per asset (a volatile asset like wrapped MON can carry a larger haircut than USDC). Portable.
- `TellerWithYieldStreaming._erc20Deposit` (the Monad vmUSD Teller) first calls `accountant.updateExchangeRate()` and divides by `rate + 1`, an extra 1-wei rounding in the vault's favor. (V)

### 2.3 Deposit cap

`depositCap` is a `uint112` share-supply cap (default max = disabled), set by `setDepositCap` (OWNER_ROLE). No partial fills. There is **no per-user cap** in BV. (V) Portable.

### 2.4 Pause

`isPaused` (set by `pause`/`unpause`, PAUSER_ROLE; also reachable through `src/base/Roles/Pauser.sol` `pauseAll`/`pauseSingle`) blocks deposits **and** withdrawals: `_beforeDeposit` and `_withdraw` both check it (lines 601 and 645). The comment on `pause()` says it only prevents deposits; the code is broader. (V)

### 2.5 Close to new deposits

BV has three ways, all admin: `pause()` (also blocks withdrawals, so unsuitable), `updateAssetData(asset, allowDeposits=false, ...)` per asset, or `setDepositCap(0)`-style cap. (V) Our "leader can close the vault to new deposits" maps cleanly to a per-vault `depositsOpen` flag that touches only the deposit path. **Confirms**; the lesson is to keep "close deposits" separate from "pause" (V: BV's pause is coupled).

### 2.6 Deny lists and the beforeTransfer hook

- `BoringVault.transfer`/`transferFrom` call `hook.beforeTransfer(from, to, msg.sender)` if a hook is set (`setBeforeTransferHook`, OWNER_ROLE). The Teller is normally the hook. (V)
- `TellerWithMultiAssetSupport.beforeTransfer(from, to, operator)` reverts if `from.denyFrom`, `to.denyTo`, `operator.denyOperator`, if `permissionedTransfers` is on and operator is not whitelisted, or if `beforeTransferData[from].shareUnlockTime > block.timestamp`. (V)
- Deny setters: `denyAll/allowAll/denyFrom/denyTo/denyOperator/...` (OWNER_ROLE and DENIER_ROLE per NatSpec). (V)
- `_erc20Deposit` also calls `_handleDenyList(from, to, msg.sender)`, so denied users cannot deposit. (V)
- `src/base/Roles/ShareWarden.sol` is an alternate hook that adds sanctions-oracle and hashed blacklists, can pause all transfers, and delegates to the Teller's checks (`test/ShareWarden.t.sol` `testShareWardenDelegatesToTellerDenyList`, `...ShareLockPeriod`). (V)

Impact on exits: a `denyFrom` user cannot transfer shares into the queue, so they cannot exit at all. (V, the queue pulls shares with `safeTransferFrom`, which triggers the hook.) **Conflicts** with our offline exit if we ever add transfer restrictions: `redeemInKind` must burn directly from the caller's balance without passing through any hook that an admin can switch on. Portability: Portable.

---

## 3. Share lock and deposit refunds

### 3.1 Mechanism (V)

- `shareLockPeriod` (uint64) set by `setShareLockPeriod` (OWNER_ROLE), bounded by `MAX_SHARE_LOCK_PERIOD = 3 days`.
- `_afterPublicDeposit` (public deposits only) does:
```solidity
uint256 nonce = ++depositNonce;
if (currentShareLockPeriod > 0) {
    beforeTransferData[user].shareUnlockTime = block.timestamp + currentShareLockPeriod;
    publicDepositHistory[nonce] = keccak256(
        abi.encode(user, depositAsset, depositAmount, shares, block.timestamp, currentShareLockPeriod, referralAddress)
    );
}
emit Deposit(nonce, user, address(depositAsset), depositAmount, shares, block.timestamp, currentShareLockPeriod, referralAddress);
```
- The lock is **per address, not per deposit**: each new deposit pushes the unlock time for the user's whole balance. (V, `test/TellerWithMultiAssetSupport.t.sol` `testMultipleDepositsWithShareLockPeriod`.)
- While locked, all transfers from the user revert, and `withdraw` reverts because it calls `beforeTransfer(msg.sender, address(0), msg.sender)` first. (V)
- NatSpec on `setShareLockPeriod` admits a limitation: lowering the period lets users with pending locks re-deposit 1 wei to unlock earlier. Accepted by Veda. (V)
- NatSpec on `beforeTransfer`: "If share lock period is set to zero, then users will be able to mint and transfer in the same tx." (V)

### 3.2 What problem it solves (I, strongly supported)

The Accountant's rate is pushed offchain at most every `minimumUpdateDelayInSeconds` (6 h for Monad vmUSD per Phase 0) and bounded to small moves (plus or minus 0.2% on vmUSD). Between updates the onchain rate is stale. Without a lock, anyone who sees that true NAV is higher than the stored rate could deposit at the stale rate, wait for the update, and exit, or deposit and exit within one block around the update, extracting value from existing holders (including with flash loans). The lock forces the depositor to hold through at least one rate update. It also forbids moving freshly minted shares into a DEX pool or lending market during that window. BV does not state this in one sentence; the design (offchain rate plus mandatory lock plus refund window) implies it.

### 3.3 Refund (V)

`refundDeposit(nonce, receiver, depositAsset, depositAmount, shareAmount, depositTimestamp, shareLockUpPeriodAtTimeOfDeposit, referralAddress)`, STRATEGIST_MULTISIG_ROLE (deploy script line ~1123):
- reverts once the lock window has passed;
- recomputes the hash and compares to `publicDepositHistory[nonce]`; deletes it;
- `vault.exit(receiver, depositAsset, depositAmount, receiver, shareAmount)`: burns the minted shares and returns the **original** deposit amount in the original asset (wrapped native for native deposits).

Purpose (I): compliance or error reversal (for example a sanctioned depositor, or a deposit made at a clearly wrong rate) without leaving the vault short. Storing only a hash and reconstructing from the event is a gas pattern that is Portable.

`test/TellerWithMultiAssetSupport.t.sol` `testDepositToLocksAndRefundsReceiver` and `testDepositToRefundReturnsAssetsToReceiver` prove the refund goes to the receiver who holds the shares.

### 3.4 Relevance to us

| Our decision | BV evidence | Verdict |
|---|---|---|
| 1-day default lockup, leader can extend | BV lock is admin-set, hard-capped at 3 days by constant | **Confirms**; **Improves**: we should hard-code a maximum lockup constant (our timelocks "longer than the maximum lockup" need a fixed bound to be meaningful). |
| Lockup as oracle-risk mitigation | Same reasoning as BV (stale rate arbitrage) | **Confirms**. Our rate is computed onchain from oracles per transaction, so the risk is oracle lag and manipulation rather than stale pushed NAV, but the fix is the same. |
| `redeemInKind` with lockup | BV applies lock to all exits | **Inferred**: `redeemInKind` must respect the lockup too, otherwise someone deposits USDC at a lagging wrapped MON oracle price and exits in kind with more wrapped MON than they paid for. A time lock is deterministic, not discretionary, so it does not violate "nothing can pause it". |
| Lock griefing | BV role-gates `deposit(..., to, ...)` so no one can relock someone else | **Missing** in our notes: if we expose ERC-4626 `deposit(assets, receiver)`, a third party could reset a victim's lockup with a dust deposit. Options: lock per deposit lot, or only lock when `receiver == msg.sender`, or require `receiver == msg.sender` (HQ does this: `UsdcVault.deposit` reverts if `receiver != msg.sender`). |
| Leader extends lockup | BV comment: lowering the period lets pending locks shorten; raising affects only new deposits | **Inferred**: lockup changes should apply only to deposits after the change (store unlock time at deposit), so a leader cannot trap existing depositors by extending. |
| Deposit refunds | Operator-discretion clawback within lock window | We do not need this at launch. It is an admin power over user funds (burns shares); it only returns the original asset so it is not theft, but it is discretionary. **Not recommended** for a manager-run vault where the manager is untrusted. |

---

## 4. BoringVault withdrawals and the "no operator" question

### 4.1 Teller exit functions (V)

| Function | Gate in default deploy | Notes |
|---|---|---|
| `withdraw(asset, shares, minAssets, to)` | `requiresAuth`; **never set public by the deploy script**. Only tests do `setPublicCapability(teller, withdraw.selector, true)` (`test/TellerWithBuffer.t.sol:144`, `test/ERC4626BufferHelper.t.sol:106`, `test/MorphoMarketBufferHelper.t.sol:224`, `test/TellerWithYieldStreamingBuffer.t.sol:167`). NatSpec: "Either public or disabled depending on configuration." | Checks share lock and deny list on `msg.sender`, then `_withdraw`. |
| `bulkWithdraw(asset, shares, minAssets, to)` | `SOLVER_ROLE` only (deploy script line ~1111), granted to the BoringSolver | No lock check (solver holds shares from the queue). |
| `_withdraw` (internal) | | `if (isPaused) revert`; `if (!asset.allowWithdraws) revert`; `assetsOut = shares * accountant.getRateInQuoteSafe(asset) / ONE_SHARE`; `vault.exit(...)`. Single asset, priced by Accountant rate. |

### 4.2 The queue path as deployed

Deploy script (`DeployArcticArchitectureWithConfig.s.sol` lines ~1195-1247) wires:
- `requestOnChainWithdraw`, `requestOnChainWithdrawWithPermit`, `cancelOnChainWithdraw`, `replaceOnChainWithdraw` public **only if** `allowPublicWithdrawals` is true.
- `solveOnChainWithdraws`: `CAN_SOLVE_ROLE` (granted to the solver contract) and `SOLVER_ORIGIN_ROLE`.
- `BoringSolver.boringRedeemSolve` / `boringRedeemMintSolve`: `SOLVER_ORIGIN_ROLE` (Veda's bots).
- `BoringSolver.boringRedeemSelfSolve` / `boringRedeemMintSelfSolve`: public **only if** `allowPublicSelfWithdrawals` is true. Across `deployments/configurations`, 83 configs set it true and 22 false (grep count). The Monad vmUSD skeleton config does not include these keys at all (V; its runtime roles were not read onchain, see open questions).

### 4.3 Can a user exit alone? Failure matrix (V unless marked)

Self-solve call chain: user -> `BoringSolver.boringRedeemSelfSolve` (public if configured) -> `BoringOnChainQueue.solveOnChainWithdraws` (solver has CAN_SOLVE_ROLE) -> callback `boringSolve` -> `teller.bulkWithdraw` (solver has SOLVER_ROLE) -> `vault.exit`.

| Condition | Effect on user exit | Who controls it |
|---|---|---|
| Teller `isPaused` | `_withdraw` reverts, so every solve reverts | PAUSER_ROLE / Pauser |
| Accountant paused (manually or **automatically** when an update is outside bounds or too early, `updateExchangeRate` sets `state.isPaused = true`) | `getRateInQuoteSafe` reverts: deposits, `bulkWithdraw`, `previewAssetsOut` (so new requests), and solves all revert | PAUSER_ROLE, or the rate updater by posting an out-of-bounds rate |
| Queue `isPaused` | new requests and all solves revert; `cancelOnChainWithdraw` still works (no pause check) | MULTISIG_ROLE |
| `stopWithdrawsInAsset` / `allowWithdraws=false` in Teller | requests revert; Teller `_withdraw` reverts | MULTISIG / STRATEGIST_MULTISIG / OWNER |
| `setWithdrawCapacity(asset, 0)` | new requests revert (`NotEnoughWithdrawCapacity`) | MULTISIG / STRATEGIST_MULTISIG |
| User deny-listed | cannot transfer shares into queue | OWNER / DENIER |
| Self-solve not made public | only Veda's solver can solve | deploy config |
| Vault lacks idle balance of the requested asset | `vault.exit` `safeTransfer` fails | strategist (funds deployed elsewhere) |
| Rate fell more than the chosen discount since request | self-solve passes `coverDeficit=false`, so `BoringSolver___CannotCoverDeficit` revert; user must cancel and re-request (and wait maturity again) | market / updater |
| Request past deadline | `DeadlinePassed` revert; user must cancel and re-request | time |
| `cancelUserWithdraws` by STRATEGIST_MULTISIG | request removed, shares returned to user | admin |
| `secondsToMaturity` up to 30 days, `minimumSecondsToDeadline` up to 30 days | long waits allowed by constants | MULTISIG |

Conclusion (V): there is no BV path that pays a user without (a) roles granted by the operator, (b) unpaused Teller, Accountant and Queue, and (c) idle liquidity of one chosen asset. BV never pays in kind (grep for in-kind or pro-rata exits in `src` finds nothing relevant).

### 4.4 Can admins seize or redirect shares? (V)

- `BoringVault.exit(to, asset, assetAmount, from, shareAmount)` burns from **any** `from` with no allowance check; `enter` mints to any `to`. Any holder of BURNER_ROLE/MINTER_ROLE can therefore destroy or create shares arbitrarily. The RolesAuthority owner can grant these roles at will (`setUserRole`, `setRoleCapability`). The Teller holds them in normal deployments.
- `src/base/Roles/TellerWithRemediation.sol`: `freezeSharesAndStartRemediation(user, remediationAddress, amount)` freezes the user's transfers immediately, then after `REMEDIATION_PERIOD = 3 days` `completeRemediation(user)` does `vault.exit(address(0), 0, 0, user, amount)` then `vault.enter(address(0), 0, 0, remediationAddress, amount)`: a forced move of shares to an admin-chosen address. `amount == type(uint256).max` takes the full balance. `cancelRemediationAndUnlockShares` undoes it. The deploy script does not wire role capabilities for these three functions, so by default only the Auth `owner` of the Teller (or whoever the authority later grants) can call them (I from the absence of `_addRoleCapabilityIfNotPresent` entries). Tested in `test/TellerWithRemediation.t.sol` `testRemediation`, `testCancellingRemediation`.
- `refundDeposit` burns shares within the lock window (section 3.3).
- `BoringOnChainQueue.rescueTokens` cannot take shares that back active requests (it re-hashes all active requests and subtracts their shares). Good constraint. (V)
- `BoringVault.manage` lets MANAGER_ROLE make arbitrary calls from the vault (merkle-gated in practice via the Manager; see sub-agent B).

**Conflicts** with "managers steer funds but never take them" and with unpausable `redeemInKind`. BV's trust model is "Veda multisig plus timelock is trusted". Ours is "manager is untrusted". Portability of the pattern (role-gated mint/burn with arbitrary `from`) is Portable, but we should **not** copy it: our share burn must only ever burn `msg.sender`'s shares (or an approved owner's), and there must be no role with an unrestricted burn.

### 4.5 Comparison with our `redeemInKind`

| Property | BV | HQ | Ours (decided) |
|---|---|---|---|
| Needs operator/keeper/solver | Yes (roles, solver, idle funds) | Yes (keeper `markRedeemReady`) | No |
| Needs price/oracle | Yes (Accountant rate) | Yes (live precompile NAV) | No |
| Can be paused | Yes (Teller, Accountant, Queue, auto-pause) | Yes (`whenNotPaused` on `redeem`, `requestRedeem`) | No |
| Admin can block a specific user | Yes (deny lists, remediation) | No per-user block found (V: no deny list in UsdcVault) | No |
| Pays in kind | No | No | Yes |
| Handles withdrawal larger than idle | Queue plus offchain unwinding by strategist | Keeper pulls funds from HyperCore | In kind always works; USDC path sells pro rata |

---

## 5. BoringOnChainQueue and BoringSolver (current)

Files: `src/base/Roles/BoringQueue/BoringOnChainQueue.sol` (740), `BoringSolver.sol` (292), `BoringOnChainQueueWithTracking.sol` (149), `IBoringSolver.sol`.

### 5.1 Configuration per withdraw asset (V)

`WithdrawAsset { allowWithdraws, secondsToMaturity, minimumSecondsToDeadline, minDiscount, maxDiscount, minimumShares, withdrawCapacity }`, set by `updateWithdrawAsset` (MULTISIG_ROLE). Hard limits: `MAX_DISCOUNT = 0.3e4` (30%), `MAXIMUM_SECONDS_TO_MATURITY = 30 days`, `MAXIMUM_MINIMUM_SECONDS_TO_DEADLINE = 30 days`. `updateWithdrawAsset` calls `accountant.getRateInQuoteSafe` to ensure the asset is priceable, and resets `withdrawCapacity` to unlimited.

### 5.2 Request lifecycle (V)

1. `requestOnChainWithdraw(assetOut, shares, discount, secondsToDeadline)`: decrements capacity, validates (not paused, allowed, discount within bounds, shares >= minimum, deadline >= minimum), pulls shares from user into the queue, and fixes `amountOfAssets = shares * rate * (1 - discount) / ONE_SHARE` **at request time** (`previewAssetsOut`). Stores only `keccak256(abi.encode(OnChainWithdraw))` in an `EnumerableSet`; the full struct is in the `OnChainWithdrawRequested` event. NatSpec: "recovery is event-indexer responsibility by design."
2. Maturity = `creationTime + secondsToMaturity`. Deadline = maturity + `secondsToDeadline`. Solve only in `[maturity, deadline]`.
3. `cancelOnChainWithdraw(request)`: only the request's user; returns shares, restores capacity. Not pause-gated.
4. `replaceOnChainWithdraw(old, discount, secondsToDeadline)`: user re-prices (new discount, new deadline) at current rate; does not re-check capacity; maturity clock restarts.
5. `solveOnChainWithdraws(requests[], solveData, solver)`: CAN_SOLVE / SOLVER_ORIGIN role; checks same asset, maturity, deadline for each; removes them; sends all shares to `solver`; optional callback `IBoringSolver.boringSolve`; then pulls `amountOfAssets` from `solver` to each user.
6. `BoringOnChainQueueWithTracking` additionally stores the struct onchain so users can cancel/replace by id (`cancelOnChainWithdrawUsingRequestId`). Portable.

### 5.3 Solver (V)

- `boringRedeemSolve(requests, teller, coverDeficit)` (SOLVER_ORIGIN_ROLE): callback calls `teller.bulkWithdraw(asset, totalShares, 0, solver)` at the **current** rate. If proceeds exceed the fixed `requiredAssets` (the discount), the excess goes to the solver's origin if `excessToSolverNonSelfSolve` (immutable, true for Monad vmUSD per `deployments/skeletons/configurations/Monad/vmUSD.json`) else back to the vault. If short, the solver origin must `coverDeficit` or the whole solve reverts.
- `boringRedeemMintSolve`: redeems from one vault and mints another vault's shares (vault-to-vault migration).
- `boringRedeemSelfSolve(request, teller)`: `request.user == msg.sender`, single request, `excessToSolver=false`, `coverDeficit=false`. So the user gets exactly the locked `amountOfAssets`; any excess from their discount goes back to the vault; any shortfall reverts.

### 5.4 Economics (I)

The discount is the user's price for immediacy and the solver's profit. Fixing the payout at request time means rate drops between request and solve hurt the solver (who must cover) or block the self-solver. Rate rises benefit the solver or vault. It is a solver-market design for vaults whose assets are illiquid or cross-chain. `withdrawCapacity` is a throttle to slow a bank run.

### 5.5 Portability and verdict

- Mechanics (hash-set requests, maturity/deadline, capacity, discount): **Portable** (pure EVM), license forbids copying.
- For us: **Not needed at launch**. If we ever need async exits, the ideas worth keeping are: payout-at-request with bounded user-chosen deadline, user cancel always available and never pausable, capacity throttle, and a rescue function that provably cannot touch escrowed shares. The idea to avoid is making the queue the only exit.

---

## 6. Archived modules (brief)

### 6.1 `src/archive/DelayedWithdraw.sol` (V)

- One request per user per asset: `requestWithdraw(asset, shares, maxLoss, allowThirdPartyToComplete)` escrows shares, snapshots `exchangeRateAtTimeOfRequest`, sets `maturity = now + withdrawDelay`.
- `completeWithdraw(asset, account)`: **user-callable** (or third party if allowed) after maturity and within `completionWindow`. Pays `shares * min(rateAtRequest, rateNow)`, and reverts if the two rates differ by more than `maxLoss` (user-chosen or global, max 50%). Optional `withdrawFee` (max 20%) paid in shares to `feeAddress`.
- `pullFundsFromVault` toggles whether assets come from the vault via `exit` or from funds pre-staged in the contract.
- Still pausable and still requires an unpaused Accountant (`getRateInQuoteSafe`).

Lesson (I): the `min(rate at request, rate now)` rule is a neat anti-arbitrage device: a withdrawer cannot profit from a rate rise during the delay but does bear losses. We get the same protection for free with in-kind exits (the user takes the actual tokens). Portable.

### 6.2 `src/archive/atomic-queue/AtomicQueue.sol` (V)

User sets an `AtomicRequest { deadline, atomicPrice, offerAmount, inSolve }` per (offer, want) pair **without escrow** (just an approval); a permissioned solver `solve(offer, want, users, runData, solver)` pulls offer tokens and pays `offerAmount * atomicPrice` in want. `safeUpdateAtomicRequest` derives the price from the Accountant minus a discount. An OTC limit-order book for exiting shares. Needs a solver. Portable; not relevant for launch.

---

## 7. hypurrquant ERC-7540 redeem queue

Files: `src/vault/UsdcVault.sol`, `src/vault/RedeemLogic.sol`, `src/vault/RedeemQueueLib.sol`, `src/vault/DepositLogic.sol`.

### 7.1 Context (V)

`deposit` pulls USDC, mints at live NAV (`totalAssets()` = EVM USDC + live HyperCore NAV from precompiles + inflight bridge buffer minus accrued fees; virtual offset `1e6/1e6`), then **auto-bridges the USDC to HyperCore** (`_depositToHyperCoreDirect`). So the EVM balance is normally near zero and redemptions need the keeper to pull funds back with `withdrawFromHyperCoreToEVM` (KEEPER_ROLE). Chain-specific plumbing; the queue logic itself is Adaptable.

### 7.2 Lifecycle (V)

| Step | Function | Caller | Key rules |
|---|---|---|---|
| Request | `requestRedeem(shares, controller, owner)` | owner, operator, or allowance holder | `whenNotPaused`; `controller == owner` required ("Finding 6", stops routing a victim's shares into an attacker's queue); max 50 active requests per controller (`MAX_PENDING_REQUESTS_PER_USER`, gas-DoS guard); shares moved to the vault itself (`_transfer(owner, address(this), shares)`); cost-basis slice moved `userDeposits -> lockedPrincipal`; timelock snapshotted (`timelockAtRequest`, default 24 h, min 1 h "to prevent flash-loan abuse", max 7 days). |
| Grace | | | Keeper cannot mark ready within `MARK_READY_GRACE_PERIOD = 10 minutes`, giving the user time to cancel. |
| Mark ready | `markRedeemReady(id)` / `tryBatchMarkRedeemReady(ids)` (max 50, skip on failure) | KEEPER_ROLE | Computes `estimatedAssets = convertToAssets(shares)` **now**, requires `evmBalance - reservedEvmBalance >= estimatedAssets`, stores `_reservedAssetsPerRequest[id]`, bumps `reservedEvmBalance`, snapshots `performanceFeeBps` (fee change also has a 24 h timelock). From here the user can no longer cancel. |
| Claim | `redeem(shares, receiver, controller)` | controller or operator; operator must pay to `receiver == controller` | `whenNotPaused`; FIFO over controller's ready and timelock-expired requests; full-consume then partial-consume the last (principal rounded up, released assets rounded down); per-request fee `max(0, released - principal) * feeBpsSnapshot`; burns shares held by the vault; releases reservation. |
| Cancel | `cancelRedeemRequest(id, controller)` then `claimCancelRedeemRequest(id, receiver, owner)` (ERC-7887) | controller or operator; operator must return to owner | Only while not ready; not pause-gated; restores cost basis. |
| Admin: undo ready | `revertRedeemReady(id)` | ADMIN_ROLE | Releases reservation; request back to pending. |
| Admin: emergency | `emergencyRedeem(id)` | ADMIN_ROLE | Only for pending (not ready, not cancel-pending) requests; pays `min(convertToAssets(shares), reserved, principal)` from free EVM balance respecting others' reservations. User forfeits any gain above cost basis. |
| Disabled | `withdraw(assets,...)`, `mint`, `previewRedeem`, `previewWithdraw` | | Revert, per ERC-7540. |

### 7.3 Notable details

- **Reserved balances (V):** `reservedEvmBalance` is excluded from what the keeper can bridge out (`depositToHyperCore` uses `_evmBalance() - reservedEvmBalance`) and from `claimFees`. This guarantees a marked-ready request is always payable. Tested in `test/unit/OperationalTest.t.sol` `test_reservation_*`. Adaptable.
- **Price exposure after markReady (I):** the requester's payout is fixed at markReady, but their locked shares stay in `totalSupply` and the reserved USDC stays in `totalAssets` until claim. Any NAV move between markReady and claim is therefore borne entirely by the remaining holders. With a 24 h timelock this can be material in a volatile strategy. A cleaner design burns shares (or removes reserved assets from NAV) at the moment the payout is fixed.
- **receiver = controller rule (V):** enforced in `redeem` and `claimCancelRedeemRequest` whenever the caller is an operator. Good pattern: delegation can trigger exits but cannot redirect proceeds. **Improves** on our notes; adopt if we add operators or a platform relayer.
- **Deposit caps (V):** `maxTotalDeposit` (against `totalAssets`) and `maxUserDeposit` (against `userDeposits + lockedPrincipal`, "Finding 3", so users cannot bypass the cap by parking principal in a pending request). `deposit` requires `receiver == msg.sender` to stop multi-wallet cap bypass. Cost basis migrates on share transfers (`_update` -> `NavLib.migrateCostBasisOnTransfer`).
- **Pause (V):** GUARDIAN pauses, ADMIN unpauses. Pause blocks `deposit`, `requestRedeem`, and `redeem` (even for already-ready requests, `test_pause_blocksReadyRedeem`). Cancel remains possible, so users can recover shares but not assets.
- **Keeper disappears (V/I):** pending requests never become ready; users can cancel and hold shares. Funds on HyperCore can only move via KEEPER_ROLE (`withdrawFromHyperCoreToEVM`) or an upgrade (48 h timelock with guardian veto). `emergencyRedeem` only pays from EVM balance, which is near zero because deposits auto-bridge. So in practice depositors wait for an admin to appoint a new keeper. **No offline exit.**
- **Fee snapshot at markReady (V):** defends against an admin raising the fee right before the user loses cancel rights. Adaptable for our performance fee.
- **Tests:** `test_redeem_aggregatesAcrossReadyRequests`, `test_redeem_partialConsumeLast`, `test_partialConsume_prorataPrincipal`, `test_P4_04_redeem_usesSnapshotTimelock`, `test_p3_gracePeriod_userCanCancelDuringGrace`, `test_critical_markReady_insufficientEvmBalance`, `test_emergencyRedeem_revertsOnReady`.

### 7.4 Verdict vs our design

- ERC-7540 async redeem is the right shape **if** we ever need a queue (standard interface, integrators understand it). Adaptable.
- Keeper-gated readiness, pausable claim, and admin-only emergency path all **Conflict** with our offline exit if they were the only path. They are acceptable only as an optional fast path next to `redeemInKind`.

---

## 8. Withdrawals larger than idle assets, and do we need a queue?

### 8.1 How each system handles it

| System | Behavior when request > idle | Label |
|---|---|---|
| BV Teller `withdraw`/`bulkWithdraw` | Reverts (vault `safeTransfer` fails). Strategist must unwind positions via `manage` first, or a `TellerWithBuffer` withdraw helper pulls from an ERC-4626/Aave/Morpho buffer in the same tx (`_beforeWithdraw` -> `vault.manage(...)`). `test/TellerWithBuffer.t.sol` `testWithdrawFailureWhenBufferIsTooSmall`. | V |
| BV Queue | Request waits (maturity up to 30 days); solver unwinds offchain or covers deficit; `withdrawCapacity` throttles total exits. | V |
| HQ | Request waits; keeper pulls USDC from HyperCore then marks ready; `tryBatchMarkRedeemReady` skips requests it cannot cover. No partial fill of a single request. | V |
| Hyperliquid native vaults | Per the brief, positions are closed proportionally when free balance cannot cover a withdrawal. Not in either repo. | From brief |
| Ours | USDC path: pay USDC while above the 10% floor, else sell the withdrawer's pro-rata share of each token through allowlisted pools with oracle min and user min, revert on failure. `redeemInKind`: always transfer pro-rata tokens. | Decided |

Our design is the onchain analogue of Hyperliquid's proportional close: it never asks the manager to unwind, never touches other holders' share of liquidity beyond pro rata, and has an always-available fallback. **Confirms** our direction; both repos are strictly weaker on availability.

### 8.2 Do we need a queue at launch? Recommendation: No.

Reasons (I, based on sections 4-7):
1. Every launch asset (USDC, wrapped MON) is a plain ERC-20 held directly by the vault, so pro-rata in-kind transfer is always possible in one transaction.
2. The oracle-based sell path already reverts safely when a pool is thin; the user then chooses `redeemInKind` or a smaller amount. That is better UX than waiting days in a queue.
3. A queue adds a trusted actor (solver or keeper), pausability, extra state, and a price-exposure window (section 7.3) that we would then have to defend.
4. The lockup already covers the oracle-lag arbitrage a queue's maturity period would otherwise cover.

When we **would** need one (add an ERC-7540-style async redeem next to `redeemInKind`):

| Trigger | Why in-kind or instant sale fails |
|---|---|
| Positions that cannot be split or transferred (concentrated LP NFTs, lending positions with withdrawal delay, staked tokens with unbonding, vesting or locked tokens, cross-chain or offchain positions) | In kind is impossible or delivers an unusable claim; sale needs time. |
| Very thin liquidity where a pro-rata sale would exceed our slippage bound for typical exit sizes | USDC path reverts often; users forced into in kind. A queue lets the manager unwind in tranches. |
| Single exits that are large relative to pool depth (for example more than a few percent of pool TVL) | Same; also sandwich risk. |
| Perps or leveraged positions (not at launch) | Closing needs sequencing; proportional close logic belongs in a keeper. |

Even then the in-kind path must stay, possibly delivering receipt tokens for non-splittable positions (I). Design notes to keep for later: request hash plus event (BV), payout fixed at request or `min(rate at request, rate now)` (BV DelayedWithdraw), user cancel never pausable (both), receiver = controller for operators (HQ), reservation of funds at readiness (HQ), per-user active request cap (HQ, 50), and burn shares at the moment payout is fixed (avoid HQ's exposure gap).

---

## 9. Deposit side comparison

### 9.1 Caps

| | BV | HQ | Ours |
|---|---|---|---|
| Global cap | `depositCap` on share supply (`setDepositCap`) | `maxTotalDeposit` on `totalAssets` | Needed (thin Monad liquidity makes TVL caps useful). Cap in assets is easier to reason about than in shares. |
| Per-user cap | None | `maxUserDeposit` incl. locked principal; `receiver == msg.sender` | Optional; **Improves** if we want guarded launch. |
| Min shares / slippage | `minimumMint` | none (zero-share guard only) | Add `minShares` on deposit (our pricing uses oracles, so users need slippage protection). **Improves.** |

### 9.2 Close to new deposits

BV: per-asset `allowDeposits` or pause (pause also blocks exits). HQ: `maxTotalDeposit` (0 means unlimited, so closing requires a tiny cap) or pause (blocks exits). Neither has a clean "closed" flag. Ours: dedicated flag the leader controls that never touches exits. **Confirms / Improves.**

### 9.3 Deposit refunds

BV only (section 3.3). Not needed for us; it is a discretionary admin power.

### 9.4 TellerWithBuffer (V)

`src/base/Roles/TellerWithBuffer.sol`: per-asset `depositBufferHelper` / `withdrawBufferHelper`, allowlisted by admin, which return `vault.manage` calls executed inside deposit (`_afterDeposit`) and withdraw (`_beforeWithdraw`). Used to auto-park idle funds in an ERC-4626 or lending market and pull them back on exit. Requires the Teller to hold MANAGER_ROLE on the vault. Not relevant at launch (we hold spot only); the hook pattern (`_afterDeposit` / `_beforeWithdraw`) is Portable if we later want idle USDC in a lending market. Note it would make withdrawals depend on an external protocol, which our in-kind path must not.

### 9.5 Leader stake enforcement

Neither repo has any concept of a manager or leader stake (V: grep for stake/ownership minimums in BV `src` and HQ `src/vault` finds nothing). **Missing** in both; we must design it:
- (I) Check `leaderShares * 1e4 >= 500 * totalSupply` after every deposit by others (so new deposits cannot dilute the leader below 5%; reject or cap the deposit) and on every leader exit (leader cannot redeem below 5% while the vault has other depositors).
- (I) Never block other depositors' exits because of the ratio. Exits by others only raise the leader's share.
- (I) On agent sale / handover, the ratio belongs to the new owner; decide whether the stake transfers with the NFT or must be re-posted before trading resumes.
- (I) Leader shares should probably be non-transferable (or tracked as a separate balance) so the ratio cannot be gamed by transferring shares to a friendly address.

---

## 10. Test suites

### 10.1 BoringVault

- **Style (V):** almost all unit tests are **mainnet forks** (`_startFork("MAINNET_RPC_URL", block)`; for example `test/BoringQueue.t.sol` setUp at block 20842935 against the live liquidEth vault, accountant and roles authority). `test/TellerWithBuffer.t.sol` uses `vm.createSelectFork`. Protocol integrations (`test/integrations/*`, about 100 files) are forks exercising merkle leaves against real protocols. Mocks live in `test/mocks` and `test/fuzzing/mocks` (`MockERC20Extended`, `MockRateProvider`, `MockWETH`).
- **Fuzz:** many unit tests take fuzzed amounts with `bound` (for example `testUserRequestsThenSelfSolves(uint128, uint16)`, `testSharePremiumLogicERC20Deposit`).
- **Invariant suite (V):** `test/fuzzing/` with Foundry and Medusa harnesses (`InvariantTestRP.sol`, `InvariantTestYS.sol`, `handlers/TellerHandler.sol`, `handlers/AccountantHandler.sol`, `invariants/BaseInvariants.sol`, `YSOnlyInvariants.sol`), fully local with mocks. Handler actions include `depositMAS`, `withdrawMAS`, `bulkDepositMAS`, `bulkWithdrawMAS`, `refundDepositMAS`, `pauseMAS`, `denyUserMAS`, `setShareLockPeriodMAS`. Invariants (from `test/fuzzing/README.md` and `BaseInvariants.sol`): `integrityOfDeposit`, `integrityOfWithdraw`, `noFreeAssets` (round trip creates no value), `tellerDoesntHoldTokens`, `tellerPaused_methodsRevert`, `dustFavorsTheHouse`, `deniedUsers_balanceNonDecreasing/NonIncreasing`, `vaultSolvency_1Asset`, `vaultSolvencyMulti`, `totalSupplyLEqCap`, `zeroAllowanceOnAssets`, conversion additivity/monotonicity, accountant `highwaterMarkNeverDecreases`, `feesCanOnlyDecreaseViaClaimFees`. The README documents two real findings (a `setFirstDepositTimestamp` bug and a `uint128` truncation in the YS accountant). **No invariant tests cover the queue.** Certora specs exist in `certora/` (sub-agent C territory).

### 10.2 hypurrquant

- **Style (V):** pure local unit tests, no forks. External protocol mocked with `vm.mockCall` at the fixed HyperCore precompile addresses (`test/mocks/MockPrecompiles.sol`: spot balance `0x801`, mark px `0x806`, oracle px `0x807`, spot px `0x808`, token info `0x80C`, margin summary `0x80F`, core user exists `0x810`), plus `MockCoreDepositWallet` and `MockUSDC`. Chain-specific mocks; the technique (mock at a fixed address) is Portable for oracles.
- About 157 tests across `UsdcVault.t.sol` (2067 lines) and `OperationalTest.t.sol` (847), plus `PrecompileNAV.t.sol`, `OrderLib.t.sol`, `DecimalMath.t.sol`. Test names reference audit findings (`test_audit_M04_minDelay`, `test_P4_03_*`, `test_critical_*`).
- **Fuzz:** only `testFuzz_deposit` and `testFuzz_convertRoundTrip`. **No invariant tests.**

### 10.3 Tests to adapt for our vault and Executor

| # | Source test | What it proves there | What to write for us |
|---|---|---|---|
| 1 | BV `test/fuzzing` `invariant_noFreeAssets` | deposit then withdraw never returns more than deposited | Round trip via USDC path and via `redeemInKind` never returns more value (at oracle price) than deposited, including across oracle updates within the lockup. |
| 2 | BV `invariant_dustFavorsTheHouse` | rounding favors vault | Every mint/burn rounds in vault's favor; sum of in-kind payouts <= pro-rata balances. |
| 3 | BV `invariant_vaultSolvency_1Asset` / `vaultSolvencyMulti` | assets back all shares | For every token, `balance >= sum of every holder's pro-rata claim` (trivially true in kind; guards against accounting bugs). |
| 4 | BV `invariant_tellerPaused_methodsRevert` | paused methods revert | Inverse for us: **`redeemInKind` succeeds under every pause, circuit breaker, oracle failure, handover mode, Executor disabled, and platform key revoked.** Make this a handler-driven invariant. |
| 5 | BV `invariant_deniedUsers_*` | deny list freezes balances | Inverse: no admin or manager action can reduce a user's share balance or block their `redeemInKind`. |
| 6 | BV `invariant_totalSupplyLEqCap` | cap holds | `totalAssets <= cap` after deposits; leader stake >= 5% after every deposit and leader exit. |
| 7 | BV `invariant_tellerDoesntHoldTokens`, `invariant_zeroAllowanceOnAssets` | no stray balances or allowances | Executor holds no tokens and leaves zero allowances after each intent (matches our "exact approvals reset"). |
| 8 | BV `testMultipleDepositsWithShareLockPeriod`, `testShowDepositAndTransferLogic`, `testHookLogic` | lock resets on deposit; locked shares cannot move | Lockup blocks all exits and transfers until expiry; third party cannot extend someone else's lock; leader lockup extension does not affect existing deposits. |
| 9 | BV `testUserPermitDepositWithFrontRunning` | front-run permit does not DoS | Same for our permit deposit. |
| 10 | BV `testSharePremiumLogicERC20Deposit` | per-asset haircut math | Buy/sell spread math, bounded by a max constant. |
| 11 | BV `testRedeemSolveCoverDeficit`, DelayedWithdraw `testExchangeRateDecreasesAfterRequest` | behavior when price moves during delay | USDC sell path with oracle moving within one tx sequence: user min and oracle min both enforced; revert leaves state untouched. |
| 12 | BV `test/TellerWithBuffer.t.sol` `testWithdrawFailureWhenBufferIsTooSmall` | clean revert when liquidity short | USDC path reverts when pool depth is insufficient; `redeemInKind` still succeeds in the same state. |
| 13 | BV `testQueueRescueTokenReverts` | rescue cannot take user funds | Any rescue/sweep function cannot move vault tokens or shares. |
| 14 | HQ `test_depositCap_userLimit`, `test_userDeposits_capBypass_blocked`, `test_maxDeposit_respectsUserCap_includesLocked` | per-user cap cannot be bypassed | If we add per-user caps. |
| 15 | HQ `test_requestRedeem_revertsIfOwnerNotController`, operator receiver rule in `redeem` | delegation cannot redirect proceeds | If we add operators/relayers: proceeds always to owner. |
| 16 | HQ `test_pause_blocksReadyRedeem` | pause blocks claim | Inverse test for us (see #4). |
| 17 | HQ `test_performanceFee_*`, `test_fee_accrualPattern`, fee snapshot at markReady | fee only on profit, fee rate snapshot | Performance fee above HWM: no fee on loss, fee change cannot hit in-flight exits (timelock). |
| 18 | HQ `test_redeem_stillWorksWhenFeeRecipientBlacklisted` | exit independent of fee recipient | Our exits must not call the fee recipient or any external contract except the tokens (in kind) or allowlisted pools (USDC path). |
| 19 | HQ `MockPrecompiles` technique | mock fixed-address reads | Mock oracles with `vm.mockCall` for staleness, deviation, zero price, revert; plus fork tests on Monad for Uniswap pools (BV `ChainValues._addMonadValues` has addresses). |
| 20 | BV `test/fuzzing` handler structure | actor-based handlers, pre/post snapshots | Model handlers: depositor, leader, Executor session key, emergency role, oracle updater, pool price mover, agent sale/handover. |

---

## 11. Decision comparison summary

| Our decision | Evidence | Verdict |
|---|---|---|
| Offline `redeemInKind`, unpausable, oracle-free | Neither repo has it; BV exits need roles, three unpaused contracts, rate, idle funds; HQ needs keeper and unpaused vault | **Conflicts** (both repos violate it). Keep ours; add invariant #4. |
| Managers never take funds | BV BURNER/MINTER roles can burn any holder's shares; `TellerWithRemediation` can move shares after 3 days; `refundDeposit` burns within lock | **Conflicts** with BV trust model. Our burn must be `msg.sender`-only. |
| Lockup (1 day, extendable) | BV share lock, hard max 3 days; HQ redeem timelock min 1 h, max 7 days, snapshotted per request | **Confirms**; **Improves**: hard max constant, snapshot at deposit, no third-party relock. |
| Buy/sell spread | BV per-asset `sharePremium` (max 10%), queue discount (max 30%) | **Confirms**; per-asset spread is an improvement. |
| Limits only on buys, never on exits | BV applies `withdrawCapacity`, deny lists, pauses to exits | **Confirms** that we are stricter; do not import exit throttles. |
| Proportional sale when USDC below floor | Neither repo; both wait for operator | **Confirms** ours is better on availability. |
| Close to new deposits | BV per-asset flag or pause; HQ cap or pause | **Improves**: separate flag that never touches exits. |
| Leader >= 5% | Not in either repo | **Missing**: design needed (section 9.5). |
| Performance fee above HWM (deferred) | HQ per-request cost-basis fee with rate snapshot and 24 h fee-change timelock | **Improves** (fee change timelock, snapshot). |
| Visibility | BV `Deposit` event with nonce, lock period, referral; queue full-struct events | **Confirms**; emit full structs for indexers. |
| Queue at launch | Not needed (section 8.2) | Recommendation: no queue; ERC-7540-compatible later. |

---

## 12. Open questions

1. Monad vmUSD live roles: are `requestOnChainWithdraw` and `boringRedeemSelfSolve` actually public on chain 143? The skeleton config omits `allowPublicWithdrawals` / `allowPublicSelfWithdrawals`. Needs `RolesAuthority.isCapabilityPublic` reads at `0xA1299741...` for queue `0xAd6b8d86...`.
2. Who holds OWNER on the vmUSD Teller/RolesAuthority, and is there any timelock (Phase 0 recorded Timelock `0x0`)? This determines how quickly Veda could pause or seize.
3. Should `redeemInKind` respect the lockup? This note infers yes (oracle-lag arbitrage). Confirm with the team, since it means a depositor in the first 24 h has no exit at all, which is a deliberate trade-off.
4. Lockup granularity: per address (BV, simple, relocks whole balance) vs per deposit lot (fairer, more storage). Which do we want given the leader can extend?
5. Should third parties be allowed to deposit for a receiver at all? HQ forbids it; BV role-gates it.
6. How exactly should the 5% leader stake interact with (a) deposits that would dilute below 5% (reject vs partial), (b) handover on agent sale, (c) leader share transfers?
7. Pool-depth thresholds that would trigger adding a queue: what exit size relative to Uniswap pool TVL on Monad makes the USDC path revert too often? Needs data, not code.
8. HQ post-markReady price exposure (section 7.3): confirm by test that remaining holders absorb NAV moves between markReady and claim. Not runnable here.
9. BV `TellerWithRemediation` role wiring: the deploy script does not add capabilities for the remediation functions, so only the Auth owner can call them by default. Confirm there is no separate script that grants them.
10. Do we want an `excessToVault`-style rule for our USDC sell path (if a sale beats the oracle minimum, surplus goes to the user, not the vault)? Our current design implies the user keeps it; confirm.
