# D: Security and edge cases (Tokenbound v3)

Sub-agent D working notes. Read only. Labels: **Verified** = seen in code, tests, or audit PDF. **Inferred** = my reasoning, not executed (Foundry not installed; nothing was run).

## Versions

| Repo | Commit | Tag | Last commit | License |
|---|---|---|---|---|
| tokenbound/contracts | `bce75f985558fad3d06ee1b86f224f0cfb783631` | v0.3.1-15-gbce75f9 | 2024-03-11 | SPDX MIT |
| erc6551/reference | `da16a63fb53db6375175a9dca22f1e19e652a193` | v0.3.0-17 | 2023-10-24 | SPDX MIT |
| contracts/lib/erc6551 (submodule) | `882159c9` | v0.3.0~1 | 2023-10-18 | MIT |
| contracts/lib/account-abstraction | v0.6.0 (EntryPoint v0.6) | | | GPL-3.0 |
| contracts/lib/openzeppelin-contracts | v4.9.3 | | | MIT |
| tokenbound/sdk | `6244f1e3` | @tokenbound/sdk 0.5.5 | 2024-10-22 | ISC (package.json) |

Audit PDFs: `contracts/audits/Tokenbound - Zellic Audit Report.pdf` (22 pages), `erc6551-reference/audits/certik-07-03.pdf` (19 pages). Text extracted with pypdf into the scratchpad.

---

## 0. Mechanisms that everything below depends on

### 0.1 `state()` is only bumped on a few paths (Verified)
`contracts/src/abstract/ERC6551Account.sol:17` declares `uint256 _state`; `state()` (line 50) returns it. The only writer is `AccountV3._updateState()`:

```solidity
// contracts/src/AccountV3.sol:260-271
function _updateState() internal virtual {
    _state = uint256(keccak256(abi.encode(_state, _msgData())));
}
function _beforeExecute() internal virtual override {
    if (isLocked()) revert AccountLocked();
    _updateState();
}
```
`_updateState` is called only from `_beforeExecute` (AccountV3.sol:268), `_beforeLock` (276), `_beforeSetOverrides` (285), `_beforeSetPermissions` (294). `_beforeExecute` is called from `ERC6551Executor.execute` (`abstract/execution/ERC6551Executor.sol:39`), `BatchExecutor.executeBatch` (`BatchExecutor.sol:31`) and `NestedAccountExecutor.executeNested` (`NestedAccountExecutor.sol:86`). Lock checks live in exactly the same four hooks, plus a lock check on intermediate accounts in `executeNested` (line 72-74).

### 0.2 Path-by-path coverage of lock and state (Verified unless marked)

| Path that can move assets or change control | Lock checked? | `state()` changes? | Citation |
|---|---|---|---|
| `execute` / `executeBatch` by owner, root owner, permissioned caller | Yes | Yes | ERC6551Executor.sol:37-41, BatchExecutor.sol:29-31, AccountV3.sol:226-255 |
| ERC-4337 op (EntryPoint calls `execute`) | Yes (at execution) | Yes | AccountV3.sol:228 (EntryPoint is a valid executor) |
| ERC-4337 `validateUserOp` prefund (`_payPrefund`) | **No** | **No** | `lib/account-abstraction/contracts/core/BaseAccount.sol:42-48, 100-106`. Only gas ETH, sent to EntryPoint. |
| `executeNested` on the target account | Yes (target), yes for deployed intermediates | Target only; intermediates **not** | NestedAccountExecutor.sol:72-74, 86 |
| `execute` with operation 1 (DELEGATECALL) | Yes | Yes (once, before the delegatecall; inner `extcall`s do not bump again) | LibExecutor.sol:18-22 |
| `setPermissions`, `setOverrides`, `lock` | Yes | Yes | Permissioned.sol:39, Overridable.sol:40, Lockable.sol:37 |
| **Override** triggered via `fallback`, `receive`, `onERC721Received`, `onERC1155Received`, `onERC1155BatchReceived` (implementation runs in sandbox and may call `extcall`/`extcreate`/`extcreate2`) | **No** | **No** | AccountV3.sol:56-67, 109-151; Overridable.sol:60-75; SandboxExecutor.sol:19-52 |
| `upgradeTo` / `upgradeToAndCall` (AccountV3Upgradable) | **No** | **No** (for plain `upgradeTo`) | AccountV3Upgradable.sol:15-18; OZ `UUPSUpgradeable.sol:68-86` |
| ERC-1271 `isValidSignature` (used by Permit2, EIP-2612 permit with 1271 support, EIP-3009, Seaport, etc.) | **No** | **No** (view) | Signatory.sol:14-24, AccountV3.sol:185-217 |
| Third party pulling via an allowance the TBA granted earlier (ERC-20 `approve`, 721/1155 `setApprovalForAll`, Permit2 allowance) | **No** (account not involved) | **No** | nothing in account code is on this path |
| Incoming tokens / ETH (unsolicited) | n/a | **No** | AccountV3.sol:56-58, 109-151 (hooks never call `_updateState`) |

Takeaway (Inferred): `state()` plus `lock()` only guard the account's own `execute*` entry points and config setters. Four other channels move assets without touching either: live overrides, ERC-1271 signatures, pre-existing allowances, and (in a limited way) upgrades.

---

## 1. Transfer (front-run) attacks against a sale

### 1.1 What the code offers (Verified)
- `Lockable.lock(uint256 _lockedUntil)` (`abstract/Lockable.sol:26-42`): only the root owner (`msg.sender`, not `_msgSender()`), max `block.timestamp + 365 days`, cannot be called while already locked (AccountV3.sol:276-279), so a lock cannot be shortened or extended once active.
- `lockedUntil` is a single storage slot (Lockable.sol:17), **not keyed by owner**, so a lock survives the NFT transfer and binds the buyer too (Verified by storage layout; consequence Inferred).
- `state()` changes on every `execute*` and config change (section 0.1). A marketplace order can embed `expectedState` and the settlement contract can `require(tba.state() == expectedState)` at fill time. The SDK/contracts do not ship such a marketplace check; it must be built by the marketplace or by us (Inferred; no such code in `contracts/src`).

### 1.2 Seller front-run via execute (Verified that it is detectable)
If the seller calls `execute` to move assets in the same block before the fill, `_state` changes (AccountV3.sol:260-262) and a state-checking order reverts. If the account is locked, `execute` reverts (`AccountLocked`). This is the intended protection.

### 1.3 Seller front-run via a pre-installed override (bypasses both lock and state)
Mechanism (Verified by code reading, exploit Inferred):
1. Before listing (before the state snapshot), seller calls `setOverrides([0xdeadbeef], [DrainImpl])`. This bumps state once, which is fine since the listing snapshot is taken after.
2. Overrides are keyed `overrides[rootOwner][selector]` (Overridable.sol:19, 50). While the seller still owns the NFT they stay live.
3. Right before the fill, anyone calls `tba.call(0xdeadbeef...)`. The account has no such function, so `fallback()` runs `_handleOverride()` (AccountV3.sol:65-67), which calls the sandbox with `implementation ++ msg.data ++ msg.sender` (Overridable.sol:66-72). **No lock check and no `_updateState` on this path.**
4. The sandbox delegatecalls `DrainImpl`, which calls `ISandboxExecutor(msg.sender).extcall(token, 0, transfer(...))`. `extcall` only checks `msg.sender == sandbox` (SandboxExecutor.sol:19-32). Assets leave with `state()` unchanged and lock ignored.

The same works through `receive()` (send 0 ETH with empty calldata) or `onERC1155Received` (send any 1155 dust). The test `testExecuteSandbox` (contracts/test/Account.t.sol, `MockSandboxExecutor.sentEther`) proves an implementation running in the sandbox can move ETH via `extcall` (Verified).

Override existence is readable on chain: `overrides(address owner, bytes4 selector)` is a public mapping (Overridable.sol:19), but it is keyed by selector so a buyer cannot enumerate it without replaying `OverrideUpdated` events (Overridable.sol:51) (Inferred).

Why Zellic did not flag it: Zellic 3.2 covered only `executeNested`. Discussion 4.1 even asked for receive hooks to be non-static so overrides "should be able to set state" (Verified, Zellic p.17). Nothing in the report discusses override calls bypassing lock/state (Verified by reading full text).

### 1.4 Seller front-run via ERC-1271 signatures (bypasses both lock and state)
`isValidSignature` (Signatory.sol:14-24) calls `_isValidSignature` (AccountV3.sol:185-217), which never checks `isLocked()` and is `view`. Any protocol that accepts ERC-1271 signatures for "from = TBA" can therefore be driven by the current owner without touching the account (Verified code; protocol behavior Inferred):
- **Permit2** (if the TBA ever did `USDC.approve(Permit2, x)`): seller signs `permitTransferFrom` or `permit` (AllowanceTransfer) as the TBA; Permit2 calls `TBA.isValidSignature`; owner's EOA signature passes `_isValidSigner` (AccountV3.sol:159-178). Funds move or a Permit2 allowance to the seller is recorded. State unchanged, lock ignored.
- **USDC EIP-2612 `permit` / EIP-3009 `transferWithAuthorization`**: FiatToken v2.2 validates smart-contract signers via ERC-1271 (external knowledge, Inferred; the Monad USDC version is an open question). If so, the seller can move all USDC from the TBA, or set `allowance(TBA, seller) = max`, with a pure signature and no prior approval at all.
- Any permissioned address (`setPermissions`) is also a valid signer (AccountV3.sol:177), so a session key granted via `setPermissions` gets the same signing power.

### 1.5 Pre-existing approvals (bypass both lock and state) (Verified by absence)
There is no code in `contracts/src` that tracks or revokes allowances. An ERC-20 `approve`, ERC-721/1155 `setApprovalForAll`, or Permit2 allowance granted by the TBA before listing lets the spender pull at any time, including after sale, without calling the TBA. `grep` for `approve`/`revoke` in `contracts/src`: only the OZ holder imports, no allowance logic (Verified).

### 1.6 Nested accounts
Zellic 3.2 (Critical): intermediate TBAs in `executeNested` could be locked but still used, and their state was not bumped. Fix commit `70c768e6` (ancestor of HEAD, Verified) added only the lock check `if (next.code.length > 0) if (Lockable(next).isLocked()) revert` (NestedAccountExecutor.sol:72-74). Intermediate **state is still not updated**, and undeployed intermediates are not checked at all (Verified). For us: only relevant if an agent TBA holds NFTs that themselves have TBAs.

### 1.7 Canonical proxy deployments disable nested/root-owner logic (Inferred, important)
`_rootTokenOwner` iterates only while `ERC6551AccountLib.isERC6551Account(_owner, __self, erc6551Registry)` (AccountV3.sol:332). `isERC6551Account` (`contracts/lib/erc6551/src/lib/ERC6551AccountLib.sol:25-45`) requires the ERC-1167 target of `_owner` to equal `__self`. `__self` is an immutable set to `address(this)` at construction of the implementation (NestedAccountExecutor.sol:25), i.e. `AccountV3Upgradable` at `0x41C8...`. Canonical TBAs are created with `implementation = AccountProxy 0x5526...` (SDK `TokenboundClient.prepareCreateAccount`, TokenboundClient.ts ~ lines 206-295, Verified), so their ERC-1167 target is the proxy, not `__self`. Therefore for canonical accounts `isERC6551Account` returns false, root owner = direct owner, and `executeNested` computes the wrong addresses (NestedAccountExecutor.sol:66-68 uses `__self`). The repo tests for nesting use the bare implementation, not the proxy (`test/Account.t.sol` `testExecuteNested`, Verified), so this path is untested for proxy accounts. Worth a spike test.

---

## 2. Ownership cycles

### 2.1 What is prevented (Verified)
```solidity
// contracts/src/AccountV3.sol:115-119
(uint256 chainId, address tokenContract, uint256 _tokenId) = ERC6551AccountLib.token();
if (msg.sender == tokenContract && tokenId == _tokenId && chainId == block.chainid) {
    revert OwnershipCycle();
}
```
Only direct self-ownership via `safeTransferFrom` is blocked, and the check runs before `_handleOverride`, so an override cannot disable it. Tested in `test/AccountERC721.t.sol:107`.

### 2.2 Bypasses (Inferred)
- **Non-safe `transferFrom`** of the agent NFT to its own TBA skips `onERC721Received` entirely. Result for canonical proxy accounts (see 1.7, no iteration): `owner()` = the TBA itself; `_isValidExecutor` requires `executor == address(this)` or `permissions[self][x]`; `setPermissions`/`setOverrides`/`lock` need `msg.sender == self`. The account cannot call itself, and the v=0 recursive signature path (AccountV3.sol:196-208) still bottoms out at an ECDSA signer that must equal the account. Result: **permanently bricked**, all assets (skills, funds) locked forever. Receiving still works.
- **Two-account cycle** (A's NFT in B, B's NFT in A): for canonical proxy accounts, A's owner = B and B's owner = A, and each can only be driven by the other. **Deadlock, both bricked.** For bare-implementation accounts (where iteration works), `_rootTokenOwner` loops A->B->A with no depth cap (AccountV3.sol:332-335) until out of gas, so every function touching it (execute, signatures, and also `_handleOverride` in receive/fallback/1155 hooks) reverts. In that variant, a `safeTransferFrom` that would close the cycle likely reverts by OOG inside `onERC721Received -> _handleOverride -> _rootTokenOwner`, but plain `transferFrom` still closes it.
- **No depth cap** on `_rootTokenOwner`; Zellic p.19 notes long chains could exceed gas (Verified).
- **Burned or reverting `ownerOf`**: `_tokenOwner` returns `address(0)` (AccountV3.sol:344-358) so nobody can execute; assets are locked (Verified code, consequence Inferred).

For us: AgentNFT must forbid transfers `to == accountOf(tokenId)` and to any agent TBA (our own contract can check this in `_beforeTokenTransfer`/`_update`), and must not allow burn while the TBA holds anything.

---

## 3. Unsolicited tokens

| Asset type | Entry point | Rejectable? | Citation |
|---|---|---|---|
| ETH (empty calldata) | `receive()` -> `_handleOverride()` | Only if the owner set an override for selector `0x00000000`-style receive; default accepts | AccountV3.sol:56-58 |
| ETH with calldata / unknown selector | `fallback()` -> `_handleOverride()`; default returns empty success | Only via override | AccountV3.sol:65-67 |
| ERC-721 safe | `onERC721Received` | Only own-token cycle; else override | AccountV3.sol:109-124 |
| ERC-721 plain `transferFrom` | no hook | Never | ERC-721 semantics |
| ERC-1155 single / batch | `onERC1155Received`, `onERC1155BatchReceived` | Only via override | AccountV3.sol:129-151 |
| ERC-20 | no hook | Never | ERC-20 semantics |

(Verified.) None of these bump `state()`, so dust does not invalidate a state-pinned order (good) but also means `state()` says nothing about holdings (Inferred). Overrides are keyed by root owner, so any rejection policy set by the seller disappears on transfer and the buyer must re-set it (Verified Overridable.sol:12-13, 50, 64).

For us (Inferred):
- Anyone can push fake "skill" ERC-1155s, look-alike tokens from a clone contract, or spam into an agent TBA. BuildRegistry must key builds on our SkillNFT contract address plus token id and an explicit equip action by the owner, never on `balanceOf`.
- Slot limits must be enforced in BuildRegistry, not by counting holdings, since holdings are unbounded.
- Malicious 1155/721 contracts can execute arbitrary code during their own transfer into the TBA, but the TBA hooks do nothing except override lookup, so there is no reentrancy surface in the account itself (Verified).
- A malicious token can emit Transfer events naming the TBA without really transferring; indexers must read our registry, not events.

---

## 4. Reentrancy and delegatecall

### 4.1 Operation types (Verified)
`LibExecutor._execute` (lib/LibExecutor.sol:13-31): 0 CALL, 1 DELEGATECALL, 2 CREATE, 3 CREATE2, else `InvalidOperation`. DELEGATECALL is **not** a real delegatecall from the account:
```solidity
// lib/LibExecutor.sol:18-22
if (operation == OP_DELEGATECALL) {
    address sandbox = LibSandbox.sandbox(address(this));
    if (sandbox.code.length == 0) LibSandbox.deploy(address(this));
    return _call(sandbox, value, abi.encodePacked(to, data));
}
```

### 4.2 Sandbox bytecode (Verified by decoding `LibSandbox.sol:7-9`)
Header `604380600d600039806000f3fe` is a constructor copying runtime. Runtime: `PUSH20 <account> CALLER EQ PUSH1 1d JUMPI; revert` (only the account may call), then `CALLDATACOPY` all calldata, `DELEGATECALL(gas, mload(0)>>96, 20, calldatasize-20, 0, 0)`, bubble return/revert. So the target code runs in the **sandbox's** storage, not the account's. Sandbox address = CREATE2 from the account with salt `keccak256("org.tokenbound.sandbox")` (LibSandbox.sol:15-22).

Consequence (Inferred, consistent with Zellic threat model 5.1, p.18-19): a delegatecall by the seller **cannot write account storage**, so it cannot plant `permissions`, `overrides`, `lockedUntil`, `_state`, or the ERC-1967 implementation slot. The only callbacks from the sandbox into the account are `extcall`, `extcreate`, `extcreate2`, `extsload` (SandboxExecutor.sol:26-61), none of which write account storage except via external calls the account itself makes (and the account cannot call its own `setPermissions`, since `msg.sender` must be the root owner, Permissioned.sol:36-37).

Anything the seller could plant pre-sale that survives the transfer, then, lives outside the account's own storage (Inferred): token allowances, Permit2 allowances, the sandbox's own storage (only read by future override/delegatecall targets, and override lookup is keyed by owner so the buyer's calls will not run seller code), contracts deployed by the TBA, or the implementation slot via `upgradeTo` (section 7).

### 4.3 Reentrancy guards (Verified: none)
No `nonReentrant` or equivalent anywhere in `contracts/src` (grep). Inferred risk is low for the account itself because it holds almost no accounting state; the relevant state (`_state`) is updated before the call (checks-effects-interactions). A callee can re-enter `execute` only if it is itself an authorized executor. For our Executor contract (a permissioned caller), reentrancy guards must live in the Executor.

### 4.4 Overrides
Executed via `sandbox.call(abi.encodePacked(implementation, msg.data, msg.sender))` (Overridable.sol:66-72). The original caller is appended (Zellic 4.2 fix `a971ebae`, Verified in history). `supportsInterface` overrides use `staticcall` directly on the implementation (Overridable.sol:82-95). See 1.3 for the lock/state bypass.

---

## 5. Signature replay

### 5.1 No domain wrapping (Verified)
`_isValidSignature` (AccountV3.sol:185-217) does `ECDSA.tryRecover(hash, signature)` on the raw `hash` and checks `_isValidSigner`. The hash is **not** re-hashed with the account address or chainId. Also `signature[64]` is read unconditionally (line 192), so signatures shorter than 65 bytes revert rather than return false (Verified; Inferred minor compatibility issue).

Consequences (Inferred):
- **Cross-account replay**: an EOA owning agents X and Y: a signature over hash H accepted by X is also accepted by Y, and by the EOA itself where the verifier does not bind the owner. Where the signed struct includes the account address (EIP-3009 `from`, EIP-2612 `owner`, Seaport `offerer`) there is no replay. Where it does not, replay is possible. Permit2's `PermitTransferFrom`/`PermitSingle` typehashes do not include `owner` (external knowledge), so a Permit2 signature the EOA made for its own tokens could be replayed against its TBA, and vice versa, if the TBA has approved Permit2 and the nonce is unused. This is the class of issue ERC-7739 addresses.
- **After NFT transfer**: every verifier that calls `isValidSignature` at submission time will reject the seller's old signatures because `_isValidSigner` now resolves to the buyer (AccountV3.sol:166-177). So an EIP-3009 authorization or Permit2 transfer signed by the old owner and **submitted after** the transfer fails (Inferred, relies on the verifier calling 1271 at submission, which USDC v2.2 and Permit2 do).
- **Submitted before transfer**: effects persist. A Permit2 `permit()` (AllowanceTransfer) or USDC `permit` submitted before the sale records an allowance in the token/Permit2 storage that outlives the transfer (Inferred). This is the main signature-based pre-sale drain vector (1.4, 6).
- **ERC-4337**: EntryPoint v0.6 `getUserOpHash` = `keccak256(abi.encode(userOp.hash(), address(entryPoint), block.chainid))` and the packed op includes `sender` and `nonce` (`lib/account-abstraction/contracts/core/EntryPoint.sol:267-269`, `interfaces/UserOperation.sol:63-86`, Verified). The account signs `userOpHash.toEthSignedMessageHash()` (ERC4337Account.sol:54-61). No cross-chain or cross-account replay. A pending op signed by the seller fails validation after transfer because the signer is no longer valid (Inferred). Nonce uniqueness is in EntryPoint; `_validateNonce` is a no-op (BaseAccount.sol:89-90).
- **v=0 contract signatures**: signer address in `r`, offset in `s`; allowed if the signer is valid or equals `address(this)` (AccountV3.sol:196-208). If our Executor contract is a permissioned address and ever implements `isValidSignature`, it would become a signer for the TBA (Inferred). Executor must not implement ERC-1271 or must reject calls about TBAs.

---

## 6. Approvals left behind

Verified: nothing in `contracts/src` revokes or even reads token approvals on transfer. The account is not notified of NFT transfers at all (no hook from AgentNFT into the TBA). Allowances live in the token contracts (and Permit2) and are keyed by `(owner = TBA, spender)`, not by the NFT holder, so they survive the sale (Inferred from ERC-20/721/1155 semantics).

Implications for our transfer design (Inferred):
- Enforce "exact-amount approvals only" in the Executor, and have the Executor consume or zero them in the same transaction (approve, swap, `approve(0)`), so no standing allowance ever exists.
- Never let the TBA `approve(Permit2, ...)` or `setApprovalForAll` on SkillNFT. Our SkillNFT (we write it) can refuse `setApprovalForAll` and transfers when the holder is an agent TBA unless called by BuildRegistry.
- At sale, a checker must verify zero allowances for all allowed assets (USDC, WETH, LST, Uniswap router, Permit2), and ideally our transfer flow sweeps personal funds out before listing, so the TBA holds only skills during a sale.

---

## 7. Upgrade, override and permission persistence

| Item | Storage key | Survives NFT transfer? | Revives if NFT returns to seller? | Citation |
|---|---|---|---|---|
| `permissions` | `permissions[rootOwner][caller]` | Dormant (keyed by old owner) | **Yes** | Permissioned.sol:17, 46, 57-58 |
| `overrides` | `overrides[rootOwner][selector]` | Dormant | **Yes** | Overridable.sol:19, 50, 64 |
| `lockedUntil` | single slot | **Active, binds buyer** up to 365 days | n/a | Lockable.sol:17, 33 |
| `_state` | single slot | Continues | n/a | ERC6551Account.sol:17 |
| ERC-1967 implementation | proxy slot | **Active** | n/a | AccountProxy.sol:22-34, UUPS |

(Storage keys Verified; revival and buyer impact Inferred.) Revival matters for us: if a buyer resells to the original seller, or the seller buys it back, every old session key permission reactivates. Our Executor's ownership epoch must cover this (epoch bump on every transfer, not "owner != previous owner").

Upgrades (Verified): `_authorizeUpgrade` (AccountV3Upgradable.sol:15-18) requires `guardian.isTrustedImplementation(impl)` and `_isValidExecutor(_msgSender())`. So the owner, **any permissioned caller**, and the EntryPoint (i.e. a userOp) can upgrade, with no lock check and no state bump. The seller cannot pick an arbitrary malicious implementation, only guardian-trusted ones (guardian owner is the Tokenbound Safe per deployment script). Risk for us (Inferred): (a) a pre-sale upgrade to a different trusted implementation that the buyer or our Executor does not expect; (b) a compromised or careless guardian adds a bad implementation; (c) a permissioned session key can upgrade. Buyer-side check: read the ERC-1967 slot (`extsload(0x3608...bbc)` via `SandboxExecutor.extsload`, SandboxExecutor.sol:57-61) and compare to the expected implementation.

`AccountProxy.initialize` (AccountProxy.sol:22-30) is permissionless but one-shot (`AlreadyInitialized`); Zellic 3.1 (Critical) fixed by `69af6f0e` (Verified in history). Remaining risk: between `createAccount` and `initialize` anyone can initialize with any trusted implementation. The SDK does both atomically via multicall (TokenboundClient.ts `prepareCreateAccount`, Verified). Our mint must also do both in one transaction.

---

## 8. Audits

### 8.1 Zellic (Verified from PDF)
- Client: Future Primitive. Review Aug 29 to Sep 8, 2023; final report Nov 13, 2023. Two consultants, two person-weeks.
- Scope commits: contracts `48155498e2a2...`, reference `fe246b7b6032...`. Both are ancestors of the commits we review; 35 commits and ~120 changed lines in `src` separate `48155498` from HEAD `bce75f9` (Verified via `git diff --stat`), including `FxChildExecutor` (new, unaudited) and the removal of `utils/MulticallForwarder.sol`.
- Files: AccountGuardian, AccountProxy, AccountV3, AccountV3Upgradable, the executors, ERC4337Account, ERC6551Account, Lockable, Overridable, Permissioned, SandboxExecutor, Signatory, registry, ERC6551AccountLib, ERC6551BytecodeLib.

| # | Finding | Severity | Status | Relevance to us |
|---|---|---|---|---|
| 3.1 | AccountProxy can be reinitialized | Critical | Fixed `69af6f0e` | Initialize atomically at mint |
| 3.2 | NestedAccountExecutor bypasses locks and state | Critical | Fixed `70c768e6` (lock only; intermediate state still not bumped) | Only if nesting; see 1.6, 1.7 |
| 3.3 | Registry `initData` front-runnable | Medium | Acknowledged; v0.3 registry has no `initData` (Verified `erc6551-reference/src/ERC6551Registry.sol` `createAccount` signature) | Front-running `initialize` still possible if not atomic |
| 3.4 | `isERC6551Account` without expected implementation can be forged | Low | Fixed `ba77e72f` | Low |
| 3.5 | Token owner can forge `_rootTokenOwner` | Informational | Fixed `b2cc0944` (warning comment, AccountV3.sol:304-306) | Never use root owner for authentication in our contracts |
| D4.1 | Receive hooks should use non-static override | Discussion | Fixed `a75a3123` | This is what makes 1.3 possible |
| D4.2 | Overrides lacked msg.sender | Discussion | Fixed `a971ebae` | n/a |

Threat model conclusions: sandbox prevents storage writes (5.1); authorization considered only from an external attacker "who never held authorization" (5.2, p.20). **The seller-as-attacker model (a legitimate owner abusing overrides, signatures, or approvals before sale) was not in scope** (Inferred from p.20 wording). The report does not discuss ERC-1271 lock bypass, override lock/state bypass, allowance persistence, or proxy vs `__self` nesting.

### 8.2 CertiK (Verified from PDF)
- Title "Manifold Reference", delivered Jul 3, 2023. Scope: `erc6551/reference` `src/` at commits `1a5b0054`, `d79a49e9`, `f2e98f27` (all ancestors of `da16a63`, Verified). Files: SimpleERC6551Account, ERC6551AccountUpgradeable, ERC6551AccountProxy, ERC6551AccountLib, ERC6551Registry, ERC6551BytecodeLib (v1 era, pre v0.3 registry). **Does not cover Tokenbound AccountV3.**

| ID | Finding | Severity | Status | Relevance |
|---|---|---|---|---|
| ERU-01 | Centralized control of contract upgrade | Major | Acknowledged | Analogous to guardian trust in AccountV3Upgradable |
| GLOBAL-01 | Owner has full `executeCall` power | Major | Acknowledged | By design |
| EXA-01 | Fraudulent ERC-721 `ownerOf` can keep control of TBA after "sale" | Minor | Acknowledged ("security model assumes conforming token contracts") | Our AgentNFT must be a standard, non-upgradeable-by-surprise ERC-721 |
| EXA-02 | Third-party dependency (token contract) | Minor | Acknowledged | Same |
| ERA-01 | `extcodecopy` length misuse | Informational | Resolved `d79a49e9` | None |
| SRC-01 | Missing zero address checks | Informational | Resolved `f2e98f27` | None |

---

## Findings table

| # | Issue | What the code does | Severity for us | Mitigation idea |
|---|---|---|---|---|
| F1 | Override-based drain bypasses lock and state | `fallback`/`receive`/1155 hooks call `_handleOverride`; sandboxed impl can `extcall` with no lock/state check (Overridable.sol:60-75, SandboxExecutor.sol:26-32) | **High** | Sale flow requires zero overrides for the seller key (replay `OverrideUpdated` events, check each selector used), or use a custom implementation whose `_handleOverride` respects `isLocked()`; or keep valuables out of TBA during sale |
| F2 | ERC-1271 signing ignores lock and state | `isValidSignature` is view, no lock check (Signatory.sol:14-24, AccountV3.sol:185-217) | **High** | Keep USDC and other permit/3009-capable tokens out of the TBA at sale time (sweep before listing); custom implementation with `_isValidSignature` returning false while locked; Executor-mediated sale that sweeps at fill |
| F3 | Pre-existing allowances survive lock and transfer | No approval tracking or revocation | **High** | Exact approvals consumed and zeroed in the same Executor tx; SkillNFT blocks approvals from TBAs; sale-time allowance audit |
| F4 | Permissioned addresses are full executors and full signers, and can upgrade | `_isValidExecutor`, `_isValidSigner`, `_authorizeUpgrade` all accept `hasPermission` (AccountV3.sol:177, 252; AccountV3Upgradable.sol:17) | **High** | Never `setPermissions` the Privy session key. Grant permission only to our Executor contract; Executor must not implement ERC-1271 and must not forward `upgradeTo` |
| F5 | Permissions and overrides revive if NFT returns to prior owner | Keyed by root owner address (Permissioned.sol:46, Overridable.sol:50) | Medium | Executor epoch increments on every AgentNFT transfer; seller clears permissions before listing (bumps state, so must happen pre-snapshot) |
| F6 | Lock persists to the buyer (up to 365 days) | `lockedUntil` single slot (Lockable.sol:17) | Medium | Marketplace/our UI shows `lockedUntil`; sale contract rejects or prices it; prefer our own escrow over `lock` |
| F7 | Upgrade without lock/state check | `_authorizeUpgrade` only checks guardian trust and executor (AccountV3Upgradable.sol:15-18) | Medium | Sale checker reads ERC-1967 slot; BuildRegistry/Executor pin expected implementation |
| F8 | Ownership cycles brick the TBA | Only safe self-transfer blocked (AccountV3.sol:115-119); `transferFrom` and 2-cycles not blocked; no depth cap | Medium | AgentNFT rejects transfers to any agent TBA; no burn while TBA non-empty |
| F9 | Unsolicited tokens and spam | All hooks accept by default; ERC-20 and plain 721 cannot be rejected | Medium (UX, build integrity) | BuildRegistry records explicit equips of our SkillNFT only; ignore balances; indexer filters by contract allowlist |
| F10 | No domain separation in ERC-1271 | Raw hash recovered (AccountV3.sol:212) | Medium | x402/EIP-3009 is safe (includes `from`); avoid Permit2 on TBAs; consider ERC-7739-style wrapper in a custom implementation |
| F11 | Nested root-owner and `executeNested` inert for canonical proxy accounts | `isERC6551Account(_, __self, _)` compares against implementation, but TBAs point to AccountProxy | Low (for us), but surprising | Do not rely on nested TBAs; spike test to confirm |
| F12 | Intermediate state not bumped in `executeNested` | NestedAccountExecutor.sol:61-86 | Low (only if nesting) | Avoid nesting agents in agents |
| F13 | Proxy initialize front-run | `initialize` permissionless until set (AccountProxy.sol:22-30) | Low | Create and initialize atomically in AgentNFT mint |
| F14 | 4337 prefund ignores lock | `_payPrefund` (BaseAccount.sol:100-106) | Low | Use a paymaster; keep minimal MON in TBA |
| F15 | Short signatures revert | `signature[64]` read unconditionally (AccountV3.sol:192) | Low | Verifiers should use try/catch |

---

## Open questions

1. Which USDC implementation is on Monad (FiatToken v2.2 with ERC-1271 in `permit`/`transferWithAuthorization`)? Determines whether F2 lets the seller drain USDC with a signature alone.
2. Which implementations has the guardian (on Monad) marked trusted? Need `AccountGuardian` address (not yet derived) and its `TrustedImplementationUpdated` events.
3. Confirm F11 with a fork test: on a canonical proxy TBA, does `_rootTokenOwner` stop at the first TBA, and does `executeNested` revert? Also confirm cycle behavior (F8) for proxy accounts.
4. Spike test for F1: set an override on an unused selector, lock the account, call the selector, check that funds move and `state()` is unchanged.
5. Does Permit2 exist on Monad at the canonical address, and do Uniswap routes we use require Permit2 approvals from the TBA? If yes, F3/F10 exposure grows.
6. Does Monad implement EIP-6780 SELFDESTRUCT semantics (affects sandbox or override implementations being destroyed and redeployed; Zellic 3.4 style forging)?
7. Is there any marketplace on Monad that already enforces `state()` in orders? None in these repos.
8. Changes after the Zellic commit (35 commits, including `FxChildExecutor` and `executeNested` edits) are unaudited as far as the repo shows.
