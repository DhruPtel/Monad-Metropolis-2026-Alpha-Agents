# Sub-agent A: Account core (AccountV3)

## Versions

| Repo | Commit | Tag | Last commit date | License |
|---|---|---|---|---|
| tokenbound/contracts | `bce75f985558fad3d06ee1b86f224f0cfb783631` | `v0.3.1-15-gbce75f9` | 2024-03-11 | MIT (SPDX headers) |
| erc6551 (submodule, `contracts/lib/erc6551`) | `882159c` | v0.3.0~1 | 2023-10-18 | MIT |
| OpenZeppelin (submodule) | v4.9.3 | | | MIT |
| account-abstraction (submodule) | v0.6.0 (EntryPoint v0.6) | | | GPL-3.0 |
| multicall-authenticated (submodule) | main @653b2bc | | | MIT |

Method: static reading of source and Foundry tests. Nothing was executed (Foundry not installed). Line numbers refer to the files at the commit above.

Files read in full: `contracts/src/AccountV3.sol`, `AccountV3Upgradable.sol`, `AccountProxy.sol`, `AccountGuardian.sol`, all of `src/abstract/` and `src/abstract/execution/`, `src/lib/LibExecutor.sol`, `LibSandbox.sol`, `OPAddressAliasHelper.sol`, `src/utils/Errors.sol`, `src/cross-chain/FxChildExecutor.sol`, `lib/erc6551/src/lib/ERC6551AccountLib.sol`, `ERC6551BytecodeLib.sol`, OZ `metatx/ERC2771Context.sol`, OZ `UUPSUpgradeable.upgradeTo*`, account-abstraction `core/BaseAccount.sol`, `lib/multicall-authenticated/src/Multicall3.sol` (grep), tests `Account.t.sol`, `AccountPermissions.t.sol`, `AccountOverrides.t.sol`, `AccountCrossChain.t.sol`, mocks.

Inheritance (Verified, `AccountV3.sol:24-33`): `ERC721Holder, ERC1155Holder, Lockable, Overridable, Permissioned, ERC6551Account, ERC4337Account, TokenboundExecutor`. `TokenboundExecutor` = `ERC6551Executor, BatchExecutor, NestedAccountExecutor, ERC2771Context`; `BaseExecutor` = `Context, SandboxExecutor`.

---

## 1. Owner resolution

### token() reads the proxy footer
**Verified.** `ERC6551Account.token()` (`abstract/ERC6551Account.sol:39-45`) returns `ERC6551AccountLib.token()`, which does `extcodecopy(address(this), ptr, 0x4d, 0x60)` and ABI-decodes `(uint256 chainId, address tokenContract, uint256 tokenId)` (`lib/erc6551/src/lib/ERC6551AccountLib.sol:59-72`). The data is the immutable footer appended by the registry to the ERC-1167 clone (`ERC6551BytecodeLib.getCreationCode`, lines 10-30: salt at 0x2d, chainId 0x4d, tokenContract 0x6d, tokenId 0x8d). It is in bytecode, so it can never change. Even when the account is an `AccountProxy` behind the clone, `address(this)` is the clone, so the footer is read from the clone (Inferred from delegatecall semantics).

### owner() and _tokenOwner
**Verified.** `AccountV3.owner()` (`AccountV3.sol:76-79`) = `_tokenOwner(token())`. `_tokenOwner` (`AccountV3.sol:344-358`):

```solidity
if (chainId != block.chainid) return address(0);
if (tokenContract.code.length == 0) return address(0);
try IERC721(tokenContract).ownerOf(tokenId) returns (address _owner) {
    return _owner;
} catch {
    return address(0);
}
```

It is a live `ownerOf` call on every authorization check. There is no cached owner. (Verified)

### _rootTokenOwner (nested accounts)
**Verified.** `AccountV3.sol:324-338` walks up the tree while the owner is an ERC-6551 account:

```solidity
while (ERC6551AccountLib.isERC6551Account(_owner, __self, erc6551Registry)) {
    (chainId, tokenContract, tokenId) = IERC6551Account(payable(_owner)).token();
    _owner = _tokenOwner(chainId, tokenContract, tokenId);
}
```

`isERC6551Account` (`ERC6551AccountLib.sol:25-45`) returns true only if the owner's code length is exactly 0xAD (an ERC-6551 clone), the clone's embedded implementation equals `expectedImplementation` (`__self`), and the address matches the registry CREATE2 computation. `__self` is `address immutable __self = address(this)` in `NestedAccountExecutor.sol:25`, i.e. the implementation contract's own address fixed at construction.

**Inferred (high confidence, needs a fork test): nested root resolution does not work for canonical proxied accounts.** The SDK creates accounts with `implementation = ACCOUNT_PROXY` (`packages/sdk/src/TokenboundClient.ts:151-152`, Verified). So a canonical TBA is a clone pointing at `AccountProxy` (0x5526...), which delegatecalls `AccountV3Upgradable` (0x41C8...). Inside that code `__self` is 0x41C8, but `ERC6551AccountLib.implementation(owner)` returns 0x5526, so `isERC6551Account` returns false and `_rootTokenOwner` stops at the direct owner (the parent TBA address). The repo tests for nesting (`AccountPermissions.t.sol:76-119`, `AccountOverrides.t.sol:122-179`, `Account.t.sol:410-458`) all create accounts with the raw `AccountV3` implementation, never the proxy, so they do not cover this. Consequences if confirmed:
- For a nested canonical TBA, the "root owner" is the parent TBA, not the EOA. The EOA must act through `parent.execute(child, ..., child.execute(...))`.
- Permissions and overrides on a nested canonical TBA are keyed by the parent TBA address, which does not change when the top-level NFT is sold. They would survive the sale (see section 6).
- `executeNested` computes addresses with `__self` (`NestedAccountExecutor.sol:66-68`), so it would compute non-proxy addresses and fail with `InvalidAccountProof` / `NotAuthorized` for canonical accounts.

### Cross-chain (token chainId != block.chainid)
**Verified.** `_tokenOwner` returns `address(0)`, so `owner()` is zero, `_rootTokenOwner` is zero (`isERC6551Account(address(0))` is false because code length is 0). Effects:
- `lock`, `setPermissions`, `setOverrides` revert `NotAuthorized` (each checks `_owner == address(0)`, `Lockable.sol:30`, `Permissioned.sol:33`, `Overridable.sol:34`).
- `hasPermission(x, address(0))` reads `permissions[0][x]`, which can never be written (setPermissions requires a non-zero owner). (Inferred from code)
- Only these executors pass `_isValidExecutor` (`AccountV3.sol:226-255`): the EntryPoint (but a UserOp needs a valid signer, and no non-zero signer matches; the v=0 path with signer `address(0)` passes `_isValidSigner` but `SignatureChecker.isValidERC1271SignatureNow(address(0), ...)` returns false because a call to an address with no code returns empty data, Inferred from OZ code), an L1 caller whose aliased address equals this account (`OPAddressAliasHelper.undoL1ToL2Alias(_msgSender()) == address(this)`, OP Stack L1-to-L2 messages from the same-address account on L1), and any `guardian.isTrustedExecutor(executor)` (bridge executors set by the guardian owner, a Tokenbound Safe per `script/DeployAccountV3.s.sol`). Test: `AccountCrossChain.t.sol:61-160`.
- On the native chain, neither the OP alias nor trusted executors are accepted (both are inside `if (chainId != block.chainid)`). Verified by code and by `AccountCrossChain.t.sol:103-111, 150-160`.

For our Monad TBAs (AgentNFT on chain 143, account chainId 143) cross-chain paths are inactive. (Inferred)

---

## 2. Execution entry points

### Authorization predicate `_isValidExecutor(executor)` (`AccountV3.sol:226-255`, Verified)
Returns true, in order, if: `executor == entryPoint()`; or (foreign chain only) OP alias of `_msgSender()` is this account, or guardian-trusted executor; or `executor == _tokenOwner`; or `executor == _rootTokenOwner`; or `hasPermission(executor, _rootOwner)`.

### `_msgSender()` / ERC-2771 (Verified)
`TokenboundExecutor._msgSender` (`abstract/execution/TokenboundExecutor.sol:34-42`) resolves to OZ `ERC2771Context._msgSender` (`ERC2771Context.sol:24-34`): if `msg.sender` is the immutable trusted forwarder (the multicall at 0xcA11...CCD) and calldata is at least 20 bytes, the sender is the last 20 bytes of calldata. The forwarder always appends its own `msg.sender` (`lib/multicall-authenticated/src/Multicall3.sol:49,73,121,162`: `call.target.call(abi.encodePacked(call.callData, msg.sender))`), so it cannot be used to spoof. Only `execute`, `executeBatch`, `executeNested`, `_authorizeUpgrade`, `_updateState` (via `_msgData`) and the OP alias check use `_msgSender`/`_msgData`. `lock`, `setPermissions`, `setOverrides` use raw `msg.sender` (`Lockable.sol:31`, `Permissioned.sol:34`, `Overridable.sol:35`), so they cannot be batched through the forwarder. (Verified)

### `_beforeExecute` (`AccountV3.sol:268-271`, Verified)
```solidity
if (isLocked()) revert AccountLocked();
_updateState();
```

### Operation dispatch `LibExecutor._execute` (`lib/LibExecutor.sol:13-31`, Verified)
```solidity
if (operation == OP_CALL) return _call(to, value, data);
if (operation == OP_DELEGATECALL) {
    address sandbox = LibSandbox.sandbox(address(this));
    if (sandbox.code.length == 0) LibSandbox.deploy(address(this));
    return _call(sandbox, value, abi.encodePacked(to, data));
}
if (operation == OP_CREATE) return abi.encodePacked(_create(value, data));
if (operation == OP_CREATE2) { salt = data[:32]; bytecode = data[32:]; ... }
revert InvalidOperation();
```

**Delegatecall is sandboxed (Verified).** The account never delegatecalls user code. It CALLs its per-account sandbox (CREATE2 by the account, salt `keccak256("org.tokenbound.sandbox")`, `LibSandbox.sol:15-22`). Decoding the sandbox runtime (`LibSandbox.sol:7-9` header/footer): `PUSH20 <account>; CALLER; EQ; JUMPI` else `revert(0,0)`; then `calldatacopy`, and `DELEGATECALL(gas, first20bytes(calldata), 0x14, calldatasize-0x14, 0, 0)`, bubbling result or revert (Verified by bytecode decoding; Inferred that my decoding is exact). So the target runs in the sandbox's storage, cannot write the account's storage, but can call back into `extcall/extcreate/extcreate2` because `msg.sender` seen by the account is then the sandbox (`SandboxExecutor._requireFromSandbox`, `abstract/execution/SandboxExecutor.sol:19-21`). Test: `Account.t.sol:543-626` (`testExecuteSandbox`).

### Entry point table

| Entry point | File:line | Who may call | Checks | Lock blocks? | Updates state? |
|---|---|---|---|---|---|
| `execute(to,value,data,op)` op 0 CALL | `ERC6551Executor.sol:31-42` | `_isValidExecutor(_msgSender())`: EntryPoint, owner, root owner, permissioned, (foreign chain: OP alias, guardian executors) | `_beforeExecute` | Yes | Yes |
| `execute` op 1 DELEGATECALL | same, `LibExecutor.sol:18-22` | same | same; routed through sandbox (call + delegatecall in sandbox) | Yes | Yes |
| `execute` op 2 CREATE / op 3 CREATE2 | `LibExecutor.sol:23-28, 47-68` | same | same; reverts `ContractCreationFailed` on zero address | Yes | Yes |
| `executeBatch(Operation[])` | `BatchExecutor.sol:24-43` | same | one `_isValidExecutor` + one `_beforeExecute` for the whole batch; each op any type | Yes | Yes (once) |
| `executeNested(to,value,data,op,proof)` | `NestedAccountExecutor.sol:50-89` | walks `proof`: `ownerOf(proof[i]) == current`, `current = computeAddress(... __self ...)`; checks `isLocked()` of each deployed intermediate account; then `_isValidExecutor(current)` | `_beforeExecute` | Yes (this account and deployed intermediates) | Yes |
| `extcall(to,value,data)` | `SandboxExecutor.sol:26-32` | only the account's sandbox | none other | **No** | **No** |
| `extcreate`, `extcreate2` | `SandboxExecutor.sol:37-52` | only sandbox | none other | **No** | **No** |
| `extsload(slot)` | `SandboxExecutor.sol:57-61` | anyone (view) | none | n/a | n/a |
| ERC-4337 `validateUserOp` | `account-abstraction/core/BaseAccount.sol:42-48`, `ERC4337Account.sol:37-61` | only EntryPoint | signature by `_isValidSigner` over `toEthSignedMessageHash(userOpHash)`; nonce managed by EntryPoint; pays prefund | **No** | No |
| ERC-4337 execution | EntryPoint calls `execute`/`executeBatch`/`executeNested`/`upgradeTo` with `msg.sender == entryPoint` | EntryPoint is always a valid executor | per function | per function | per function |
| Multicall forwarder | any function above using `_msgSender` | real caller appended by forwarder | same as direct call | same | same |
| Cross-chain executors (`FxChildExecutor`, OP portal alias, guardian-trusted) | `AccountV3.sol:233-241`, `cross-chain/FxChildExecutor.sol:20-26` | only when token chainId != block.chainid | same as execute | Yes | Yes |
| `upgradeTo` / `upgradeToAndCall` (upgradable impl only) | `AccountV3Upgradable.sol:15-18`, OZ UUPS | `guardian.isTrustedImplementation(impl)` AND `_isValidExecutor(_msgSender())` (so permissioned callers and EntryPoint too) | no `_beforeExecute` | **No** | **No** |
| `lock(ts)` | `Lockable.sol:26-42` | `msg.sender == rootOwner` only | `_beforeLock` (reverts if locked) | Yes (cannot re-lock or unlock early) | Yes |
| `setPermissions` | `Permissioned.sol:29-49` | `msg.sender == rootOwner` only | `_beforeSetPermissions` | Yes | Yes |
| `setOverrides` | `Overridable.sol:30-53` | `msg.sender == rootOwner` only | `_beforeSetOverrides` | Yes | Yes |
| `receive`, `fallback`, `onERC721Received`, `onERC1155Received`, `onERC1155BatchReceived` | `AccountV3.sol:56-67, 109-151` | anyone | `_handleOverride` (runs root owner's override via sandbox, which can `extcall`) | **No** | **No** |
| `supportsInterface` (non-base IDs) | `AccountV3.sol:89-103` | anyone (view) | `_handleOverrideStatic` (plain staticcall to override impl) | n/a | n/a |

All "Yes/No" cells are Verified from the cited code unless otherwise noted. Note `executeBatch` returns results but reverts wholesale if any op reverts (`LibExecutor._call` bubbles revert, `LibExecutor.sol:33-45`). (Verified)

---

## 3. Signatures (ERC-1271 and isValidSigner)

`isValidSignature(hash, sig)` (`abstract/Signatory.sol:14-24`) -> `AccountV3._isValidSignature` (`AccountV3.sol:185-217`). `isValidSigner(signer, data)` (`ERC6551Account.sol:24-35`) -> `AccountV3._isValidSigner` (`AccountV3.sol:159-178`); the `data` argument is ignored (Verified).

```solidity
// _isValidSigner
if (signer == _owner) return true;
address _rootOwner = _rootTokenOwner(_owner, chainId, tokenContract, tokenId);
if (signer == _rootOwner) return true;
return hasPermission(signer, _rootOwner);
```

- **Who can sign (Verified):** the direct owner, the root owner, and any address with `permissions[rootOwner][signer] == true`. Two formats: (a) 65-byte ECDSA, recovered with `ECDSA.tryRecover` and checked with `_isValidSigner`; (b) `v == 0` contract signature: signer address in `r`, offset in `s`, inner signature at that offset, then `SignatureChecker.isValidERC1271SignatureNow(signer, hash, inner)`. The contract signer must itself be a valid signer or `address(this)` (recursive). So a smart-wallet owner (Safe etc.) and a permissioned contract can sign. Test: `Account.t.sol:115-161`.
- **Permissioned callers can sign ERC-1271 and ERC-4337 UserOps (Verified).** `_isValidSigner` includes `hasPermission`, and `_validateSignature` for 4337 uses `_isValidSignature` (`ERC4337Account.sol:37-49`).
- **Hash binding (Verified):** `_isValidSignature` checks the raw `hash` with no EIP-712 wrapping, no account address, no chainId. **Inferred consequence:** an owner EOA's signature over a hash is accepted by every TBA whose owner/root owner is that EOA (and by the EOA itself), unless the application hash already includes the verifying account (e.g., EIP-712 domain or a `from` field). ERC-4337 is bound because `userOpHash` from EntryPoint v0.6 includes the EntryPoint address, chainId and `sender` (Inferred from EntryPoint v0.6 design; not re-read here), and is wrapped with `toEthSignedMessageHash` (`ERC4337Account.sol:54-61`, Verified).
- **After NFT transfer (Verified):** the check is live: `_tokenOwner` calls `ownerOf` at verification time. A signature by the seller stops validating the moment `ownerOf` changes; permissioned signers keyed to the seller also stop (keys change, section 6). Anything already consumed onchain (Permit2 allowances, executed orders) is not undone (Inferred; out of account scope).
- **Lock does not block signatures (Verified).** `_isValidSignature`/`_isValidSigner` contain no `isLocked` check. The test `testAccountLocksAndUnlocks` claims "signing should fail if account is locked" (`Account.t.sol:246-252`) but signs with key 2 (`vm.sign(2, hash)`), which is not the owner, so it fails for being a wrong signer, not because of the lock. The test is misleading. (Verified)

---

## 4. `state()`

**Verified.** `_state` is a plain storage `uint256` (`ERC6551Account.sol:18`), returned by `state()` (`ERC6551Account.sol:50-52`). Updated only by `_updateState` (`AccountV3.sol:260-262`):

```solidity
_state = uint256(keccak256(abi.encode(_state, _msgData())));
```

Called from `_beforeExecute` (execute, executeBatch, executeNested), `_beforeLock`, `_beforeSetOverrides`, `_beforeSetPermissions` (`AccountV3.sol:268-297`). Tests: state changes on lock (`Account.t.sol:198-204`), setOverrides (`AccountOverrides.t.sol:66-78`), executeNested (`Account.t.sol:443-448`).

**Does not change on (Verified from code):** NFT transfer of the bound token (the account is not notified), incoming ETH/ERC-721/ERC-1155/ERC-20, `upgradeTo`/`upgradeToAndCall`, `validateUserOp` (prefund payment), and override-driven `extcall`/`extcreate` executions triggered through `receive`/`fallback`/token hooks. **Inferred:** `state()` is the ERC-6551 "nonce-like" value for marketplaces to detect changes between listing and fill, but it misses upgrades and override-driven asset movements, so a buyer or marketplace relying only on `state()` can be fooled (section 7).

---

## 5. Permissions (`abstract/Permissioned.sol`)

**Storage (Verified):** `mapping(address => mapping(address => bool)) public permissions;` (line 17), keyed `rootOwner => caller => bool`. It lives in each account's own storage (so per account). Contract comment (lines 9-11): "Permissions are keyed by the root owner address, so will be disabled upon transfer of the token which owns this account tree."

**setPermissions (Verified, lines 29-49):**
```solidity
address _owner = _rootTokenOwner(chainId, tokenContract, tokenId);
if (_owner == address(0)) revert NotAuthorized();
if (msg.sender != _owner) revert NotAuthorized();
_beforeSetPermissions();                 // reverts if locked, updates state
...
permissions[_owner][callers[i]] = _permissions[i];
emit PermissionUpdated(_owner, callers[i], _permissions[i]);
```
Only the root owner, only by direct `msg.sender` (not via forwarder, EntryPoint, or permissioned caller), only while unlocked.

**Granularity (Verified):** a single `bool`. No target, selector, value, amount, operation-type, or expiry scoping. A permissioned address gets exactly the root owner's executor powers: `execute` with all four operation types, `executeBatch`, `executeNested` (empty proof), `upgradeTo`/`upgradeToAndCall` to guardian-trusted implementations (`AccountV3Upgradable.sol:15-18`), ERC-1271 signing, and ERC-4337 UserOp signing.

**What a permissioned caller cannot do (Verified):** call `setPermissions`, `setOverrides`, `lock` (all require `msg.sender == rootOwner`). It also cannot reach them through `execute(address(this), ...)` because then `msg.sender` is the account itself, which is not the root owner (Inferred; the account can never own its own token, `AccountV3.sol:115-119`). It cannot transfer the AgentNFT itself (the NFT is held by the owner, not the account) (Inferred).

---

## 6. CRITICAL: permissions and overrides across NFT transfer

### Code path (Verified)
1. Every check recomputes the root owner live: `_isValidExecutor` -> `_tokenOwner` (`ownerOf`) -> `_rootTokenOwner` -> `hasPermission(executor, _rootOwner)` = `permissions[_rootOwner][executor]` (`AccountV3.sol:244-252`, `Permissioned.sol:57-59`).
2. After `safeTransferFrom(seller, buyer, id)`, `_rootOwner` becomes `buyer`, so lookups read `permissions[buyer][...]`, an untouched mapping. The seller's grants in `permissions[seller][...]` are **not deleted**, just no longer consulted.
3. Test proof: `AccountPermissions.t.sol:112-118` transfers the root token and asserts the permissioned `user2` is no longer a valid signer and `execute` reverts `NotAuthorized`.

So on transfer to a new address, permissions become inactive immediately, in the same block as the transfer, with no action needed. (Verified)

### Transfer back to the original owner (Verified storage behavior, Inferred risk)
Nothing ever clears `permissions[seller][*]` or `overrides[seller][*]`. If the NFT returns to the seller address, `_rootOwner == seller` again, and every old grant (session keys, executors) and every old override silently revives. There is no epoch, nonce, or owner-change hook. Scenarios: buyer resells to seller; a marketplace or escrow returns the NFT after a cancelled sale; a lending/rental protocol returns it; the same address buys it back years later. The buyer-side mirror image also applies: if the buyer ever owned this agent before, their old grants revive. **Also Inferred:** because the key is the root owner, if the root owner is an escrow or marketplace contract that holds many NFTs over time, grants made "as" that contract persist across unrelated custody periods (only possible if that contract calls `setPermissions`).

### Nested accounts (Inferred, see section 1)
For canonical proxied TBAs the root-owner walk likely stops at the parent TBA. Then a nested account's permissions/overrides are keyed by the parent TBA address, which is unchanged by selling the top-level NFT, so those grants would persist to the buyer's tree and remain usable by whoever the seller permissioned on the child. Needs a fork test.

### Other state that persists across transfer (Verified)
- `lockedUntil` is a plain `uint256` (`Lockable.sol:17`), not keyed by owner: a lock set by the seller binds the buyer.
- `_state` persists (just a counter).
- Sandbox contract persists (keyed by account address) and has no storage that matters for auth (Inferred).
- ERC-20/Permit2 approvals granted by the account persist (they are in token contracts) (Inferred; Sub-agent D).

---

## 7. Lock (`abstract/Lockable.sol`)

**Verified:**
- `lock(uint256 _lockedUntil)` (lines 26-42): only `msg.sender == rootOwner` (non-zero). Not callable by permissioned callers, EntryPoint, forwarder-relayed callers, or cross-chain executors.
- Max: `_lockedUntil > block.timestamp + 365 days` reverts `ExceedsMaxLockTime` (line 33). The argument is an absolute timestamp. Values in the past are allowed and are a no-op lock (state still updates).
- `_beforeLock` reverts if already locked (`AccountV3.sol:276-279`), so a lock cannot be extended, shortened, or cancelled until it expires. Test `Account.t.sol:236-239`.
- `isLocked()` = `lockedUntil > block.timestamp` (line 47-49); `lockedUntil` is `public`. A buyer can read both onchain. `LockUpdated` event emitted.

**What lock blocks (Verified):** `execute`, `executeBatch`, `executeNested` (for this account and deployed intermediate accounts in the proof), `setPermissions`, `setOverrides`, `lock`. This applies to all executors including permissioned callers, EntryPoint execution, and cross-chain executors, since all go through `_beforeExecute`.

**What lock does NOT block (Verified):**
1. ERC-1271 `isValidSignature` and `isValidSigner` (no lock check). Owner and permissioned addresses can still sign off-chain orders/permits during the lock.
2. ERC-4337 `validateUserOp`, including `_payPrefund` which sends ETH from the account to the EntryPoint (`BaseAccount.sol:42-48, 100-106`). The execution phase then reverts. **Inferred:** an owner/permissioned signer can make the account pay gas for reverted UserOps; if they also act as bundler (beneficiary) with a high `maxFeePerGas`, ETH leaks to them during a lock.
3. `upgradeTo`/`upgradeToAndCall` (`AccountV3Upgradable.sol:15-18` has no lock check); limited to guardian-trusted implementations; `state` does not change.
4. **Overrides.** `receive`, `fallback`, and token-received hooks call `_handleOverride` with no lock check (`Overridable.sol:60-75`). The override implementation runs inside the sandbox (`sandbox.call(abi.encodePacked(implementation, msg.data, msg.sender))`), and the sandbox may call `extcall/extcreate/extcreate2` (`SandboxExecutor.sol:26-52`) which have no lock check and no state update. **Inferred (high confidence from code): a seller can set an override before locking (for example on a custom selector that forwards all funds to the seller, gated on the appended `msg.sender`), then lock, list, and drain the account during the lock by calling that selector. `state()` would not change and `isLocked()` stays true.** The repo test comment "fallback calls should revert if account is locked" (`Account.t.sol:215-221`) has no assertion; it only logs.
5. Nested child accounts: the root owner can call `child.execute(...)` directly (root owner branch of `_isValidExecutor`), which checks only the child's lock, not the parent's. Assets in TBAs of NFTs held by a locked TBA remain movable (Verified from `AccountV3.sol:243-252`; relies on root resolution working, see section 1; if it does not work for proxies, the path is `parent.execute`, which is blocked by the parent lock).

**Can lock prevent a seller draining during a sale? (Inferred)** Only partially. It blocks the normal execute paths, but not the override path (4), 4337 gas leakage (2), or signature-based actions (1). A buyer must also check that `overrides[seller][selector]` is empty for all relevant selectors; that mapping is public but keyed by selector, so enumeration requires scanning `OverrideUpdated` events. Also the lock itself survives the transfer, so a seller can grief a buyer with up to 365 days of lock (Verified that `lockedUntil` is not owner-keyed; griefing impact is Inferred).

---

## 8. Overrides (`abstract/Overridable.sol`)

**Verified:**
- Storage: `mapping(address => mapping(bytes4 => address)) public overrides;` (line 19), keyed `rootOwner => selector => implementation`.
- `setOverrides` (lines 30-53): only `msg.sender == rootOwner`, reverts if locked, updates state, deploys the sandbox if needed.
- Which selectors are overridable: only calls that reach `_handleOverride`/`_handleOverrideStatic`, which are `receive`, `fallback` (any unknown selector), `onERC721Received`, `onERC1155Received`, `onERC1155BatchReceived` (`AccountV3.sol:56-151`), and `supportsInterface` for non-base interface IDs (`AccountV3.sol:89-103`, test `AccountOverrides.t.sol:88-120`). Defined functions such as `execute`, `isValidSignature`, `setPermissions`, `lock` are dispatched by Solidity before the fallback, so they cannot be overridden (Inferred from Solidity dispatch; consistent with tests).
- Execution mode: mutating overrides run via CALL to the sandbox, which DELEGATECALLs the implementation with `msg.data ++ msg.sender` appended (`Overridable.sol:66-70`). The implementation runs in the sandbox's storage, not the account's, but can move account assets through `extcall` etc. `supportsInterface` overrides are a plain `staticcall` to the implementation (`Overridable.sol:82-95`).
- `onERC721Received` still reverts `OwnershipCycle` for the account's own bound token before consulting overrides (`AccountV3.sol:115-119`).
- Transfer: same model as permissions. Overrides are read from `overrides[currentRootOwner]`; after a sale they go dormant, and revive if the NFT returns to the same root owner. Test `AccountOverrides.t.sol:290-298` asserts reset on transfer, **but it checks `accountAddress` (the parent account, which never had overrides) instead of `accountAddress2`**, so it does not actually prove the reset (Verified test weakness; the reset itself follows from the storage key, Inferred-high).

---

## 9. Receive, fallback, token hooks (brief)

**Verified:** `receive()` and `fallback()` are payable and call `_handleOverride`; with no override they return empty success (test `AccountOverrides.t.sol:60-64`). `onERC721Received` rejects only the account's own bound token on the same chain (`OwnershipCycle`), else runs override, returns selector. ERC-1155 hooks run override, return selector. No hook updates `state` or checks lock. An override can make the account refuse tokens (by returning a wrong value or reverting; test mocks return `bytes4("")`, `AccountERC1155.t.sol:121-188`, `AccountERC721.t.sol:111-136`). **Inferred:** deeper cycles (A owns B's token, B owns A's token) are not blocked by this check and would make `_rootTokenOwner` loop until out of gas (Sub-agent D should confirm).

---

## Implications for our platform

1. **Can setPermissions restrict a session key to only call our Executor? No (Verified).** A permission is a single `bool` per `(rootOwner, caller)` and grants full executor and signer powers: arbitrary `execute` (call, sandboxed delegatecall, create, create2), `executeBatch`, `upgradeTo` to any guardian-trusted implementation, ERC-1271 signing, ERC-4337 UserOp signing. Granting the Privy session key directly would give it unrestricted custody of the personal account.
2. **The precise way to get restriction:** do not permission the session key. Permission our **Executor contract address** instead (`setPermissions([executor], [true])`, called by the NFT holder directly). The session key calls the Executor; the Executor enforces typed actions and calls `tba.execute(...)`. The TBA sees `msg.sender == Executor`, which is permissioned. Conditions (Inferred):
   - The Executor must never forward arbitrary calldata to the TBA, must never call `upgradeTo*`, and must use only operation 0 (CALL).
   - The Executor must **not** implement ERC-1271 `isValidSignature` in a way that approves arbitrary hashes, because the TBA's `v == 0` path would accept any signature the Executor approves (`AccountV3.sol:196-208`). Safest: the Executor does not implement `isValidSignature` at all.
   - The Executor itself cannot be restricted by the TBA; its code is the entire policy. A bug in it is a full-custody bug.
   - ERC-4337 via Privy: a UserOp signed by the session key would require the session key to be a valid signer, i.e. permissioned, which re-opens full power. So gas sponsorship should sponsor the session key's own account calling the Executor, not UserOps from the TBA. (Inferred)
3. **Transfer handling:** permission to the Executor goes dormant automatically on sale (keyed by old owner) and the buyer must re-grant. But it **revives if the NFT returns to the same address**, as do seller overrides. Our Executor must keep its own ownership epoch: record `ownerOf(agentId)` (and a BuildRegistry/config epoch) at grant time and refuse to act if the current owner or epoch differs, and bump the epoch on every AgentNFT transfer (our AgentNFT `_update` hook can do this). Do not rely on Tokenbound keying alone.
4. **Pre-sale drain protection:** Tokenbound `lock` is not sufficient (overrides and signatures bypass it, see section 7). For the sale flow we should enforce in our own AgentNFT/marketplace: block transfer while any Executor action is pending, require overrides to be empty (or block `setOverrides` use entirely by checking `OverrideUpdated` events / reading `overrides[owner][sel]` for known selectors), and treat `state()` as insufficient (it ignores upgrades and override activity). Consider a custom account implementation (our own ERC-6551 implementation or a fork without overrides) if exact restriction is a hard requirement.
5. **Lock side effects:** while locked, the owner cannot revoke permissions (`setPermissions` reverts). A compromised permissioned signer keeps ERC-1271 power until the lock expires. Seller locks persist to the buyer.
6. **ERC-1271 for x402:** the TBA accepts raw hashes not bound to the account. EIP-3009 `transferWithAuthorization` style payloads include `from` and the token's EIP-712 domain, so they are bound (Inferred). Generic `personal_sign` messages are replayable across all TBAs of the same owner.
7. **Strategy vault:** because a permissioned Executor has unrestricted TBA custody, the vault must never grant the TBA or the Executor-as-TBA rights to withdraw depositor assets; vault roles should be granted to the Executor path with its own checks, not to the TBA. (Inferred)

---

## Open questions

1. Does `_rootTokenOwner` actually fail for canonical proxied accounts (`__self` = 0x41C8 vs clone implementation = 0x5526)? Needs a fork test on Monad: mint NFT A to EOA, create TBA_A via registry with AccountProxy, mint NFT B to TBA_A, create TBA_B, then check `TBA_B.isValidSigner(EOA)` and `TBA_B.execute` from EOA; then transfer A and test whether a permission granted on TBA_B survives.
2. Is the deployed Monad bytecode at 0x41C8 identical to HEAD or v0.3.1 (orientation notes the `virtual`-only diff)? Needs a bytecode comparison.
3. Override drain during lock: confirm with a Foundry test (set override on selector X with implementation calling `ISandboxExecutor(msg.sender).extcall(seller, balance, "")`, lock, call X).
4. ERC-4337 prefund leakage during lock: confirm magnitude with EntryPoint v0.6 accounting (unused prefund goes to the account's EntryPoint deposit, not back to the account).
5. Which implementations and cross-chain executors has the guardian (Tokenbound Safe) marked trusted on Monad? Read `isTrustedImplementation`/`isTrustedExecutor` via `eth_call` once the guardian address is derived.
6. Zellic audit findings on overrides/lock were not reviewed by this sub-agent.
7. Whether marketplaces on Monad check `state()` or `isLocked()` at all (outside code scope).
