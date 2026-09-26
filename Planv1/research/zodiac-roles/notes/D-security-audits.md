# D. Security and audits (Sub-agent D working notes)

Scope: audits in `packages/evm/docs`, post-audit code drift, known bypasses and pitfalls, reentrancy, callbacks, Safe-specific risks, target upgrades, revocation, and worst case for a compromised role member under a tight Uniswap permission.

Conventions: **Verified** = read in code / PDF text in this checkout. **Inferred** = reasoning or outside knowledge not confirmed in this repo. Paths are relative to repo root unless absolute. `main` = HEAD `820e5bc9`. `v2` = remote branch `origin/v2`. `v3` = remote branch `origin/contracts-v3`.

PDF text was extracted with `pypdf` (pdftotext and pdftoppm are not installed). Omniscia severity labels are icons, not text; I mapped them by hashing the icon images on each finding page against the severity legend on the synopsis page (Audit02). For Audit03 the icons did not hash-match, so severity there is derived from the synopsis counts (see below).

---

## 0. Headline findings (read this first)

1. **The Roles code on `main` is NOT the code that is deployed, and NOT the code that was audited.** (Verified)
   - Audited code ends at commit `a19c0ebd` (2023-11-29), which is what README says "all identified issues have been resolved as of" (`README.md` lines 96-102).
   - The currently advertised mastercopy `0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5` (README, updated in `2db58108`, 2026-06-19) is **Roles 2.1.1**, built from branch `origin/v2` (commit `218a5164`, 2026-06-08). `git show origin/v2:packages/evm/mastercopies.json` lists `Roles 2.1.1 0xF2964CE6...83D5` and `Packer 2.1.1 0x869718C9...09F0`. `git diff --stat a19c0ebd origin/v2 -- packages/evm/contracts` shows only `PermissionChecker.sol` (8 lines) and a test fixture changed. So v2.1.1 = audited code + 3 small post-audit bug fixes (unaudited, but tiny and regression-tested).
   - `main` instead carries a large 2025 rewrite (`557b17d5`, "Brings in eip-712 evm ... introduces new AbiDecoder"): `Decoder.sol` deleted, `AbiDecoder.sol` (+277 lines) added, `Integrity.sol` (88 lines), `Topology.sol` (115), `PermissionChecker.sol`, `PermissionLoader.sol`, `Types.sol` changed, plus new periphery `EIP712Encoder.sol`, `SignTypedMessageLib.sol`, `SafeStorage.sol`, `MorphoBundler3Unwrapper.sol`. None of this is covered by any audit PDF. `main`'s `packages/evm/package.json` still says version `2.1.0`, and `main`'s `mastercopies.json` still points Roles 2.1.0 at `0x9646fD...D337`, whose `compilerInput.sources` contains `contracts/Decoder.sol` (the old decoder), i.e. the pre-rewrite code.
   - **`main` does not contain the 2.1.1 fixes** (Verified: `packages/evm/contracts/PermissionChecker.sol` `_arraySome` still loops `condition.children.length`; `_bitmask` still uses `payload.size - 32`; no `scripts/patch-zodiac-signature-checker.js`; `yarn.lock` resolves `@gnosis-guild/zodiac-core@3.0.1`, whose `SignatureChecker._isValidContractSignature` ignores the `success` flag).
   - Implication for us: for the Monad deployment, review and integrate against `origin/v2` source (Roles 2.1.1 at `0xF2964C...`), not `main`. Bytecode equality on Monad still needs checking (Phase 0 found code at both addresses).

2. **Three real bugs were found in the audited 2.1.0 code in 2026 and fixed in 2.1.1** (commit `218a5164`, Verified diff). None were found by the four audits:
   - `_arraySome` evaluated only the first array element (loop bound was `condition.children.length`, which Integrity forces to 1). Fail-closed on its own, but **fail-open when wrapped in `Nor`** (Inferred: `Nor(ArraySome(x))` meant "no element matches x", actually meant "element 0 does not match x").
   - `_bitmask` on `Dynamic` values included ABI padding in the checked slice, so the `shift >= value.length` overflow guard could be satisfied by padding bytes (Inferred minor permissiveness).
   - zodiac `SignatureChecker._isValidContractSignature` accepted an ERC-1271 signer that **reverts** with the magic value as revert data (`FaultyErc1271Signer.sol` regression test). Authentication bypass for contract members whose `isValidSignature` path can revert with bytes starting `0x1626ba7e`. Not relevant if our module is an EOA (Inferred).

3. **v3 (`origin/contracts-v3`) has no audit in the repo.** It carries the same four 2023 v2 PDFs only; `git log --all -- '*.pdf'` shows the last audit PDF commit on 2023-12-01 (`48fbb7c0`). v3 is BUSL-1.1 and a near-total rewrite (new `core/`, `common/`, `types/` trees). (Verified)

4. **Roles v2 cannot express the price-dependent parts of our executor limits** (min-out vs oracle, 0.5% slippage, % of account value, deadlines vs `block.timestamp`). A compromised role member with a "tight" `exactInputSingle` permission can still lose close to 100% of each trade's `amountIn` through a manipulated or attacker-seeded pool unless `amountOutMinimum` is checked against a price via a `Custom` condition (v2) or `WithinRatio` + pricing adapter (v3). See section 7.

---

## 1. Audit summaries

### Audit01: G0 Group, Roles v2, April 2023 (`Audit01_RolesV2_Apr2023_G0Group.pdf`, 4 pages) (Verified)
- Scope: all Solidity in `packages/evm/contracts` at commit `5d218a4b6b6d01412abac07a2a7582d07dd35a65` (commit not present in this clone's history, likely a force-pushed or pre-squash commit).
- Status: "All discovered issues have been fixed or addressed. No known issues are present in" commit `c824d7b2` (present: 2023-04-20, "Merge pull request #197 from gnosis/fix-operator-comments").

| # | Title | Severity | Status |
|---|---|---|---|
| 1 | Allowance conditions not decidable during evaluation (allowance checked after call, so `Or` with an allowance branch could not backtrack) | Medium | Fixed (c824d7b2) |
| 2 | `setAllowance` should ensure `maxBalance >= balance` | Medium | Fixed |
| 3 | Implicit 65536 condition limit (header packing in `BufferPacker.packHeader`) should be enforced in Integrity | Medium | Fixed |
| 4 | First condition node must be the only root | Minor | Fixed |
| 5 | `_arraySubset` assumes <= 256 children (`taken` bitmap); enforce in Integrity | Medium | Fixed |

Relevance: #1 is why current code computes consumptions during the walk (`Consumptions.sol`, `PermissionChecker._withinAllowance`) and flushes before exec (`AllowanceTracker._flushPrepare`).

### Audit02: Omniscia, Roles v2, May 2023 (`Audit02_RolesV2_May2023_Omniscia.pdf`, 63 pages) (Verified)
- Commits: initial `a9f65e8f05` (not in clone), revision `23b782f781` (2023-05-08, "Format"). Report hash `916e3ac17f`.
- Scope: BufferPacker, Core, Consumptions, Decoder, Integrity, MultiSendUnwrapper, Packer, Periphery, PermissionLoader, PermissionBuilder, PermissionChecker, PermissionTracker (later AllowanceTracker), Roles, Types (adapters + core), Topology, WriteOnce.
- Totals (synopsis table): Unknown 0; Informational 27 (14 alleviated, 13 acknowledged); Minor 2 (2 alleviated); Medium 2 (2 alleviated); Major 0. 3 static-analysis + 28 manual findings.
- Conclusion: "all exhibits have been adequately dealt with no outstanding issues remaining". Omniscia explicitly checked re-entrancy, truncation, logical flaws.

| ID | Title | Severity | Outcome |
|---|---|---|---|
| PCR-01M | Discrepant XOR behaviour (`_xor` returned Ok only when exactly one child passed) | Medium | Alleviated: XOR operator removed (now `_Placeholder04` in `Types.sol` `Operator`) |
| TYG-01M | `Topology.childrenBounds` assumed root at index 0; Integrity allowed root elsewhere, risk of wrong topology / recursion | Medium | Alleviated: `Integrity._root` requires single root at index 0 |
| IYT-01M | Weak validation of children counts per operator | Minor | Alleviated (`Integrity._tree`) |
| IYT-02M | Weak validation of compValue per operator | Minor | Alleviated (`Integrity._node`) |
| TSE-01M | `ICustomCondition.check` declared `pure` | Informational | Nullified then; later made `view` in v2.1 (see Audit03) |
| WOE-01M | `WriteOnce.creationBytecodeFor` casts `data.length + 1` to `uint32` unchecked | Informational | Acknowledged (not fixed) |
| RSE-01S | No zero-address sanitization in `Roles` constructor | Informational | Acknowledged (not fixed) |
| 24 others | Gas / style (BPR, CSN, IYT, MSU, PRE, PYR, PBR, PCR, PTR, RSE, TYG, TSP, TSE, WOE) | Informational | Mixed alleviated / acknowledged |

### Audit03: Omniscia, Roles v2.1 delta ("Zodiac PR206"), Nov 2023 (`Audit03_RolesV2_1_Nov2023_Ominiscia.pdf`, 45 pages) (Verified)
- Scope: **delta only** between the May audit and PR#206 (`6a7fb909a1`, 2023-09-18), revisions `e6d315f917` (not in clone) and `4d851d2a84` (2023-11-01). Files: `adapters/AvatarIsOwnerOfERC721.sol`, `Decoder.sol` (0 findings), `Integrity.sol`, `packers/Packer.sol`, `PermissionBuilder.sol`, `PermissionChecker.sol`, `adapters/Types.sol`, `Types.sol`, `Topology.sol`.
- Explicit caveat in report: "Changes introduced to contracts that were outside the scope of the original audit have not been evaluated". The PBR-01M text calls `AllowanceTracker` "out-of-scope".
- Totals: Informational 7 (2 alleviated, 5 acknowledged); Minor 0; Medium 3 (3 alleviated). The three `-M` findings are therefore the three Mediums (Inferred mapping, since icons did not hash-match; counts line up exactly).

| ID | Title | Severity | Outcome |
|---|---|---|---|
| PRE-01M | `Packer._isInline` treated `AbiEncoded` differently from `Calldata` | Medium | Fixed (`b1d2f5de`) |
| TYG-01M | Same discrepancy in `Topology.isInline` | Medium | Fixed (`b1d2f5de`) |
| PBR-01M | Removal of `balance <= maxBalance` check in `setAllowance` made `_accruedAllowance` reset high balances down | Medium | Fixed (`58dd8953`): refactor to `maxRefill` semantics. Omniscia notes side effect: refill periods elapsed while balance >= maxRefill are not credited later ("desirable trait") |
| AIO-01S, AIO-01C, AIO-02C, IYT-01C, IYT-02C, PCR-01C, PCR-02C | style / gas | Informational | Mixed |

### Audit04: G0 Group, Roles v2.1, Nov 2023 (`Audit04_Roles-V2_1_Nov2023_G0Group.pdf`, 1 page) (Verified)
- Scope: all Solidity in `packages/evm/contracts` at `d4b6539b` (2023-11-06, "Include latest audit").
- Text is self-contradictory: "No issues have been discovered during audit" and then lists one:

| # | Title | Severity | Status |
|---|---|---|---|
| 1 | `ICustomCondition.check` does not receive the operation (call vs delegatecall) | Minor (usability) | Fixed at `a19c0ebd` (2023-11-29) |

### Audit coverage vs today's code (Verified from `git log a19c0ebd..HEAD -- packages/evm/contracts`)

| Commit | Date | Change | Audited? | Deployed? |
|---|---|---|---|---|
| `05f2ca83` | 2024-08-21 | switch to `@gnosis-guild/zodiac-core` | No | Unclear |
| `557b17d5` + `ba65a4b0`, `1d9ed036`, `740b4959`, `7d44738e` | 2025-04-25/26 | EIP-712: new `AbiDecoder.sol` replaces `Decoder.sol`, Integrity/Topology/Checker/Loader/Types changes, new `EIP712Encoder`, `SignTypedMessageLib`, `SafeStorage`; `adapters` renamed `periphery` | **No** | Roles: no (Inferred; neither mastercopy entry points at it) |
| `cdc224d3`, `a14c836c` | 2025-10 | `MorphoBundler3Unwrapper` (+callback watermark fix) | **No** | Yes, `0x7533...E8` |
| `1ddde84d` (#448) | 2026-02-23 | `MultiSendUnwrapper` loop bound now uses declared `bytes` length instead of `data.length` | **No** | Yes, `MultiSendUnwrapper 2.1.1` `0xB4Cd...efD` |
| `218a5164` (origin/v2 only) | 2026-06-08 | v2.1.1: ArraySome, Bitmask, SignatureChecker fixes | **No** (small, regression tests added) | Yes, Roles `0xF2964C...` |

Other notes:
- Old decoder adversarial tests ("pluck fails if calldata is too short", "pluck fails with param scoped out of bounds") existed in `test/decoder/Decoder.spec.ts` and were deleted in `557b17d5`; nothing in `main`'s `test/` references `CalldataOutOfBounds` (Verified by grep). The new `test/decoder/AbiDecoder.test.ts` covers only well-formed encodings.
- Older audits exist in history for v1 (Sub7, Ackee, 2022-2023; `5aa1f3b3`, `e7299c81`, `c99157b3`), removed in `3d74cbac`. Not relevant to v2.
- v3 (`origin/contracts-v3`): no audit report, no audit-related commit after 2023 (Verified: `git log --all -i --grep=audit --since=2024-01-01` returns nothing).

---

## 2. Calldata encoding tricks (AbiDecoder / Decoder)

Code read: `packages/evm/contracts/AbiDecoder.sol` (main) and `git show origin/v2:packages/evm/contracts/Decoder.sol` (deployed). Both have the same semantics (Verified):

- Offsets are followed exactly like Solidity's decoder: `_locationInBlock` returns `location + word(data, location + offset)` for non-inline children (tail pointers are relative to the start of the enclosing block).
- Bounds: `word()` reverts `CalldataOutOfBounds` if `location + 32 > data.length`; `pluck()` uses a calldata slice which reverts on out-of-range. Arithmetic is checked (0.8.x), so huge offsets revert on overflow.
- **No canonicality checks at all.** Nothing rejects overlapping offsets, offsets pointing backwards or into the head, non-zero padding, dirty high bits, or trailing calldata.

```solidity
// AbiDecoder._locationInBlock (main), same logic in v2 Decoder
if (isInline) { return location + offset; }
else { return location + uint256(word(data, location + offset)); }
```

Analysis:
- **Overlapping / non-canonical offsets.** Roles reads the value at the same place Solidity's ABI decoder (abicoder v2) will read it, because both follow offsets the same way. So non-canonical layouts do not by themselves create a Roles-vs-target mismatch for Solidity targets. (Inferred from code comparison with Solidity decoding rules.) Risk rises for targets with hand-written assembly decoders or non-Solidity decoders (e.g. routers with custom calldata libraries) where offset interpretation could differ. For Uniswap SwapRouter02 `exactInputSingle` the param is a static tuple (all inline), so there are no offsets to play with (Inferred).
- **Dirty high bits.** `_compare` (`PermissionChecker.sol`) uses `keccak256(pluck(...32 bytes))` for `EqualTo` and the raw 256-bit word for `GreaterThan`/`LessThan`. So for a `uint24 fee` or `address` param: dirty bits make `EqualTo` fail (fail-closed), make `LessThan` fail (fail-closed), but make **`GreaterThan` pass** even if the low bits are small. A Solidity >=0.8 abicoder-v2 target reverts on dirty bits for sub-256 types, so the call fails anyway. A target that masks instead of reverting (abicoder v1, Vyper, assembly) would see the small value: bypass of `GreaterThan` on sub-256-bit types. (Inferred.) Our Uniswap amounts are `uint256`, so no dirty bits possible there.
- **Dirty padding on `bytes`/`string`.** `EqualTo` on `Dynamic` hashes `32 + ceil32(len)` bytes including padding, so dirty padding fails closed. (Verified: `_walk` sets `size = 32 + _ceil32(len)`.)
- **Trailing calldata.** Ignored by Roles (it decodes only the typeTree). Also ignored by Solidity targets. Not a bypass by itself. Note Roles' own signature path appends a signature after the ABI args (see section 5).
- **Parameters not described in the condition tree** are never inspected. `_matches` requires `condition.children.length == payload.children.length`, but the payload is built from the same typeTree, so a tree that declares fewer params than the real function just leaves the rest unconstrained. (Verified `_matches`; consequence Inferred.)
- **Wrong typeTree** (declaring `Static` where the ABI has `Dynamic`, etc.) makes Roles check the wrong bytes. Pure configuration risk; Integrity checks tree shape, not that it matches the real ABI. (Inferred.)
- **Huge array length** from calldata is used to allocate `new Payload[](blockLength)`: out-of-gas revert only, fail-closed DoS (Verified allocation; effect Inferred).

Verdict: no known permissive encoding bypass against Solidity abicoder-v2 targets. The decoder rewrite on `main` is unaudited and lacks adversarial tests; the deployed 2.1.1 still uses the audited `Decoder.sol`.

---

## 3. Permissive defaults and configuration mistakes

All in `PermissionBuilder.sol` and `PermissionChecker._transaction` (Verified):

| Mistake | What the code does | Severity for us |
|---|---|---|
| `allowTarget(role, token, options)` (`Clearance.Target`) | `_transaction` returns only `_executionOptions(...)`: **any selector, any params** on that address (`transfer`, `approve`, `permit`...) | Critical if applied to any token or the router |
| `allowFunction(role, target, selector, options)` | Stores `packHeaderAsWildcarded(options)`; `_transaction` returns Ok when `isWildcarded`, no param checks | Critical for `approve`, `transfer`, `exactInputSingle`, `multicall`, `sweepToken`, `unwrapWETH9` |
| `scopeFunction` with root `Pass` (or `Matches` whose children are all `Pass`) | `Integrity._node` accepts `Pass` with no compValue; `_walk` returns Ok | Same as wildcard |
| Empty calldata (ETH send / `receive`) | `bytes4(data)` of empty data is `0x00000000`; under `Clearance.Function` the key `_key(to, 0x00000000)` must be scoped; under `Clearance.Target` it is allowed (subject to `Send` option). Data of 1-3 bytes reverts `FunctionSignatureTooShort` | Low (we do not need ETH sends to arbitrary addresses) |
| `ExecutionOptions.DelegateCall` / `Both` | Allows delegatecall to the target, which runs arbitrary code in the avatar's context (can rewrite Safe storage: owners, modules, guard, threshold) | Critical; never grant except to vetted libs (MultiSend via unwrapper, SignTypedMessageLib) |
| `ExecutionOptions.Send` | allows `value > 0` | Low-Medium |
| Allowance keys are **global**, not per role | `allowances` is `mapping(bytes32 => Allowance)` in `_Core.sol`; any role's condition naming the key consumes it | Medium: one compromised role can exhaust a budget another role relies on (griefing) |
| `revokeTarget` does not clear function scopes | Sets `clearance: None` only; `scopeConfig[key]` entries remain. A later `scopeTarget` silently restores all old function scopes | High for our epoch model: stale permissions come back |
| `setAllowance(key, 0, ...)` with `refill > 0, period > 0` | `_accruedAllowance` keeps refilling on schedule | Medium: "set to 0" is not a revocation unless refill is also 0 |
| `EqualToAvatar` | `PermissionLoader._load` patches compValue to `keccak256(abi.encode(avatar))` where `avatar` is the module's `avatar` storage, which owner can change via `setAvatar` | Low; but note it is `avatar`, not `target` (differs in modifier chains) |
| `Custom` condition | Arbitrary external `view` call to `address(bytes20(compValue))` (`_custom`); trust in that contract | Medium: our oracle checker would be a trusted dependency |

---

## 4. Reentrancy and ordering

- **No reentrancy guard in v2** (Verified: no `nonReentrant` / lock in `Roles.sol`, `PermissionChecker.sol`, `AllowanceTracker.sol`, zodiac-core `Modifier.sol`).
- Order in every entry point (`Roles.execTransactionFromModule`, `...ReturnData`, `execTransactionWithRole`, `...ReturnData`): `_authorize` (view checks) -> `_flushPrepare` (writes `balance - consumed` to storage) -> `exec` (avatar call) -> `_flushCommit` (on failure restores `allowances[key].balance = consumption.balance`). (Verified)
- Consequence 1: allowances are debited before the external call, so a reentrant call sees the reduced balance: no simple double-spend. (Verified)
- Consequence 2 (edge): if a reentrant inner call consumes the same allowance and succeeds, and the outer call then returns `success == false` without reverting (`shouldRevert == false`), the outer `_flushCommit` writes back the pre-outer balance, **erasing the inner consumption**. (Verified code path; exploitability Inferred: requires a module or a valid module signature to reenter Roles during exec. With our EOA session key and Uniswap targets, nothing calls back into Roles.)
- Reentry requires passing `moduleOnly`: `msg.sender` must be an enabled module, or calldata must carry a valid module signature (zodiac-core `Modifier.moduleOnly`). A target contract cannot reenter unless it is itself an enabled module / member. (Verified)
- `_flushPrepare` asserts `balance == consumption.balance`, i.e. the balance must not have changed between `_authorize` and flush (same tx, fine). (Verified)
- v3 adds `nonReentrant` on all exec entry points (transient-storage guard per `core/StorageSlots.sol` comment "RolesStorage._reentrancyGuard"; `__test__/fixtures/ReentrancyChecker.sol`) and persists consumption only after successful exec (`core/Settlement.sol`: "Invoked after successful execution"). (Verified via `git show origin/contracts-v3:...`.) Inferred: Monad must support TSTORE/TLOAD for v3; not checked.

---

## 5. Signed (relayed) module transactions: no expiry

zodiac-core 3.0.1 `Modifier.moduleOnly` + `SignatureChecker.moduleTxSignedBy` (read from the npm tarball in scratchpad) (Verified):
- If `msg.sender` is not a module, Roles accepts an EIP-712 signature appended to calldata (`data || salt || r/s/v` or contract-signature form). Hash = `moduleTxHash(data[:end], salt)` over the full call data including selector and args. Replay protection is only `consumed[signer][hash]`; the signer can pre-invalidate with `ExecutionTracker.invalidate(hash)`.
- **No deadline and no nonce ordering.** A signed-but-unsent transaction can be submitted by anyone at any later time while the signer is still a member.
- For `execTransactionFromModule` (default role) the signed data does not include the roleKey; it runs under whatever `defaultRoles[signer]` is at execution time. For `execTransactionWithRole` the roleKey is inside the signed data.
- 2.1.1 fixed `_isValidContractSignature` to require `success` (patch script on `origin/v2`); `main` still resolves zodiac-core 3.0.1 without the patch.
- v3 `Roles.execTransactionWithSignature(..., salt, signature)` still has salt-only replay protection, no deadline (Verified signature of function in v3 `Roles.sol`).
- For us: do not use the relayed-signature path, or only with fresh roleKeys per epoch and explicit `invalidate` on rotation. Deadlines must come from the target call itself (e.g., a `deadline` param constrained in conditions, which v2 cannot compare to `block.timestamp`).

---

## 6. Safe-specific pitfalls and callback paths

Execution path: `Module.exec` -> `IAvatar(target).execTransactionFromModule(to, value, data, operation)` (zodiac-core `core/Module.sol`, Verified). The call originates from the Safe.

- **Target = the avatar (Safe) itself.** A Safe self-call satisfies Safe's `authorized` (msg.sender == this), so any allowed call to the Safe can `enableModule`, `addOwnerWithThreshold`, `changeThreshold`, `setGuard`, `setFallbackHandler`, `execTransactionFromModule`, etc. Never allow the avatar address as a target. (Inferred from Safe 1.4.1 `SelfAuthorized`; Safe source not in repo.)
- **Target = the Roles modifier itself** (or any contract the Safe owns/admins). Roles' owner is typically the Safe, so allowing the Roles address as a target lets a member call `assignRoles`, `scopeFunction`, `setAllowance` through the avatar and self-escalate. Same for any Delay/other modifier or any protocol where the Safe is admin. (Inferred from `onlyOwner` + avatar-as-owner setups.)
- **DelegateCall** to anything not vetted = full takeover (writes Safe storage). (Inferred)
- **MultiSend** is only analyzable when the MultiSend address+selector is registered via `setTransactionUnwrapper` (`_Periphery.sol`); then each inner tx is checked (`PermissionChecker._multiEntrypoint`). If an owner instead grants `DelegateCall` to MultiSend without an unwrapper, inner calls are unchecked. (Verified code; consequence Inferred.)
- **SignTypedMessageLib / signMessage** (main only, unaudited, `periphery/SignTypedMessageLib.sol`): delegatecalled, it writes `signedMessages[hash] = 1` in the Safe, making the Safe's ERC-1271 `isValidSignature` return valid. If a role may delegatecall it with weak conditions, a member can sign Permit2 permits, CoW orders, or any off-chain approval, which moves funds outside Roles' view. `signMessage(bytes)` has no domain/message structure at all. (Verified code; consequence Inferred.)
- **Callbacks.** Uniswap V3 pool callbacks (`uniswapV3SwapCallback`) go to the pool's `msg.sender`, i.e. the router, not the Safe, when swapping via SwapRouter. Calling a pool directly from the Safe would hit the Safe's fallback handler, which does not implement the callback, so it reverts (fail-closed). Safe `CompatibilityFallbackHandler` handles ERC-721/1155 receipt hooks and `isValidSignature`; it does not give callers any power over funds. (Inferred; Safe and Uniswap code not in repo.)
- **Approvals.** `approve(spender, amount)` must pin `spender` with `EqualTo` and bound `amount` (`LessThan` or `WithinAllowance`). Roles v2 cannot tie the approve amount to the later swap amount (no cross-call relation), so "exact-amount approvals" must be enforced off-chain or by batching approve+swap in one MultiSend with separately bounded values. Leftover router approvals are only usable by calls from the Safe itself (Inferred: SwapRouter02 `pay` uses `msg.sender` as payer), so they are not directly stealable by third parties, but remain usable by the member via any permitted router function.
- **`transfer` / `transferFrom` / `permit` / `increaseAllowance`** on allowed tokens must never be permitted, or only with `EqualToAvatar` recipients. `Clearance.Target` on a token permits them all.
- **Uniswap router side doors** (Inferred, SwapRouter02 knowledge): `recipient` special constants (`address(1)` msg.sender, `address(2)` router) mean output can be parked in the router where anyone can `sweepToken`; `sweepToken(token, min, recipient)`, `unwrapWETH9(min, recipient)`, `pull`, and `multicall(bytes[])` must be either forbidden or scoped with `EqualToAvatar` recipients. `multicall` requires nested `Calldata` scoping of each element.

---

## 7. Target protocol upgrades and selector collisions

- Permissions are keyed on `(targetAddress, selector)` only: `_key(targetAddress, selector) = bytes32(bytes20(targetAddress)) | (bytes32(selector) >> 160)` (`_Core.sol`, Verified). No code-hash or implementation check.
- If a target is an upgradeable proxy and gets upgraded, the same selector with the same scoped params keeps passing, whatever the new implementation does. Roles has no notion of it. (Verified absence; consequence Inferred.) Mitigation is ours: pin non-upgradeable contracts, or monitor `Upgraded` events and revoke.
- Selector collisions: two different functions with the same 4-byte selector on one contract are impossible in Solidity (compile error), but a proxy's admin functions and the implementation share one address; transparent proxies route admin calls only for the admin. Collisions only matter if our config was written for a different ABI than what the contract exposes. (Inferred.)
- Unwrappers are also keyed on `(to, selector)` (`_Periphery.getTransactionUnwrapper`), same upgrade caveat.

---

## 8. Revocation

v2 (Verified, `Roles.sol`, `PermissionBuilder.sol`, zodiac-core `Modifier.sol`):

| Action | Effect | Caveats |
|---|---|---|
| `assignRoles(module, [role], [false])` | `roles[role].members[module] = false`; immediate | Module stays enabled on Roles (`enableModule` only on grant; no disable here). `defaultRoles[module]` unchanged. Re-granting restores every permission of that role |
| `disableModule(prev, module)` on Roles | Module can no longer pass `moduleOnly` directly or by signature | Kills the module across all roles |
| `revokeTarget` | `clearance = None` | Function scopes stay in storage (see section 3) |
| `revokeFunction` | `delete scopeConfig[key]` | Per selector |
| `setAllowance(key, 0, maxRefill, 0, 0, ts)` | Budget zero | Must also zero `refill` / `period` |
| Safe: `disableModule(prev, rolesModifier)` | Removes Roles as a Safe module; all roles dead | Requires Safe owners |
| Roles owner: `setAvatar` / `setTarget` | Re-points the modifier | Owner-only |

- Timing: all of these are plain storage writes in one tx, effective for any later tx, including later txs in the same block. A member tx ordered before the revocation in the same block succeeds. There is no timelock or pending state. Revocation cost = one owner tx (or a Safe multisig tx if the Safe is owner). On chains with a public mempool, a compromised key can see a pending revocation and front-run it with priority fees. (Verified storage semantics; ordering Inferred.)
- Membership expiry in v2: **none**. v3 `core/Membership.sol` adds packed `startTimestamp | endTimestamp | usesLeft` per `(role, module)`; `_authenticate` reverts `MembershipNotYetValid` / `MembershipExpired`, decrements uses and auto-revokes at 0. v3 `core/Setup.sol` adds `grantRole(module, role, start, end, uses)`, `revokeRole`, `renounceRole`, and `allowFunctionGlobally` (a selector on **all** targets: another permissive default to avoid). (Verified in v3 branch.)
- For our "stale permissions must fail and never come back" requirement: v2 has no epochs. The pattern must be: a fresh `roleKey` per (owner epoch, config epoch) and a fresh module/session-key address, never reuse keys, and explicitly revoke the old membership. Because allowances are global and function scopes persist after `revokeTarget`, never "revive" an old roleKey. (Inferred design guidance.)

---

## 9. Worst case: compromised role member under a tight Uniswap permission

Assumed permission: `SwapRouter.exactInputSingle` scoped with `tokenIn`/`tokenOut` in allowlist (`Or` of `EqualTo`), `recipient` `EqualToAvatar`, `amountIn` `WithinAllowance(key)` (budget per period), `approve(router, amount)` with spender `EqualTo router` and amount bounded. No `Custom` oracle check.

What Roles v2 can bound (Verified operators in `Types.sol` `Operator` and `PermissionChecker`): per-call absolute amounts (`LessThan`, `WithinAllowance` with refill/period in `AllowanceTracker._accruedAllowance`), call counts (`CallWithinAllowance`), exact equality on addresses and `fee`, and recipient. What it cannot express natively: relation between two params (min-out vs amount-in), price or oracle values, percentage of account value, `block.timestamp` comparisons (deadline), cross-call state (portfolio caps, circuit breaker), and exact approve == swap amount.

| Attack | Mechanism | Bound under v2 as configured | Roles-preventable? |
|---|---|---|---|
| Sandwich / self-MEV with `amountOutMinimum = 0` and `sqrtPriceLimitX96 = 0` | Attacker (who holds the key) front-runs own trade, pushes price, back-runs | Up to nearly 100% of each trade's `amountIn`; per period up to the full `WithinAllowance` budget | Only with a `Custom` condition reading an oracle (v2) or `WithinRatio` + price adapter (v3). `GreaterThan` on `amountOutMinimum` with a constant is too coarse |
| Attacker-seeded pool (unpinned `fee`) | Create or seed a thin pool at a different fee tier for the same pair with liquidity at an absurd price; route the swap there | ~100% of `amountIn` transferred to attacker LP | Pin `fee` with `EqualTo` (to deep tiers). Still does not help if the pinned tier itself is thin on Monad |
| Manipulated price in the pinned pool | Flash-swap the pool, trade, restore | Large fraction of trade; attacker cost ~2 x fee x manipulation size | Only oracle-based min-out |
| Round-trip churn | Swap A->B->A repeatedly | Per round trip loses ~2 x (pool fee + price impact). Example with our limits (10% of account per trade, 20 trades/day, min-out enforced at 0.5% slippage): 20 legs x 10% x (0.05% fee + 0.5%) ~= 1.1% of account/day at the 0.05% tier; ~3%/day at the 1% tier. Without min-out enforcement, see sandwich row | Rate limits (`CallWithinAllowance`, `WithinAllowance`) cap throughput; fees themselves cannot be prevented |
| Allowance griefing | Burn the shared budget with dust or useless swaps; allowance keys are global so other roles sharing the key are also blocked | DoS for rest of period | No (it is authorized use) |
| Approve abuse | Approve max, or approve a different spender | Prevented if spender `EqualTo` and amount bounded | Yes, if scoped |
| Output redirection | `recipient` = attacker, `address(2)` + `sweepToken`, `unwrapWETH9` to attacker | Full trade | Yes, with `EqualToAvatar` on every recipient and no wildcarded router functions |
| Replay of old signed tx after re-grant | Section 5 | Any previously signed tx | Partly (fresh roleKey; `invalidate`) |
| Front-running revocation | Section 8 | Whatever fits in remaining budget | No |

Quantified worst case with our stated caps but no oracle condition: a compromised key can route each permitted trade through a manipulated or attacker-seeded pool and extract nearly all of `amountIn`. With 10% of account per trade and 20 trades/day, the account can be drained within one day (10 trades at 10% of initial value each already reach ~100%; at 10% of remaining value, 20 trades leave 0.9^20 ~= 12%). The real bound is the `WithinAllowance` budget per period on `amountIn`, so set it well below the per-day tolerable loss. With an oracle `Custom` condition enforcing min-out within 0.5% of a fresh oracle price, loss is bounded to fees plus 0.5% per leg (about 1.1% of account/day at the stated limits), which the circuit breaker would catch after about 9 days of maximal churn at the 10% threshold.

What Roles cannot prevent in any configuration: loss from pool fees and permitted slippage, MEV within the allowed slippage band, DoS of shared allowances, front-running of a revocation, the behaviour of an upgraded target, and oracle or custom-checker failure (the checker is trusted).

---

## 10. Open questions

1. Is the bytecode on Monad at `0xF2964C...83D5` identical to the `origin/v2` 2.1.1 build (and `0x9646fD...` to 2.1.0)? Compare `eth_getCode` against `mastercopies.json` `bytecode` (runtime part) in both branches.
2. Why does `main` diverge from the deployed v2 line? Will the 2.1.1 fixes be merged into `main`, and will the `main` (AbiDecoder + EIP-712) code ever be audited or deployed as a Roles mastercopy?
3. Does zodiac-core 4.3.0 (used by v3) include the `success` check in `SignatureChecker`?
4. Which Uniswap router(s) exist on Monad (SwapRouter vs SwapRouter02 vs UniversalRouter), and which fee tiers have deep liquidity for our pairs? UniversalRouter's `execute(bytes commands, bytes[] inputs)` is much harder to scope.
5. Is our PersonalAccount a Safe? If not, it must implement `IAvatar.execTransactionFromModule` and we lose Safe's module/guard semantics; section 6 analysis assumes Safe 1.4.1.
6. v3 has no audit in repo. Is one planned or completed privately? v3's `allowFunctionGlobally` and pricing adapters are new attack surface.
7. Does Monad support EIP-1153 transient storage (needed by v3's reentrancy guard)?
8. What does Monad's block building / mempool visibility look like (relevant to front-running revocations and sandwiching)?
