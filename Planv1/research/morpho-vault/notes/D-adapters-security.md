# D. Adapters, extensibility, and security (Morpho Vault V2)

Sub-agent D. Repo `/home/dhrupatel/agent_tool/vaults` at commit `9ee4dbdc`. All line numbers refer to that commit.
Labels: **Verified** = read in code or in the audit PDF text. **Inferred** = reasoning, general knowledge, or design sketch.
Audit text was extracted with pypdf into the session scratchpad (not in the repo).

---

## 1. How adapters plug into the vault

### 1.1 The interface (Verified, `src/interfaces/IAdapter.sol` lines 6-19)

```solidity
function allocate(bytes memory data, uint256 assets, bytes4 selector, address sender)
    external returns (bytes32[] memory ids, int256 change);
function deallocate(bytes memory data, uint256 assets, bytes4 selector, address sender)
    external returns (bytes32[] memory ids, int256 change);
function realAssets() external view returns (uint256 assets);
```

- `data`: opaque bytes chosen by the caller (allocator, sentinel, liquidity config, or forceDeallocate caller). Each adapter decodes it (MarketParams for the Blue adapter, must be empty for the Vault V1 adapter).
- `assets`: amount of the vault's single `asset` moved.
- `selector`: the vault passes `msg.sig`, i.e. the vault entry point that triggered the call (`allocate`, `deallocate`, `deposit`, `mint`, `withdraw`, `redeem`, `forceDeallocate`). **Verified** `VaultV2.allocateInternal` line 588, `deallocateInternal` line 617.
- `sender`: the vault passes its own `msg.sender` (the allocator, sentinel, depositor, or forceDeallocate caller). Same lines.
- Return `ids`: the cap buckets this position belongs to. Return `change`: signed delta of the position's value since the last time the vault recorded it. The vault adds the **same** `change` to **every** returned id (lines 590-593, 619-623).
- `realAssets()`: current value of everything the adapter holds, in units of `asset`. Summed with the vault's idle balance on the first accrual of each transaction (`accrueInterestView`, lines 670-678).

The loose adapter spec is NatSpec in `src/VaultV2.sol` lines 70-92 (Verified). Key rules:
1. Only the vault may call allocate/deallocate.
2. Enter/exit markets only inside allocate/deallocate.
3. Return correct, non-repeating ids.
4. After deallocate the vault must have approval to pull at least `assets` from the adapter.
5. Deallocate must be possible (for in-kind redemptions via forceDeallocate).
6. realAssets ignores markets with zero allocation.
7. Must not re-enter the vault; the curator must not use markets that can.
8. Sum of returned changes for a market must equal its current estimated position.
9. Entry/exit losses should stay negligible compared to gas (lines 87-89). This is the rule a swap adapter violates (see section 2).

Liveness requirements (lines 122-129, Verified): adapters must not revert on `realAssets`, and must not revert on deallocate if the underlying market is liquid.

### 1.2 Token flow on allocate / deallocate (Verified)

| Step | allocate (`allocateInternal`, lines 582-603) | deallocate (`deallocateInternal`, lines 610-629) |
|---|---|---|
| Auth | `allocate` requires `isAllocator[msg.sender]` (line 578). Also reached from `enter` via liquidity adapter (line 791). | `deallocate` requires allocator or sentinel (line 606). Also reached from `exit` (line 817) and permissionless `forceDeallocate` (line 844). |
| Adapter check | `require(isAdapter[adapter])` line 583 | line 614 |
| Accrual | `accrueInterest()` line 585 | **none** (Spearbit 2025-05 L 5.3.10 noted this; current code still does not accrue here) |
| Tokens | vault **pushes** `assets` to adapter with `safeTransfer` **before** calling it (line 587) | vault calls adapter first, then **pulls** `assets` with `safeTransferFrom(asset, adapter, vault, assets)` (line 626). Adapter must have approved the vault. |
| Cap checks | for each id: allocation += change; require absoluteCap > 0, allocation <= absoluteCap, and relativeCap == WAD or allocation <= firstTotalAssets * relativeCap (lines 595-600) | for each id: require allocation > 0 before applying change (line 621). No cap checks on the way out. |

Both shipped adapters grant the vault an unlimited approval in their constructors (`MorphoVaultV1Adapter` line 47, `MorphoMarketV1AdapterV2` line 81) and unlimited approval to their yield source (lines 48 and 80). Spearbit 2025-09 I 5.2.4 "Adapter Approvals" flagged this as a design choice; Spearbit arbitrary-ERC4626 M 5.1.4 recommends atomic approvals for untrusted yield sources (acknowledged, not changed).

Note: the vault only ever handles one token, `asset` (immutable, line 197). It never approves anything itself, never calls arbitrary targets, and has no generic `execute`. **Verified** (grep of `src/VaultV2.sol`: the only external calls are to `asset`, adapters, gates, the adapter registry, and `address(this)` via multicall).

### 1.3 Adding and removing adapters (Verified)

- `addAdapter(account)` lines 429-440: curator-submitted, timelocked (`timelocked()` lines 362-370). If `adapterRegistry != 0`, requires `IAdapterRegistry(adapterRegistry).isInRegistry(account)`. Pushes to `adapters[]` and sets `isAdapter`.
- `removeAdapter(account)` lines 442-455: timelocked, swap-and-pop from `adapters[]`. No check that the adapter is empty. NatSpec lines 90-92: remove only when empty, and keep an id exclusive to the adapter with cap 0 so no allocator can put funds in during the removal timelock (this comment was added for Blackthorn 2025-09 M-2).
- `setAdapterRegistry(new)` lines 413-427: timelocked; checks every existing adapter is in the new registry. The "all adapters are in registry" invariant only holds if the registry is add-only (lines 101-102; Certora `Invariants.spec` `adaptersAreInRegistry`).
- Registries (`src/periphery/registries/`):
  - `MorphoMarketV1RegistryV2.isInRegistry` = factory's `isMorphoMarketV1AdapterV2[adapter]`.
  - `MorphoVaultV1Registry.isInRegistry` = adapter came from the adapter factory AND its `morphoVaultV1()` is a MetaMorpho from the MetaMorpho factory.
  - `RegistryList`: owner-controlled append-only list of sub-registries; true if any sub-registry says true. Owner can only add (lines 37-42), so it is add-only if sub-registries are.
- Adapter factories record `isX[adapter] = true` and deploy with CREATE2 salt 0 (`MorphoVaultV1AdapterFactory` lines 16-22, `MorphoMarketV1AdapterV2Factory` lines 30-37).

Relevance for us (Inferred): if we set `adapterRegistry` to our own add-only registry (or abdicate `addAdapter`), depositors get a hard guarantee that only our audited swap adapters can ever hold vault funds. That is the V2 equivalent of "only the Executor path can move assets".

### 1.4 The two shipped adapters (Verified)

**`MorphoVaultV1Adapter.sol`** (117 lines). Wraps a MetaMorpho (or, with caveats, any ERC4626).
- One id: `adapterId = keccak256(abi.encode("this", address(this)))` (line 44).
- allocate: `deposit(assets)` into the ERC4626, then `newAllocation = previewRedeem(balanceOf(adapter))`, returns `newAllocation - vault.allocation(adapterId)` (lines 69-80). So each touch re-marks the whole position.
- deallocate: `withdraw(assets)` then same re-mark (lines 84-98). Tokens stay in the adapter; the vault pulls them.
- realAssets: `previewRedeem(shares)` but returns 0 if allocation is 0 (lines 111-116). The zero-allocation rule was added after ChainSecurity CS-MORPHO-VLT2-020 (donated positions counting).
- skim: owner-set `skimRecipient` can sweep any token except the vault's ERC4626 shares (lines 51-65).

**`MorphoMarketV1AdapterV2.sol`** (284 lines). Supplies to many Morpho Blue markets.
- Three ids per market: adapter id, `("collateralToken", collateral)`, `("this/marketParams", adapter, marketParams)` (lines 268-274). Shared ids let the curator cap exposure to a collateral across markets.
- Tracks its own `supplyShares[marketId]` so donated Blue shares are ignored ("Donated shares are lost forever", line 30). Requires `mintedShares >= assets` (line 191) to reject manipulated share prices.
- `marketIds` list is maintained on zero crossings (`updateList`, lines 234-246); realAssets loops over it (276-283).
- Has its own timelock system (submit/revoke/abdicate), and `burnShares` to write off a broken market (lines 162-167).
- Only markets with the adaptive curve IRM (line 185), so interest can be computed in a view (`AdaptiveCurveIrmLib.expectedMarketBalances`).

**Pattern worth copying (Inferred):** both adapters return `change = freshValue - vault.allocation(id)` computed from the adapter's own accounting, and never trust balances that can be donated.

### 1.5 An existing precedent for "a contract as allocator" (Verified)

`src/periphery/blue-public-allocator/BluePublicAllocator.sol` is a contract that must hold the vault's allocator role. It exposes permissionless `reallocate` / `allocateFromIdle`, applies its own per-vault policy (active adapters, own absolute caps, penalty), then calls `IVaultV2(vault).deallocate(...)` and `.allocate(...)` (lines 114-163) and re-checks `vault.allocation(id)` after the call (lines 138, 162). Its configuration is set by accounts that are allocators on the vault (`require(IVaultV2(vault).isAllocator(msg.sender))`, lines 70-106). Our Executor-as-allocator would have the same shape.

---

## 2. Could our Executor be the vault's only adapter or allocator?

### 2.1 What each role can do (Verified)

| Role | Powers over funds | Timelocked? |
|---|---|---|
| Owner | setOwner, setCurator, setIsSentinel, name/symbol (lines 315-343) | No |
| Curator | submit/revoke; after timelock: setIsAllocator, gates, adapterRegistry, add/removeAdapter, increase caps, fees, forceDeallocatePenalty, timelocks, abdicate. Can decrease caps instantly (537-566). | Increases yes |
| Allocator | `allocate`, `deallocate`, `setLiquidityAdapterAndData`, `setMaxRate` (lines 577-649) | No |
| Sentinel | `deallocate`, `revoke`, decrease caps | No |
| Anyone | `forceDeallocate` (with penalty charged to `onBehalf`, needs share allowance if caller != onBehalf) | No |

### 2.2 Option A: Executor as the only allocator, with no custom adapter

Does not work on its own (Verified). An allocator can only move `asset` between the vault and registered adapters. There is no vault function to approve a router, call Uniswap, or hold a second token. A swap therefore has to happen inside an adapter.

### 2.3 Option B: Executor as the adapter holding non-USDC tokens

Technically possible (Inferred sketch):
- `allocate(data, assets, selector, sender)`: receives `assets` USDC from the vault, decodes `data = (tokenOut, route, minOut, deadline)`, swaps USDC to tokenOut on Uniswap, returns ids `[adapterId, ("token", tokenOut), ("risk-assets")]` and `change = oracleValue(position) - vault.allocation(tokenId)`.
- `deallocate(data, assets, ...)`: exact-output swap tokenIn to `assets` USDC, leave it approved for the vault to pull.
- `realAssets()`: sum over held tokens of `internalBalance * oraclePrice`.

But making the Executor itself the adapter mixes two jobs: a policy engine called by our session key, and a custody contract that must only be called by the vault. A bug or upgrade in policy code would then directly expose custody. It also puts depositor funds in the Executor, which conflicts with the brief's model that the Executor moves assets but assets stay in the vault. Not recommended.

### 2.4 Option C (best fit if we reuse V2): Executor = sole allocator, plus dumb per-token SwapAdapters

- Executor holds the allocator role (granted via timelocked `setIsAllocator`). It enforces our limits (10% per trade, 40% per asset, 10% USDC floor, 0.5% slippage, 20 trades/24h, epochs, circuit breaker) and then calls `vault.allocate(swapAdapter, data, usdcIn)` to buy or `vault.deallocate(swapAdapter, data, usdcOut)` to sell.
- Each SwapAdapter (one per token, e.g. WETH, WMON, LST) only accepts calls from the vault, checks `sender == executor` for allocator-driven calls, and uses `selector` to apply a strict oracle-derived `minOut` when called from `forceDeallocate`, `withdraw`, or `redeem` (the caller's `data` is untrusted there). Exact approvals to the router, reset after each swap.
- Caps map neatly onto our limits:
  - per-token id `relativeCap = 0.40e18` gives the 40% max per non-USDC asset,
  - a shared id `("risk-assets")` returned by every SwapAdapter with `relativeCap = 0.90e18` gives the "at least 10% USDC" floor,
  - absolute caps as a hard ceiling.
  Caps are checked only on allocate (lines 590-601), against `firstTotalAssets` (start-of-transaction NAV). Price moves after the trade can push a token above 40% without any revert (NatSpec line 55-56 "Relative caps are soft"). So the Executor still has to enforce these itself; vault caps are a backstop.
- Sentinels (deallocate + cap decrease, not timelocked) map onto our circuit breaker and handover mode: a platform or owner sentinel can sell to USDC and zero the caps, making the vault reduce-only.
- Curator should set `adapterRegistry` to an add-only registry of our SwapAdapter factory, and consider abdicating `addAdapter`, `setIsAllocator`, `setReceiveAssetsGate`, `setSendSharesGate` once configured (abdication: lines 478-482, Certora `AbdicatedFunctions.spec`).

### 2.5 Why the V2 model is a poor fit for spot trading (key findings)

1. **Upside is rate-limited, downside is immediate.** `newTotalAssets = min(realAssets, _totalAssets * (1 + maxRate * elapsed))` (lines 677-678) with `MAX_MAX_RATE = 200% APR` (`ConstantsLib.sol`). 200% APR is about 0.55% per day. A 10% move on a 40% WETH position is 4% of NAV in a day, which V2 would dribble out over roughly a week, while a 4% drop is recognized at once. **Verified** formula; consequences **Inferred**.
   - Undistributed gains can be captured by new depositors who enter below true value (Blackthorn 2025-09 M-5 "Delayed yield can be stolen", documented in NatSpec lines 47-48).
   - Performance fee is charged on `newTotalAssets - _totalAssets` (line 679), with no high-water mark. After a loss, recovery is charged again. Our product needs an HWM. **Verified**.
2. **Every swap is an entry/exit loss.** Pool fee plus slippage (up to 0.5%) on each allocate/deallocate. NatSpec lines 87-89 says curators should not use markets with big entry/exit losses. Blackthorn 2025-09 M-4 shows that because totalAssets is frozen within a transaction (`firstTotalAssets`, line 671), a lossy adapter used as **liquidity adapter** lets an attacker deposit and withdraw in one transaction and push the loss onto others, repeatedly. Therefore a SwapAdapter must never be the liquidity adapter. **Verified** finding; applicability **Inferred**.
3. **Valuation depends on an oracle, and realAssets must never revert.** If a SwapAdapter's `realAssets` reverts on a stale oracle, `accrueInterest` reverts and all deposits, withdrawals, and forceDeallocate are bricked (liveness requirement line 124). If it instead returns 0 or a stale price, the share price jumps. Either way the non-negotiable "withdraw while we are offline" rule is at risk if the oracle stops. Morpho's adapters avoid this because lending positions are valued by deterministic interest math, not market prices. **Inferred**.
4. **Stale-NAV arbitrage.** A spot price is visible off-chain before our oracle updates (5-minute staleness, 2% deviation window). Depositors can redeem ahead of a known drop. The vault's once-per-transaction accrual only stops flash-loan share shorting (NatSpec lines 32-33), not this. ChainSecurity CS-MORPHO-VLT2-001 and Blackthorn H-1 (both risk accepted) describe the lending version. For a volatile-asset vault this becomes a daily event. Mitigations (deposit lockup, entry/exit fee, withdrawal delay) are not in V2. A lockup cannot be built from gates alone because gates are `view` and get no amount or timestamp (`canSendShares(account)`, lines 929-944). **Inferred**.
5. **Withdrawals do not close positions proportionally.** `exit` uses idle USDC, then only the single `liquidityAdapter` (lines 815-818). If idle is short and there is no liquidity adapter, the final `safeTransfer` reverts. The user must call `forceDeallocate` per adapter (paying up to 2%, `MAX_FORCE_DEALLOCATE_PENALTY`) and then redeem. This is an in-kind exit path that works without our platform (good), but it is not Hyperliquid-style proportional close. A periphery router could batch it. **Verified** mechanics; product gap **Inferred**.
6. **One `change` for all ids.** A single adapter cannot move value from a WETH id to a MON id in one call (lines 590-593). Token-to-token trades must go through USDC (two swaps, two fees) or use per-token adapters with a multi-hop route inside one side. **Verified** mechanics.
7. **forceDeallocate becomes a forced market sell.** Anyone can make a SwapAdapter sell up to its allocation. With penalty 0 this is free griefing and a sandwich target (Spearbit 2025-05 M 5.2.4, acknowledged). The penalty must exceed the adapter's allowed slippage plus pool fee so sandwiching a forced sell is unprofitable. **Inferred**.

**Bottom line (Inferred):** Option C is workable and inherits a lot of audited machinery (roles, timelocks, abdication, caps, gates, in-kind exit, sentinel de-risking). But the share-price engine was built for slowly accruing lending yield. For a spot vault we would at least have to (a) fork the accrual logic to remove or widen the maxRate clamp and add an HWM, (b) make oracle failure non-bricking, and (c) add anti-arbitrage entry/exit friction. Once we fork VaultV2, the audits no longer cover us. The alternative is a purpose-built vault that copies V2's patterns (see section 6) rather than its code.

---

## 3. Audits

Counts are from each report's summary table. "Fix status" quotes the report. Several early findings target code that no longer exists (VIC interest controllers, `realizeLoss`). The current code has neither (grep of `src/`: no `vic` or `realizeLoss`, **Verified**).

### 3.1 Summary table

| PDF | Auditor | Dates / commit | Scope | C | H | M | L | Info/Gas |
|---|---|---|---|---|---|---|---|---|
| 2025-05-19-spearbit.pdf | Spearbit | May 20 to Jul 11 2025; `77aa7c5b` (report dated Oct 13 2025) | Full VaultV2 v1 incl. VICs, MetaMorpho/MorphoBlue adapters | 0 | 1 | 6 | 14 | 15 info, 3 gas |
| 2025-07-15-zellic.pdf | Zellic | May 22-29 + Jul 14-17 2025; `77aa7c5b` | VaultV2, factory, adapters, vic, libs | 0 | 0 | 1 | 3 | 1 |
| 2025-07-15-competition.pdf | Cantina competition | Jul 15-25 2025; `5938a924` | vault-v2 | 0 (High) | - | 3 | 9 | 19 (only H/M published) |
| 2025-08-11-spearbit.pdf | Spearbit fix review | Aug 10 to Sep 12 2025; `ce661d82` (PR 723, 724) | diffs | 0 | 0 | 0 | 7 | 6 |
| 2025-09-15-spearbit.pdf | Spearbit fix review | 3 phases Jul to Nov 25 2025; `4bba946b..6f2af660` | diffs (same 13 findings as 08-11, plus abdicated fix PR 758) | 0 | 0 | 0 | 7 | 6 |
| 2025-09-15-blackthorn.pdf | Blackthorn (Sherlock) | Aug 13-20 2025; `ce661d82` to final `6f2af66` | VaultV2, factory, both adapters, libs | - | 1 | 5 | 18 low/info | |
| 2025-09-15-chainsecurity.pdf | ChainSecurity | May 19 to Sep 15 2025; 6 versions, final `6f2af660` | VaultV2, factory, adapters, VIC (removed after V3) | 1 | 0 | 5 | 6 | 5 |
| 2025-12-04-market-v1-adapter-v2-blackthorn.pdf | Blackthorn | Nov 24-27 2025; `169044ef` to `425f6b1f` | MorphoMarketV1Adapter(V2) + AdaptiveCurveIrmLib | - | 0 | 0 | 8 low/info | |
| 2025-12-04-market-v1-adapter-v2-certora.pdf | Certora (manual) | Dec 9-15 2025; `425f6b1` + PRs | MarketV1AdapterV2, factory, registries | 0 | 0 | 0 | 2 | 4 |
| 2025-12-04-market-v1-adapter-v2-spearbit.pdf | Cantina Managed (Spearbit) | Nov 24 to Dec 6 2025; `169044ef`, holistic check at `425f6b1f` | MarketV1Adapter + IRM lib | 0 | 0 | 0 | 0 | 2 |
| 2025-12-04-fee-wrapper-spearbit.pdf | Spearbit | "Jan 7th to Jan 9th" (year not printed; report dated Aug 11 2026); `425f6b1f` | Config: VaultV2 supplying into one child VaultV2 via MorphoVaultV1Adapter, add/removeAdapter abdicated | 0 | 0 | 0 | 0 | 2 |
| 2025-12-04-vault-v1-adapter-arbitrary-erc4626-spearbit.pdf | Spearbit | "Jan 7th to Jan 9th"; report dated Sep 21 2026; `425f6b1f` | VaultV2 + MorphoVaultV1Adapter into arbitrary ERC4626 | 0 | 0 | 4 | 5 | 2 |
| 2026-07-08-gates-blackthorn.pdf | Blackthorn | Jun 10-11 2026; `ffa22a60` to `549b1131` | WhitelistSendAssetsGate, WhitelistReceiveSharesGate | - | 0 | 0 | 1 | |
| 2026-08-13-blue-public-allocator-blackthorn.pdf | Blackthorn | Jul 30 to Aug 2 2026; `10f16971` to `2b139002` | BluePublicAllocator | - | 1 | 4 | 7 low/info | |
| 2026-08-13-blue-public-allocator-spearbit.pdf | Spearbit | Jul 29-31 2026; `10f16971`, holistic check `2b139002` | BluePublicAllocator | 0 | 0 | 0 | 6 | 11 |

All Blackthorn reports state "Issues Not Fixed and Not Acknowledged: 0 / 0 / 0".

### 3.2 Every Critical, High, and Medium finding

**Spearbit 2025-05 (`2025-05-19-spearbit.pdf`)** (H: 1 fixed; M: 4 fixed, 2 acknowledged)
- 5.1.1 High, "Side effects of underlying directly donated to the VaultV2 or adapters positions". Status: Fixed/Verified (PR 347). Morpho acknowledged the residual part: donated funds deliberately do not raise the share price instantly. Current code: donations count via `balanceOf` but are clamped by maxRate (lines 39, 673-678).
- 5.2.1 Medium, rounding down in forceDeallocate lets anyone skip the penalty. Fixed (PR 389). Current: `mulDivUp` at line 845.
- 5.2.2 Medium, `interestPerSecond` precision in ManualVic. Acknowledged. VIC later removed.
- 5.2.3 Medium, exchange rate skew when totalSupply = 0 and totalAssets != 0. Fixed with decimal offset (PR 497) and a comment (PR 524). Current: `virtualShares = 10**max(0, 18 - decimals)` (lines 305-309), plus a seeding advice comment (lines 40-46).
- 5.2.4 Medium, forceDeallocatePenalty = 0 lets anyone deallocate everything. Acknowledged (curator responsibility; comment PR 397).
- 5.2.5 Medium, forceDeallocate lets a user dodge losses and dump them on others. Fixed at the time with incentivized `realizeLoss` (PR 337). Since superseded: losses are now realized automatically in `accrueInterest`.
- 5.2.6 Medium, losses not accounted before share math in deposit/withdraw. Same fix path as 5.2.5. Now superseded by automatic realization in `accrueInterestView`.

**Zellic (`2025-07-15-zellic.pdf`)**
- 3.1 Medium, "First deposit attack as a consequence of interest accrual" (truncation inflates one remaining share). Acknowledged in commit `40767bf9` with a comment: vaults must be seeded. Current NatSpec lines 40-46.

**Cantina competition (`2025-07-15-competition.pdf`)** (report lists no fix statuses)
- 3.1.1 Medium, ManualVic forgets interest after its deadline. Code removed (no VIC in current src).
- 3.1.2 Medium, incorrect loss calculation in `realizeLoss` because allocations lag `_totalAssets`. Code removed (no `realizeLoss`).
- 3.1.3 Medium, SingleMorphoVaultV1Vic double counts losses when vault balance exceeds idle (donations or penalties). Code removed.

**Blackthorn 2025-09 (`2025-09-15-blackthorn.pdf`)**
- H-1, "Fixed total assets within a transaction allow for avoiding underlying market bad debt loss" (depositor touches the vault, liquidates bad debt, exits at the pre-loss price, all in one transaction). **Acknowledged, won't fix**. Morpho: recomputing within the transaction would re-enable share-shorting via flash loans. Directly relevant to us: any in-transaction price move (a swap, an oracle update) is invisible until the next transaction.
- M-1, withdraw/redeem have no slippage parameter. Resolved by comment (line 37: "a check must be performed on top").
- M-2, assets could be allocated to an adapter about to be removed. Resolved by comment (lines 90-92).
- M-3, relative cap can block deposits through the liquidity adapter. Resolved by comment (lines 110-112).
- M-4, honest users lose funds if adapters have deposit fees (frozen totalAssets plus liquidity adapter lets an attacker loop deposit/withdraw). Acknowledged, comment added (lines 87-89).
- M-5, delayed yield can be stolen (maxRate clamp and forceDeallocate penalties create a claimable backlog). Acknowledged, documented (lines 47-48): keep maxRate near the real rate.

**ChainSecurity (`2025-09-15-chainsecurity.pdf`)**
- CS-016 Critical, "totalAssets Can Be Manipulated": attacker gifts a supply position in a self-made Blue market to the adapter, then uses forceDeallocate(0) plus oracle manipulation to register a huge fake loss. Code corrected: losses bounded by allocation, and ids with absoluteCap 0 can never hold allocation. Current: `require(_caps.absoluteCap > 0)` line 595, `require(_caps.allocation > 0)` line 621, internal share accounting in the Blue adapter.
- CS-001 Medium, "Users Can Escape Losses" (redeem before a predictable loss is realized). **Risk accepted.**
- CS-019 Medium, assets double counted in the Blue adapter's market list. Code corrected (list updated on both allocate and deallocate; Certora `MarketIds.spec`).
- CS-020 Medium, unallocated Vault V1 adapter can report donated assets. Code corrected (`realAssets` returns 0 when allocation is 0, line 113).
- CS-002 Medium, fee inconsistency when realizing a loss (order of fee vs loss). Code corrected.
- Medium, "Low-level STATICCALL Results in Reading Dirty Memory" (VIC call). Code corrected; VIC removed.

**Market V1 Adapter V2 reviews (Blackthorn, Certora, Cantina, Dec 2025):** no C/H/M. Notables: Certora L-02 "Users can sandwich scheduled burnShares to shift losses to others" (acknowledged); Cantina I 3.1.2 burned shares unrecoverable (fixed PR 841).

**Fee-wrapper config (Spearbit):** no C/H/M. Both infos (forceDeallocate needed on the child vault to exit the parent; allocator/force-deallocate symmetry) acknowledged.

**Arbitrary ERC4626 via MorphoVaultV1Adapter (Spearbit)** (all 11 acknowledged, none fixed). These are the most relevant findings for a custom adapter:
- 5.1.1 Medium, allocate does not revert if newAllocation is 0 or no shares minted (inflation attack). Morpho: too strict; per-operation loss must just be small relative to gas.
- 5.1.2 Medium, no slippage protection in adapter deallocate/allocate. Spearbit suggested encoding max shares in `data` and using the `selector` argument to apply it selectively. Morpho: use only inflation-protected vaults; slippage checks on withdraw just brick exits.
- 5.1.3 Medium, no check that the adapter's balance rose by exactly `assets` on withdraw (donated tokens could mask a short withdrawal). Acknowledged.
- 5.1.4 Medium, use atomic approvals and balance-delta checks when depositing into the yield source. Acknowledged.

**Gates (Blackthorn 2026-07):** 1 Low (docs said gates never revert while `canSendAssets` can). Resolved in PR 933; current NatSpec lines 151-166 no longer claims gates never revert.

**BluePublicAllocator, Blackthorn 2026-08:**
- H-1, real exposure to a compromised oracle can exceed vault caps by orders of magnitude (public refills after bad debt keep allocation "within cap"). **Acknowledged, won't fix.**
- M-1, flat native penalty allows profitable IRM manipulation and griefing. **Resolved.**
- M-2, a liquidator can shift Blue bad debt to the vault (allocateFromIdle, then exit own supply, then liquidate). Acknowledged.
- M-3, BPA risk-raising settings take effect instantly (no timelock, unlike VaultV2). Acknowledged.
- M-4, BPA can be used to grief vault liquidity (move idle into a market that the public cannot pull from; exits then pay forceDeallocate penalty). Acknowledged.

**BluePublicAllocator, Spearbit 2026-08:** no C/H/M (6 Low: 2 fixed, 4 acknowledged). Several Lows mirror the Blackthorn mediums (5.1.2 bad debt shift, 5.1.3 rate manipulation, 5.1.4 strip withdrawal liquidity).

**Lesson for our Executor (Inferred):** the BPA findings are exactly the class of risk our Executor adds. An allocator contract with non-timelocked policy knobs lets whoever controls it (or anyone, if public) route vault funds into places depositors did not get to review. The Executor's policy changes should be timelocked relative to depositors, or at least only reduce risk instantly.

---

## 4. Certora formal verification (`certora/README.md`, 39 confs/specs)

**Verified**: README lines 7-104 list the properties; rule names read from specs.

| Theme | Spec | What is proven |
|---|---|---|
| Core invariants | `Invariants.spec` | fee <= max, fee != 0 implies recipient != 0, relativeCap <= WAD, maxRate bound, penalty bound, `balanceOf(0) == 0`, `totalSupplyIsSumOfBalances`, `balanceOfLeqTotalSupply`, allocations fit int256, `adapters[]` and `isAdapter` consistent and distinct, virtualShares bounds, `adaptersAreInRegistry` (add-only registry assumed) |
| Accounting | `TotalAssetsChange.spec` | deposit/mint add exactly assets, withdraw/redeem subtract exactly, forceDeallocate subtracts exactly its rounded-up penalty, every other entry point leaves `_totalAssets` unchanged |
| | `TotalAssetsIsUpToDate.spec` | every state-changing entry point accrues before reading `_totalAssets` |
| | `AllocationVaultV2.spec` | allocations change only via ERC4626 entry/exit (only with liquidity adapter), allocate, deallocate, forceDeallocate |
| | `AllocationsHierarchy.spec` | a group id's allocation equals the sum of its leaves |
| Share price | `ExchangeRate.spec` | `sharePriceIsIncreasing` (seeded, mgmt fee 0, after first accrual), `lossRealizationDecreasesSharePrice`, protocol-favoring rounding on all four ops |
| | `PreviewFunctions.spec` | previews equal actual results; preview never reverts if the op can succeed |
| | `RoundTrip.spec` | 10 round-trip rules (deposit-redeem, mint-withdraw, etc.) cannot create value |
| | `EntrypointEquivalence.spec` | deposit and mint (withdraw and redeem) are equivalent internally |
| Adapter ids | `Ids*`, `Allocation*Adapter*`, `Changes*`, `MarketIds.spec` | fixed distinct ids; each returned id changes by exactly the reported change and others untouched; allocation equals expected position after each call; zero-asset allocate and deallocate report the same change; no change makes allocation negative; market list distinct and no zero-allocation entries |
| Caps and timelocks | `RelativeCaps.spec` | relative caps preserved |
| | `EarliestTime.spec` | a timelocked call cannot execute before its computed earliest time, which never moves backward |
| | `AbdicatedFunctions.spec` | abdicated functions cannot be called, abdication permanent |
| | `Immutability.spec` | every DELEGATECALL targets the vault itself |
| Auth and liveness | `Reverts`, `AllocateDeallocateReverts`, `AllocateDeallocateInputValidation`, `AccrueInterestReverts` | exact revert conditions; allocate rejects ids with absoluteCap 0, deallocate rejects ids with allocation 0; accrual does not revert under stated bounds |
| | `Liveness`, `OwnerSafety`, `SentinelLiveness`, `SentinelLivenessDeallocate*` | curator/sentinel can always zero caps; owner can always set owner/curator/sentinel; sentinel can always revoke and deallocate when underlying is liquid |
| | `ForceDeallocate.spec` | `canForceDeallocateZero`: forceDeallocate(0) stays callable (given gates admit exit, adapter returns valid values, accrual live) |
| | `RemoveMarketLiveness.spec` | a liquid Blue position can be fully deallocated and removed |
| Gates and tokens | `Gates.spec` | cannot-receive users never gain shares, cannot-send users never lose shares, vault-initiated asset moves respect asset gates |
| | `TokensNoAdapter`, `Tokens*Adapter*` | exact balance changes for sender, receiver, vault on deposit/withdraw |
| | `Skim*` | skim does not change reported assets; skim recipient auth |
| Reentrancy | `Reentrancy.spec` | `reentrancySafe`: no external call outside the vault, registered supported adapters, asset, Morpho Blue, MetaMorpho |
| | `ReentrancyView.spec` | no external static call between storage writes (read-only reentrancy) |

Modeling assumptions (README lines 106-114): bounded loops; adapter calls summarized at vault level; tokens modeled as standard, false-returning, or USDT-style; **fee-on-transfer and reentrant tokens not supported**; multicall removed and covered by induction.

---

## 5. Known pitfalls and how the code handles them

| Pitfall | How V2 handles it | Evidence | Carries over to our spot vault? |
|---|---|---|---|
| Reentrancy | **No guard.** Relies on trust assumptions: adapters must not re-enter (NatSpec 78-79), token must not re-enter (118), curator must avoid re-entering markets. Deallocate has lint suppression "adapters are trusted to not reenter" (line 616). Certora `Reentrancy.spec` proves the only external calls go to the trusted set. The reason is gas and a closed set of trusted callees. | Verified | Partly. Our SwapAdapters call Uniswap routers and pools, which are non-reentrant into our vault. But Uniswap v4 hooks or unusual tokens could call back. Inferred: add a guard in the adapter, or restrict pools to hookless ones. |
| Rounding | Deposit and redeem round shares/assets down; mint and withdraw round up (lines 702-727). Penalty rounds up (845). Fees round down (667, 681-696). Relative cap check rounds down (598). Virtual share + 1 virtual asset. | Verified; Certora `ExchangeRate`, `RoundTrip` | Yes, copy directly. |
| Inflation / first depositor | Decimal offset `virtualShares = 10**(18 - decimals)` (USDC gives 1e12) plus 1 virtual asset; advice to seed the vault (40-46). | Verified | Yes. Also our 5% leader stake doubles as a seed. |
| Fee-on-transfer and rebasing | Not supported (114-120). Vault balance must only decrease on transfer. Positive rebases act as donations (clamped by maxRate). | Verified | USDC is fine. For held tokens (LST), the adapter must use non-rebasing wrappers and internal balance accounting. Inferred. |
| Donations | Vault donations count via `balanceOf` but share price can rise no faster than maxRate (39, 673-678). Blue adapter ignores donated shares; Vault V1 adapter returns 0 when allocation is 0. | Verified; tests `testAccrueInterestDonationNoSkip/Skip` | Yes. Our adapters should track internal token balances, never raw `balanceOf`. |
| Oracle dependence | Vault itself uses no oracle. Adapter valuation for Blue comes from interest math (`expectedMarketBalances`); Blue market oracles matter only for bad debt. | Verified | **No.** Our realAssets would be oracle-priced. Must never revert and must be manipulation-resistant. Biggest new risk. Inferred. |
| Flash-loan manipulation of caps and share price | `firstTotalAssets` is transient and captures NAV once per transaction; accrual happens once per transaction; relative caps check against it (62-68, 657, 671). Shares may be flash-loanable but not loanable over time (32-33). | Verified; test `testRelativeCapManipulationProtection` | Yes, same mechanism useful. Side effect: in-transaction losses are invisible (Blackthorn H-1, M-4). |
| Front-running interest accrual or loss | Interest is clamped by maxRate, so no big upward jump to front-run. Losses are realized on the first touch per transaction, so a depositor who predicts a loss can exit first (CS-001, Blackthorn H-1, both accepted). | Verified | Worse for spot: price moves are frequent and visible. Needs lockup or exit fee. Inferred. |
| Griefing of withdrawals: allocator drains idle | Allocators can allocate all idle and point the liquidity adapter anywhere. Users keep an in-kind exit: `forceDeallocate` is permissionless, penalty at most 2% (`MAX_FORCE_DEALLOCATE_PENALTY`), penalty stays in the vault. Documented at 175-177. | Verified | Yes. Our Executor must keep the 10% USDC floor and must not expose `setLiquidityAdapterAndData` or `setMaxRate` to the session key. |
| Griefing via gates | `receiveAssetsGate` and `sendSharesGate` can lock users out; a reverting `receiveSharesGate` blocks everything (153-166). Gate changes are timelocked. `canReceiveAssets` always allows `address(this)` so forceDeallocate penalties work even if the gate blocks the vault (938; test `testForceDeallocateWithBlockedVault`). | Verified | Yes. Abdicate the exit-side gate setters if we do not need them. |
| Griefing via forceDeallocate with 0 penalty | Anyone can pull all funds to idle (Spearbit M 5.2.4, acknowledged). | Verified | For us it forces market sells: set penalty above max slippage plus fee. Inferred. |
| Bad or malicious adapter | Adapter is trusted: can return any ids/change. Spearbit 2025-09 L 5.1.7: a buggy adapter returning a huge change can freeze shared ids. Only timelocked `addAdapter` (and optional registry) protects depositors. | Verified | Yes. Registry of our own adapters, then abdicate addAdapter. |
| In-kind redemption | `forceDeallocate(adapter, data, assets, onBehalf)` (840-849): deallocate, then `withdraw(penalty, address(this), onBehalf)`. Caller needs share allowance if not onBehalf. | Verified | Adapter must enforce its own minOut when `selector == forceDeallocate.selector`, since `data` is caller-chosen. Inferred. |
| Multicall | Delegatecall to `address(this)` only, bubbles reverts, not payable, returns nothing (284-296). `msg.sender` preserved. Certora `Immutability.spec`. | Verified | Yes, safe pattern. |
| Permit malleability | Not checked; nonce prevents replay (895-906). | Verified | Fine. |
| Gas DoS on accrual | Loops over all adapters' realAssets each first touch (27-28); RegistryList loops sub-registries. | Verified | Keep adapter count small (one per token). |
| Timelock bypass | `submit` stores `executableAt[data]`; `timelocked()` checks exact calldata, not abdicated; `decreaseTimelock` uses the target selector's timelock (132-145, 347-370). | Verified; Certora `EarliestTime` | Yes, copy for policy changes. |

---

## 6. Invariants from tests and specs, and which to copy

### 6.1 What the test suite checks (Verified)
- 373 test functions under `test/`. No stateful `invariant_` fuzz tests; tests are fuzzed unit tests (`bound(...)`) plus integration tests against Blue, MetaMorpho V1, V1.1 (`test/integration/*`, including BadDebt, Donation, Ikr = in-kind redemption, Interest).
- Examples: `AccrueInterestTest` (maxRate clamp, fees, donations, `testFirstTotalAssets`), `AllocateTest` (zero absolute cap, relative cap manipulation protection, rounding down, negative change bounds), `ForceDeallocateTest` (penalty, blocked-vault gate), `RealizeLossTest` (touch then loss, loss then touch, loss via allocate/deallocate/forceDeallocate), `ExchangeRateTest`, `GatingTest` (13 gate cases), `LiquidityAdapterTest`, `MulticallTest`.
- `test/mocks/AdapterMock.sol` is a 72-line reference adapter: records `selector`/`sender`, returns `assets + interest - loss` as change, approves the vault in its constructor. Good template for our adapter tests.

### 6.2 Recommended to copy into our vault's tests (Inferred)
1. `totalSupply == sum(balances)`, `balanceOf(0) == 0`.
2. Rounding direction on all four ERC4626 ops and all round trips cannot create value (RoundTrip.spec list).
3. Previews equal actual results.
4. `_totalAssets` changes by exactly the deposit/withdraw amount, and only via accrual otherwise (TotalAssetsChange.spec).
5. Share price non-decreasing across any non-accrual call with zero management fee (sharePriceIsIncreasing).
6. Donations (to vault or adapters) never raise the share price instantly.
7. Caps: allocation never exceeds absolute cap after allocate; zero-cap ids can never gain allocation.
8. Liveness: a depositor can always exit (redeem, or forceDeallocate then redeem) with Executor, session keys, and platform offline, and with the oracle stale. This is our non-negotiable rule and should be a dedicated test plus, ideally, a formal rule.
9. Sentinel or owner can always de-risk (sell to USDC, zero caps) regardless of Executor state.
10. Gate rules: blocked accounts never gain or lose shares.
11. Reentrancy: no external calls outside a whitelisted set (vault, adapters, USDC, whitelisted tokens, router/pools, oracle).
12. Timelock earliest-time and abdication permanence, applied to our Executor policy changes too.
13. New for spot: `realAssets()` never reverts (stale or broken oracle); swap adapters' tracked balances equal actual balances minus donations; per-trade loss bounded by slippage limit; forced sells via forceDeallocate respect oracle minOut.

---

## 7. Open questions

1. Can we accept the maxRate clamp (at most 200% APR upward, instant losses) for a volatile portfolio, or do we fork `accrueInterestView`? If we fork, which audit coverage do we lose, and does GPL-2.0-or-later suit us (Phase 0 license note)?
2. What oracle do we have on Monad for MON, WETH, and the LST, and how do we make adapter `realAssets()` degrade safely (never revert, never jump to 0) when it is stale?
3. How do we implement the Hyperliquid 1-day deposit lockup? Gates are `view`, receive no amount or timestamp, so a lockup needs a wrapper or share-transfer restriction contract. Not answerable from this code.
4. Proportional close on withdrawal: build a periphery router that calls `forceDeallocate` on each SwapAdapter proportionally and then `redeem`? What penalty level balances "exit is cheap" against "forced sells are not a sandwich target"?
5. Performance fee with a high-water mark is not supported (fee on `newTotalAssets - _totalAssets`). The fee-wrapper audit suggests Morpho's own answer is a wrapper vault; that code is not in this repo.
6. Would Morpho's deployed `VaultV2Factory` on Monad accept a vault whose adapters are ours? Technically yes (no registry is enforced by default, `adapterRegistry == 0` allows any adapter, line 97). Whether Morpho's app/curation UI lists such vaults is not answerable here.
7. Uniswap version on Monad (v3 or v4 with hooks)? v4 hooks affect reentrancy assumptions for our adapters.
8. Handover mode on NFT sale: V2 roles are addresses, not epoch-bound. The owner, curator, and allocator must be contracts that read our NFT ownership epoch; `setIsAllocator` is timelocked, so revoking an old owner's Executor rights must happen at the Executor level, not the vault level.
