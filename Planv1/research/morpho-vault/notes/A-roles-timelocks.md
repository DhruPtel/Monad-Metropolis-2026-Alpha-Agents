# A. Roles, permissions, and timelocks (Morpho Vault V2)

Sub-agent A. Repo `/home/dhrupatel/agent_tool/vaults` at commit `9ee4dbdc`. All line numbers refer to `src/VaultV2.sol` unless another file is named. Labels: **Verified** = read in code; **Inferred** = reasoning or design suggestion not directly in code.

## 1. Summary

- Four configured roles: **owner**, **curator**, **allocators**, **sentinels**. Plus non-role actors: **anyone** (executes matured timelocked calls, `forceDeallocate`, `accrueInterest`, deposit/withdraw), **fee recipients**, **adapters**, **gates**, **adapter registry**, and per-adapter **skimRecipient**. (Verified)
- Owner functions are instant and not timelocked. Curator functions that can hurt depositors go through `submit` then a permissionless execute after the timelock. Risk-reducing functions (`revoke`, `decrease*Cap`, `deallocate`) are instant and open to sentinels. (Verified)
- **Every timelock starts at zero** (NatSpec line 187). Until timelocks are raised, the curator can submit and execute in the same transaction via `multicall`. (Verified)
- No role can transfer vault assets to an arbitrary address directly. Assets leave only via (a) `withdraw/redeem/forceDeallocate` burning shares, or (b) `allocate` to an **adapter**, which is fully trusted. Adding an adapter and raising caps are timelocked. (Verified)
- Sentinel is the "risk-reduce only" role. It can cancel pending actions, lower caps, and pull assets from adapters back to idle. It cannot allocate, submit, or change roles. The owner can remove a sentinel instantly. (Verified)

## 2. Roles and every function

### 2.1 Storage (Verified, lines 203-211, 243-252)
`owner`, `curator` (single addresses), `isSentinel`, `isAllocator` (mappings), gates (4 addresses), `adapterRegistry`, `timelock[selector]`, `abdicated[selector]`, `executableAt[data]`, fees and fee recipients.

### 2.2 Function-by-function access table (Verified)

| Function | Line | Who can call | Timelocked? | Effect |
|---|---|---|---|---|
| `constructor(_owner, _asset)` | 300 | deployer (via factory) | n/a | sets `owner`, immutable `asset` |
| `setOwner` | 315 | owner | No | replaces owner (one step, no accept) |
| `setCurator` | 321 | owner | No | replaces curator |
| `setIsSentinel` | 327 | owner | No | add/remove sentinel |
| `setName`, `setSymbol` | 333, 339 | owner | No | metadata |
| `submit(data)` | 349 | curator | n/a | schedules `data` at `now + timelock` |
| `revoke(data)` | 372 | curator or sentinel | No | cancels pending `data` |
| `setIsAllocator` | 383 | anyone, after timelock | Yes | add/remove allocator |
| `setReceiveSharesGate`, `setSendSharesGate`, `setReceiveAssetsGate`, `setSendAssetsGate` | 389-411 | anyone, after timelock | Yes | gates |
| `setAdapterRegistry` | 414 | anyone, after timelock | Yes | checks all current adapters are in new registry |
| `addAdapter`, `removeAdapter` | 429, 442 | anyone, after timelock | Yes | adapter set |
| `increaseTimelock`, `decreaseTimelock` | 460, 469 | anyone, after timelock | Yes | see section 3 |
| `abdicate(selector)` | 478 | anyone, after timelock | Yes | permanently disables selector |
| `setPerformanceFee`, `setManagementFee` | 484, 496 | anyone, after timelock | Yes | max 50% perf, 5%/yr mgmt (`ConstantsLib.sol`) |
| `setPerformanceFeeRecipient`, `setManagementFeeRecipient` | 508, 518 | anyone, after timelock | Yes | |
| `increaseAbsoluteCap`, `increaseRelativeCap` | 528, 547 | anyone, after timelock | Yes | |
| `decreaseAbsoluteCap`, `decreaseRelativeCap` | 537, 558 | curator or sentinel | No | |
| `setForceDeallocatePenalty` | 568 | anyone, after timelock | Yes | max 2% |
| `allocate` | 577 | allocator | No | sends idle asset to an adapter, checks caps |
| `deallocate` | 605 | allocator or sentinel | No | pulls asset from adapter to vault |
| `setLiquidityAdapterAndData` | 633 | allocator | No | adapter used on deposit/withdraw |
| `setMaxRate` | 640 | allocator | No | max share price growth, up to 200% APR |
| `accrueInterest` | 653 | anyone | No | may mint fee shares |
| `deposit`, `mint` | 766, 774 | anyone passing gates | No | |
| `withdraw`, `redeem` | 795, 803 | share owner or approved spender, passing gates | No | |
| `forceDeallocate` | 840 | anyone (penalty charged to `onBehalf`) | No | deallocate + penalty withdraw to vault |
| `transfer`, `transferFrom`, `approve`, `permit` | 854-911 | share holders | No | share token ERC-20/2612 |
| `multicall` | 287 | anyone | No | `delegatecall` to self, so `msg.sender` is preserved per sub-call |

Key detail (Verified): timelocked functions have **no caller check**. `timelocked()` (line 362) only checks that `executableAt[msg.data]` is set, has matured, and the selector is not abdicated. `SettersTest.testTimelocked` (test/SettersTest.sol:208) calls `vault.setIsAllocator` from the test contract, not the curator. So once matured, anyone can execute. The curator decides *what*; timing of execution is open.

### 2.3 Roles outside VaultV2 (Verified)
- Adapter `skimRecipient`: `MorphoVaultV1Adapter.setSkimRecipient` (src/adapters/MorphoVaultV1Adapter.sol:51) is callable by the **vault owner** instantly. `skim` (line 59) sends any token except the MetaMorpho shares to that recipient. In `MorphoMarketV1AdapterV2` (src/adapters/MorphoMarketV1AdapterV2.sol:155) `setSkimRecipient` is timelocked under the adapter's own curator-driven timelock (`submit` at line 88 requires `msg.sender == parentVault.curator()`), and `skim` (line 173) has no token restriction.
- Adapters have their own mini timelock system (MorphoMarketV1AdapterV2 lines 88-153), mirroring the vault's.
- `BluePublicAllocator` (src/periphery/blue-public-allocator/BluePublicAllocator.sol:68-110): configuration requires `vault.isAllocator(msg.sender)`; `reallocate` is public within its flow caps. Only relevant if the contract itself is made an allocator. Lending-specific.
- Gates (e.g. `WhitelistSendAssetsGate`) have their own `roleSetter` and `whitelister` roles (src/periphery/gates/*.sol). Whoever controls a gate contract indirectly controls who can enter or exit.

### 2.4 How roles are assigned and removed (Verified)
| Role | Assigned by | Removed by | Timelock | Two-step? |
|---|---|---|---|---|
| owner | constructor, then current owner via `setOwner` | current owner | none | No (line 179: "Roles are not two-step") |
| curator | owner via `setCurator` | owner | none | No |
| sentinel | owner via `setIsSentinel` | owner | none | No |
| allocator | curator `submit` + anyone executes `setIsAllocator` | same path | `timelock[setIsAllocator]` | No |

Line 178 warns: "if setIsAllocator is timelocked, removing an allocator will take time." Setting owner to `address(0)` is allowed (no zero check), which renounces all owner powers permanently (Inferred from absence of check, consistent with line 182).

## 3. Timelock mechanics

### 3.1 submit (Verified, lines 349-360)
```solidity
function submit(bytes calldata data) external {
    require(msg.sender == curator, ErrorsLib.Unauthorized());
    require(executableAt[data] == 0, ErrorsLib.DataAlreadyPending());
    bytes4 selector = bytes4(data);
    uint256 _timelock =
        selector == IVaultV2.decreaseTimelock.selector ? timelock[bytes4(data[4:8])] : timelock[selector];
    executableAt[data] = block.timestamp + _timelock;
    emit EventsLib.Submit(selector, data, executableAt[data]);
}
```
- Keyed by the **exact calldata bytes**, so one pending entry per identical call. Different arguments are independent entries.
- Nothing about `data` is validated at submit time (NatSpec line 143).
- If `timelock[selector]` is huge, `block.timestamp + _timelock` overflows and `submit` reverts. So raising a timelock to `type(uint256).max` effectively disables that selector forever, because the `decreaseTimelock` for it would also overflow on submit (NatSpec lines 347, 457). (Verified)

### 3.2 Execution / accept (Verified, lines 362-370)
```solidity
function timelocked() internal {
    bytes4 selector = bytes4(msg.data);
    require(executableAt[msg.data] != 0, ErrorsLib.DataNotTimelocked());
    require(block.timestamp >= executableAt[msg.data], ErrorsLib.TimelockNotExpired());
    require(!abdicated[selector], ErrorsLib.Abdicated());
    executableAt[msg.data] = 0;
    emit EventsLib.Accept(selector, msg.data);
}
```
- Execution = calling the target function with identical calldata. Anyone may do it. No expiry: a matured entry stays executable indefinitely until executed or revoked. (Verified: no expiry field.)
- Through `multicall`, `msg.data` inside the delegatecall is the sub-call data, so batching works. With timelock 0, `multicall([submit(x)])` then `x` in the same tx is possible (Inferred; the tests do submit then execute back-to-back, e.g. SettersTest.sol:157-158).

### 3.3 revoke (Verified, lines 372-379)
Curator or any sentinel sets `executableAt[data] = 0`. **The owner cannot revoke directly**; it can only replace the curator (instant) and have the new curator revoke, or add itself as sentinel (instant) and revoke. So in practice the owner can cancel anything within one transaction (Inferred from `setIsSentinel` + `revoke` both being instant). Certora `SentinelLiveness.sentinelCanRevoke` proves a sentinel can always revoke pending data.

### 3.4 increaseTimelock / decreaseTimelock (Verified, lines 460-476)
- Both are themselves timelocked and both reject `selector == decreaseTimelock.selector` (`AutomaticallyTimelocked`).
- `increaseTimelock(sel, d)` waits `timelock[increaseTimelock]`, requires `d >= timelock[sel]`.
- `decreaseTimelock(sel, d)` waits **`timelock[sel]`** (the timelock of the function being made faster), requires `d <= timelock[sel]`. So you cannot shortcut a long timelock by first shortening `decreaseTimelock`.
- Pending entries submitted before an increase keep their original `executableAt` (line 458). A sentinel should revoke them if the increase is meant to protect depositors.
- Earliest possible execution of any function, per NatSpec lines 136-142 and Certora `EarliestTime.spec` (`earliestExecutionTimeIncreases`, `cannotExecuteBeforeMinimumTime`): `min(now + timelock[sel], executableAt[existing], executableAt[decreaseTimelock(sel,d)] + d)`.

### 3.5 abdicate (Verified, lines 478-482)
Timelocked with `timelock[abdicate]`. Sets `abdicated[sel] = true`; there is no un-abdicate. `timelocked()` then always reverts for `sel` even if data is pending. Certora `AbdicatedFunctions.spec`: `abdicatedFunctionsCantBeCalled`, `abdicatedCantBeDeabdicated`, plus per-function rules showing, for example, that abdicating `increaseAbsoluteCap` means caps can only go down. Abdication applies only to timelocked functions; owner functions, `revoke`, `decrease*Cap`, and allocator functions cannot be abdicated (Verified: they do not call `timelocked()`).

### 3.6 Which actions are timelocked (Verified)
Timelocked (call `timelocked()`): `setIsAllocator`, four gate setters, `setAdapterRegistry`, `addAdapter`, `removeAdapter`, `increaseTimelock`, `decreaseTimelock`, `abdicate`, `setPerformanceFee`, `setManagementFee`, both fee recipients, `increaseAbsoluteCap`, `increaseRelativeCap`, `setForceDeallocatePenalty`.

Not timelocked: all owner functions, `submit`, `revoke`, `decreaseAbsoluteCap`, `decreaseRelativeCap`, `allocate`, `deallocate`, `setLiquidityAdapterAndData`, `setMaxRate`, user functions.

## 4. What stops a manager or curator from taking depositor funds

### 4.1 The vault never grants token approvals (Verified)
`grep approve` in `src/VaultV2.sol` finds only the share `approve` (line 889). The vault calls the asset token only via `safeTransfer` (lines 587, 827) and `safeTransferFrom` (lines 626, 786), plus `balanceOf`.

### 4.2 Every path by which the asset leaves the vault

| # | Path | Code | Who triggers | Limits |
|---|---|---|---|---|
| 1 | `withdraw` / `redeem` -> `exit` | 795-829, transfer at 827 | share owner or approved spender | burns shares at current price; `receiveAssetsGate` and `sendSharesGate` checks (812-813) |
| 2 | Liquidity deallocate inside `exit` | 816-818 | same as 1 | pulls into vault, then path 1 |
| 3 | `allocate` -> transfer to adapter | 587 | allocator; also any depositor via `enter` if `liquidityAdapter` set (791) | adapter must be in `isAdapter` (583); absolute cap > 0 and not exceeded; relative cap vs `firstTotalAssets` (595-600) |
| 4 | `forceDeallocate` | 840-849 | anyone | assets move adapter -> vault; penalty is withdrawn **to the vault itself** (`withdraw(penaltyAssets, address(this), onBehalf)`), so nothing leaves |
| 5 | Fees | `accrueInterest` 653-662 | anyone triggers; curator sets rates via timelock | fees are **minted shares**, not asset transfers. Recipients then use path 1 |
| 6 | Adapter code after path 3 | adapter contract | adapter logic | vault has no control. Adapters approve the vault for max (MorphoVaultV1Adapter.sol:47, MorphoMarketV1AdapterV2.sol:81) so the vault can pull back |
| 7 | Adapter `skim` | MorphoVaultV1Adapter.sol:59; MorphoMarketV1AdapterV2.sol:173 | `skimRecipient` (set by vault owner in V1 adapter) | only tokens sitting loose in the adapter; normal flow leaves none there |

No other asset-transfer site exists in `VaultV2.sol` (Verified by reading all 945 lines). There is no `sweep`, `rescue`, or `execute` function.

### 4.3 Why owner/curator/allocator cannot directly steal (Verified unless noted)
- Owner: no function touches assets. NatSpec line 173. Its power is appointing curator and sentinels. Certora `OwnerSafety.spec` only proves owner liveness (owner can always set owner, curator, sentinel).
- Curator: can only `submit`. Any harmful change (new adapter, higher caps, gates, fees, allocator changes) waits for the timelock and is visible via `Submit` events, giving depositors time to exit and sentinels time to revoke.
- Allocator: can move assets only into adapters already added (timelocked) and within caps (increase is timelocked). It cannot send assets to an EOA.
- Indirect theft routes (Inferred, all require timelocked steps):
  1. Curator adds a malicious adapter + raises its caps, allocator allocates, adapter keeps funds.
  2. Adapter reports inflated `realAssets()` (line 675). Share price rises up to `maxRate` (set instantly by allocator, max 200% APR, line 642). Performance fee is minted on that phantom interest and redeemed for real assets; existing holders who redeem at the inflated price also drain others.
  3. Curator sets `receiveAssetsGate` or `sendSharesGate` to a contract that blocks exits (lines 155-163), trapping depositors. `receiveSharesGate` reverting blocks all interactions (line 156) since `accrueInterestView` calls `canReceiveShares` for fee recipients (682, 687).
  4. Curator raises fees to maximum (50% perf, 5%/yr mgmt).
- Allocator griefing without timelock (Verified): `setLiquidityAdapterAndData` to a non-adapter makes deposits revert and exits that need liquidity revert (NatSpec 176-177); `setMaxRate(0)` freezes share price growth (profits accrue later when raised); allocating into illiquid markets. `forceDeallocate` still works as an escape.

### 4.4 Trust assumption on adapters (Verified, NatSpec lines 70-92)
Adapters must: only let the vault call allocate/deallocate; move funds only inside those calls; return correct ids and changes; approve the vault to pull `assets` after deallocate; not re-enter; allow deallocation for in-kind exits; report `realAssets` honestly and without reverting (lines 124, 129). The vault forwards `msg.sig` and `msg.sender` to the adapter (lines 588, 617), so an adapter can tell which entry point and caller triggered it (allocator vs depositor vs sentinel vs `forceDeallocate` caller). **An adapter is fully trusted with everything allocated to it and with the share price.**

### 4.5 Depositor exit guarantee (Verified mechanics, Inferred conclusions)
- Idle assets: `withdraw/redeem` always available unless a gate blocks.
- Assets in adapters: `forceDeallocate(adapter, data, assets, onBehalf)` is permissionless (line 840) and pays at most 2% (`MAX_FORCE_DEALLOCATE_PENALTY`). Certora `ForceDeallocate.canForceDeallocateZero` covers liveness. The caller supplies arbitrary `data` to the adapter, so the adapter must validate it.
- To make exits unstoppable, abdicate `setReceiveAssetsGate` and `setSendSharesGate` (and probably `setReceiveSharesGate`) while they are zero (Inferred recommendation; mechanism Verified in 3.5).

## 5. Emergency role: sentinel (Verified)
Sentinel can call exactly four things:
1. `revoke(data)` (372): cancel any pending timelocked action.
2. `decreaseAbsoluteCap` (537) and 3. `decreaseRelativeCap` (558): only downward (`AbsoluteCapNotDecreasing` / `RelativeCapNotDecreasing`). Absolute cap 0 blocks all `allocate` touching that id (`ZeroAbsoluteCap`, line 595).
4. `deallocate` (605): moves assets from an adapter back to vault idle. Assets never leave the vault's control through this path.

Limits: cannot `submit`, `allocate`, set liquidity adapter, set maxRate, change roles, or undo anything. It can still cause harm by griefing (forcing untimely exits from positions, which for a spot strategy means forced selling at a bad time, or cutting yield). Certora `SentinelLiveness.spec` proves sentinels can always revoke and decrease caps; `SentinelLivenessDeallocate*.spec` proves deallocate liveness for the two Morpho adapters under assumptions. Weakness: the owner can remove a sentinel instantly (`setIsSentinel`, no timelock), so the sentinel is only as independent as the owner allows.

## 6. Mapping onto our product

Important context (Verified): `asset` is a single immutable token (line 197). All accounting is in that asset (USDC for us). WETH, MON, LST exposure would have to live **inside an adapter** whose `realAssets()` reports their USDC value. Morpho's adapters supply to lending markets; none of them trades. So a custom "spot adapter" is required (Inferred).

### 6.1 Suggested mapping (Inferred)

| Our actor | Vault V2 role | Rationale |
|---|---|---|
| **Executor** | allocator (only allocator) | `allocate(spotAdapter, data, assets)` and `deallocate` are the only ways to move assets; `data` can encode a typed swap intent. The adapter sees `sender` (line 588) and can require the Executor. Per-trade 10% limit, slippage, deadlines, oracle checks, trade count, epochs live in the Executor and/or adapter, since the vault only enforces caps. |
| **Platform admin** | sentinel (and probably owner, see below) | Sentinel maps cleanly onto the circuit breaker and handover: zero caps on risky ids = reduce-only; `deallocate` = move back to USDC; `revoke` = cancel bad curator changes. |
| **Agent owner (manager)** | Not owner, not a raw curator key. Either (a) curator through a platform "curator policy" contract, or (b) nothing on-chain in the vault, acting only through the Executor. | Curator decides adapters, caps, fees, gates. Giving it to an EOA that can be sold is risky. |
| **Vault owner** | platform-controlled contract (or the agent's ERC-6551 account, with care) | Owner can replace curator and remove sentinels instantly, so it must be a party that will not remove the platform's sentinel. |

### 6.2 What transfers directly (Inferred unless noted)
- Timelock/submit/revoke/abdicate framework: fully reusable. Put `addAdapter`, `increase*Cap`, fees, gates, `setIsAllocator` behind multi-day timelocks; abdicate exit gates.
- Caps as portfolio limits: give the spot adapter ids per token (e.g. `keccak256("token", WETH)`) and a shared id for "all non-USDC". Relative cap 0.4 WAD per token id = "max 40% in any non-USDC asset"; relative cap 0.9 on the shared id = "at least 10% USDC". Caveats (Verified NatSpec 55-57): relative caps are checked only on `allocate`, against `firstTotalAssets`, and can be exceeded by price moves. Allocation tracking only updates on allocate/deallocate (52-53).
- Sentinel as the risk-only emergency role, and caps-to-zero as reduce-only mode.
- `forceDeallocate` as the "exit even if we are offline" path, if the spot adapter's `deallocate` can sell to USDC permissionlessly and safely.
- Fees: performance fee on distributed interest, but it is **not a high-water mark**. `interest = newTotalAssets - _totalAssets` (line 679), and after a loss `_totalAssets` drops, so recovering to the old level is charged again. HWM needs a custom approach (e.g. fee recipient contract or wrapper). (Verified mechanics, Inferred conclusion.)

### 6.3 What does not transfer (Inferred)
- The whole adapter design assumes yield markets with near-par exit. A spot adapter's `realAssets` must use an oracle; oracle error directly moves share price and fees. `forceDeallocate` by anyone with caller-chosen `data` means the adapter must enforce swap routes and oracle-bounded slippage itself.
- Per-trade size, trade frequency, deadlines, epochs, and circuit-breaker triggers have no vault equivalent; they belong to the Executor/adapter.
- Leader 5% stake, deposit lockup, "close positions on withdrawal": not in the vault. Lockup could be approximated with a `sendSharesGate` (timelocked, and a blocking gate also blocks exits, which conflicts with our non-negotiable rule).
- Closing to new deposits: `sendAssetsGate` or `receiveSharesGate`, both timelocked. There is no instant "pause deposits" for the manager, though allocator setting a bad liquidity adapter would do it crudely.

### 6.4 Agent sale / new owner (Inferred)
- Vault roles are plain addresses; nothing follows the AgentNFT automatically. If the vault owner is the agent's ERC-6551 account, ownership moves with the NFT atomically, and the buyer can instantly call `setCurator` and `setIsSentinel(platform, false)`. That defeats handover mode, so this only works if the TBA is constrained or the owner is a platform contract that resolves the current NFT owner and enforces handover.
- Pending actions survive a sale: anything the old curator submitted can still be executed by anyone after maturity. Handover must include revoking all pending entries (sentinel can do it) and replacing the curator.
- Removing the Executor as allocator is timelocked (`setIsAllocator`). Epoch checks inside the Executor are the fast lever; sentinel cap-zeroing is the vault-level fast lever.

## 7. Open questions
1. Can a spot adapter satisfy the adapter spec, especially "realAssets must not revert" and "deallocate must work when markets are liquid", using Uniswap on Monad and an oracle? Who is trusted for the oracle?
2. Does the Morpho VaultV2Factory on Monad (0x8B2F...) and any registry allow a custom adapter? If `adapterRegistry` is set to Morpho's registry, custom adapters would be blocked; we would leave it at `address(0)` or use our own add-only registry.
3. What timelock durations do we pick per selector, and which selectors do we abdicate at launch (exit gates, perhaps `setAdapterRegistry`)?
4. Should the manager hold the curator role at all, given curator can replace fees, gates, adapters after timelock and can revoke platform-submitted actions?
5. HWM performance fee: build in the fee recipient layer, in a wrapper, or not use V2 fees?
6. How does `forceDeallocate` interact with a spot adapter holding several tokens: which token does it sell, and can a caller pick a route that harms remaining depositors? Penalty max 2% may be too low or too high vs. slippage.
7. Whether deployed Monad bytecode matches this commit (Phase 0 open item).
8. Audit PDFs were not read for this section; findings on roles or timelocks there are not covered.
