# B. Allowances, rate limits, and state

Sub-agent B working notes. Scope: allowances, rate limits, onchain state, pricing, oracles, time, and how far the Roles Modifier gets toward our hard limits.
Repo HEAD `820e5bc9` (main, Roles v2). v3 read via `git show origin/contracts-v3:<path>` (HEAD `47dd69bd`, 2026-07-20, BUSL-1.1 until 2030-03-01).
Labels: **[V]** = Verified (read in code), **[I]** = Inferred.
All paths are relative to `packages/evm/contracts/` unless stated.

---

## 1. v2 allowance data model

### 1.1 Struct and storage

`Types.sol`:

```solidity
struct Allowance {
    uint128 refill;     // added to balance after each period
    uint128 maxRefill;  // refilling stops once balance reaches this
    uint64 period;      // seconds; 0 = one-time allowance, never refills
    uint128 balance;    // remaining
    uint64 timestamp;   // time of last refill (anchor)
}
struct Consumption { bytes32 allowanceKey; uint128 balance; uint128 consumed; }
```

- Storage: `_Core.sol` `mapping(bytes32 => Allowance) public allowances;` **[V]**. It is a single flat mapping per Roles instance, keyed by an arbitrary `bytes32`. It is not namespaced by role, target or function **[V]**.
- The public getter `allowances(key)` returns the **stored** values, not the accrued balance **[V]** (no accrued view in v2; v3 adds `accruedAllowance(key)` in `core/Setup.sol`).

### 1.2 Who can set allowances

`PermissionBuilder.sol` `setAllowance(key, balance, maxRefill, refill, period, timestamp)` is `onlyOwner` **[V]**. Defaults: `maxRefill == 0` is stored as `type(uint128).max`, `timestamp == 0` is stored as `block.timestamp` **[V]**. It overwrites the whole struct (including balance), emits `SetAllowance` **[V]**. There is no role-level or module-level setter; only the Roles owner (for us, the account owner or whatever contract owns the modifier) can create or reset allowances **[V]**. Consumption is the only non-owner write path **[V]**.

Note: `packages/docs/content/general/allowances.mdx` has a callout "Allowance management is available for Roles Modifiers owned by a Zodiac OS account". This is a product/UI statement; onchain `setAllowance` has no such gate **[V]** (only `onlyOwner`).

### 1.3 Accrual math (`AllowanceTracker._accruedAllowance`)

```solidity
if (allowance.period == 0 || blockTimestamp < allowance.timestamp + allowance.period)
    return (allowance.balance, allowance.timestamp);
uint64 elapsedIntervals = (blockTimestamp - allowance.timestamp) / allowance.period;
if (allowance.balance < allowance.maxRefill) {
    balance = allowance.balance + allowance.refill * elapsedIntervals;
    balance = balance < allowance.maxRefill ? balance : allowance.maxRefill;
} else { balance = allowance.balance; }
timestamp = allowance.timestamp + elapsedIntervals * allowance.period;
```

Behavior **[V]**:
- Discrete, **fixed-window** refills anchored at `timestamp`. Refill happens only after a whole `period` elapses; partial periods accrue nothing. The anchor advances by whole periods (`timestamp + n*period`), so windows stay aligned to the original anchor (e.g. if set to 00:00 UTC with period 86400, windows are UTC days).
- Refill is additive (`balance + refill*n`) capped at `maxRefill`. Unused balance carries over up to the cap. If `balance >= maxRefill` (e.g. owner set balance above cap), no refill but the balance is kept and fully spendable (test `Allowance.spec.ts` "balance above maxRefill gets consumed") **[V]**.
- A future `timestamp` means no accrual until `timestamp + period` (test "Does not update timestamp from future timestamp" in `test/operators/28WithinAllowance.spec.ts`) **[V]**.
- `refill * elapsedIntervals` is `uint128 * uint64` in checked arithmetic, so extremely large refill values with many elapsed intervals would revert (overflow) rather than wrap **[I]** (Solidity 0.8 checked math; v3 fixes this by widening to uint256 in `AllowanceConsumer.accrue`).
- Storage is only touched when consumed; accrual is computed lazily on read **[V]** (`PermissionLoader._consumptions` calls `_accruedAllowance`).

### 1.4 Units

All allowances are unitless `uint128` counters **[V]**:
- `WithinAllowance`: the raw 32-byte ABI word of the parameter in scope, read by `AbiDecoder.word` and treated as `uint256` (`PermissionChecker._withinAllowance`) **[V]**. So raw token units (USDC 6 decimals, WETH 18 decimals). A single key cannot meaningfully mix tokens of different decimals or prices **[I]**.
- `EtherWithinAllowance`: `context.value` (wei of the call's `msg.value`) **[V]** (`_etherWithinAllowance`).
- `CallWithinAllowance`: constant `1` per evaluation **[V]** (`_callWithinAllowance`).
- Integrity: `WithinAllowance` requires `paramType Static`; `EtherWithinAllowance` / `CallWithinAllowance` require `paramType None`, no children, and a parent whose paramType is `Calldata` (`Integrity.sol` `_tree`, `UnsuitableParent`) **[V]**. Compvalue is exactly 32 bytes (the key) **[V]**.

### 1.5 Consumption within one transaction (`Consumptions.sol`, `PermissionChecker.__consume`)

- On `_load`, `PermissionLoader._consumptions` builds one `Consumption` entry per distinct allowance key referenced anywhere in the function's condition tree, with `balance` = accrued balance at `block.timestamp`, `consumed` = 0 **[V]**.
- `__consume(value, ...)`: fails with `AllowanceExceeded` if `value + consumed > balance`; else clones the array and adds `value` to `consumed` **[V]**. So all references to the same key within one call accumulate (test "Consumes balance, even with multiple references to same allowance", "Fails, when multiple parameters referencing the same limit overspend") **[V]**.
- Logical operators and consumption **[V]** (`PermissionChecker._and/_or/_nor/_array*`, tests in `test/Allowance.spec.ts`):
  - `And` / `Matches`: consumptions thread through children; a failing branch returns the original (unconsumed) list.
  - `Or`: first passing branch's consumption is kept; failing branches discarded ("consumption in falsy Or branch gets discarded").
  - `Nor`: children consumption is never propagated.
  - `ArraySome`: counted once (first matching element). `ArrayEvery`: counted for every element. `ArraySubset`: counted for matched elements.
- Multi-call (MultiSend via `ITransactionUnwrapper`): `_multiEntrypoint` threads `result.consumptions` through each inner tx and `Consumptions.merge` adds consumed amounts per key, keeping the first-seen balance **[V]**. So a key shared across several inner calls is enforced cumulatively across the batch (tests "consumptions with overlap overspend") **[V]**.

### 1.6 Flush to storage, events, revert behavior

`Roles.sol` (all four exec entry points follow the same pattern) **[V]**:

```solidity
Consumption[] memory consumptions = _authorize(roleKey, to, value, data, operation);
_flushPrepare(consumptions);           // write balance - consumed, new timestamp
success = exec(to, value, data, operation);
if (shouldRevert && !success) revert ModuleTransactionFailed();
_flushCommit(consumptions, success);   // success: emit ConsumeAllowance; failure: restore balance
```

- `_flushPrepare` (`AllowanceTracker.sol`) writes `balance - consumed` and the advanced timestamp **before** execution, asserting the recomputed balance equals the one used during checking **[V]**. Writing before exec means a reentrant call through the avatar sees the reduced balance **[I]** (v2 has no `nonReentrant`; this pre-flush is the reentrancy defense).
- `_flushCommit`: on success emits `ConsumeAllowance(key, consumed, newBalance)`; on failure (`shouldRevert=false` or `execTransactionFromModule*`) restores `balance` to the accrued pre-consumption value; timestamp stays advanced (harmless, equivalent state) **[V]**. No event on failure (test "does not raise ConsumeAllowance, when inner transaction reverts, shouldRevert=false") **[V]**.
- If `shouldRevert=true` and the inner call fails, the whole tx reverts, so nothing persists **[V]**.
- If the condition check fails, `_authorize` reverts `ConditionViolation(status, info)`; `info` carries the allowance key on `AllowanceExceeded` **[V]**.

### 1.7 Sharing keys

- Any condition in any role on any target/function can reference any key; the key is just the compValue **[V]** (`PermissionLoader._consumptions` reads `allowances[compValues[i]]`). So one key can be a shared budget across roles, targets, selectors and across the three allowance operators (mixing units is the configurer's problem) **[V]/[I]**.
- Keys are per Roles modifier instance. There is no sharing across two modifiers (e.g. PersonalAccount's modifier vs StrategyVault's modifier) **[V]** (storage is in the instance).

### 1.8 WithinAllowance vs EtherWithinAllowance vs CallWithinAllowance

| Operator | Measures | paramType | Placement | Status on fail |
|---|---|---|---|---|
| WithinAllowance (28) | raw uint256 calldata word | Static | any static leaf | AllowanceExceeded |
| EtherWithinAllowance (29) | msg.value (wei) | None | direct child of Calldata node | EtherAllowanceExceeded |
| CallWithinAllowance (30) | 1 per evaluation | None | direct child of Calldata node | CallAllowanceExceeded |

All three share the same `__consume` path and storage **[V]**.

---

## 2. Mapping our hard limits onto v2 allowances

### 2.1 "Per day" semantics precisely

Only fixed-window token-bucket style refill exists **[V]**. No rolling window, no sliding log of timestamps **[V]**.

- "20 trades per day" as `setAllowance(key, 20, 20, 20, 86400, midnight)` with `CallWithinAllowance` in every swap selector's tree: at most 20 per anchored day window, but up to 40 within a few seconds across a window boundary (20 at 23:59:59, 20 at 00:00:00) **[I]** from the math in 1.3.
- A strict rolling bound can be approximated by a smaller bucket: e.g. `maxRefill = 10, refill = 1, period = 9600` (10 refills per 86400 s). In any 24 h window, consumption is at most `maxRefill + refill events in the window` which is about 10 + 10 = 20 **[I]**. Cost: burst capacity drops to 10. Precise off-by-one at window edges should be tested.
- Placement problem for "trades": `CallWithinAllowance` counts evaluations of the condition node, so it must be added to every swap-capable selector (exactInputSingle, exactInput, exactOutput*, multicall, execute, etc.) with the same key. If a router `multicall(bytes[])` bundles N swaps, it counts 1 unless the tree descends into the array and places the counter per element (`ArrayEvery` counts every element) **[I]** (Integrity requires parent paramType `Calldata`; the inner `bytes` elements of multicall can be typed as `AbiType.Calldata`, so a per-element counter looks possible but I did not test it).

### 2.2 Max trade size

- Per-trade absolute cap: native via `LessThan` on `amountIn` (static compValue, raw units, per token) **[V]** (`_compare`). Not an allowance.
- `WithinAllowance` is cumulative, not per-trade **[V]**. A per-trade cap via allowance would need `balance = refill = maxRefill = cap` and `period = 1` second, which still allows multiple trades per block/second; not a real per-trade limit **[I]**.
- Relative to account value (10%): not expressible natively in v2. Compvalues are static; no operator reads balances or prices **[V]** (full operator list in `Types.sol`; `_compare` only reads calldata).

### 2.3 Daily turnover

- Per token, raw units: native via `WithinAllowance` on `amountIn` with a daily refill **[V]**. One key per input token, because units are raw **[I]**.
- Denominated in USD across tokens: not in v2 **[V]**; yes in v3 via priced allowances (section 4.2).
- Relative to account value (e.g. 100% of NAV per day): not native in any version **[I]**.

---

## 3. Oracles, custom conditions, post-trade checks, time (v2)

### 3.1 Custom conditions (`Operator.Custom`, `periphery/Types.sol` `ICustomCondition`)

```solidity
function check(address to, uint256 value, bytes calldata data, Operation operation,
    uint256 location, uint256 size, bytes12 extra)
    external view returns (bool success, bytes32 reason);
```

- Called from `PermissionChecker._custom` (a `private view` function) through an interface declared `view`, so it is a STATICCALL **[V]** (Solidity emits staticcall for view external calls). It cannot write state **[V]**.
- Context received: target `to`, `value`, the **full** calldata of the (inner) tx, operation, location/size of the value in scope, and 12 bytes of `extra` from the compValue (the other 20 bytes are the checker address) **[V]**. It does not receive the role key, the module/sender, or the avatar directly; `msg.sender` is the Roles modifier, so the checker can call `IModifier(msg.sender).avatar()` as `periphery/AvatarIsOwnerOfERC721.sol` does **[V]**.
- There is no try/catch around it in v2; a revert inside the checker reverts the whole authorization **[V]**. Returning `false` yields `CustomConditionViolation` with `reason` as info **[V]**.
- Custom conditions **cannot** consume allowances in v2 (they return only bool + reason) **[V]**.
- Docs `general/conditions.mdx` "Custom conditions": must not maintain per-tx state because the checker cannot know whether the tx will execute **[V]**.
- Can a custom checker do oracle reads? Yes, it is a normal view call and can read Chainlink feeds, pool `slot0`, `block.timestamp`, avatar token balances **[I]** (nothing in the call path forbids it; gas is the only limit). Therefore freshness (`block.timestamp - updatedAt < 300`) and oracle-vs-pool deviation (`|spot - oracle| < 2%`) are implementable in a custom checker we write and audit **[I]**. Account value (sum of balances times oracle prices) is also computable pre-trade **[I]**.

### 3.2 Post-execution hooks

None **[V]**. After `exec` returns, v2 only runs `_flushCommit` (emit or restore) in `Roles.sol`; v3 only runs `_persist` (`core/Settlement.sol`). Nothing inspects balances or return data. So "verify balance after swap", "post-trade portfolio composition", and "actual slippage" cannot be enforced by Roles **[V]**. Workarounds **[I]**: (a) route swaps through our own executor contract that checks post-conditions and reverts, with Roles only allowing calls to that contract; (b) use a MultiSend batch whose last call is a view-like "assert" contract that reverts (Roles would need to allow that call; the assert contract reads balances post-swap in the same tx). Both put the logic outside Roles.

### 3.3 Time and deadlines

- No operator compares against `block.timestamp` **[V]** (grep of `packages/evm/contracts` on main: `block.timestamp` only in `AllowanceTracker.sol`, `PermissionLoader.sol`, `PermissionBuilder.sol`). `GreaterThan`/`LessThan` compare to a static compValue fixed at `scopeFunction` time **[V]**.
- A "deadline <= now + 120 s" check therefore needs a Custom condition reading `block.timestamp` and the deadline word at `location` **[I]**. Uniswap's own `deadline` check (`checkDeadline` in the router) enforces `block.timestamp <= deadline` but not that the deadline is short **[I]** (external to this repo).
- No role expiry, validity windows or usage counts in v2 **[V]** (`Role.members` is `mapping(address => bool)`, `Roles.assignRoles`).
- No epochs **[V]**. Role keys are arbitrary `bytes32`, so an epoch could be baked into role keys or into a Custom condition's `extra` (e.g. checker reads `EpochRegistry.current(account)` and compares to the epoch encoded in `extra`) **[I]**. With monotonic epochs, stale permissions would fail automatically and could not come back on an NFT round-trip **[I]**.

---

## 4. v3 (origin/contracts-v3, BUSL-1.1)

### 4.1 Allowance changes

- `types/Allowance.sol`: same struct; `Consumption` gains `uint64 timestamp` **[V]**.
- `common/AllowanceConsumer.sol` `accrue`: same fixed-window semantics, but widened math (`uint256(a.refill) * elapsedIntervals`), explicit `blockTimestamp <= a.timestamp` guard, and timestamp advances even when balance is at cap **[V]**. `consume`: `amount > entry.balance - entry.consumed` fails; copy-on-write list **[V]**.
- Keys are accrued lazily on first touch (`_findOrAccrue`) rather than pre-scanned from the tree **[V]**.
- `EtherWithinAllowance` removed; `WithinAllowance` accepts `paramType EtherValue` instead (`types/Operator.sol`) **[V]**. `CallWithinAllowance` kept **[V]**.
- Persistence: `Roles._execWithRole` calls `_persist` **only after successful exec**; no pre-flush and no restore step; all exec entry points are `nonReentrant` **[V]** (`Roles.sol`, `core/Settlement.sol`). Failed inner exec with `shouldRevert=false` persists nothing **[V]**.
- `setAllowance` and new `updateAllowance(key, maxRefill, refill, period)` (keeps balance and timestamp) are `onlyOwner` **[V]** (`core/Setup.sol`). New view `accruedAllowance(key)` **[V]**.

### 4.2 Priced allowances (`core/evaluate/WithinAllowanceChecker.sol`)

compValue layout: `allowanceKey(32) | balanceDecimals(1) | inputDecimals(1) | adapter(20) | adapterParams(...)`, trailing parts optional **[V]**.

```solidity
(status, price) = PriceLoader.load(adapter, params);
return _ceilDiv(value * 10**(precision - inputDecimals) * price,
                10**(precision - balanceDecimals) * 1e18);
```

- Converts the input to balance units with an 18-decimal price, rounding the consumed amount **up** **[V]**. So one USD-denominated key can cover USDC, WETH, WMON and the LST legs **[V]** (docs `general/price-adapters.mdx` "Denominated Allowances").
- Overflow of `value * scale * price` reverts (checked math) **[I]**.

### 4.3 PriceLoader and IPricing

- `IPricing.getPrice(bytes params) view returns (uint256 price)`, 18 decimals **[V]**.
- `common/PriceLoader.load`: adapter `address(0)` means price 1e18; otherwise extcodesize check, `staticcall`, 32-byte result, nonzero; each failure maps to a status (`PricingAdapterNotAContract/Reverted/InvalidResult/ZeroPrice`) rather than a revert **[V]**. No staleness or deviation logic in core; that is the adapter's job **[V]**.
- contracts-v3 ships **no production adapter**, only mocks (`__test__/mocks/MockPricing.sol`) **[V]** (no `periphery/pricing/` in `git ls-tree`).

### 4.4 WithinRatio (`core/evaluate/WithinRatioChecker.sol`)

- Compares two values previously captured by `Pluck` (operator 14) into `context.pluckedValues` **[V]**. compValue: `refPluckIdx, refDecimals, relPluckIdx, relDecimals, minRatio(uint32 bps), maxRatio(uint32 bps)` plus optional ref and rel adapter blobs (`len | adapter | params`) **[V]**.
- Each side: `value * 10**(precision - decimals) * price` (price 1e18 when no adapter) **[V]**.
- Check, exact cross-multiplication, no truncation: `rel*10000 < ref*minRatio` gives `RatioBelowMin`; `rel*10000 > ref*maxRatio` gives `RatioAboveMax`; 0 disables a bound; overflow reverts **[V]**. (Branch `fix/allowance-rounding` commit `0e52fad6` had an earlier floor/ceil fix; contracts-v3's current cross-multiplied version supersedes it **[V]**.)
- Plucked values come only from calldata or ether value (`ConditionEvaluator._pluck` / `__input`) **[V]**. It cannot reference account balances or NAV **[V]**.
- Intended use: slippage, e.g. `amountOutMinimum * priceOut >= 9950 bps of amountIn * priceIn` (docs `general/price-adapters.mdx`, test "ETH/USD swap - validates output within slippage tolerance" in `test/operators/23WithinRatio.spec.ts`) **[V]**. This is exactly our "max 0.5% slippage relative to oracle" if the adapter is an oracle **[I]**.

### 4.5 Custom conditions in v3

`periphery/interfaces/ICustomCondition.sol` **[V]**:

```solidity
function check(address to, uint256 value, bytes calldata data, Operation operation,
    uint256 location, uint256 size, bytes calldata extra, bytes32[] calldata pluckedValues)
    external view returns (bool success, AllowanceConsumption[] memory consumptions);
```

- `extra` is now arbitrary-length (compValue after the 20-byte address), the checker receives plucked values, and it can return allowance consumptions that core applies through `AllowanceConsumer.consume` (`core/evaluate/CustomConditionChecker.sol` `_applyConsumptions`) **[V]**. So a custom checker could compute a USD or NAV-relative amount and have core consume it **[I]**. Called via `staticcall`; reverts and malformed results become statuses **[V]**.
- (Branch `proposal/custom-condition-consumptions` `b98a47ef` is the proposal; the feature is present in contracts-v3 HEAD.) **[V]** for presence on contracts-v3; relation between the two is **[I]**.

### 4.6 Chainlink / Uniswap / Consensus adapters (unmerged branches)

- `origin/feat/chainlink-pricing` `periphery/pricing/ChainlinkPricing.sol` **[V]**: params `(address feed, bool invert, uint256 maxAge)`; reverts `InvalidAnswer` if `answer <= 0`; reverts `StalePrice` if `updatedAt == 0 || block.timestamp - updatedAt > maxAge`; normalizes to 18 decimals, inverted price computed as `ceil(1e36 / answer)`; all divisions round up ("never understated"). No `answeredInRound`/roundId check and no L2 sequencer-uptime check **[V]**. Rounding up is conservative for allowance consumption, but for a WithinRatio minRatio check on the relative side it is slightly lenient (tiny, sub-wei of price) **[I]**.
- `origin/codex/pricing-adapters-generic-api` (older, March 2026) **[V]**: `ChainlinkPricing` variant with constructor `maxAge` and optional `answeredInRound < roundId` check; `UniswapPricing` (Uniswap V3 `observe` TWAP with immutable `twapWindow`, params `(pool, invert)`); `ConsensusPricing` (params `(PriceSource[] sources, uint256 maxDeviationBps)`, returns mean, reverts `DeviationExceeded` if any source deviates from the mean by more than `maxDeviationBps`).
- ConsensusPricing(Chainlink, UniswapTWAP) is the closest thing to "oracle within 2% of pool price" **[I]**, with caveats: it compares to the mean (with 2 sources, pairwise gap = 2 x per-source deviation, so 2% pairwise needs `maxDeviationBps = 100`) **[I]**; it uses a TWAP, not spot `slot0`; `UniswapPricing` only works on V3-style pools with `observe()` (not Uniswap v4 singleton pools) **[I]**.
- None of these adapters is on contracts-v3 HEAD, none audited per the repo (audit PDFs in `packages/evm/docs/` are 2023, v2) **[V]** for absence in tree; audit status **[I]**.

### 4.7 Membership windows and usage counts (`core/Membership.sol`)

- `roles[roleKey].members[module]` is a packed uint256: `startTimestamp(64) | endTimestamp(64) | usesLeft(128)` **[V]**. `_authenticate` reverts `MembershipNotYetValid` / `MembershipExpired`; `usesLeft == uint128.max` means unlimited; otherwise decremented on successful exec, and at 0 the membership is deleted with `RevokeRole` **[V]** (`core/Settlement._persist`, tests in `test/membership.spec.ts`).
- `grantRole(module, roleKey, start, end, usesLeft)` is `onlyOwner`; `renounceRole` by the module itself **[V]** (`core/Setup.sol`).
- Useful for time-boxed session keys and "N actions then re-grant" **[I]**. It is not a per-day rate limit (no refill) and not a per-tx deadline **[V]**.
- Still no operator comparing a parameter to `block.timestamp` in v3 **[V]** (grep: `block.timestamp` only in `AllowanceConsumer.sol`, `Membership.sol`, `Setup.sol`). Deadline enforcement still needs a Custom condition **[I]**.
- `execTransactionWithSignature` (EIP-712 `RoleTx` with `salt`) lets an enabled module sign and a relayer submit; there is no signature expiry field in `RoleTx` (`core/RoleTx.sol`) **[V]**. So a signed intent has no built-in deadline; only the salt prevents replay **[V]**.

---

## 5. Requirements for the percentage-based limits

| Limit | What is needed | v2 | v3 |
|---|---|---|---|
| Max 10% of account value per trade | NAV (sum of balances x prices) at check time, compare to priced amountIn | Custom checker: reads avatar balances + oracles, prices `amountIn`, compares to 10% | Same, or custom checker returns consumption; WithinRatio cannot (NAV not pluckable) |
| Max 40% of account value in any non-USDC asset | Post-trade holdings of output token vs NAV | Pre-trade projection in Custom checker (balances + worst-case output). No post-exec check, so actual output above min can exceed projection **[I]** | Same |
| At least 10% USDC | Post-trade USDC balance vs NAV | Pre-trade projection in Custom checker (USDC out = amountIn if selling USDC) | Same |
| Circuit breaker (7-day peak) | Stateful peak tracking | Custom checkers are stateless; needs an external keeper-updated or self-updating tracker contract read by the checker **[I]** | Same |

All of these are Inferred designs; nothing in the repo implements them.

---

## 6. Hard-limit mapping

Native = expressible with shipped operators and config only. Partial = expressible with caveats or an approximation. Custom = requires our own ICustomCondition / adapter / wrapper contract. Not supported = not possible inside Roles.

| Hard limit | v2 (main) | v3 (contracts-v3) |
|---|---|---|
| Allowed assets only | Native (EqualTo/Or on token params) | Native |
| Max 10% of account value per trade | Not supported natively; Custom | Not native; Custom (can also return consumption) |
| Max 40% in any non-USDC asset | Not supported; Custom pre-trade projection only | Same |
| At least 10% in USDC | Not supported; Custom pre-trade projection only | Same |
| Max 0.5% slippage vs oracle | Not supported natively; Custom | Partial/Native: WithinRatio + IPricing adapter (adapter not shipped in v3 HEAD; Chainlink adapter on unmerged branch) |
| Max 20 trades per day | Partial: CallWithinAllowance, fixed anchored window (boundary burst up to 2x) or smaller bucket for strict rolling bound | Partial: same; usesLeft membership adds a hard total cap |
| Daily turnover (raw units per token) | Native (WithinAllowance per token key) | Native |
| Daily turnover in USD across tokens | Not supported | Native via priced WithinAllowance (needs adapter) |
| Max trade size absolute | Native (LessThan on amount, per token) | Native; also USD-priced via WithinAllowance with period 1 is still cumulative, so LessThan or Custom |
| 2-minute deadline | Not supported natively; Custom (reads block.timestamp) | Same |
| Oracle < 5 min old | Custom | Partial: ChainlinkPricing `maxAge` (unmerged branch) reverts on stale feed inside WithinRatio/WithinAllowance |
| Oracle within 2% of pool | Custom | Partial: ConsensusPricing(Chainlink, UniswapTWAP) (unmerged, TWAP not spot, V3 pools only) or Custom |
| Circuit breaker (7-day peak) | Not supported; external state + Custom | Same |
| Epochs / stale permissions | Not supported; owner revokes, or Custom epoch check | Partial: membership start/end/usesLeft; epochs still Custom |
| Post-trade balance verification | Not supported (no post-exec hook) | Not supported |

---

## 7. Open questions

1. Uniswap on Monad: is our venue V3-style (with `observe`) or v4 (PoolManager singleton, hooks)? `UniswapPricing` only supports V3 `observe`, and v4 swap calldata (Universal Router `execute(bytes,bytes[],uint256)`) is hard to decode for WithinRatio/Pluck **[I]**. Needs Sub-agent covering swap decoding.
2. Is there a Chainlink (or Pyth/Redstone) feed on Monad for MON, WETH, our LST, with known heartbeat? ChainlinkPricing assumes AggregatorV3.
3. Will GG DAO merge `feat/chainlink-pricing` / ConsensusPricing into v3, and will v3 be audited before release? BUSL-1.1 terms for production use on Monad need legal review (Additional Use Grant text not reviewed here).
4. Exact CallWithinAllowance counting inside router `multicall(bytes[])` via ArrayEvery: needs a test.
5. Custom checker gas: NAV computation over 4 assets with oracle reads per trade; acceptable on Monad but unmeasured.
6. Can the pre-trade projection for 40% / 10% limits be made sound without a post-exec check? Probably only if we bound output with oracle price x (1 + tolerance) or use exact-output swaps; otherwise route through our own executor with a post-check.
7. v2 `_accruedAllowance` overflow on large `refill * elapsedIntervals`: confirm practical bounds for our configs (small values, unlikely to matter).
8. v3 `execTransactionWithSignature` has no expiry: if we use signed relaying, deadline must come from calldata + Custom check or from membership `endTimestamp`.
