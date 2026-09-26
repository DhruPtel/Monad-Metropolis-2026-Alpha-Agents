# B. Strategy restrictions: Manager + Merkle verification, micro-managers, BoringSwapper

Sub-agent B. Read-only research. Repos and versions as recorded in `00-phase0-orientation.md`:
BoringVault `c9c221f9` (license SEL-1.0: patterns only, no code reuse), hypurrquant `79e41cdc` (Apache 2.0, unaudited).

Paths below are relative to the BoringVault repo root unless prefixed with `hq:` (hypurrquant repo root).

Labels used:
- **Verified**: read in code (or read live onchain, stated as such).
- **Inferred**: reasoning from code, not directly exercised.
- Portability: **Portable** / **Adaptable** / **Chain-specific**.
- Verdict vs our design: **Confirms** / **Improves** / **Missing from ours** / **Conflicts**.

---

## 1. The Merkle verification model

### 1.1 Call path

`strategist -> ManagerWithMerkleVerification.manageVaultWithMerkleVerification(...) -> BoringVault.manage(target, data, value)`

- **Verified.** `src/base/Roles/ManagerWithMerkleVerification.sol` `manageVaultWithMerkleVerification` takes five parallel arrays: `manageProofs`, `decodersAndSanitizers`, `targets`, `targetData`, `values`. Lengths must match (lines 141-147).
- **Verified.** For each call it runs `_verifyCallData` and then `vault.manage(targets[i], targetData[i], values[i])` (lines 152-157). `BoringVault.manage` (`src/base/BoringVault.sol` `manage(address,bytes,uint256)`) is a raw `functionCallWithValue` gated only by `requiresAuth`; all the safety lives in the Manager.
- **Verified.** The root used is `manageRoot[msg.sender]` (line 149): a per-caller root. A caller with the role but no root gets `bytes32(0)` and every proof fails.

### 1.2 Leaf structure (exact encoding)

```solidity
// ManagerWithMerkleVerification.sol _verifyManageProof, lines 284-287
bool valueNonZero = value > 0;
bytes32 leaf =
    keccak256(abi.encodePacked(decoderAndSanitizer, target, valueNonZero, selector, packedArgumentAddresses));
return MerkleProofLib.verify(proof, root, leaf);
```

Packed order (Verified, also documented in the state comment at lines 28-36 and in the leaf-file metadata written by `test/resources/MerkleTreeHelper/MerkleTreeHelper.sol` `_generateLeafs`, "DigestComposition"):

| Bytes | Field | Notes |
|---|---|---|
| 20 | `decoderAndSanitizer` | Part of the leaf, so the strategist cannot pick a lenient decoder. |
| 20 | `target` | Contract being called. |
| 1 | `valueNonZero` (bool) | Only zero vs non-zero. The amount of native value is never bound. |
| 4 | `selector` | `bytes4(targetData)`. |
| 20 x N | `argumentAddresses` | Whatever the decoder returns, in the decoder's order. |

Plus one quirk: if the calldata ends with the `DroneLib.TARGET_FLAG` marker, the drone target address is appended to the packed addresses (`_verifyCallData`, lines 252-255; `src/base/Drones/DroneLib.sol` `extractTargetFromInput`). Drones are sub-accounts, not relevant to us.

Leaf builder side (Verified, `MerkleTreeHelper.sol` `_generateMerkleTree`): identical `abi.encodePacked(decoderAndSanitizer, target, canSendValue, selector)` followed by each argument address. `ManageLeaf` struct: `{target, canSendValue, signature, argumentAddresses[], description, decoderAndSanitizer}`.

### 1.3 How decoders extract sensitive arguments

A decoder is a stateless (usually `pure`) contract that implements the same function signature as the target, is `staticcall`ed with the real calldata, and returns `abi.encodePacked(...)` of every address argument that matters (`_verifyCallData` line 251: `abi.decode(decoderAndSanitizer.functionStaticCall(targetData), (bytes))`). If it does not implement the selector, `BaseDecoderAndSanitizer`'s `fallback` reverts with `FunctionSelectorNotSupported`, so unknown functions fail closed. Decoders can also revert to "sanitize" shapes they refuse to reason about.

| Decoder (file, function) | Addresses returned | Sanitization (reverts) | Not bound |
|---|---|---|---|
| `BaseDecoderAndSanitizer.approve` | `spender` | none | amount (so max approvals pass) |
| `BaseDecoderAndSanitizer.transfer` | `_to` | none | amount |
| `Protocols/UniswapV3DecoderAndSanitizer.exactInput` | every token in `path`, then `recipient` | path length must be `20 mod 23` | fee tier, `amountIn`, `amountOutMinimum`, deadline (explicit design comment, lines 30-38) |
| `UniswapV3...mint` | token0, token1, recipient | none | ticks, amounts |
| `UniswapV3...increaseLiquidity / decreaseLiquidity / collect` | reads `ownerOf(tokenId)` and position tokens onchain (`view`) | none | amounts |
| `Protocols/UniswapV4DecoderAndSanitizer.execute` (Universal Router) | currency0, currency1, hook, currencyToSpend, currencyToReceive, [sweep currency, sweep recipient] | only 1 command (+ optional SWEEP); only `SWAP_EXACT_IN_SINGLE`/`SWAP_EXACT_OUT_SINGLE` followed by `SETTLE_ALL`, `TAKE_ALL` | amounts, deadline, fee tier inside PoolKey |
| `UniswapV4...approve` (Permit2) | token, spender | none | amount, expiry |
| `UniswapV4...modifyLiquidities` | pool currencies, hook, recipient, settle currencies, optional sweep | strict action/sub-action grammar | amounts |
| `Protocols/OdosDecoderAndSanitizer.swap` | inputToken, outputToken, outputReceiver, executor | none | amounts, `pathDefinition` |
| `Odos...swapCompact` | same four, parsed from packed calldata with router `addressList` lookups | none | amounts |
| `Protocols/OneInchDecoderAndSanitizer.swap` (V5 and V6) | executor, srcToken, dstToken, srcReceiver, dstReceiver | V5 rejects non-empty `permit` | amounts, the opaque `data` executed by the executor |
| `OneInch...unoswap*` | token, dex pool(s) | none | amounts |
| `Protocols/NativeWrapperDecoderAndSanitizer.deposit / withdraw` | nothing | none | amount |
| `Protocols/BoringSwapperDecoderAndSanitizer` (`BoringSwapperDecoder`) `swap / submitOrder / cancelOrder / replaceOrder` | tokenIn, tokenOut, receiver (x2 for replace) | none | adapter, quoteAsset, slippageBps, swapData |

"Owned" variants (`OdosOwnedDecoderAndSanitizer`, `OneInchOwnedDecoderAndSanitizer`) keep a mutable `odosExecutor` / `oneInchExecutor` settable by the decoder's `owner` and revert if the call uses another executor (Verified, `OneInchOwnedDecoderAndSanitizer.swap`). **Inferred:** this moves part of the permission set outside the root, so it can change without a `setManageRoot` (and without any timelock on the root).

Portability: the decoder pattern is **Portable**. Individual decoders are **Adaptable** (they bind to specific protocol ABIs and immutables such as the Uniswap position manager address; Monad has Uniswap V3/V4 addresses in `test/resources/ChainValues.sol` `_addMonadValues`).

### 1.4 Proof checking

**Verified.** `MerkleProofLib.verify` from solmate (sorted-pair hashing; the helper's `_hashPair` builds the tree the same way). One proof per call; proofs are calldata so root storage is a single `bytes32` per strategist regardless of how many permissions exist. **Inferred:** gas grows with log2(leaf count) per call plus one `staticcall` to the decoder.

### 1.5 Roots per strategist

- **Verified.** `mapping(address => bytes32) public manageRoot;` (line 37). `setManageRoot(address strategist, bytes32 _manageRoot)` is `requiresAuth` and takes effect immediately (lines 100-104). No delay inside the contract.
- **Verified.** Caller eligibility is a separate RolesAuthority check: in `script/ArchitectureDeployments/DeployArcticArchitectureWithConfig.s.sol` `_setupRoles`, `manageVaultWithMerkleVerification` is granted to `STRATEGIST_ROLE` (7) and `MANAGER_INTERNAL_ROLE` (4), `setManageRoot` to `OWNER_ROLE` (8), `pause/unpause` to `PAUSER_ROLE` (5).
- **Verified live (Monad vmUSD, RPC `https://rpc.monad.xyz`, block ~108,055,600).** On RolesAuthority `0xA1299741...`, `doesRoleHaveCapability` shows `setManageRoot` -> role 8 only, `manageVaultWithMerkleVerification` -> roles 4 and 7, `pause/unpause` -> role 5; none are public. The RolesAuthority `owner()` is `0x16ba7650...` (a contract) whose `getMinDelay()` returns 172,800 s (48 h) and which holds role bitmap `0x100` (role 8, OWNER_ROLE). **Inferred:** that contract is an OpenZeppelin `TimelockController`, so root updates on vmUSD go through a 48 h timelock, **unless** other addresses also hold role 8 (not enumerable without logs; the public RPC rejected the log range, see Open questions).

### 1.6 Flash loan path

**Verified** (`flashLoan`, `receiveFlashLoan`, lines 172-235):
1. The vault (via a Merkle-approved `manage` call whose target is the Manager itself) calls `flashLoan`; only `msg.sender == vault` is accepted.
2. Manager stores `flashLoanIntentHash = keccak256(userData)` and calls Balancer.
3. `receiveFlashLoan` requires `msg.sender == balancerVault`, `performingFlashLoan`, and a matching intent hash; it zeroes the hash (anti-replay), transfers borrowed tokens to the vault, then **calls `this.manageVaultWithMerkleVerification`**, so the inner calls are checked against `manageRoot[address(manager)]`, not the strategist's root (confirmed by `test/integrations/BalancerV2FlashloansIntegration.t.sol` which calls `setManageRoot(address(manager), ...)`).
4. Repayment is done by the vault through `vault.manage` with raw `transfer` calldata (no Merkle check, amounts from Balancer).

**Inferred:** any strategist whose root contains the `flashLoan` leaf gets access to the Manager's shared flash-loan root for the duration. Portability: **Adaptable** (needs Balancer V2 on the chain). Relevance to us: none at launch; we should not support flash loans.

### 1.7 Pause and post-call checks

- **Verified.** `pause()` sets `isPaused`; `manageVaultWithMerkleVerification` reverts when paused (line 140). Pause blocks strategist actions only; it does not touch deposits or withdrawals (those are in the Teller/Queue). `src/base/Roles/Pauser.sol` fans out pause calls to many `IPausable` contracts.
- **Verified.** The only post-call invariant is that `vault.totalSupply()` is unchanged across the batch (lines 150, 158-160). No check on NAV, balances, allowances, or asset composition.

Verdict: the pause-only-blocks-management shape **Confirms** our rule that nothing can pause `redeemInKind`. The share-supply invariant is cheap and worth copying: **Improves** (add "totalSupply unchanged" and "no balance change in tokens other than tokenIn/tokenOut" as Executor post-conditions).

---

## 2. Can a leaf force recipient = vault, restrict tokens, forbid native value?

Yes, for all three, provided the decoder returns the right addresses. It cannot bound amounts.

Decoder (Verified, `Protocols/UniswapV3DecoderAndSanitizer.sol` `exactInput`):

```solidity
uint256 chunkSize = 23; // 3 bytes fee + 20 bytes token
uint256 pathLength = params.path.length;
if (pathLength % chunkSize != 20) revert UniswapV3DecoderAndSanitizer__BadPathFormat();
uint256 pathAddressLength = 1 + (pathLength / chunkSize);
uint256 pathIndex;
for (uint256 i; i < pathAddressLength; ++i) {
    addressesFound = abi.encodePacked(addressesFound, params.path[pathIndex:pathIndex + 20]);
    pathIndex += chunkSize;
}
addressesFound = abi.encodePacked(addressesFound, params.recipient);
```

Leaf helper (Verified, `MerkleTreeHelper.sol` `_addUniswapV3OneWaySwapLeafs`):

```solidity
leafs[leafIndex] = ManageLeaf(
    getAddress(sourceChain, "uniV3Router"),
    false,                                   // canSendValue = false -> value must be 0
    "exactInput((bytes,address,uint256,uint256))",
    new address[](3), "Swap ...", getAddress(sourceChain, "rawDataDecoderAndSanitizer"));
leafs[leafIndex].argumentAddresses[0] = token0[i];                         // path token in
leafs[leafIndex].argumentAddresses[1] = token1[i];                         // path token out
leafs[leafIndex].argumentAddresses[2] = getAddress(sourceChain, "boringVault"); // recipient
```

What this enforces (Verified by construction, Inferred for completeness):
- **Recipient = vault:** the recipient address is hashed into the leaf; any other recipient changes the packed bytes and the proof fails.
- **Tokens:** exactly `[token0, token1]` as a single-hop path in that direction. A multi-hop path produces more addresses and needs its own leaf. "One-way" leafs allow only token0 -> token1 (exit-only style).
- **No native value:** `canSendValue = false` means `valueNonZero` must be false, so any `value > 0` fails.
- **Approvals:** a separate leaf `approve(address,uint256)` with argument `uniV3Router` pins the spender but not the amount (`BaseDecoderAndSanitizer.approve`). A strategist can approve `type(uint256).max`.
- **Not enforced:** amountIn, amountOutMinimum (so slippage can be 100%), fee tier (so any pool of the pair, including a thin one), deadline.

For aggregators the recipient is also bindable (`OdosDecoderAndSanitizer.swap` returns `outputReceiver`, `OneInchDecoderAndSanitizer.swap` returns `dstReceiver`), but the executor's opaque route data is not inspected. Uniswap V4 `TAKE_ALL` pays `msgSender` (the vault) implicitly and the decoder rejects any action grammar other than swap/settle/take (+ sweep with a bound recipient).

Portability: **Portable** pattern. Verdict: **Confirms** our choice to hard-bind recipient = vault and value = 0 in the Executor; our typed intents already do this without proofs.

---

## 3. Different permission sets per strategist; micro-managers

### 3.1 Mechanism

- **Verified.** Each address has its own root (`manageRoot[strategist]`). Veda scripts routinely build several roots per vault: across `script/MerkleRootCreation/` there are 53 `generateStrategistMerkleRoot`, 52 `generateAdminStrategistMerkleRoot`, plus narrow ones like `generateSniperMerkleRoot` and `generate...OperationalStrategistMerkleRoot`. Example: `script/MerkleRootCreation/Mainnet/CreateSuperSymbioticLRTMerkleRoot.s.sol` `generateSniperMerkleRoot` builds a 16-slot tree with only "approve + deposit into Symbiotic collateral" leafs, while `generateAdminStrategistMerkleRoot` in the same file builds a 1024-slot tree.
- **Verified.** A micro-manager ("uManager") is a contract that holds `STRATEGIST_ROLE` on the Manager and has its **own** root. A bot holds a role on the uManager, not on the Manager. The uManager builds the calldata itself, so the bot can only choose parameters. Test wiring: `test/micro-managers/DexSwapperUManager.t.sol` `setUp` grants `STRATEGIST_ROLE` to `address(dexSwapperUManager)` and calls `manager.setManageRoot(address(dexSwapperUManager), root)` with exactly two leafs (approve router, exactInput weETH->WETH with recipient = vault).

### 3.2 The micro-managers

| Contract | What it adds on top of Merkle | Verified details |
|---|---|---|
| `src/micro-managers/UManager.sol` (abstract) | `enforceRateLimit` modifier (call count), `revokeTokenApproval` helper | See section 4.1 for the rate-limit analysis. |
| `src/micro-managers/DexSwapperUManager.sol` | Typed swaps for UniV3, BalancerV2, Curve; exact approval = `amountIn`; post-trade oracle slippage check via a `PriceRouter`; revokes leftover allowance | `swapWithUniswapV3` hardcodes `recipient: boringVault`, measures `tokenOut` balance delta, then `priceRouter.getValue(tokenOut, delta, path[0])` must be `>= amountIn * (1 - allowedSlippage)`. `allowedSlippage` default 5 bps, admin-settable up to `MAX_SLIPPAGE = 0.1e4` (10%). |
| `src/micro-managers/DexAggregatorUManager.sol` | Same pattern for 1inch V5 `swap` | `swapWith1Inch(tokenIn, amountIn, tokenOut, data)`: approve exact, forward opaque `data` (still Merkle-checked by the 1inch decoder), check oracle value of `tokenOut` delta, revoke leftover. **Inferred:** `tokenOut` is a free parameter not tied to `data`; a mismatch yields delta 0 and the slippage check reverts, so it fails safe. |
| `SymbioticUManager.sol` | Symbiotic-specific (not read in depth, out of scope) | |

"Slippage vs price router": the micro-managers use an external `PriceRouter.getValue` (`src/interfaces/PriceRouter.sol`, the Sommelier-style price router) and compare **realized** output value to input amount. Oracle freshness is whatever the PriceRouter does; nothing in the uManager checks it. **Verified** absence.

### 3.3 Mapping to our roles

| Our role | Veda analogue | Fit |
|---|---|---|
| Agent session key (normal trading) | A bot with a role on a uManager (typed function, uManager's own narrow root) | Good fit. This is essentially what our Executor already is: a typed front-end that builds calldata itself. **Confirms.** |
| Emergency risk role (reduce-only) | A separate strategist address with a narrow "one-way" root (e.g. only `X -> USDC` leafs from `_addUniswapV3OneWaySwapLeafs`, only `approve(router)`), or a second uManager | **Improves** our design slightly: express "reduce risk only" as a *directional* route allowlist (`tokenIn != USDC, tokenOut == USDC`) plus a separate role, not as a flag inside the same code path. BoringSwapper's directed routes (`getRouteId(tokenIn, tokenOut)` is ordered) are the same idea. |
| Handover mode after agent sale (reduce-only) | Swap the root for the strategist to a one-way root, or revoke the role | Veda can do it by `setManageRoot`, but only via OWNER_ROLE (48 h timelock on vmUSD), which is too slow for a sale. Our epoch approach is better. **Confirms ours.** |

Portability: per-caller permission sets are **Portable**.

---

## 4. What Merkle verification cannot express, and how Veda patches it

### 4.1 Gaps (Verified by leaf format: only addresses, selector, target, decoder, value!=0)

| Needed limit | Expressible by a leaf? | Why |
|---|---|---|
| Percentage of vault per trade | No | Amounts are not in the leaf; no NAV access. |
| Max % in any asset / USDC floor | No | Needs post-trade portfolio valuation. |
| Oracle checks (price, freshness, deviation) | No | Leaf verification is `pure` over calldata (decoders may be `view`, but only to extract addresses). |
| Slippage | No | `amountOutMinimum` is not bound (explicit comment in `UniswapV3DecoderAndSanitizer.sol` lines 30-38). |
| Rate limits (count or volume) | No | Stateless. |
| Deadlines | No | Not decoded. |
| Epochs / invalidating in-flight permissions on ownership change | Partly | Replacing a root invalidates all old proofs immediately; there is no notion of owner/config epoch for signed intents. |
| Exact approvals + reset | No | Approve amount is not bound. |
| Native value amount | No | Only zero vs non-zero. |

### 4.2 `UManager.enforceRateLimit`: not a rolling window, and actually broken

```solidity
// src/micro-managers/UManager.sol lines 44-55
modifier enforceRateLimit() {
    {
        uint256 currentCallCountForPeriod = callCountPerPeriod[block.timestamp % period] + 1;
        if (currentCallCountForPeriod > allowedCallsPerPeriod) revert UManager__CallCountExceeded();
        callCountPerPeriod[block.timestamp % period] = currentCallCountForPeriod;
    }
    _;
}
```

Analysis (**Verified** code, **Inferred** consequences):
- The key is `block.timestamp % period`, i.e. the *second-offset within a period* (0..period-1), not the period index (`block.timestamp / period`). Counters are never reset.
- Consequence 1: calls at different seconds land in different buckets, so within one period a strategist can make up to `allowedCallsPerPeriod` calls **per second**, up to `period * allowedCallsPerPeriod` calls per period. With the test values (`period = 300`, `allowed = 10`) that is up to 3,000 calls in 5 minutes.
- Consequence 2: each offset bucket accumulates forever. Once a given second-offset has been hit `allowed` times across all history, calls at that offset fail forever (until `setPeriod` changes the modulus). It degrades over time into random denial of service.
- Consequence 3: `period` is `uint16`, max 65,535 s (about 18.2 h), so a 24 h window cannot even be configured. `period = 0` makes every call revert (modulo by zero).
- Tests (`test/micro-managers/DexSwapperUManager.t.sol`, `DexAggregatorUManager.t.sol`) only exercise the limit within a single block/timestamp, so they do not catch this.
- It is neither a fixed window nor a rolling window. Treat as a bug; the audited successor pattern is BoringSwapper's token bucket.

Verdict: **Conflicts** with nothing of ours, but is a clear "do not copy". Our "20 trades per rolling 24 h" should be implemented as an exact rolling window, e.g. a ring buffer of the last 20 trade timestamps: allow trade iff `ring[head] + 24h <= block.timestamp` (or slot unused), then overwrite `ring[head]` and advance. O(1), exact, no bucket-edge doubling. Portability of our fix: **Portable**.

### 4.3 BoringSwapper: Veda's typed swap layer (the real answer to the gaps)

Files: `src/base/Periphery/BoringSwapper.sol`, `src/base/Periphery/adapters/*.sol`, `src/base/Periphery/adapters/price/PriceValidator.sol`, `src/base/Periphery/AdapterRegistry.sol`, `src/base/Periphery/FeeRegistry.sol`, `src/helper/GenericRateProviderWithStalenessCheck.sol`. Audited per Phase 0 (Certora boring-swapper 0-1); file headers do not carry `Last audited` lines. Portability of the whole design: **Portable** (it is already deployed on Monad, see 4.4).

Architecture (Verified):
1. The vault calls `BoringSwapper.swap(SwapConfig)` through the Manager. The Merkle leaf (via `BoringSwapperDecoder.swap`) binds `tokenIn`, `tokenOut`, `receiver` (= vault). `SwapConfig = {tokenRoute{tokenIn, tokenOut}, adapter, quoteAsset, swapData, slippageBps, receiver}` (`src/interfaces/ISwapperTypes.sol`).
2. `_swapPreFlightCheck`: `_validateAdapter` (global pause, per-adapter pause, registered in the Veda-wide `AdapterRegistry`, and approved in this swapper), `_validateSwapSelector` (blocks callbacks into adapter admin functions), then **staticcalls the adapter with `swapData` plus the appended `SwapConfig`**. The adapter mirrors the router ABI and returns `(target router, amountIn)`, reverting if calldata disagrees with the config. Example `UniswapV3Adapter.exactInput`: requires `params.recipient == msg.sender` (the swapper), checks path first token == `tokenIn` and last token == `tokenOut`, returns `(UNIV3_ROUTER, params.amountIn)`.
3. Rate limit: `_consumeRateLimit(routeId, tokenIn, amount)`.
4. `_swapPostFlightCheck`: snapshot swapper's `tokenOut` balance and current allowance; `safeTransferFrom(receiver -> swapper, amount)` (pull exactly `amount` from the vault); `approve(target, 0)` then `approve(target, amount)`; call router; `approve(target, 0)` then restore the prior allowance (so pending limit orders keep theirs); compute realized `tokenOut` delta; `PriceValidator.validate(...)`; take optional fee; send the output to `receiver`; return any unspent `tokenIn` dust (excluding escrowed limit-order funds) to `receiver`.

Mechanism-by-mechanism:

| Mechanism | How (Verified, function) | Notes |
|---|---|---|
| Per-route max slippage | `maxSlippageBpsPerRoute[getRouteId(tokenIn, tokenOut)]`; `PriceValidator.validate` reverts if caller's `slippageBps > maxSlippageBps` | Route is **directional** (ordered hash). Default 0 means an unconfigured route only works with 0 bps or `skipValidation`. |
| Oracle validation | `PriceValidator.validate` values both input and realized output in `quoteAsset` via `IRateProvider.getRate()` (optionally through an intermediary oracle set), then requires **every** output valuation to be `>= every input valuation * (1 - slippageBps)` (nested loop, lines 42-49) | Cross-product = most pessimistic pair. **Inferred:** acts as an implicit deviation check; if oracles disagree by more than the slippage budget, swaps revert. `skipValidation` per (token, quoteAsset) disables the check entirely. Zero rate reverts. |
| Oracle freshness | Not in PriceValidator. Delegated to the rate provider, e.g. `GenericRateProviderWithStalenessCheck.getRate` reverts if `lastUpdate + maxStaleness < block.timestamp`, and forces 18-decimal output | `script/Test/DeployBoringSwapper.s.sol` `_deployChainlinkRateProvider` uses `maxStaleness: 21600` (6 h) for Monad USDC/mUSD Chainlink feeds. Much looser than ours. |
| Rate limits | Token bucket per route: `RateLimit{capacity, remaining, lastRefill, refillRate}`; `_refillBucket` adds `elapsed * refillRate` capped at capacity; `_consumeRateLimit` subtracts the amount normalized to 18 decimals | Continuous refill = a smooth rolling approximation, but it limits **volume in token units**, not trade count and not % of NAV, and has no price awareness (1e18 units of WMON and of USDC count the same). `capacity == 0` disables. Cancelled limit orders restore capacity (`_cancelOrder`). **Verified caveat:** `setRouteConfig` resets `remaining = capacity` (a config write refills the bucket); `setRateLimit` does not. |
| Pausing | `pause/unpause` (global), `setAdapterPaused(adapter)`, `AdapterRegistry.remove` (Veda-wide kill switch), plus the Manager pause upstream | Granular circuit breakers. |
| Approvals handling | Router approval is from the **swapper**, exact `amount`, reset to 0 and prior value after the call. Vault approves the swapper via a Merkle `approve(swapper, amount)` leaf (`_addBoringSwapperDirectedLeafs`) with amount unbound | **Inferred:** vault-to-swapper allowance can be left standing; the swapper can only pull when an authorized caller invokes it, and always returns output to the same `receiver` it pulled from. |
| Recipient enforcement | Two layers: Merkle leaf binds `receiver` = vault; adapter binds router recipient = swapper; swapper pays out to `receiver` from its own measured balance delta | Balance-delta accounting makes router `amountOutMinimum` irrelevant to safety. |
| Deadline | **Not enforced.** `UniswapV3Adapter` ignores the deadline field; SwapConfig has none | Missing vs ours. |
| Limit orders via ERC-1271 | `submitOrder`: adapter's `verifyLimitOrder` returns `OrderInfo`; duplicate/used hash rejection; PriceValidator run on the order's limit price ("fat finger" check); principal (+fee) pulled into the swapper and tracked in `pendingOrderPrincipal`; `approvedHashes[hash] = true`; allowance to the settlement contract accumulated. At fill time the venue calls `isValidSignature(hash, abi.encode(SwapConfig))`, which re-verifies the adapter, re-derives the hash, checks approval, and **re-runs PriceValidator against current oracles** | Cancel/replace (`_cancelOrder`) refunds unfilled principal to the vault, trims allowance, restores rate-limit capacity. Adapters: `CowswapAdapter`, `OneInchAdapter`, `M0Adapter`, etc. Venues are **Chain-specific** (must exist on Monad); the ERC-1271 pattern is **Portable**. |
| Fees | `FeeRegistry` (Veda-owned): per-swapper atomic/limit fees by token-group pair, default fee, recipients; clamped to `maxFeeBps`, which the registry admin can set up to 10,000 (100%) (`setMaxFeeBps`). `BoringSwapper.setFeeRegistry` comment: vault admins must not get this capability | **Inferred:** swap fee is a Veda platform revenue lever with no hard cap protecting depositors. `script/Test/DeployBoringSwapper.s.sol` comment "maxFeeBps capped at 100%". |

Conflict to flag: **limit orders move principal out of the vault into the swapper** (`pendingOrderPrincipal`). If we ever add limit orders, those funds would not be in the vault during `redeemInKind` unless the vault's in-kind logic counts and can reclaim them without the platform. That **Conflicts** with our non-negotiable offline exit unless escrow stays inside the vault (vault signs ERC-1271 itself) or cancellation is permissionless.

### 4.4 Monad: SwapperTestVault root and live swapper config

`script/MerkleRootCreation/Monad/CreateTestSwapperMerkleRoot.s.sol` (Verified): vault `0xC395ef90...`, swapper `0x6b01D470...`. Three pairs, all `SwapKind.BuyAndSell`: WETH/USDC, mUSD/USDC, mUSD/WMON. `_addBoringSwapperLeafs` emits per directed route: `approve(swapper)`, `swap`, `submitOrder`, `cancelOrder`, and a `replaceOrder` leaf for every (cancelRoute x newRoute) pair (6 x 6 = 36). All bind `receiver = boringVault`. Nothing binds adapter, quoteAsset or slippage; those are enforced inside the swapper.

Live reads of swapper `0x6b01D470d3c2E57070E2DCC23a2576bAa4e49F9b` on Monad (Verified live, same RPC): 21,382 bytes code, `version() = "v1"`, `isPaused = false`, `owner = 0xe80F045f...` (the create3 deployer listed in `deployments/addresses/Monad/Deployers.json`), `authority = 0x73Bd4c88...`, `orders = 4` (3 limit orders submitted so far).

| Route | maxSlippageBps | capacity (1e18 units) | refillRate / s |
|---|---|---|---|
| USDC -> mUSD | 5 | 2,000,000 | 23.148149 (2m per 24 h) |
| mUSD -> USDC | 5 | 2,000,000 | 23.148149 |
| USDC -> WETH | 1000 | 100,000,000 | 100,000 |
| WMON -> mUSD | 1000 | 100,000,000 | 100,000 |
| WETH -> USDC, mUSD -> WMON | 0 (unconfigured) | 0 (unlimited) | 0 |

**Inferred:** this is a test deployment (10% slippage on volatile routes, owner is a deployer EOA/contract). It shows Veda's intended production shape: per-direction routes, "$2m per 24 h" volume buckets on stable routes, tight 5 bps slippage on stable pairs.

---

## 5. Root updates: who, how, with what delay

| Question | Answer | Label |
|---|---|---|
| Function | `ManagerWithMerkleVerification.setManageRoot(strategist, root)`, `requiresAuth`, immediate | Verified |
| Who | `OWNER_ROLE` (8) in the standard deploy script `_setupRoles` | Verified |
| Delay in contract | None | Verified |
| Delay in practice | Only if OWNER_ROLE is held by a timelock. Deploy script can deploy an OZ `TimelockController` (`_deployTimelock`, config `timelockConfiguration`). Monad configs: `vmUSD.json` and `mUSDTest.json` set `minDelay 43200` (12 h) but `shouldDeploy: false`; `SwapperTestVault.json` `minDelay 0`. vmUSD address file lists `Timelock: 0x0` | Verified |
| Live vmUSD | RolesAuthority owner is a contract with `getMinDelay() = 172800` (48 h) holding OWNER_ROLE | Verified live; "it is a TimelockController" and "sole holder" are Inferred |
| `TimelockTxs/` folder | One file, `ebtc-timelock-tx-1.json`: a `scheduleBatch` with `delay: 300` whose payloads are `setRoleCapability` (`0x7d40583d`) calls, i.e. role wiring, not root updates. `script/ProposeTimelockTx.s.sol` schedules with delay 300. `script/DeployTimelock.s.sol` (Plasma) deploys with `minDelay = 0` | Verified |
| Other bypass | Owned decoders' mutable executor (section 1.3) and swapper config (`setRouteConfig`, `setTokenOracle`, `setPriceValidator`) are separate `requiresAuth` functions; whether they sit behind the same timelock depends on role wiring per deployment | Verified functions; wiring Inferred |

Verdict: Veda treats "what the strategist may call" as governance data, changed by an owner that may or may not be timelocked, per deployment. Our design (risky config changes behind a timelock longer than the max lockup; emergency role can only reduce risk) is stricter and more uniform. **Confirms ours.** Worth borrowing: emit old and new values on every config change (`ManageRootUpdated(strategist, oldRoot, newRoot)`, `RouteUpdated(...)`) so indexers can show depositors exactly what changed. **Improves** (if not already planned).

---

## 6. hypurrquant: how the keeper is restricted

Architecture (Verified, `hq:README.md` and code): trading is **offchain**. The admin registers an API "agent wallet" on HyperCore (`hq:src/vault/UsdcVault.sol` `registerAgentWallet`, `onlyRole(ADMIN_ROLE)`, via `CoreWriterLib.addApiWallet`). The keeper's offchain signer uses that agent key to place perp orders on HyperCore. The vault contract never sees or checks individual trades. **Chain-specific.**

Onchain keeper powers (`KEEPER_ROLE`, all Verified in `hq:src/vault/UsdcVault.sol`):

| Function | Restriction enforced onchain |
|---|---|
| `depositToHyperCore(amount)` | `_requireCoreActivated`; `_checkPriceSanity` (NavLib: perp oracle vs mark, spot vs perp oracle, tracked spots, each within `MAX_PRICE_DIVERGENCE_BPS = 500`, i.e. 5%); `amount <= _evmBalance() - reservedEvmBalance` (cannot bridge USDC reserved for ready redemptions); non-zero. Destination fixed: the vault's own Core account (`HyperCoreBridgeLib.executeDepositToHyperCore`). |
| `withdrawFromHyperCoreToEVM(amount)` | `HyperCoreBridgeLib.executeWithdrawToEVM`: non-zero, `<=` Core spot balance, uint64 bound; destination fixed to `usdcSystemAddress` (back to the vault's EVM side). Adjusts inflight seal. |
| `transferUsdClass(amount, toPerp)` | Non-zero only. Moves USDC between the vault's own spot and perp accounts. |
| `markRedeemReady(requestId)` / `tryBatchMarkRedeemReady` | 10-minute grace after request (`GracePeriodNotElapsed`), enough free EVM balance (`InsufficientEvmBalance`), reserves `estimatedAssets` into `reservedEvmBalance`; batch <= 50. |

What is not restricted onchain (Verified absence): no position size, leverage, asset allowlist, slippage, trade count, or loss limit on keeper trading; the only brakes are Hyperliquid's agent-wallet semantics (can trade, cannot withdraw) and admin/guardian controls (`pause` by GUARDIAN, `emergencyWithdrawToken` and `emergencyRedeem` by ADMIN). Unused `CoreWriterLib` helpers (`placeLimitOrder`, `spotSend`, `vaultTransfer`, staking) are not exposed by `UsdcVault` (grep shows only `usdClassTransfer`, `addApiWallet`, `approveBuilderFee`, `sendAsset` via the bridge lib). `approveBuilderFee` is ADMIN-only and capped at `MAX_BUILDER_FEE_DECIBPS = 1000` (1%).

Portability: the whole keeper model is **Chain-specific**. Two ideas are **Adaptable**:
1. `reservedEvmBalance`: once a redemption is marked ready, its assets are ring-fenced from strategy use. For us: USDC committed to queued withdrawals should be excluded from what the Executor may spend. **Improves** (if our vault ever has async withdrawals).
2. Keeper can only move funds between the vault's own accounts; every destination is hardcoded. **Confirms** our "managers steer, never take".

Verdict: hypurrquant is much weaker than our Executor on trading restrictions (no onchain trade limits at all). Nothing to adopt for limits.

---

## 7. Our typed-intent Executor vs Merkle vs hybrid

### 7.1 Limit-by-limit comparison

| Our hard limit | Merkle leaf alone | Veda patch (uManager / BoringSwapper) | Our typed Executor | Verdict |
|---|---|---|---|---|
| Max 10% of vault value per trade | No | No. BoringSwapper bucket is token-unit volume per route, not % of NAV | Yes (needs NAV at trade time) | **Confirms ours**; Veda has no equivalent. |
| Max 40% in any non-USDC asset | No | No | Yes (post-trade check) | **Confirms ours.** |
| At least 10% USDC | No | No | Yes (post-trade check) | **Confirms ours.** |
| Max 0.5% slippage | No | Yes: realized output vs oracle, per-route cap (BoringSwapper) or global cap (uManager, default 5 bps) | Yes | **Improves:** validate on the **realized balance delta** (not only router `minOut`), and when multiple oracles exist require the worst pair to pass (PriceValidator cross-product). Directional per-route caps are a nice extension (tighter for USDC->WMON buys than for exits). |
| Exact approvals, reset after swap | No (amount unbound) | Yes: uManagers approve `amountIn` and revoke leftovers; BoringSwapper pulls exact amount into itself, approves exact, resets | Yes | **Confirms ours. Improves:** BoringSwapper's "pull exact amount into a single-purpose executor, approve from there, sweep dust back" means the vault never approves a router at all. |
| 20 trades per rolling 24 h | No | uManager call-count limit is broken (4.2); BoringSwapper limits volume not count | Yes | **Confirms ours** (Veda has no correct count limit). **Improves:** consider adding a per-direction volume token bucket in USD terms as a second brake. Implement our count limit as a ring buffer, not `timestamp % period`. |
| 2-minute deadline | No | No (adapters ignore deadline) | Yes | **Confirms ours.** Note: bound the *intent's* deadline (`now <= deadline <= now + 120`), and pass it to the router; a deadline computed onchain as `block.timestamp + x` is meaningless. |
| Oracle freshness and deviation | No | Freshness in rate provider (6 h on Monad test config); deviation only implicitly through cross-product | Yes | **Confirms ours** (stricter). **Improves:** put staleness inside a wrapper oracle contract per feed so every consumer (Executor, vault exits, valuation) gets the same check. |
| Circuit breaker | Manager `pause` | Swapper global pause + per-adapter pause + global registry removal | Yes | **Improves:** per-venue pause granularity; a platform-wide adapter registry kill switch in addition to per-vault switches. Must never block `redeemInKind` (Veda pauses only management, consistent with us). |
| Ownership and config epochs | Root per address; replacing a root invalidates old proofs instantly | None | Yes | **Missing from Veda; ours is better.** Veda has no answer for agent sale or handover. Caveat seen in BoringSwapper: `setRouteConfig` refills the rate-limit bucket; our config epochs must not reset trade counters or rate state. |
| Recipient = vault, no native value | Yes | Yes (two layers) | Yes (hardcoded) | **Confirms ours.** |
| Target/function/token allowlist | Yes (its strength) | Adapters + registry + approved list + directed routes | Yes (typed intents imply it) | **Confirms ours.** |
| Share supply unchanged | Post-check in Manager | n/a | Not stated | **Missing from ours; cheap to add.** |

### 7.2 Hybrid or not?

What Merkle buys Veda: one generic gate for hundreds of protocol functions across dozens of vaults and chains, cheap onchain storage (one root), per-strategist sets, and a reviewable leaf JSON. It costs: an offchain tree-building toolchain, one decoder per protocol ABI (119 decoder files), opaque roots onchain (depositors cannot read permissions without the leaf file), no amounts, no state, and the need to bolt on uManagers or BoringSwapper for anything economic.

What Veda itself did for swaps: it moved to a **typed** swap entrypoint (`BoringSwapper.swap(SwapConfig)`) with adapters that validate calldata against the typed config, and kept Merkle only as the outer "which tokens / which receiver" gate. That is essentially our Executor design plus per-venue adapters.

For our launch scope (USDC and WMON, one or two DEXes, one swap intent type):
- A Merkle layer would duplicate what the typed intent already pins (router, selector, tokens, recipient, value) and add a second artifact (root + leaf JSON + decoders) to audit and govern. No benefit.
- The genuinely useful ideas are structural, not Merkle itself: (a) **adapter-validated calldata** (typed intent carries venue calldata, a per-venue adapter parses it and must agree with the typed fields), (b) **balance-delta oracle check after the call**, (c) **directed routes with per-route caps**, (d) **per-role permission sets** (session key vs reduce-only risk role), (e) **per-venue pause**.
- Where a Merkle-style allowlist could earn its keep later: if we add many protocols (lending, LP, staking) that do not fit one typed intent, an owner-only (timelocked) Merkle-gated "extension" path could cover the long tail, while all value-moving trading stays in the typed Executor with our limits. Even then, a plain onchain mapping `(target, selector, argsHash) -> allowed` is more transparent for depositors than a root and is fine at our scale.

**Recommendation: stay typed-only.** Borrow BoringSwapper's adapter pattern (typed intent + per-venue calldata validator + post-trade realized-output oracle check + exact pull/approve/reset) inside the Executor, add a per-direction route table and per-venue pause, and add the `totalSupply`-unchanged post-condition. Do not add Merkle proofs. Revisit a Merkle or mapping-based allowlist only for a future admin-only extension path.

---

## 8. Mechanism summary table

| # | Mechanism | Where | Label | Portability | Verdict vs ours |
|---|---|---|---|---|---|
| 1 | Leaf = `keccak(decoder, target, valueNonZero, selector, addrs...)` | `ManagerWithMerkleVerification._verifyManageProof` | Verified | Portable | Not needed (typed intents pin these directly) |
| 2 | Decoders extract address args, fail closed on unknown selectors | `BaseDecoderAndSanitizer` fallback; `Protocols/*` | Verified | Adaptable | Idea reused as per-venue adapters: Improves |
| 3 | Per-strategist root | `manageRoot` mapping, `setManageRoot` | Verified | Portable | Confirms per-role permission sets |
| 4 | Root update immediate; timelock only via role holder | `setManageRoot`; deploy script `_setupRoles`; live vmUSD 48 h | Verified (+ live) | Portable | Confirms ours (we mandate timelock) |
| 5 | Mutable executor in "Owned" decoders | `OneInchOwnedDecoderAndSanitizer.setOneInchExecutor` | Verified | Portable | Warning: permissions changeable outside the timelocked path |
| 6 | Flash loan with intent hash; inner calls use Manager's own root | `flashLoan`, `receiveFlashLoan` | Verified | Adaptable | Not applicable; do not support |
| 7 | Manage pause | `pause`, `Pauser.sol` | Verified | Portable | Confirms |
| 8 | Post-check totalSupply unchanged | `manageVaultWithMerkleVerification` | Verified | Portable | Missing from ours: add |
| 9 | uManager call-count rate limit (`timestamp % period`) | `UManager.enforceRateLimit` | Verified code, Inferred bug | Portable | Do not copy; use ring buffer |
| 10 | uManager exact approve + revoke leftovers | `DexSwapperUManager`, `DexAggregatorUManager` | Verified | Portable | Confirms |
| 11 | uManager realized-output vs PriceRouter slippage | same | Verified | Adaptable (needs a price router) | Confirms / Improves (realized delta) |
| 12 | BoringSwapper adapter calldata validation | `_swapPreFlightCheck`, `UniswapV3Adapter.exactInput` | Verified | Portable | Improves |
| 13 | Pull-exact, approve-exact, restore, sweep dust | `_swapPostFlightCheck` | Verified | Portable | Improves |
| 14 | Directed per-route max slippage | `maxSlippageBpsPerRoute`, `PriceValidator.validate` | Verified | Portable | Improves |
| 15 | Multi-oracle cross-product validation | `PriceValidator.validate`, `_getPrices` | Verified | Portable | Improves |
| 16 | Staleness in rate provider wrapper | `GenericRateProviderWithStalenessCheck.getRate` | Verified | Portable | Confirms (ours stricter) |
| 17 | Token-bucket volume limit per route | `_consumeRateLimit`, `_refillBucket` | Verified | Portable | Improves (optional second brake) |
| 18 | `setRouteConfig` refills bucket | `setRouteConfig` | Verified | Portable | Lesson: config changes must not reset limits |
| 19 | Global + per-adapter pause + registry kill switch | `pause`, `setAdapterPaused`, `AdapterRegistry.remove` | Verified | Portable | Improves |
| 20 | Limit orders via ERC-1271 with fill-time oracle re-check | `submitOrder`, `isValidSignature` | Verified | Portable pattern, Chain-specific venues | Conflicts with offline exit if escrow leaves the vault |
| 21 | Platform swap fee registry, cap up to 100% | `FeeRegistry.setMaxFeeBps` | Verified | Portable | Lesson: hard-code a low immutable max if we ever charge swap fees |
| 22 | hypurrquant keeper: fixed destinations, reserved balance, price sanity on bridging | `hq:UsdcVault.depositToHyperCore`, `withdrawFromHyperCoreToEVM`, `markRedeemReady`, `hq:NavLib.checkPriceSanity` | Verified | Chain-specific (reserved-balance idea Adaptable) | Confirms "steer not take"; reserved balance Improves |
| 23 | hypurrquant trading limits | none onchain (offchain agent wallet) | Verified absence | Chain-specific | Ours is far stricter |

---

## 9. Open questions

1. **Who else holds OWNER_ROLE (8) on Monad vmUSD's RolesAuthority?** The 48 h timelock holds it, but `eth_getLogs` over a useful range was rejected by the public RPC (HTTP 413), so other holders (e.g. a multisig without delay) cannot be ruled out. Needs an indexer or archive RPC scan of `UserRoleUpdated`.
2. Is the 48 h contract (`0x16ba7650...`) really an OZ `TimelockController`, and who are its proposers/executors/cancellers? Only `getMinDelay()` was read.
3. Which role(s) control `BoringSwapper.setRouteConfig`, `setTokenOracle`, `setPriceValidator`, `setApprovedAdapter` on the Monad swapper's authority `0x73Bd4c88...`, and is any of it timelocked? Not checked.
4. Does Veda consider the `UManager.enforceRateLimit` behavior a known issue? No fix or comment found; micro-managers may be legacy. Audit PDFs in `audit/` were not searched for it.
5. What `PriceRouter` do the uManagers use in production and does it check staleness? Only the interface is in the repo.
6. BoringSwapper vault-to-swapper allowance: do Veda's strategists approve exact amounts per swap or leave a standing allowance? The leaf allows either; production call patterns were not inspected.
7. For limit orders, how does Veda's accountant value `pendingOrderPrincipal` held in the swapper? (Relevant to Sub-agent C.) Not traced.
8. Certora `certora/` specs for boring-swapper were not read; they may encode invariants (e.g. dust return, allowance restore) worth reusing as our Executor invariants.
9. Monad block timestamps: with sub-second blocks, many blocks share a timestamp. This affects any `block.timestamp`-based limit (ours included, e.g. deadlines and 24 h windows are fine, but per-second buckets are not). Not measured.
