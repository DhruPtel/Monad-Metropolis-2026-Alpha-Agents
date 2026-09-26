# Sub-agent C: Administration, deployment, SDK

Scope: who administers a Roles modifier and how, how permission changes are applied, how Roles is deployed (and what is live on Monad chain 143), avatar requirements, SDK and presets, gas.

Conventions: **Verified** = read in code or observed via read-only RPC in this session. **Inferred** = reasoning, not directly observed. Paths relative to repo root `/home/dhrupatel/agent_tool/zodiac` unless noted. The `@gnosis-guild/zodiac-core` package is not installed in this checkout (no `node_modules`), so I downloaded the npm tarball `@gnosis-guild/zodiac-core@3.0.1` (the version pinned in `yarn.lock` line 1336) into the session scratchpad and read it there. Those files are cited as `zodiac-core@3.0.1:<path>`. The deployed mastercopy source is also embedded in `packages/evm/mastercopies.json` (`compilerInput.sources`), cited as `mastercopies.json#Roles/2.1.0`.

---

## 0. Headline finding: `main` is not the deployed code

**Verified.**

1. `README.md` (commit `2db58108`, 2026-06-19, "fix: update addresses (#487)") points to Roles `0xF2964CE6...83D5` and Packer `0x869718c9...09f0`. Those addresses first appear in commit `218a5164` "v2.1.1 (#486)" (2026-06-08), which lives **only on branch `origin/v2`**, not on `main` (`git log main..origin/v2` = `380efcc3`, `218a5164`; merge base is old commit `a19c0ebd`; `main` has 1516 commits not in `origin/v2`).
2. `origin/v2:packages/evm/mastercopies.json` lists both Roles `2.1.0` = `0x9646fDAD...D337` (linked to Packer `0x61C5...8C`) and Roles `2.1.1` = `0xF2964CE6...83D5` (linked to Packer `0x8697...09F0`, same Integrity `0x6a6A...1049`). `main`'s `packages/evm/mastercopies.json` only has Roles `2.1.0`. So the README/mastercopies mismatch is simply: README was updated to 2.1.1, but the 2.1.1 mastercopy metadata was committed to `origin/v2` and never merged into `main`.
3. v2.1.1 (`git show 218a5164`) fixes three bugs:
   - **SignatureChecker** (zodiac library, patched by `packages/evm/scripts/patch-zodiac-signature-checker.js` on `origin/v2`): `_isValidContractSignature` ignored the `staticcall` success flag, so an ERC-1271 signer that *reverts* with `0x1626ba7e` as revert data was treated as a valid signature. Regression contract `origin/v2:packages/evm/contracts/test/FaultyErc1271Signer.sol`.
   - **ArraySome** (`PermissionChecker._arraySome`): looped `condition.children.length` (always 1) instead of `payload.children.length`, so only the first array element was checked; also carried consumptions from failed attempts.
   - **Bitmask** (`PermissionChecker._bitmask`): for dynamic values used `payload.size - 32` (padded length) instead of the real byte length from the length word.
4. **`main` still has all three bugs**: `packages/evm/contracts/PermissionChecker.sol` line 436 `uint256 length = condition.children.length;` and line 604 `payload.size - (isInline ? 0 : 32)`; and `zodiac-core@3.0.1:contracts/signature/SignatureChecker.sol` `_isValidContractSignature` has `(, bytes memory returnData) = signer.staticcall(...)` with no success check.
5. `main`'s source layout also differs from what was deployed. The deployed 2.1.0 compiler input (`mastercopies.json#Roles/2.1.0`) uses file names `contracts/Core.sol`, `contracts/Decoder.sol`, `contracts/adapters/Types.sol`, imports `@gnosis.pm/zodiac/...` and OpenZeppelin **5.0.0** upgradeable (`Initializable.sol` header "last updated v5.0.0"). `main` uses `_Core.sol`, `AbiDecoder.sol`, `periphery/`, `@gnosis-guild/zodiac-core`, and declares `@openzeppelin/contracts-upgradeable` 4.9.3 in `packages/evm/package.json`. `main` also has post-deployment changes, e.g. `1ddde84d fix: Simplify Loop Bounds (#448)` (Feb 2026). `packages/evm/test/FactoryFriendly.spec.ts` on main expects the OZ 4 string `"Initializable: contract is already initialized"`, while the live mastercopy on Monad reverts with OZ 5 `InvalidInitialization()` (`0xf92ee8a9`, see section 3.4).

**Implication (Inferred):** anything we audit on `main` is an approximation of what runs onchain. The audit baseline for the live `0xF2964...` mastercopy is `origin/v2` at `218a5164` (or equivalently the `compilerInput` embedded in `origin/v2:packages/evm/mastercopies.json` for Roles 2.1.1). We should use **2.1.1 (`0xF2964...`)**, not 2.1.0 (`0x9646...`), which has the three bugs above.

---

## 1. Administration model

### 1.1 Ownership

- `Roles` inherits `Modifier` -> `Module` -> `FactoryFriendly` -> `OwnableUpgradeable` (`zodiac-core@3.0.1:contracts/factory/FactoryFriendly.sol`; `packages/evm/contracts/_Periphery.sol` also inherits `OwnableUpgradeable`). **Verified.**
- The owner is a single address with no restriction on its type: EOA, Safe, the avatar itself, a TimelockController, a Governor, or any custom contract. **Verified** (plain `onlyOwner`, no type checks).
- Ownership is **single-step**: `transferOwnership(address)` and `renounceOwnership()` are public `onlyOwner` in OZ `OwnableUpgradeable` (listed in the deployed compiler input, `mastercopies.json#Roles/2.1.0` `@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol`). There is no `Ownable2Step`, so a wrong address in a transfer locks admin permanently. `renounceOwnership` freezes the config forever: no further permission changes, and no `disableModule` either. **Verified** (function list), consequence **Inferred**.
- The deployed build uses OZ 5 namespaced (ERC-7201) Ownable storage (`_getOwnableStorage()` present in the deployed compiler input). **Verified.**

### 1.2 Owner-only functions (v2, main)

| Function | File:function | Effect |
|---|---|---|
| `assignRoles(module, roleKeys[], memberOf[])` | `contracts/Roles.sol:assignRoles` | Sets `roles[key].members[module]`. **Automatically calls `enableModule(module)`** if not already enabled. Never disables the module. |
| `setDefaultRole(module, roleKey)` | `Roles.sol:setDefaultRole` | Role used when module calls `execTransactionFromModule*` |
| `allowTarget(role, target, options)` | `PermissionBuilder.sol:allowTarget` | Clearance.Target: any function, any params |
| `scopeTarget(role, target)` | `PermissionBuilder.sol:scopeTarget` | Clearance.Function: only listed selectors |
| `revokeTarget(role, target)` | `PermissionBuilder.sol:revokeTarget` | Clearance.None |
| `allowFunction(role, target, selector, options)` | `PermissionBuilder.sol:allowFunction` | Selector wildcarded (no param checks) |
| `scopeFunction(role, target, selector, ConditionFlat[], options)` | `PermissionBuilder.sol:scopeFunction` | `Integrity.enforce(conditions)`, then `_store` (Packer + WriteOnce) |
| `revokeFunction(role, target, selector)` | `PermissionBuilder.sol:revokeFunction` | deletes scopeConfig |
| `setAllowance(key, balance, maxRefill, refill, period, timestamp)` | `PermissionBuilder.sol:setAllowance` | Overwrites the whole allowance struct |
| `setTransactionUnwrapper(to, selector, adapter)` | `_Periphery.sol:setTransactionUnwrapper` | e.g. MultiSendUnwrapper for MultiSend |
| `enableModule(module)` / `disableModule(prev, module)` | `zodiac-core@3.0.1:core/Modifier.sol` | Module linked list |
| `setAvatar(a)` / `setTarget(t)` | `zodiac-core@3.0.1:core/Module.sol` | Rewires the modifier |
| `transferOwnership` / `renounceOwnership` | OZ OwnableUpgradeable | Admin |

All **Verified**. Note: `ExecutionTracker.invalidate(hash)` (`zodiac-core@3.0.1:signature/ExecutionTracker.sol`) is **not** owner-gated. Any address can mark its *own* signed-tx hashes as consumed.

Excerpt, `packages/evm/contracts/Roles.sol:assignRoles`:
```solidity
for (uint16 i; i < roleKeys.length; ++i) {
    roles[roleKeys[i]].members[module] = memberOf[i];
}
if (!isModuleEnabled(module)) {
    enableModule(module);
}
```

### 1.3 Built-in time delay?

None in v2. All setters take effect in the same transaction. There is no timelock, no pending-change queue, and no role expiry. **Verified** (no timestamp logic in `PermissionBuilder.sol` or `Roles.sol` except in allowances).

**v3 (`origin/contracts-v3`)**, `packages/evm/contracts/core/Setup.sol`: `grantRole(module, roleKey, startTimestamp, endTimestamp, usesLeft)` packs time-bounded and use-bounded membership. There is also `revokeRole` and a member-callable `renounceRole(roleKey)`. `assignRoles` becomes a wrapper. v3 also adds `allowTarget` with conditions, `allowFunctionGlobally` (target `address(0)`), `*Packed` variants, `updateAllowance`, `_requireNonZeroAddress`, and `execTransactionWithSignature(..., salt, signature)` using a typed `RoleTx` hash (`origin/contracts-v3:packages/evm/contracts/Roles.sol`). This is still not an admin timelock, but `endTimestamp` gives automatic expiry of a session-key membership. **Verified** (read on branch). v3 is BUSL-1.1 (Phase 0).

### 1.4 Layering a delay or timelock (Inferred)

- **Option A: owner = OZ `TimelockController`** (proposer = our config service or owner multisig; executor = anyone). Every `scopeFunction`, `assignRoles` and similar call waits the min delay. This is the simplest way to get a real delay because the timelock is the only path to `onlyOwner`.
- **Option B: owner = Safe, and a Zodiac Delay modifier enabled on that Safe.** Proposals go `proposer module -> Delay.execTransactionFromModule` (queued) -> after `txCooldown`, `executeNextTx` -> `Safe.execTransactionFromModule` -> `Roles.<setter>`. This is only a real delay if the Safe owners cannot bypass it with a direct Safe transaction, which they normally can. So this suits "platform proposes, owner can veto" rather than enforced delay on the owner.
- A contract exposing Delay's interface exists on Monad at the canonical Delay mastercopy address `0xd54895B1121A2eE3f37b502F507631FA1331BED6`. **Verified** by RPC: code 16359 bytes; `txCooldown()`, `txExpiration()`, `queueNonce()` return 0; `owner()` and `avatar()` return `0x1`. That it is the canonical Delay 1.0.0 is **Inferred** (bytecode not compared).
- For our product, a delay on *loosening* permissions is probably wanted, but *tightening* (revocation, circuit breaker) must be instant. With a single owner there is only one path. So we likely need owner = a custom `PolicyAdmin` contract with two paths: an instant path restricted to revoke-type selectors (`revokeTarget`, `revokeFunction`, `assignRoles(..., false)`, `setAllowance` to 0) and a delayed path for everything else. **Inferred.**

### 1.5 setUp, avatar vs target

`Roles.sol:setUp(bytes initParams)` decodes `(address owner, address avatar, address target)`, then calls `_transferOwnership(owner)`, sets `avatar` and `target`, calls `setupModules()`, and emits `RolesModSetup`. It is marked `initializer`, so it runs once. **Verified.**

- `target` is the contract that actually executes calls: `Module.exec` calls `IAvatar(target).execTransactionFromModule(...)` and `execAndReturnData` calls `execTransactionFromModuleReturnData` (`zodiac-core@3.0.1:core/Module.sol`; same in deployed `@gnosis.pm/zodiac` source). **Verified.**
- `avatar` is only *read*, never called, by Roles:
  - `PermissionLoader._load` patches `Operator.EqualToAvatar` to `EqualTo keccak256(abi.encode(avatar))` at check time (`packages/evm/contracts/PermissionLoader.sol` ~line 67).
  - `periphery/AvatarIsOwnerOfERC721.sol:check` calls `IModifier(msg.sender).avatar()`.
  **Verified.**
- Normally `avatar == target == Safe`. They differ when chaining modifiers, e.g. `target` = a Delay modifier whose own target is the Safe. **Inferred** (standard Zodiac pattern).
- **Risk (Inferred):** `setAvatar` silently changes the meaning of every `EqualToAvatar` (`c.avatar`) condition across all roles, e.g. a "swap recipient must be avatar" condition. `setTarget` redirects all execution. Both are owner-only, so the owner has full power over funds reachable through the target.
- Because `EqualToAvatar` is resolved at load time, condition blobs are avatar-agnostic. Identical condition sets across many Roles instances produce the same WriteOnce pointer (section 3.5), which is good for per-account deployments.

### 1.6 Who is really in control (Inferred)

The Roles owner can grant any module unrestricted `allowTarget` on the target with `ExecutionOptions.Both`, including delegatecall. So **the owner of the Roles modifier is effectively a full controller of the target's funds** (through the Roles path). For PersonalAccount, the owner should be the NFT owner (or a contract that follows the NFT owner) and never a platform key. For StrategyVault, the owner must not be able to grant withdrawal or redirect permissions over depositor funds. That means the vault itself must enforce invariants independently of Roles, or the owner must be an immutable or timelocked policy contract.

---

## 2. Applying permission changes

### 2.1 Onchain granularity

Each setter is a separate external call, and v2 Roles has no batch or multicall function. Batching is done by the *owner*:
- Safe owner: MultiSend (delegatecall) or MultiSendCallOnly with N calls to the Roles proxy. The app links the owner Safe to Safe{Wallet} (`packages/app/components/ApplyUpdate/ApplyViaSafe/index.tsx`) and knows MultiSend 1.4.1 addresses (`packages/app/components/ApplyUpdate/const.ts`: `MULTISEND_141 0x38869bf6...`, `MULTISEND_CALLONLY_141 0x9641d764...`). The app also supports Governor owners (`ApplyViaGovernor/isGovernor.ts` checks `COUNTING_MODE()`) and a "Rethink factory" path. **Verified.**
- A custom owner contract can loop the calls itself. **Inferred.**
- Changes are *not* atomic across separate transactions. A partially applied update is live immediately. So batch in one transaction, or do revocations first. The app's `planApplyRole` orders `[...minus, ...plus]`. **Verified** (`packages/app/utils/plan/planApplyRole.ts`).

### 2.2 Diffing tooling (where it lives now)

- SDK v4 (`packages/sdk`, 4.1.3) **removed** the plan/apply API. Commit `3a05b490` "feat!: SDK v4 - sunset deployments package and prune apply API (#480)" (2026-05-28) says: "removes from the sdk public API: planApply, planApplyRole, planExtendRole, callsPlannedForApply, callsPlannedForApplyRole, encodeCalls, and the Call type". It also sunsets the `zodiac-roles-deployments` package. **Verified.**
- The replacement is the external **Zodiac SDK `@zodiac-os/sdk`** (`push()`), which "requires a Zodiac org and a project-scoped API key". The Zodiac API diffs and plans server-side (`packages/docs/content/sdk/v3-v4-migration.mdx`). **Verified** (docs). It is closed-off infrastructure from our point of view; Monad support is unknown.
- The app keeps an inlined copy: `packages/app/utils/plan/planApplyRole.ts:planApplyRole` fetches the current role via `fetchRole` (subgraph), merges it with the desired partial role, calls `diffRole({prev,next})` (`packages/app/utils/plan/diff/{role,target,function,members,annotations}.ts`), and encodes with `encodeCalls` (`packages/app/utils/plan/encodeCalls.ts`). Call kinds (`packages/app/utils/plan/Call.ts`): `allowTarget`, `scopeTarget`, `revokeTarget`, `allowFunction`, `scopeFunction`, `revokeFunction`, `assignRoles`, `setAllowance`, `postAnnotations` (the last goes to the EIP-3722 Poster `0x000000000000cd17345801aa8147b8D3950260FF`, `const.ts`). **Verified.**
- The app copy still runs `fetchLicense` + `enforceLicenseTerms` when `fetchRolesModConfig` returns a config (`planApplyRole.ts`), even though the commit message says license enforcement was dropped. **Verified** (code), discrepancy noted.
- Subgraph: `packages/app/utils/subgraph/subgraph.ts` `SQD_URL = "https://gnosisguild.squids.live/roles:production/api/graphql"`, a Subsquid indexer run by Gnosis Guild. No Monad indexing is evident, and chain 143 is not in `chains.ts`. **Inferred.**

### 2.3 Chain 143 in the SDK

- `packages/sdk/src/main/chains.ts` has 25 chains; 143 is absent. `ChainId = keyof typeof chains` (`packages/sdk/src/main/types.ts:3`). **Verified.**
- `ChainId` is only needed by `licensing.ts` (`fetchLicense`) and `swaps/*` (CoW). Authoring (`c`, `forAll`, `processPermissions`, `flattenCondition`, `normalizeCondition`, `targetIntegrity`, `rolesAbi`, `encodeKey`) is chain-agnostic. **Verified** (grep of `chainId` usage).
- **What we need on Monad (Inferred):** use `zodiac-roles-sdk` authoring to produce `Target[]`, then either (a) write our own diff against state we track ourselves (our DB or our own event indexer of `ScopeFunction`, `AssignRoles` and similar), or (b) skip diffing and apply whole role rewrites under a fresh role key (see section 7). Encoding is trivial with `rolesAbi` / `zodiac-roles-sdk/typechain` (`Roles__factory`). No subgraph is needed. Annotations posting needs Poster, which has **no code on Monad** (**Verified** by RPC: `eth_getCode` = `0x`), so skip annotations or deploy Poster ourselves.

---

## 3. Deployment

### 3.1 Mechanism

- Mastercopies are deployed through the singleton factory `0xce0042b868300000d44a59004da54a005ffdcf9f` with salt 0 (`packages/evm/mastercopies.json`; tasks `packages/evm/tasks/deploy-mastercopies.ts`, `deploy-mastercopy.ts` use `deployMastercopy` from `@gnosis-guild/zodiac-core`). `extract-mastercopy.ts` builds Roles with constructor args `(0x1, 0x1, 0x1)`, so the mastercopy's `setUp` is consumed at construction and the mastercopy is inert. **Verified.**
- Instances are EIP-1167 proxies from `ModuleProxyFactory.deployModule(masterCopy, initializer, saltNonce)` (`zodiac-core@3.0.1:contracts/factory/ModuleProxyFactory.sol`):
  - `salt = keccak256(abi.encodePacked(keccak256(initializer), saltNonce))`
  - It calls `proxy.call(initializer)` in the same tx, so there is no uninitialized-proxy window.
  - `initializer = abi.encodeWithSignature("setUp(bytes)", abi.encode(owner, avatar, target))`.
  - The test flow is `packages/evm/test/FactoryFriendly.spec.ts` (`deployProxy` with `setupArgs types ["address","address","address"], values [owner, avatar, target]`).
  **Verified.**
- The address is deterministic from `(masterCopy, initializer, saltNonce)`, so anyone can precompute it. Front-running a deploy just creates the same configured proxy. **Inferred.**
- Post-deploy wiring: (1) the avatar or target must `enableModule(rolesProxy)` (Safe) or otherwise authorize Roles as caller. (2) The owner calls `assignRoles(member, ...)`, which also enables the member inside Roles, then `scopeTarget` / `scopeFunction` / `setAllowance` and similar. **Inferred** from code.

### 3.2 Libraries

`Integrity` (`contracts/Integrity.sol`, `library Integrity`) and `Packer` (`contracts/packers/Packer.sol`, `library Packer`) are **external linked libraries**. `BufferPacker` is internal. Their addresses are embedded in the Roles bytecode: in main's `mastercopies.json` Roles 2.1.0 bytecode, the Integrity and Packer 0x61C5 addresses each occur once, and the `compilerInput.settings.libraries` confirms the link. Roles 2.1.1 links Integrity `0x6a6A...1049` and Packer `0x8697...09F0` (`origin/v2` mastercopies.json). **Verified.**

`WriteOnce` (`contracts/WriteOnce.sol`) hardcodes `SINGLETON_FACTORY = 0xce0042B8...cf9f` for storing condition blobs. The factory **must exist on the chain** or `scopeFunction` fails. It does exist on Monad (Phase 0). **Verified.**

### 3.3 Monad bytecode verification (read-only RPC, this session)

Script (scratchpad `check.py`): for each entry in `main` and `origin/v2` `mastercopies.json` it recomputes the CREATE2 address from `factory`, `salt`, `bytecode ++ abi.encode(constructorArgs)`, fetches `eth_getCode` from `https://rpc.monad.xyz` (`eth_chainId` = `0x8f`), and checks that the onchain runtime is a substring of the recorded creation bytecode. **Verified** results:

| Contract | Version | Address | CREATE2 recomputed matches | Monad runtime len | Runtime found in recorded initcode |
|---|---|---|---|---|---|
| Roles | 2.1.0 | 0x9646fDAD...D337 | yes | 24401 | yes |
| Roles | 2.1.1 | 0xF2964CE6...83D5 | yes | 24409 | yes |
| Integrity | 2.1.0/2.1.1 | 0x6a6Af4b1...1049 | yes | 5637 | yes, after zeroing library self-address (bytes 1..20 after `PUSH20`) |
| Packer | 2.1.0 | 0x61C5B1bE...8a8C | yes | 2138 | yes (same zeroing) |
| Packer | 2.1.1 | 0x869718C9...09F0 | yes | 2138 | yes (same zeroing) |
| MultiSendUnwrapper | 2.1.0 | 0x93B7fCbc...27c0 | yes | 2071 | yes |
| MultiSendUnwrapper | 2.1.1 | 0xB4Cd4bb7...9efD | yes | 2096 | yes |
| MorphoBundler3Unwrapper | 2.1.0 | 0x7533922A...D3E8 | yes | 1530 | yes |
| AvatarIsOwnerOfERC721 | 2.1.0 | 0x91B1bd7B...19d1 | yes | 811 | yes |

The libraries' runtime starts with `0x73 <own address>`, which is the standard library call-protection. The deployer overwrites the placeholder, which is why the raw runtime is not a substring until those 20 bytes are zeroed. The embedded addresses equal the library's own address. **Verified.**

Runtime keccak prefixes (first 8 bytes): Roles 2.1.1 `471d8b3b419f1eb9`, Roles 2.1.0 `87911cbc6aa0496e`, Packer 2.1.1 `c28f5fb0c8857669`, Integrity `ee8ec55ea4ac609a`.

Conclusion: the Monad deployments are byte-identical in runtime to the recorded Gnosis Guild mastercopy artifacts. The recorded artifacts include full `compilerInput`, so source-level verification is possible. **Verified** (runtime-in-initcode, plus CREATE2 address equality with the recorded initcode).

### 3.4 Mastercopy state on Monad

`eth_call` against both Roles mastercopies (**Verified**):
- `owner()`, `avatar()` and `target()` all return `0x...0001`.
- `setUp(abi.encode(0,0,0))` reverts with `0xf92ee8a9` = `InvalidInitialization()` (OZ 5 custom error).

So the mastercopies are initialized and inert, as intended.

ModuleProxyFactory `0x000000000000aDdB49795b0f9bA5BC298cDda236` on Monad: 2046 bytes, runtime keccak `01623cbc...f21e`, contains the `deployModule(address,bytes,uint256)` selector. **Verified.** I did not compare it byte-for-byte with a canonical artifact (open question).

### 3.5 What to do on Monad (Inferred)

- Do **not** deploy our own mastercopy. Use `ModuleProxyFactory.deployModule(0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5, setUp(owner, avatar, target), nonce)`. 2.1.1 contains the three fixes in section 0. Integrity and Packer 2.1.1 are present.
- Pin the audit and test baseline to `origin/v2@218a5164`, not `main`.
- Deploy one Roles proxy per capital account, because a Roles instance has exactly one `target`. Proxy deploy is cheap (EIP-1167 plus about 4 to 5 SSTOREs in `setUp`).
- Condition blobs are shared across instances. `WriteOnce.store` skips deployment if the CREATE2 pointer already has code, and `EqualToAvatar` keeps blobs avatar-independent. So the Nth account with the same permission set pays only the header SSTORE per function.

---

## 4. Avatar or target requirements

- Roles only *calls* two functions on `target` (`zodiac-core@3.0.1:core/Module.sol`, deployed `@gnosis.pm/zodiac/contracts/core/Module.sol`):
  - `execTransactionFromModule(address to, uint256 value, bytes data, uint8 operation) returns (bool)`
  - `execTransactionFromModuleReturnData(...) returns (bool, bytes)`

  `enableModule`, `isModuleEnabled` and `getModulesPaginated` are part of `IAvatar` (`zodiac-core@3.0.1:interfaces/IAvatar.sol`), but Roles never calls them on the target. Tooling (the app, Pilot) may. **Verified.**
- `avatar` must answer nothing. It is only an address used for `EqualToAvatar` and `AvatarIsOwnerOfERC721`. **Verified.**
- **A Safe is not required.** `packages/evm/contracts/test/TestAvatar.sol` is a minimal non-Safe avatar used in tests. Note that it does *no* caller check, which is test-only. **Verified.**
- What our PersonalAccount or StrategyVault must implement to be the target (Inferred):
  1. `execTransactionFromModule` and `...ReturnData` with the exact `IAvatar` signature (operation is `uint8` / `Enum.Operation`).
  2. Allow the call only when `msg.sender == rolesModifier` (or an enabled-module set), because this is the only gate. Anything that can call it bypasses Roles.
  3. Refuse `operation == 1` (delegatecall) at the account level as defense in depth, even though Roles can also forbid it via `ExecutionOptions`.
  4. Emit `ExecutionFromModuleSuccess/Failure` for tooling compatibility (optional).
  5. Keep the owner-withdraw path independent of Roles, so it works when the platform is down.
  6. For the ERC-4626 vault: calls executed from the vault change `totalAssets` and share price. The vault must enforce its own invariants (no transfer of underlying out except to allowed venues and back to itself, no approval to arbitrary spenders), because a Roles misconfiguration by the owner would otherwise redirect depositor funds.
- The call chain is `member -> Roles.execTransactionWithRole -> target.execTransactionFromModule -> to`, so `msg.sender` at the DeFi protocol is the target (account or vault). Swap recipients must equal the target, which is what `c.avatar` checks when `avatar == target`. **Inferred.**

### 4.1 Signed (relayed) module transactions

`Modifier.moduleOnly` accepts either `msg.sender` being an enabled module, or calldata with an appended `salt(32) + signature(65)` signed by an enabled module (`zodiac-core@3.0.1:core/Modifier.sol:moduleOnly`, `signature/SignatureChecker.sol:moduleTxSignedBy`). `_authorize` then uses `sentOrSignedByModule()` for the membership check (`packages/evm/contracts/PermissionChecker.sol:_authorize`). **Verified.**

- The EIP-712 domain is `(chainId, verifyingContract)` and the struct is `ModuleTx(bytes data, bytes32 salt)`. There is **no deadline**: a signed tx stays valid until used, `invalidate(hash)`-ed by the signer, or the signer loses membership (checked at execution). **Verified**, implication **Inferred**.
- For our "2-minute deadline" and "stale epoch must fail" rules, we must not rely on signature freshness. Use a direct `msg.sender` session key, or deadlines enforced in the calldata or by conditions (e.g. the Uniswap `deadline` param constrained with `lte`, which is relative to a stored constant, so not really a rolling bound). Rotate role membership on epoch change. v3's `execTransactionWithSignature` includes `roleKey`, `shouldRevert` and `salt` in the hash but also no deadline (per signature). **Inferred.**
- ERC-1271 member signatures are subject to the SignatureChecker bug on 2.1.0 and on `main` (section 0).

---

## 5. SDK (`packages/sdk`, `zodiac-roles-sdk` 4.1.3, LGPL-3.0+)

Exports (`packages/sdk/package.json` `exports`): `.`, `./kit`, `./annotations`, `./swaps`, `./typechain`. **Verified.**

- **Layer 1, targets** (`src/main/index.ts`): types (`Role`, `Target`, `Condition`, `Operator`, `ParameterType`, `ExecutionOptions`, `Clearance`), `chains`, `targetIntegrity` (`src/main/target/integrity.ts`: no duplicate targets or selectors, function-cleared targets need functions, and a function is either wildcarded or has a condition, never both), plus `checkRootConditionIntegrity` (`src/main/condition/conditionIntegrity.ts`).
- **Condition builders `c.*`** (`src/main/target/authoring/c/index.ts`): `withinAllowance`, `every`, `and`, `or`, `avatar`, `bitmask`, `eq`, `gt`, `gte`, `lt`, `lte`, `abiEncodedMatches`, `calldataMatches`, `matches`, `avatarIsOwnerOfErc721` (hardcodes `0x91B1...19d1`, `src/main/target/authoring/c/custom.ts`), `pass`, plus `forAll`. `c.some` and `nor` are not exposed in `c` (ArraySome exists onchain). **Verified.**
- **Layer 2, permissions**: `processPermissions` (`src/main/permission/processPermissions.ts`) coerces and merges `Permission | PermissionSet` entries (`mergePermissions`), throws on violations, and returns `{targets, annotations}` with conditions passed through `normalizeCondition`. Also `coercePermission`, `permissionId`, `reconstructPermissions`, `validatePresets`, `targetId`. **Verified.**
- **Condition primitives**: `flattenCondition` (to `ConditionFlat[]` for `scopeFunction`), `normalizeCondition` (including `pushDownOr`, `padToMatchTypeTree`), `conditionId` / `conditionHash` / `conditionAddress`. **Verified.**
- **Misc**: `rolesAbi`, `posterAbi`, `encodeKey` / `decodeKey` (role key labels to bytes32), `postRole` (POSTs `{targets, annotations, members}` to `https://roles.gnosisguild.org/api/permissions` and returns a hash for the app's diff page), `fetchLicense`. **Verified.**
- **`kit` (`allow`)**: `src/kit/typings.ts` derives a typed `allow.<chain>.<contract>.<fn>(...conditions)` from `@gnosis-guild/eth-sdk-client`, which is generated from the user's eth-sdk config. The repo's own `packages/sdk/eth-sdk/config.ts` is mainnet-only (lido, uniswap nftPositions and router2, compound, stakewise, weth, aave, balancer, aura) for tests. The docs mark the eth-sdk + kit flow **deprecated** in favor of `@zodiac-os/sdk/allow` (commit `3a05b490` message, `packages/docs/content/sdk/v3-v4-migration.mdx`). For Monad we would add our own eth-sdk config (chain name and ABIs), or skip the kit and write `Permission` objects with `c.*` directly. **Verified** (code), recommendation **Inferred**.
- **Annotations** (`src/annotations/annotations.ts`): resolve annotation `{uri, schema}` (OpenAPI) into `Preset`s and validate them as subsets of the onchain permissions. Uses network fetches. It is only a UI and documentation aid, not enforcement. **Verified.**
- **Swaps** (`src/swaps/*`): CoW Protocol order signing via Roles. `appData.ts:makeAppData` calls `fetchLicense`. For non-Enterprise licenses it **injects a 25 bps CoW `partnerFee` to `0x3ec84da3A9bCed9767490c198E69Aa216A35Df12` ("zodiacOsSafe")**, and `validateAppData` enforces it. It is irrelevant for us (CoW, not Uniswap, and not on Monad), but worth knowing. **Verified.**

### 5.1 Licensing

`src/main/licensing.ts:fetchLicense` does `GET https://app.zodiac.eco/system/get-plan/<prefix>:<owner>` and returns `none | free | enterprise | blocked`. It gates:
- (a) SDK swaps appData fee (above).
- (b) In the app only, `packages/app/utils/plan/enforceLicenseTerms.ts`: `blocked` means updates are refused, and `none` means roles using `WithinAllowance`, `CallWithinAllowance` or `EtherWithinAllowance` are refused ("Add the owner ... to your Zodiac OS organization").

It gates **nothing onchain**. The contracts have no license checks. Calling the Roles setters directly (our own tooling) bypasses all of it. Also note `prefixAddress` needs a `chains` entry, so it would throw for chain 143. **Verified.**

### 5.2 Presets / Uniswap

- There is no preset library in this repo. `grep -ril uniswap packages` hits only `packages/sdk/eth-sdk/{config.ts, abis/mainnet/uniswap/router2.json, nftPositions.json}` (test ABIs for the typed kit) and `packages/app/components/ContractName/addressLabels.json`. "Preset" hits are annotation and preset *validation* code and app UI. **Verified.**
- DeFi Kit (karpatkey) is external: `packages/docs/content/general/annotations.mdx` references `https://kit.karpatkey.com/api/v1/permissions/eth/cowswap/swap?...`. Whether DeFi Kit has Uniswap presets or Monad support is **Inferred/unknown** from this repo. We will author Uniswap permissions for Monad ourselves (router address, `exactInputSingle` / `exactInput` params, recipient = `c.avatar`, token whitelist via `or(eq...)`, amounts via `withinAllowance`).

---

## 6. Gas

- **Measurements in repo:** none committed. `packages/evm/hardhat.config.ts` enables `hardhat-gas-reporter` (`gasReporter: { enabled: true }`), and `packages/evm/test/utils.ts:logGas` prints `receipt.gasUsed` but has no callers in `test/` (grep). The docs have no gas figures, and `origin/contracts-v3` has no benchmark files. **Verified.** I could not run the tests (no `node_modules`; installing would write into the repo tree).
- **Cost drivers per execution (from code):**
  1. `members[module]` SLOAD, `targets[to]` SLOAD, `scopeConfig[key]` SLOAD (`PermissionChecker._transaction`). Three cold SLOADs, about 6.3k on Ethereum pricing.
  2. `WriteOnce.load(pointer)`: `extcodesize` + `extcodecopy` of the packed blob (cold account access about 2.6k, plus about 3 gas/word copy, plus memory expansion), then `BufferPacker.unpackBody` and `Topology` bounds in memory, which is linear in the number of condition nodes (`PermissionLoader._load`).
  3. Calldata decoding (`AbiDecoder`) and tree walk (`PermissionChecker._walk`): linear in nodes and in decoded params. Array operators (`ArrayEvery`/`ArraySome`) multiply by array length.
  4. Allowances: per consumed allowance, a 2-slot read (`Allowance` struct: slot0 `refill|maxRefill`, slot1 `period|balance|timestamp`) and one SSTORE in `_flushPrepare` (about 2.9k warm or 5k cold dirty write on Ethereum), plus an event in `_flushCommit`, or a second SSTORE on failure.
  5. `EqualToAvatar` adds a keccak of `avatar` per occurrence (cheap).
  6. Unwrapper path (MultiSend): an external `unwrap` call plus N sub-transaction checks.
  7. Execution: external CALL to the target (cold, about 2.6k), whose own module check (Safe: 1 SLOAD) and then the actual call.
- **Estimates (Inferred, Ethereum pricing, not measured):** a function-scoped call with a small condition (about 5 to 10 nodes, one static param check) and no allowance costs roughly 25k to 40k overhead above the underlying call. A Uniswap `exactInputSingle` with a tuple condition (token whitelist `or` of 4, recipient `avatar`, `amountIn` within allowance) is probably about 40k to 70k overhead. Admin `scopeFunction` with a new blob costs about 32k CREATE + 200 gas/byte code deposit + Integrity checks + a header SSTORE (for example a 500-byte blob is about 150k to 250k total). It is much cheaper if the blob already exists.
- **Monad specifics (Inferred, external knowledge, needs confirmation):** Monad charges on gas *limit* rather than gas used, and has repriced cold state access upward. Roles' multiple cold SLOADs plus the cold `extcodecopy` per call would weigh more there. Measure on a Monad fork or testnet.

---

## 7. Notes toward our design (Inferred)

- **Epoch binding:** v2 has no expiry or epochs. The cleanest mapping is `roleKey = keccak256(accountId, ownerEpoch, configEpoch)`. On any epoch bump: `assignRoles(sessionKey, [oldKey], [false])` and assign `newKey` with a fresh `scopeFunction` set. Old keys keep their scopeConfig but have no members, and because keys are never reused, "old permissions never come back". This relies on no one re-adding members to old keys, so the owner contract should refuse that. v3 `grantRole(..., endTimestamp, usesLeft)` adds auto-expiry.
- On NFT transfer, Roles `transferOwnership` must follow, or the Roles owner should be a contract that reads the current NFT owner. Single-step transfer is fine if done by our contract.
- `assignRoles` auto-enables the module but `assignRoles(false)` does not disable it. A module with no role memberships is harmless (`_authorize` reverts `NoMembership`), but `disableModule` is cleaner.
- Our executor limits (portfolio %, daily trade count, oracle freshness, circuit breaker) are not expressible as pure v2 conditions except via allowances (rate-limited amounts) and custom conditions (`ICustomCondition` adapters). They belong in a custom condition contract or in the account itself (sub-agent A/B territory).

---

## Open questions

1. Is `origin/v2@218a5164` the exact source for the `0xF2964...` bytecode? The runtime matches the recorded initcode, but I did not recompile. Is there an audit of the 2.1.1 delta?
2. Why did Packer's bytecode change between 2.1.0 and 2.1.1 (`0x61C5` to `0x8697`) with no Packer source change? Probably the metadata hash from a different compiler input; unconfirmed.
3. ModuleProxyFactory on Monad: byte-compare with the canonical zodiac-core artifact.
4. Is `0xd548...BED6` on Monad the canonical Delay 1.0.0?
5. Does `@zodiac-os/sdk` or the Zodiac API support chain 143? Does DeFi Kit have Monad or Uniswap presets?
6. Actual gas on Monad for a representative Uniswap-scoped call. This needs a Monad fork run of the test suite from `origin/v2`.
7. Does Gnosis Guild plan to merge 2.1.1 back into `main`? `main` currently ships the three bugs in source form.
