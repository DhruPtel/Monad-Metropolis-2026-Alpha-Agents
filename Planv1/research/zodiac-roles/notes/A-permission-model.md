# A. Core permission model (Roles v2 on `main`, with v3 deltas)

Sub-agent A working notes. Scope: call flow, scoping, conditions system, swap-recipient enforcement for Uniswap, execution options, batched calls.

Conventions: paths are relative to `packages/evm/contracts/` unless stated otherwise. **Verified** = read in code (or test). **Inferred** = reasoning, external knowledge, or not confirmed by running code. No tests were executed (running Hardhat would write build artifacts into the repo, which the ground rules forbid).

zodiac-core (dependency `@gnosis-guild/zodiac-core` 3.0.1 per `yarn.lock`) is not installed in the checkout. I downloaded the npm tarball into the session scratchpad (outside the repo) and read `contracts/core/Modifier.sol`, `Module.sol`, `signature/SignatureChecker.sol` from it. Citations to those files are marked `zodiac-core:`.

---

## 1. Actors and storage

| Actor | What it is | Where |
|---|---|---|
| **Owner** | Admin of the Roles mod (OZ `OwnableUpgradeable`). Only party that can change roles, scopes, allowances, unwrappers, avatar/target. | `Roles.setUp` calls `_transferOwnership(_owner)`; every builder fn is `onlyOwner` (`PermissionBuilder.sol`, `Roles.assignRoles`, `Roles.setDefaultRole`, `_Periphery.setTransactionUnwrapper`) **Verified** |
| **Avatar** | The account whose funds are used (e.g. Safe). Used as the value for `EqualToAvatar`. | `Roles.setUp`: `avatar = _avatar` **Verified**. Changeable by owner via `zodiac-core: Module.setAvatar` (onlyOwner) **Verified** |
| **Target** | The contract the Roles mod calls `execTransactionFromModule` on. Usually equal to avatar, but can be another modifier (e.g. a Delay) in a chain. | `zodiac-core: Module.exec` -> `IAvatar(target).execTransactionFromModule(...)` **Verified**; `Module.setTarget` onlyOwner **Verified** |
| **Module / member** | Address that submits txs to the Roles mod. Must be an enabled module and a member of the role used. | `Roles.assignRoles` sets `roles[roleKey].members[module]` and auto-enables module **Verified** |
| **Role** | `bytes32` key -> `Role { members, targets, scopeConfig }` | `Types.sol` struct `Role`; `_Core.sol` `mapping(bytes32 => Role) internal roles` **Verified** |

`Role` storage (Types.sol, **Verified**):
- `members: address => bool`
- `targets: address => TargetAddress{ clearance, options }` (target-level clearance and, for `Clearance.Target` only, the ExecutionOptions)
- `scopeConfig: bytes32 => bytes32` keyed by `_key(target, selector)` = `bytes32(bytes20(target)) | (bytes32(selector) >> 160)` (`_Core._key`). Value is a packed header (see section 5).

Allowances are global to the modifier, not per role: `_Core.sol` `mapping(bytes32 => Allowance) public allowances` **Verified**. Unwrappers are also global (all roles): `_Periphery.unwrappers` keyed by `(to, selector)` **Verified**.

Wiring for our product (Inferred): Roles mod is enabled as a module on the PersonalAccount / StrategyVault avatar (which must implement `IAvatar.execTransactionFromModule[ReturnData]`, i.e. Safe-like), `avatar == target == account`, owner = the account itself or the NFT owner's control path, and the Privy session key address is assigned as a member of a role.

---

## 2. Call flow, function by function

### 2.1 Entry points (`Roles.sol`)

All four entry points share the same skeleton (**Verified**, `Roles.sol` lines 103-205):

```solidity
Consumption[] memory consumptions = _authorize(roleKey, to, value, data, operation);
_flushPrepare(consumptions);                 // write allowance debits BEFORE exec
success = exec(to, value, data, operation);  // or execAndReturnData
if (shouldRevert && !success) revert ModuleTransactionFailed(); // WithRole variants only
_flushCommit(consumptions, success);         // on failure restore balances
```

| Function | Role used | `shouldRevert` | Returns data |
|---|---|---|---|
| `execTransactionFromModule(to,value,data,op)` | `defaultRoles[msg.sender]` | no (never reverts on inner failure) | no |
| `execTransactionFromModuleReturnData(...)` | `defaultRoles[msg.sender]` | no | yes |
| `execTransactionWithRole(to,value,data,op,roleKey,shouldRevert)` | explicit `roleKey` | optional | no |
| `execTransactionWithRoleReturnData(...)` | explicit `roleKey` | optional | yes |

Notes:
- `defaultRoles` is set by owner with `Roles.setDefaultRole(module, roleKey)` **Verified**. It is keyed by `msg.sender`, not by the signature-recovered signer, so the default-role path does not work for relayed signed txs (a relayer has no default role; `roleKey == 0` reverts `NoMembership`). **Verified** from code (`defaultRoles[msg.sender]` in `Roles.execTransactionFromModule`) + `_authorize` zero-role check.
- `shouldRevert`: if false and the inner call fails, the outer tx succeeds with `success=false`, and `_flushCommit(..., false)` restores allowance balances (`allowances[key].balance = consumption.balance`) **Verified** (`AllowanceTracker._flushCommit`). If true, the whole tx reverts (`ModuleTransactionFailed`), which also undoes allowance writes. For an executor that must observe failures, `shouldRevert = true` is the sane default (Inferred).
- There is no reentrancy guard on these entry points in v2 (**Verified**: no `nonReentrant` anywhere in v2 `Roles.sol`). Allowance debits are written before `exec` (`_flushPrepare`) so a reentrant call sees reduced balances (**Verified** by ordering; design intent stated in `AllowanceTracker._flushPrepare` natspec). v3 adds `nonReentrant` to all exec entry points (`origin/contracts-v3:packages/evm/contracts/Roles.sol`) **Verified**.

### 2.2 `PermissionChecker._authorize` (the gate)

```solidity
function _authorize(bytes32 roleKey, address to, uint256 value, bytes calldata data, Operation operation)
    internal moduleOnly returns (Consumption[] memory) {
    if (roleKey == 0) revert NoMembership();
    Role storage role = roles[roleKey];
    if (!role.members[sentOrSignedByModule()]) revert NoMembership();
    ITransactionUnwrapper adapter = getTransactionUnwrapper(to, bytes4(data));
    if (address(adapter) == address(0)) (status, result) = _transaction(role, to, value, data, operation, ...);
    else (status, result) = _multiEntrypoint(adapter, role, to, value, data, operation);
    if (status != Status.Ok) revert ConditionViolation(status, result.info);
```
(`PermissionChecker.sol` lines 20-69, abridged) **Verified**

Step by step:
1. **`moduleOnly`** (`zodiac-core: Modifier.moduleOnly`) **Verified**: if `msg.sender` is an enabled module, pass. Otherwise try `moduleTxSignedBy()` (`zodiac-core: SignatureChecker`): the last `32 + 65` bytes of `msg.data` are treated as `salt` + signature (ECDSA, or `v == 0` for EIP-1271 contract signatures). Signer must be an enabled module; hash is marked consumed (`consumed[signer][hash] = true`) for replay protection. There is no expiry/deadline in the signed payload in v2 (only a salt) **Verified**.
2. **Zero role rejected** (so an unset default role can never authorize) **Verified**.
3. **Membership**: `role.members[sentOrSignedByModule()]` where `sentOrSignedByModule()` returns `msg.sender` if it is a module, else the recovered signer **Verified**. Note: being an enabled module is not enough; `assignRoles(module, keys, false)` removes membership immediately, but does not disable the module (**Verified**, `Roles.assignRoles` only writes `members` and enables).
4. **Unwrapper lookup** by `(to, bytes4(data))` (section 8).
5. **`_transaction`** (or per inner tx for batches).
6. Any non-Ok status reverts `ConditionViolation(Status, bytes32 info)`.

### 2.3 `PermissionChecker._transaction`

**Verified** (lines 113-181):
1. `data.length` in 1..3 reverts `FunctionSignatureTooShort`. Empty data is allowed and yields selector `0x00000000`.
2. Branch on `role.targets[to].clearance`:
   - `None` -> `Status.TargetAddressNotAllowed`.
   - `Target` -> only `_executionOptions(value, operation, role.targets[to].options)`. Any selector, any params, including empty calldata. No conditions possible in v2.
   - `Function` -> read `header = role.scopeConfig[_key(to, selector)]`:
     - `header == 0` -> `FunctionNotAllowed` (info = selector).
     - unpack `(isWildcarded, options)`; check `_executionOptions` against the per-function options.
     - wildcarded (`allowFunction`) -> Ok without inspecting params.
     - else `_scopedFunction`: `_load` the condition tree, `AbiDecoder.inspect(data, typeTree, 0)`, merge consumptions, `_walk`.

### 2.4 `_scopedFunction` and `_walk`

`_scopedFunction` (**Verified**): `_load(role, key)` returns `(Condition tree, AbiTypeTree[], Consumption[])`; `AbiDecoder.inspect` maps every parameter to a `Payload{location,size,children}` using the type tree; consumptions from earlier inner txs of a batch are merged (`Consumptions.merge`) so allowances are cumulative across a batch.

`_walk` dispatches on operator (**Verified**, lines 234-291). Status enum with all failure reasons is at lines 728-764.

### 2.5 Execution

`exec`/`execAndReturnData` (`zodiac-core: Module`) call `IAvatar(target).execTransactionFromModule[ReturnData](to, value, data, operation)` **Verified**. So the avatar (Safe) performs the call or delegatecall. The Roles mod must itself be an enabled module on the target.

---

## 3. Scoping layers

| Layer | Set by | Effect | Verified in |
|---|---|---|---|
| Target `None` | default / `revokeTarget` | everything to `to` denied | `_transaction` |
| Target `Target` | `allowTarget(role, to, options)` | every call to `to` allowed subject only to `options` | `PermissionBuilder.allowTarget`, `_transaction` |
| Target `Function` | `scopeTarget(role, to)` | only selectors with a non-zero `scopeConfig` header | `PermissionBuilder.scopeTarget` (also resets target options to `None`) |
| Function wildcarded | `allowFunction(role, to, sel, options)` | selector allowed, params not inspected, per-function options enforced | `PermissionBuilder.allowFunction` -> `BufferPacker.packHeaderAsWildcarded` |
| Function scoped | `scopeFunction(role, to, sel, ConditionFlat[], options)` | `Integrity.enforce`, store tree, enforce conditions + options | `PermissionBuilder.scopeFunction` |
| Revoke function | `revokeFunction` | deletes header | **Verified** |

Interaction semantics (**Verified** by `test/Clearance.spec.ts` case names "allowing a function tightens a previously allowed target", "allowing a target loosens a previously allowed function"): clearance is a single enum per target; switching from `Target` to `Function` keeps old function headers in storage, and they become active again. Switching back to `Target` ignores them. Revoking a target does not delete function headers (`revokeTarget` only writes `targets[to]`) **Verified**. Operational risk: a later `scopeTarget` silently re-activates stale function scopes (Inferred from code; relevant to our "old permissions must never come back" requirement: role keys should be versioned/epoch-derived rather than reused).

Fallback / plain ETH transfer to a `Function`-scoped target: empty calldata maps to selector `0x00000000`, so it is only allowed if `allowFunction`/`scopeFunction` was set for `bytes4(0)` (**Verified** from `_key(to, bytes4(data))` with empty data).

---

## 4. Conditions system

### 4.1 Data model

`ConditionFlat { uint8 parent; AbiType paramType; Operator operator; bytes compValue; }` (Types.sol). The tree is passed flat in BFS order; root is index 0 with `parent == 0`, and it is the only self-parented node (`Integrity._root`, `Integrity._tree` "check BFS": parents must be non-decreasing) **Verified**.

`AbiType` (paramType) **Verified** (Types.sol):

| Type | Meaning in `AbiDecoder._walk` |
|---|---|
| `None` | no decoding; used by logical ops and `EtherWithinAllowance`/`CallWithinAllowance` |
| `Static` | one 32-byte word inline (`size = 32`) |
| `Dynamic` | `bytes`/`string`: head holds offset; `size = 32 + ceil32(len)` (length word + padded body) |
| `Tuple` | a block of fields; inline if all fields static (`_isInline`) |
| `Array` | offset -> length word -> block of `length` elements; elements all decoded with the first child's type (`Topology.typeTree` uses `end = start + 1` for arrays) |
| `Calldata` | bytes value containing `selector + abi params`; decoder skips length word + 4 bytes; selector itself is NOT checked by the decoder |
| `AbiEncoded` | bytes value containing abi params, no selector |

The root must resolve to `Calldata` (`Integrity._tree`: `typeTree[0]._type != AbiType.Calldata` -> `UnsuitableRootNode`) **Verified**. At the root, `AbiDecoder.inspect` starts at offset 4 of the full calldata.

Logical nodes (`And/Or/Nor`) are transparent for typing: `Topology.typeTree` recurses into the first child (**Verified**), and `Integrity._compatibleSiblingTypes` requires every child of a logical node or of an array to have an identical type tree, with one exception: `_isTypeEquivalent` accepts a `Dynamic` sibling when the first sibling is `Calldata`/`AbiEncoded` **Verified**.

### 4.2 Operators (v2 `Types.sol` enum `Operator`)

All **Verified** in `PermissionChecker.sol` and `Integrity._node` unless noted.

| # | Operator | paramType | compValue | Semantics (`PermissionChecker`) |
|---|---|---|---|---|
| 0 | `Pass` | any | none | always Ok; used to describe structure |
| 1 | `And` | None | none | all children Ok on same payload (`_and`); >=1 child |
| 2 | `Or` | None | none | first Ok child wins (`_or`); consumptions of the winning branch kept |
| 3 | `Nor` | None | none | Ok iff no child Ok (`_nor`); child consumptions discarded. Gives "not equal to" |
| 4 | placeholder | | | `Integrity` reverts `UnsupportedOperator` |
| 5 | `Matches` | Tuple/Array/Calldata/AbiEncoded | none | children map positionally to payload children; **child count must equal payload child count** (`_matches`: `condition.children.length != payload.children.length` -> `ParameterNotAMatch`). For Array this enforces exact array length |
| 6 | `ArraySome` | Array | none, exactly 1 child | intended: some element matches. **See bug note 4.3** |
| 7 | `ArrayEvery` | Array | none, exactly 1 child | every element matches; **empty array passes** (loop over 0 elements returns Ok) |
| 8 | `ArraySubset` | Array | none, <=256 children | array non-empty, length <= children, each element matches a distinct child (bitmap `taken`) |
| 9-14 | placeholders | | | rejected |
| 15 | `EqualToAvatar` | Static | none | patched at load time to `EqualTo(keccak256(abi.encode(avatar)))` (`PermissionLoader._load`) |
| 16 | `EqualTo` | Static/Dynamic/Tuple/Array | len>0, multiple of 32 | `keccak256(pluck(data, location, size)) == compValue`, where stored compValue is `keccak256(compValue)` (`BufferPacker.packCompValue`) |
| 17 | `GreaterThan` | Static | 32 bytes | unsigned strict `>` on the word |
| 18 | `LessThan` | Static | 32 bytes | unsigned strict `<` |
| 19 | `SignedIntGreaterThan` | Static | 32 bytes | signed strict `>` |
| 20 | `SignedIntLessThan` | Static | 32 bytes | signed strict `<` |
| 21 | `Bitmask` | Static/Dynamic | 32 bytes: `<2B shift><15B mask><15B expected>` | `(bytes32(value[shift:]) & mask) == expected`; for Dynamic, `value` is body after length word including padding; `shift >= len` -> `BitmaskOverflow` (`_bitmask`) |
| 22 | `Custom` | any (not checked) | 32 bytes: `<20B address><12B extra>` | calls `ICustomCondition(adapter).check(to, value, data, operation, location, size, extra)`; `_custom` is `view` so this is a STATICCALL; returns `(bool, bytes32 info)` |
| 23-27 | placeholders | | | rejected |
| 28 | `WithinAllowance` | Static | 32-byte allowance key | `__consume(uint256(word))` |
| 29 | `EtherWithinAllowance` | None | allowance key | consumes `context.value`; parent must be `Calldata` (`Integrity._tree`) |
| 30 | `CallWithinAllowance` | None | allowance key | consumes 1; parent must be `Calldata` |
| 31 | placeholder | | | rejected |

Operators with index `>= EqualTo` (16) carry a stored 32-byte compValue word (`Packer.pack`, `BufferPacker.packedSize`) **Verified**. `EqualToAvatar` (15) has no stored compValue; it is resolved against the current `avatar` storage var every time a tree is loaded, so it follows `setAvatar` changes (**Verified** `PermissionLoader._load` lines 63-76).

EqualTo encoding detail: callers pass `abi.encode(value)`. For non-inline types (Dynamic, Array, dynamic Tuple) `Packer._removeExtraneousOffsets` strips the leading 32-byte offset word so the hash matches what the decoder plucks (length word + padded body) **Verified**. Consequence: for Dynamic `EqualTo`, the padding bytes are part of the hash; non-zero padding would fail (fail-closed) (Inferred).

`Custom` natspec warning: custom conditions must not keep per-tx state because the check cannot know whether the tx will execute (`packages/docs/content/general/conditions.mdx`, "Custom conditions") **Verified**.

Allowances (`AllowanceTracker._accruedAllowance`, `__consume`): balance/refill/maxRefill/period; consumption is only persisted after `exec`; restored on inner failure. Keys are global, so two roles referencing the same key share one budget **Verified**.

### 4.3 Bug found: `ArraySome` only inspects element 0 (v2)

```solidity
function _arraySome(...) {
    result.consumptions = context.consumptions;
    uint256 length = condition.children.length;          // always 1 (Integrity)
    for (uint256 i; i < length; ) {
        (status, result) = _walk(data, condition.children[0], payload.children[i], ...);
```
(`PermissionChecker._arraySome` lines 428-460) **Verified**.

`Integrity._tree` forces `ArraySome` to have exactly one child (`childBounds.length != 1` -> revert) **Verified**, so the loop runs once and only `payload.children[0]` is checked. An empty array indexes `payload.children[0]` out of bounds (Panic 0x32 revert, not a `ConditionViolation`). `ArrayEvery` correctly loops `payload.children.length`. The only test (`test/operators/06ArraySome.spec.ts`) only uses arrays whose first element is the matching one, so it does not catch this **Verified**. `git blame` dates the line to 2023-07-02 (`f2ad9ddf`), i.e. it is in audited, deployed v2.1 bytecode (Inferred from dates). Effect: fail-closed (stricter than documented), not a bypass. v3 `ConditionEvaluator._arrayIterator` loops over all `childLocations` **Verified** (`origin/contracts-v3:packages/evm/contracts/core/evaluate/ConditionEvaluator.sol`). Avoid `ArraySome` on v2 unless you intend "first element matches".

### 4.4 Decoding (`AbiDecoder.sol`, `Topology.sol`)

- `Topology.childrenBounds` computes, from BFS parent indices, each node's contiguous child range **Verified**.
- `Topology.typeTree` builds an `AbiTypeTree[]` from the condition tree: logical nodes are replaced by their first child's type; arrays keep only the first child as the element template **Verified**.
- `AbiDecoder.inspect` / `_walk` / `__block__` compute locations using standard head/tail offsets relative to the start of each block; `word()` reverts `CalldataOutOfBounds` when reading past the end; slicing out of range reverts **Verified**. There is no canonical-encoding check (offsets may point anywhere in-bounds, trailing bytes are ignored) **Verified** by absence. Since the checker and Solidity's `abi.decode` in the target follow the same offsets, this is consistent for ABI-decoding targets (Inferred). Targets that parse calldata with custom assembly (e.g. Uniswap Universal Router's `CalldataDecoder`) must follow standard offsets for this to hold (Inferred; I believe UR does, but not checked here).
- Nested `Calldata` inside a `bytes` param: selector is skipped, not checked. The SDK compensates by wrapping `And(Calldata Matches, Dynamic Bitmask(selector))` (`packages/sdk/src/main/target/authoring/c/matches.ts` `calldataMatchesScopings` / `calldataMatchesFunctionPermission`) **Verified**.

### 4.5 Integrity rules and limits (`Integrity.sol`, packers)

**Verified** unless noted:
- Exactly one root at index 0; BFS order (`_root`, `_tree`).
- Per-operator paramType and compValue length rules as in the table above (`_node`).
- `And/Or/Nor` need >= 1 child; Static/Dynamic leaves must have no children; Tuple/Calldata/AbiEncoded/Array need >= 1 child; `ArraySome`/`ArrayEvery` exactly 1 child; `ArraySubset` <= 256 children.
- `EtherWithinAllowance`/`CallWithinAllowance` must be direct children of a `Calldata` node and have no children.
- Sibling type compatibility for logical and array nodes (`_compatibleSiblingTypes`).
- Root type tree must be `Calldata`.
- No explicit max node count or depth in v2 Integrity. Practical limits: `parent` is `uint8` (`ConditionFlat.parent`, and 8 bits in `BufferPacker`), so any node with children must be within the first 256 indices; header count is 16 bits; the packed buffer is deployed as contract code by `WriteOnce.store`, so `2*n + 32*k + 1 <= max code size` (24,576 bytes under EIP-170 on Ethereum; Monad's code size limit differs, Inferred) where `k` = nodes with operator >= EqualTo. Depth is bounded only by gas/stack (recursive `_walk`, `_conditionTree`) (Inferred).
- Bitmask can only test a 15-byte window per node.
- v3 Integrity adds explicit caps: `MAX_CONDITION_COUNT = type(uint16).max`, `MAX_CHILD_COUNT = 1023`, `MAX_INLINED_SIZE = 8191`, `MAX_COMP_VALUE_LENGTH = 65535` (`origin/contracts-v3:.../core/serialize/Integrity.sol`) **Verified**.

### 4.6 Storage (`PermissionLoader`, `packers/`, `WriteOnce`)

- `PermissionLoader._store`: `Packer.pack(conditions)` -> `WriteOnce.store(buffer)` -> `scopeConfig[key] = BufferPacker.packHeader(count, options, pointer)` **Verified**.
- Header word: `[2B count][1B options][1B isWildcarded][8B unused][20B pointer]` (`BufferPacker` constants) **Verified**.
- Body: 2 bytes per node (`8b parent | 3b paramType | 5b operator`), then one 32-byte word per node with operator >= EqualTo. `EqualTo` stores `keccak256(compValue)`, others store `bytes32(compValue)` **Verified**.
- `WriteOnce` is SSTORE2-like: creation code `63 <len> 80 60 0E 60 00 39 60 00 F3 00 <data>` deployed via the singleton factory `0xce0042B8...cf9f` with salt 0 (CREATE2), so identical buffers dedupe to the same pointer; runtime code is prefixed with `0x00` (STOP) so it cannot be meaningfully called; `load` uses `extcodecopy` skipping the first byte **Verified**. Implication: the singleton factory must exist on the chain (it does on Monad per Phase 0).
- `_load` re-derives the tree and type tree on every call (gas cost scales with tree size) **Verified**.

---

## 5. Execution options (value and delegatecall)

```solidity
if (value > 0 && options != ExecutionOptions.Send && options != ExecutionOptions.Both)
    return Status.SendNotAllowed;
if (operation == Operation.DelegateCall && options != ExecutionOptions.DelegateCall && options != ExecutionOptions.Both)
    return Status.DelegateCallNotAllowed;
```
(`PermissionChecker._executionOptions`) **Verified**.

- `ExecutionOptions.None` forbids both native value and delegatecall. It is the default for `scopeTarget` (`options: None`) and whatever the owner passes for `allowTarget`/`allowFunction`/`scopeFunction` **Verified**.
- Where options live: for `Clearance.Target`, in `role.targets[to].options`; for `Clearance.Function`, in the per-selector header (`BufferPacker.unpackOptions`). There is no role-wide "never delegatecall" switch; it is enforced per target/function entry. Every grant must pass `None` (Inferred best practice, derived from code).
- Tests cover all four options for both clearance modes and delegatecall allow/deny (`test/ExecutionOptions.spec.ts`) **Verified** (by test names).
- Finer ETH control inside `Send`: `EtherWithinAllowance` caps cumulative value. In v3 `EtherValue` becomes a paramType so `EqualTo/LessThan/WithinAllowance` can apply to `msg.value` (`origin/contracts-v3:.../types/Operator.sol`) **Verified**.
- For our product: grant everything with `ExecutionOptions.None`; use WMON instead of native MON so no call needs value (Inferred).

---

## 6. Forcing swap recipient == avatar

### 6.1 Mechanism

`EqualToAvatar` on a `Static` node. At load time it becomes `EqualTo` with compValue `keccak256(abi.encode(avatar))`, and `_compare` checks `keccak256(32-byte word) == compValue` **Verified** (`PermissionLoader._load`, `PermissionChecker._compare`). Because it is a full 32-byte word comparison, dirty upper bits in the address slot also fail (Inferred from the hash of the whole word). The avatar used is the Roles mod's `avatar` variable; if the owner changes it with `setAvatar`, the constraint follows automatically (**Verified** by load-time patch). Test: `test/operators/15EqualToAvatar.spec.ts` **Verified** (exists).

### 6.2 SwapRouter02 `exactInputSingle` (recommended, practical in v2)

Signature (Inferred, from Uniswap `swap-router-contracts` `IV3SwapRouter`): `exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96))`, selector `0x04e45aaf` (Inferred). No deadline field in SwapRouter02 structs; deadline is only available via `multicall(uint256 deadline, bytes[] data)` (Inferred).

Flat condition tree (BFS), token allowlist via `Or` of `EqualTo`:

| idx | parent | paramType | operator | compValue |
|---|---|---|---|---|
| 0 | 0 | Calldata | Matches | |
| 1 | 0 | Tuple | Matches | |
| 2 | 1 | None | Or | (tokenIn) |
| 3 | 1 | None | Or | (tokenOut) |
| 4 | 1 | Static | Pass or Or/EqualTo | fee tiers |
| 5 | 1 | Static | **EqualToAvatar** | (recipient) |
| 6 | 1 | Static | WithinAllowance or Pass | amountIn |
| 7 | 1 | Static | GreaterThan / Pass | amountOutMinimum (only constant bounds) |
| 8 | 1 | Static | EqualTo 0 or Pass | sqrtPriceLimitX96 |
| 9-12 | 2 | Static | EqualTo | abi.encode(USDC), (WMON), (WETH), (LST) |
| 13-16 | 3 | Static | EqualTo | same four |

This passes `Integrity`: BFS parents non-decreasing; `Or` children same type (Static); tuple is all-static so inline (Inferred by applying the rules in 4.5). Pair restriction ("USDC must be on one side") is expressible by an `Or` over several `Tuple Matches` branches at index 1, one per allowed pair, since siblings share one type tree (Inferred). Cross-field relations (tokenIn != tokenOut, amountOutMinimum >= f(amountIn, price)) are not expressible in v2 without `Custom` (Verified: no operator compares two fields). Router constants `address(1)` (msg.sender) and `address(2)` (router itself) in SwapRouter02 are excluded by `EqualToAvatar` (Inferred about router semantics).

Also required: `scopeTarget(role, router)` plus `scopeFunction(... exactInputSingle ..., ExecutionOptions.None)`; do not allow `multicall` unless its `bytes[] data` is itself scoped with nested `And(Calldata Matches, Bitmask selector)` (see 4.4); do not allow `sweepToken`, `unwrapWETH9`, `refundETH`, `transferFrom`-style helpers without recipient constraints (Inferred).

### 6.3 SwapRouter02 `exactInput` and packed `path`

`exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum))` (Inferred ABI). Tree: `Calldata Matches -> Tuple Matches -> [Dynamic path, Static EqualToAvatar, Static, Static]`.

Constraining `path` (packed `token(20) | fee(3) | token(20) | ...`, not ABI encoded):
- **Recommended: `Or` of `EqualTo` exact paths.** `EqualTo` on `Dynamic` hashes length word + padded body, so it pins length and every byte (Verified mechanism, section 4.2). With 4 assets and a few fee tiers the allowlist is small.
- `Bitmask` on `Dynamic` can check 15-byte windows at fixed offsets (tokenIn needs two nodes: bytes 0-14 and 15-19). It cannot see the length word, so it cannot bind the final token for variable-length paths: an attacker could append extra hops ending in a disallowed token (Inferred from `_bitmask` reading `value[shift:]` of the body only). Not safe alone.
- v3 adds `Slice` (extract 1-32 bytes at a fixed offset of a Static/Dynamic value, then compare with a Static child) (`ConditionEvaluator._slice`) **Verified**, which makes per-token checks cleaner, but the length-binding problem remains for variable hop counts; exact-path `EqualTo` is still the robust choice (Inferred).

### 6.4 Universal Router `execute(bytes commands, bytes[] inputs, uint256 deadline)`

(Universal Router semantics below are Inferred from external knowledge of Uniswap's `Dispatcher`/`Commands`, not from this repo.) Each byte of `commands` selects a command (low bits = type, `0x80` = allow-revert flag); `inputs[i]` is the ABI-encoded parameter blob for command `i`. `V3_SWAP_EXACT_IN` (0x00) input = `(address recipient, uint256 amountIn, uint256 amountOutMin, bytes path, bool payerIsUser)`.

What v2 can express (mechanism **Verified**, applicability Inferred):
- `commands`: `Dynamic` with `Or` of `EqualTo` exact command strings (e.g. exactly `0x00`). Exact hash pins length and every byte, so no extra commands and no allow-revert flag.
- `inputs`: `Array Matches` with N children. `_matches` requires `children.length == inputs.length`, so positions are pinned and command i lines up with child i.
- Each element: `AbiEncoded Matches -> [Static EqualToAvatar (recipient), Static amountIn, Static amountOutMin, Dynamic path (Or of EqualTo), Static EqualTo(true) payerIsUser]`.
- `deadline`: only constant bounds (`LessThan`), no "now + 120s". Needs `Custom`.

Example tree for single-command `0x00`:

| idx | parent | paramType | operator | note |
|---|---|---|---|---|
| 0 | 0 | Calldata | Matches | |
| 1 | 0 | Dynamic | EqualTo | abi.encode(bytes(0x00)) |
| 2 | 0 | Array | Matches | inputs, exactly 1 element |
| 3 | 0 | Static | Pass / Custom | deadline |
| 4 | 2 | AbiEncoded | Matches | inputs[0] |
| 5 | 4 | Static | EqualToAvatar | recipient |
| 6 | 4 | Static | Pass / WithinAllowance | amountIn |
| 7 | 4 | Static | Pass | amountOutMin |
| 8 | 4 | None | Or | path allowlist |
| 9 | 4 | Static | EqualTo | payerIsUser = true |
| 10.. | 8 | Dynamic | EqualTo | exact paths |

Limits in v2:
- **Heterogeneous command sequences are not cleanly expressible.** Array elements are all decoded with the first child's type tree (`Topology.typeTree`, arrays take `start + 1`), and `Integrity._compatibleSiblingTypes` requires identical child type trees, except that later children may be plain `Dynamic` if the first is `AbiEncoded` **Verified**. So `[PERMIT2_PERMIT, V3_SWAP_EXACT_IN, SWEEP]` would force every element to be decoded with element 0's layout, which may read garbage offsets or revert `CalldataOutOfBounds` (Inferred). Workable only when all elements share a layout (e.g. several V3 swaps) or non-first elements are pinned by exact `Dynamic EqualTo`.
- `payerIsUser = true` means UR pulls funds through Permit2 from the avatar, which adds two approval layers: ERC20 `approve(Permit2, amt)` and `Permit2.approve(token, UR, uint160 amt, uint48 expiration)`. Both are scopable (spender `EqualTo`), but it is more surface (Inferred).
- UR v2 `V4_SWAP` nests `abi.encode(bytes actions, bytes[] params)` with recipients inside `TAKE*` actions; this is deeper and also heterogeneous (Inferred). Not practical in v2.
- v3 fixes the main blocker: "variant" arrays and logical nodes, where each array child can have its own type tree (`origin/contracts-v3:.../core/serialize/TypeTree.sol` `_isVariant`, `resolve`) **Verified**; plus `AbiEncoded` leading-bytes/selector matching (`ConditionEvaluator._matches` compValue prefix check) **Verified**, `ArrayTailMatches`, `ZipSome/ZipEvery` (iterate several plucked arrays in lockstep, e.g. commands vs inputs), `Pluck` **Verified** (existence and evaluator code).

**Assessment (Inferred):** On v2, SwapRouter02 `exactInputSingle` (and `exactInput` with exact-path allowlist) is the practical, auditable target. Universal Router is constrainable only for a fixed single-command (or homogeneous) shape like `commands == 0x00`, with Permit2 approvals added. Anything using V4 hooks/pools or mixed command sequences should wait for v3 or go through a `Custom` condition / wrapper contract. Need to confirm which Uniswap contracts are deployed on Monad (open question).

### 6.5 Token allowlists

`Or` (paramType None) with `Static EqualTo` children is valid (`Integrity._node` + `_compatibleSiblingTypes`) **Verified**. For an ERC20 `approve(spender, amount)` scope: `Calldata Matches -> [Static EqualTo(router), Static WithinAllowance/LessThan]` on each token target. "Exact-amount approval matching the swap amount" cannot be bound across two calls in v2 (each inner tx is evaluated independently; only allowance consumption is shared) **Verified** for v2 (`_multiEntrypoint` walks each tx separately). v3 `Pluck` context is created per `_transaction` (`Authorization._transaction` builds a fresh `Context`) **Verified**, so cross-call binding also does not exist in v3 (Inferred).

---

## 7. What conditions cannot do (relevant to our limits)

| Our limit | v2 | Notes |
|---|---|---|
| Allowed assets | Yes | `Or` of `EqualTo`, scope only token targets we list |
| One venue | Yes | only scope that router |
| Recipient == source account | Yes | `EqualToAvatar` |
| No delegatecall / no value | Yes | `ExecutionOptions.None` everywhere |
| No arbitrary calls | Yes | `scopeTarget` + explicit functions only, never `allowTarget` |
| Exact-amount approvals | Partial | cap by constant/allowance, not linked to swap |
| Max 10% per trade, 40% exposure, 10% USDC floor | No | needs balances/prices: `Custom` condition or v3 `WithinRatio` + pricing adapters |
| Max 0.5% slippage | No (v2) | needs price; v3 `WithinRatio` (not analyzed here) |
| Max 20 trades/day | Yes | `CallWithinAllowance` with `refill=20, period=86400, maxRefill=20` (Inferred config; mechanism Verified) |
| 2-minute deadline | No | no timestamp operator; `Custom` can read `block.timestamp` (Inferred) |
| Oracle freshness / circuit breaker | No | off-chain policy or `Custom` |

---

## 8. Batched calls and unwrappers

### 8.1 Mechanism

- Owner calls `setTransactionUnwrapper(to, selector, adapter)`; global for all roles (`_Periphery.sol`) **Verified**.
- In `_authorize`, if an adapter exists for `(to, bytes4(data))`, `_multiEntrypoint` calls `adapter.unwrap(to, value, data, operation)` (a `view` interface, so STATICCALL), and runs `_transaction` for every returned inner tx `(to, value, data[left:right], operation)` with the same role, accumulating consumptions. The first failure stops and reverts. Any adapter revert becomes `MalformedMultiEntrypoint` **Verified** (`PermissionChecker._multiEntrypoint`).
- The outer call itself (e.g. delegatecall to MultiSend) is **not** checked against targets or options when an unwrapper is registered; it is trusted to be exactly the batch the adapter described **Verified** by control flow. The executed tx is still the original outer tx (`exec(to, value, data, operation)` in `Roles.sol`).
- Unwrapping is one level only: inner txs go through `_transaction`, which never consults unwrappers **Verified**.

### 8.2 `MultiSendUnwrapper` (`periphery/MultiSendUnwrapper.sol`) **Verified**

- Requires outer `value == 0` and `operation == DelegateCall`, else `UnsupportedMode`.
- Header: selector `multiSend(bytes)`, offset word exactly `0x20`, and `4 + ceil32(64 + length) == data.length` (no trailing data).
- Entries: `op(1) | to(20) | value(32) | len(32) | data(len)`; `op > 1` -> `MalformedBody`; each entry must fit inside the declared length; zero entries rejected.
- Returns each entry's op, to, value and a calldata slice location. Each inner op (call or delegatecall) and value is then checked with normal `_executionOptions`.
- It ignores the `to` argument, so correctness depends on the owner registering it only for a genuine MultiSend/MultiSendCallOnly address (Inferred risk: registering it for any other contract would authorize delegatecalls to that contract based on a parse of its calldata).
- Parsing matches Safe's `MultiSend.multiSend` assembly loop (compare `contracts/test/MultiSend.sol`) (Inferred by reading both).

### 8.3 Can a batch smuggle a forbidden call?

(Inferred analysis based on Verified code paths.)
- Each inner tx faces the same target clearance, selector scope, conditions and options as a direct call, so no.
- Inner `delegatecall` entries are rejected unless the inner target/function grants `DelegateCall`.
- Nested batch: an inner delegatecall to MultiSend is checked as a plain tx (no second unwrap). It passes only if the role grants the MultiSend address with a `DelegateCall` option, which would make the nested batch unchecked. Rule: never grant any clearance on the MultiSend address itself; rely only on the unwrapper.
- Allowances are cumulative across inner txs (`Consumptions.merge`), so splitting a trade into several inner txs does not bypass `WithinAllowance`/`CallWithinAllowance` **Verified**.

### 8.4 Delegatecall to MultiSend with no unwrapper

It is treated as a single ordinary tx to the MultiSend address: `Clearance.None` -> `TargetAddressNotAllowed`; if the owner had granted it (`allowTarget` or `allowFunction(multiSend)` with `DelegateCall`), the entire packed batch would execute inside the avatar's context with no inner checks, which is full compromise (**Verified** control flow; consequence Inferred). Default is fail-closed.

### 8.5 `MorphoBundler3Unwrapper` (`periphery/MorphoBundler3Unwrapper.sol`) **Verified**

Requires `value == 0`, `operation == Call`, selector `multicall`, offset `0x20`; reads each `Call{to, data, value}` and ignores `skipRevert` and `callbackHash`. Inferred caveats: inner calls are executed by Bundler3 (not the avatar), and callback re-entries (`reenter`) authorized by `callbackHash` are not inspected. Not relevant for our launch scope. The v3 tree only ships `MultiSendUnwrapper` (`origin/contracts-v3:packages/evm/contracts/periphery/unwrappers/`) **Verified** by file list.

Recommendation (Inferred): at launch, avoid batching entirely, or register the unwrapper only for MultiSendCallOnly 1.4.1 on Monad, and send approve + swap as two inner calls.

---

## 9. v3 deltas relevant to us (branch `origin/contracts-v3`, BUSL-1.1)

All **Verified** by reading files on the branch unless noted.
- Memberships become `uint256` packed `start(64) | end(64) | usesLeft(128)` with `MembershipNotYetValid`, `MembershipExpired`, auto-revoke at 0 uses (`core/Membership.sol`). Directly useful for session-key expiry.
- `grantRole`, `revokeRole`, `renounceRole` (`core/Setup.sol` function list).
- Target clearance can carry a condition tree (`scopeConfig` target entry key `address | 0xFF..FF`) and a new global selector entry `allowFunctionGlobally` (any target) (`core/Authorization.sol` comments, `Setup.sol`). The global entry is a new foot-gun (Inferred).
- `ExecutionOptions` checked as bit flags in the scopeConfig high bits; same semantics (`Authorization._transaction`).
- `execTransactionWithSignature` with typed `RoleTx(to,value,data,operation,roleKey,shouldRevert,salt)` (`core/RoleTx.sol`, `Roles.sol`) and `nonReentrant` on exec entry points.
- Operators: removed `Nor`, `ArraySubset`, `EtherWithinAllowance` (now `EtherValue` paramType); added `Empty`, `ArrayTailMatches`, `ZipSome`, `ZipEvery`, `Slice`, `Pluck`, `WithinRatio`; variant (heterogeneous) arrays; `AbiEncoded` with leading bytes (selector check) replaces `Calldata` (`types/Operator.sol`, `types/Condition.sol`, `core/serialize/TypeTree.sol`).
- `ArraySome` bug fixed (`ConditionEvaluator._arrayIterator`).
- Explicit Integrity size caps (section 4.5).

---

## 10. Open questions

1. Which Uniswap contracts exist on Monad (SwapRouter02? Universal Router version? Permit2?) and their exact ABIs/selectors. Everything Uniswap-specific above is Inferred.
2. Confirm the ArraySome finding by running `test/operators/06ArraySome.spec.ts` with a case where only element 1 matches (needs a scratch checkout, since running tests writes artifacts).
3. Our PersonalAccount / StrategyVault must implement `IAvatar.execTransactionFromModule[ReturnData]` with call/delegatecall semantics; for an ERC-4626 vault this means building Safe-like module support. Not investigated here.
4. Whether Universal Router's `CalldataDecoder` follows standard ABI offsets exactly as `AbiDecoder` does (consistency assumption in 4.4 and 6.4).
5. Monad max contract code size vs `WriteOnce` buffer sizes (larger condition trees may fit on Monad but not on Ethereum).
6. Whether a `Custom` condition for deadline (`deadline <= block.timestamp + 120`) and per-trade size vs account value is acceptable, or whether v3 `WithinRatio` covers slippage (sub-agent covering pricing).
7. v2 signed module txs (`moduleTxSignedBy`) have no expiry; relevant if the session key signs and a relayer submits. Not analyzed in depth.
8. Whether Safe v1.5.0 MultiSend changes (if any, e.g. special handling of `to == address(0)`) are consistent with `MultiSendUnwrapper` parsing; not checked.
