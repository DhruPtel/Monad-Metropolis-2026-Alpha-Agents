# Report 1: How Tokenbound works

Research date: 2026-09-25. Read-only analysis. Labels: **Verified** means seen in code, tests, in-repo docs, or a read-only onchain call. **Inferred** means our reasoning, not executed. Nothing was compiled or run because Foundry is not installed on the research machine; the tests that would settle the Inferred items are in Report 3.

Working notes with more detail: `research/tokenbound/notes/A-account-core.md`, `B-registry-deploy-trust.md`, `C-sdk.md`, `D-security.md`.

---

## 1. Versions, licenses, and what is deployed on Monad

### 1.1 Repositories

| Repository | Where it came from | Commit | Version or tag | Last commit | License |
|---|---|---|---|---|---|
| tokenbound/sdk | Cloned by us at `agent_tool/tokenbound` | `6244f1e3a1027e1e411574df166fa5d3302eff64` | `@tokenbound/sdk` 0.5.5 | 2024-10-22 | No LICENSE file. Root `package.json` says ISC |
| tokenbound/contracts | Not present in the workspace. Cloned read-only by the research lead into a scratch folder | `bce75f985558fad3d06ee1b86f224f0cfb783631` | `v0.3.1-15-gbce75f9` (15 commits after the v0.3.1 tag of 2023-10-25) | 2024-03-11 | MIT (SPDX headers, no LICENSE file) |
| erc6551/reference | Same as above | `da16a63fb53db6375175a9dca22f1e19e652a193` | `v0.3.0-17-gda16a63` | 2023-10-24 | MIT (SPDX headers) |
| contracts submodules | `lib/` | erc6551 `882159c` (v0.3.0~1), OpenZeppelin v4.9.3, account-abstraction v0.6.0 (GPL-3.0), multicall-authenticated `653b2bc` | | | |

The only source changes between tag v0.3.1 and HEAD are `virtual` keywords on six functions in `AccountV3.sol` and import path changes (**Verified**, `git diff v0.3.1 HEAD -- src`). The logic is the same (**Inferred**). The contracts and SDK repos have seen no commits since March 2024 and October 2024 respectively, and neither mentions Monad (**Verified**).

Paths in this report are written as `contracts/src/...`, `erc6551-reference/src/...` and `sdk/packages/sdk/src/...` at the commits above.

### 1.2 What is deployed on Monad

Checked with read-only `eth_getCode`, `eth_call` and `eth_getStorageAt` against `https://rpc.monad.xyz` (chain 143), `https://testnet-rpc.monad.xyz` (chain 10143) and an Ethereum RPC. Runtime code was compared by keccak-256 hash (**Verified**).

| Address | Role | Code on Monad mainnet and testnet | Same runtime hash as Ethereum |
|---|---|---|---|
| `0x000000006551c19487814612e58FE06813775758` | ERC6551Registry | Yes (571 bytes) | Yes |
| `0x55266d75D1a14E4572138116aF39863Ed6596E7F` | AccountProxy (what TBAs actually point at) | Yes (902) | Yes |
| `0x41C8f39463A868d3A88af00cd0fe7102F30E44eC` | AccountV3Upgradable (logic) | Yes (14924) | Yes |
| `0x2FE5ccb0d7Ea195FEb87987d3573F9fcCE2b5D57` | AccountGuardian | Yes (1211) | Yes |
| `0xcA1167915584462449EE5b4Ea51c37fE81eCDCCD` | Authenticated Multicall3 (trusted forwarder) | Yes (4126) | Yes |
| `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` | ERC-4337 EntryPoint v0.6 | Yes (23689) | Yes |
| `0x4e59b44847b379578588920cA78FbF26c0B4956C` | CREATE2 deployer used by the scripts | Yes | Yes |

- The CREATE2 addresses of Guardian, AccountV3Upgradable, AccountProxy, Registry and forwarder were recomputed from the Ethereum creation transactions and all match. The constructor arguments embedded at the end of the init code match `contracts/script/DeployAccountV3.s.sol`, and the compiler metadata says solc 0.8.17 (**Verified**, notes B section 6). Monad has the same addresses, the same factory and the same runtime hashes, so the Monad contracts were built from the same init code (**Inferred**, strong).
- The one step left is to compile `contracts@v0.3.1` and confirm it reproduces that init code. That needs Foundry, so it is in Report 3.
- Guardian owner on Monad mainnet is the Tokenbound Safe `0x781b6A527482828bB04F33563797d4b696ddF328`, a 3-of-4 Safe v1.3.0 with the same signers as on Ethereum. Its nonce is 0 and it has no modules (**Verified**). So the Safe has never sent a transaction on Monad (**Inferred**), which means the guardian's trust lists are still at their defaults.
- On Monad testnet the Safe address has no code, so the testnet guardian's settings are frozen at defaults (**Verified** code absence; consequence **Inferred**).
- `isTrustedImplementation` returns false for both 0x41C8 and 0x5526 on Monad (**Verified**). No upgrade target is trusted, so no TBA on Monad can currently upgrade (**Inferred**).
- Other Monad facts relevant later (**Verified** by `eth_getCode` and `eth_call`):
  - Permit2 is deployed at `0x000000000022D473030F116dDEE9F6B43aC78BA3`.
  - EntryPoint v0.7 and v0.8 are also deployed.
  - A token at `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` returns symbol `USDC` and `version()` "2". Its implementation exposes the FiatToken v2.2 `bytes signature` variants of `permit` and `transferWithAuthorization`. That it is Circle's official Monad USDC is **Inferred**; confirm with Circle.

---

## 2. What Tokenbound is

Tokenbound is the reference production implementation of ERC-6551. Any ERC-721 token gets a smart contract account at a deterministic address, computed by a shared registry from the implementation, a salt, the chain ID, the token contract and the token ID. Whoever currently owns the NFT controls the account. The account checks `ownerOf` live on every authorization, so control moves with the NFT immediately and the account is never notified of a transfer.

The v3 account (`AccountV3`) adds several features on top of plain execution:
- delegated executors ("permissions")
- a time lock
- per-selector fallback overrides
- nested account trees
- ERC-1271 signing
- ERC-4337 support (EntryPoint v0.6)
- cross-chain execution through guardian-trusted bridges
- upgradability through a proxy, where a Tokenbound-controlled guardian allowlists the implementations accounts may upgrade to

The SDK is a thin viem-based client that computes addresses, creates and initializes accounts, and sends simple calls from the NFT holder's wallet.

---

## 3. Architecture

```mermaid
flowchart LR
  subgraph Deploy[Deployed once per chain via CREATE2 factory 0x4e59]
    REG[ERC6551Registry<br/>0x0000...5758]
    GUARD[AccountGuardian<br/>0x2FE5...5D57<br/>owner: Tokenbound Safe]
    IMPL[AccountV3Upgradable<br/>0x41C8...44eC]
    PROXY[AccountProxy<br/>0x5526...6E7F]
    FWD[Multicall3 forwarder<br/>0xcA11...CCD]
    EP[EntryPoint v0.6<br/>0x5FF1...2789]
  end
  NFT[ERC-721 e.g. AgentNFT] -- ownerOf live check --> TBA
  REG -- CREATE2 ERC-1167 clone<br/>+ salt, chainId, token, tokenId --> TBA[TBA clone 173 bytes]
  TBA -- delegatecall --> PROXY
  PROXY -- delegatecall to ERC-1967 slot --> IMPL
  IMPL -. immutable .-> GUARD
  IMPL -. trusted forwarder .-> FWD
  IMPL -. entryPoint .-> EP
  TBA -- CALL for op=DELEGATECALL and overrides --> SBX[Per-account sandbox<br/>CREATE2 by TBA]
  SBX -- extcall / extcreate --> TBA
  SDK[@tokenbound/sdk TokenboundClient] -- aggregate3: createAccount + initialize --> FWD
  FWD --> REG
  FWD --> TBA
```

### 3.1 Contracts (`contracts/src`, 1355 lines)

| Contract | Purpose | Key functions |
|---|---|---|
| `AccountV3.sol` | Main account. Inherits ERC721Holder, ERC1155Holder, Lockable, Overridable, Permissioned, ERC6551Account, ERC4337Account, TokenboundExecutor (lines 24-33) | `owner`, `_isValidExecutor`, `_isValidSigner`, `_isValidSignature`, `_rootTokenOwner`, `_tokenOwner`, receiver hooks |
| `AccountV3Upgradable.sol` | AccountV3 plus OZ UUPS | `_authorizeUpgrade` (lines 15-18) |
| `AccountProxy.sol` | ERC-1967 proxy that TBAs are clones of | `initialize(address)` (lines 22-30) |
| `AccountGuardian.sol` | Ownable2Step allowlists | `setTrustedImplementation`, `setTrustedExecutor` |
| `abstract/ERC6551Account.sol` | ERC-6551 interface | `token`, `state`, `isValidSigner` |
| `abstract/Permissioned.sol` | Delegated executors | `setPermissions`, `permissions` mapping |
| `abstract/Lockable.sol` | Time lock | `lock`, `isLocked`, `lockedUntil` |
| `abstract/Overridable.sol` | Per-selector fallback handlers | `setOverrides`, `_handleOverride` |
| `abstract/Signatory.sol` | ERC-1271 | `isValidSignature` |
| `abstract/ERC4337Account.sol` | ERC-4337 v0.6 | `_validateSignature` |
| `abstract/execution/*` | `execute`, `executeBatch`, `executeNested`, sandbox `extcall`/`extcreate`/`extcreate2`/`extsload`, ERC-2771 sender via forwarder | |
| `lib/LibExecutor.sol`, `lib/LibSandbox.sol` | Operation dispatch, sandbox deployment | |
| `cross-chain/FxChildExecutor.sol`, `lib/OPAddressAliasHelper.sol` | Polygon Fx and OP-stack cross-chain paths | |

Deployment order (`contracts/script/DeployAccountV3.s.sol`, **Verified**):
1. `AccountGuardian(tokenboundSafe)`
2. `AccountV3Upgradable(entryPoint, forwarder, registry, guardian)`
3. `AccountProxy(guardian, implementation)`

All three use salt `0x6551...6551` through the 0x4e59 factory. The registry is deployed separately by `erc6551-reference/script/DeployRegistry.s.sol`.

### 3.2 SDK (`sdk/packages/sdk`)

The `TokenboundClient` class is the only supported V3 entry point. The functions exported directly from `index.ts` are deprecated V2 versions (**Verified**, `functions/viemV2.ts`). The client builds on viem ^2.21.32, and ethers v5/v6 signers are handled by duck typing. For account creation, the SDK sends one Multicall3 `aggregate3` call through the forwarder containing `registry.createAccount(AccountProxy, ...)` and then `AccountProxy.initialize(0x41C8...)` (**Verified**, `TokenboundClient.ts` `prepareCreateAccount`, lines 210-297).

---

## 4. Account core

### 4.1 Ownership

- `token()` reads `(chainId, tokenContract, tokenId)` from the immutable footer that the registry appended to the clone's bytecode (`ERC6551AccountLib.token`, lib lines 59-72). The binding can never change (**Verified**).
- `owner()` calls `_tokenOwner`, which returns `address(0)` if `chainId != block.chainid` or the token contract has no code. Otherwise it calls `IERC721.ownerOf(tokenId)` inside a try/catch (`AccountV3.sol` lines 76-79, 344-358). There is no cached owner, so every check is live (**Verified**).
- `_rootTokenOwner` walks up the tree while the owner is itself an ERC-6551 account (lines 324-338), with no depth cap (**Verified**).
- **Canonical accounts probably never walk the tree.** The walk requires the parent's clone to point at `__self`, which is the implementation address (0x41C8). Canonical TBAs point at the AccountProxy (0x5526), so the root owner of a canonical account is just its direct owner, and `executeNested` would compute wrong addresses. This is **Inferred** with high confidence. The repo only tests nesting with the bare implementation. Report 3 includes a test.
- Cross-chain: if the token lives on another chain, `owner()` is zero. Only the EntryPoint (with a valid signature, which cannot exist), the OP-stack L1 alias of the same address, or a guardian-trusted executor can act (lines 226-241). None of these paths are active for our Monad-native TBAs (**Verified** from code, **Inferred** for our case).

### 4.2 Execution entry points

`_isValidExecutor(executor)` (lines 226-255) returns true in this order:
1. the EntryPoint
2. only for foreign-chain accounts: the OP alias or a guardian-trusted executor
3. the direct owner
4. the root owner
5. any address in `permissions[rootOwner][executor]`

The caller is `_msgSender()`. The forwarder appends the real caller to calldata, so it cannot be used to spoof (**Verified**, `TokenboundExecutor.sol` lines 34-42, `Multicall3.sol` line 121).

| Entry point | Who may call | Lock checked | `state()` bumped |
|---|---|---|---|
| `execute(to, value, data, op)`, op 0 CALL | `_isValidExecutor` | Yes | Yes |
| `execute` op 1 DELEGATECALL | same; runs in the per-account sandbox, never in the account's storage (`LibExecutor.sol` lines 18-22) | Yes | Yes |
| `execute` op 2 and 3 CREATE and CREATE2 | same | Yes | Yes |
| `executeBatch(Operation[])` | same; one check for the whole batch | Yes | Yes |
| `executeNested(...)` | proof walk plus `_isValidExecutor` | Yes, including deployed intermediates | This account only |
| `extcall`, `extcreate`, `extcreate2` | only the account's sandbox | **No** | **No** |
| `upgradeTo`, `upgradeToAndCall` | trusted implementation AND `_isValidExecutor` | **No** | **No** |
| `lock`, `setPermissions`, `setOverrides` | `msg.sender == rootOwner` only (raw `msg.sender`, not the forwarder) | Yes | Yes |
| `receive`, `fallback`, ERC-721 and ERC-1155 hooks | anyone; run the owner's override if one is set | **No** | **No** |
| ERC-4337 `validateUserOp` | EntryPoint only; signature from a valid signer; pays prefund | **No** | No |

All cells are **Verified** from the cited code (notes A section 2).

### 4.3 Signatures (ERC-1271)

- `isValidSignature(hash, sig)` (`Signatory.sol` lines 14-24, `AccountV3.sol` lines 185-217) accepts two formats (**Verified**):
  - A 65-byte ECDSA signature from a valid signer: the direct owner, the root owner, or a permissioned address (lines 159-178).
  - `v == 0` contract signatures: the signer address goes in `r` and the offset in `s`, then the inner signature is checked through ERC-1271 on the signer. The signer must itself be a valid signer or the account.
- The hash is used raw, with no account address or chain ID mixed in (**Verified**). A signature valid for one TBA is valid for every TBA with the same owner, unless the signed payload names the account itself, as EIP-3009 `from` and EIP-2612 `owner` do (**Inferred**).
- After a transfer, the check resolves to the new owner, so old signatures fail for anything verified after the transfer (**Verified**, live `ownerOf`). Effects that were already recorded, such as a Permit2 or USDC allowance, are not undone (**Inferred**).
- The lock does not affect signatures (**Verified**: there is no `isLocked` check in the signature path). The repo test that says otherwise signs with a non-owner key (`Account.t.sol` lines 246-252).
- Signatures shorter than 65 bytes revert instead of returning false, because `signature[64]` is read unconditionally (**Verified**, line 192).

### 4.4 State

`_state = keccak256(abi.encode(_state, _msgData()))` runs on `execute*`, `lock`, `setPermissions` and `setOverrides` (lines 260-297) (**Verified**). It does not change on NFT transfer, incoming tokens, upgrades, override-driven calls, or ERC-4337 prefund (**Verified**). It is intended as the value a marketplace pins in an order. It only covers the account's own execute and config paths (**Inferred**).

### 4.5 Permissions

- `permissions[rootOwner][caller] = bool`. Only the root owner can set it, by calling directly, and only while unlocked (`Permissioned.sol` lines 17, 29-49) (**Verified**).
- **It is all-or-nothing.** A permissioned address can do everything the owner can except `lock`, `setPermissions` and `setOverrides` (**Verified**):
  - call anything with any value
  - use sandboxed delegatecall, create and create2
  - batch
  - upgrade to a trusted implementation
  - produce ERC-1271 signatures and sign ERC-4337 UserOps
- The account cannot limit a permission to certain targets, functions or amounts, and cannot give it an expiry (**Verified**).
- **After a transfer**, lookups use `permissions[newOwner]`, which is empty, so every grant stops working in the same block (**Verified**, `AccountPermissions.t.sol` lines 112-118). Nothing deletes the old entries. **If the NFT returns to a previous owner, that owner's old grants come back** (**Verified** storage behavior; the risk is **Inferred**).

### 4.6 Lock

- `lock(untilTimestamp)` can only be called by the root owner directly. The maximum is `block.timestamp + 365 days`. Once set, a lock cannot be extended, shortened or cancelled until it expires (`Lockable.sol` lines 26-49; `AccountV3.sol` lines 276-279) (**Verified**).
- `lockedUntil` is a single storage slot, not keyed by owner, so **a seller's lock binds the buyer** (**Verified**).
- It blocks `execute*`, `setPermissions`, `setOverrides` and `lock` (**Verified**).
- It does not block (**Verified**):
  - ERC-1271 signatures
  - ERC-4337 validation and prefund
  - `upgradeTo`
  - overrides, which can move funds through `extcall`
- **The lock cannot stop a determined seller from draining the account.** An override the seller installed before locking can still move funds, and so can a signature-based permit, and neither changes `state()` (**Inferred** from code; to be confirmed by the spike test).

### 4.7 Overrides

- `overrides[rootOwner][selector] = implementation`. Only the root owner can set it, and only while unlocked (`Overridable.sol` lines 19, 30-53) (**Verified**).
- Overrides only apply to calls that reach `receive`, `fallback` (unknown selectors), the ERC-721 and ERC-1155 receive hooks, and `supportsInterface` for non-base interface IDs. Built-in functions such as `execute` and `isValidSignature` cannot be overridden (**Verified** for the hook list; **Inferred** from Solidity dispatch for the rest).
- An override runs in the sandbox with the original caller appended, and it can call `extcall` to move account assets (lines 60-75) (**Verified**).
- Overrides are keyed by owner, so they go dormant after a transfer and come back if the NFT returns to that owner (**Verified** key; **Inferred** effect). The repo test for this checks the wrong account (`AccountOverrides.t.sol` lines 290-298).

---

## 5. Registry, deployment, upgradeability, guardian, ERC-4337, cross-chain

### 5.1 Registry

- The address is CREATE2 from the registry of an ERC-1167 clone with `abi.encode(salt, chainId, tokenContract, tokenId)` appended. It depends only on (registry, implementation, salt, chainId, tokenContract, tokenId) (`erc6551-reference/src/ERC6551Registry.sol` lines 54-161) (**Verified**).
- Anyone may call `createAccount`. It is idempotent and returns the existing address without an event (**Verified**).
- We confirmed the formula against the live Monad registry (**Verified**, notes B section 1).
- For Tokenbound V3 the "implementation" argument is the AccountProxy 0x5526, not the logic contract (`sdk/.../constants/tokenboundAddresses.ts` lines 30-43) (**Verified**).

### 5.2 Upgradeability

- `AccountProxy.initialize(impl)` has no caller check and can run only once. It accepts either the initial implementation 0x41C8 or a guardian-trusted one (`AccountProxy.sol` lines 22-30) (**Verified**).
- Until it runs, the proxy delegates to `address(0)`. Plain transfers of the native token and ERC-20s into the account succeed, but `safeTransferFrom` of ERC-721 or ERC-1155 reverts because the receive hook returns empty data (**Inferred** from OZ `Proxy`). **Create and initialize in the same transaction.**
- `upgradeTo` requires `guardian.isTrustedImplementation(impl)` and `_isValidExecutor(_msgSender())` (`AccountV3Upgradable.sol` lines 15-18). So the owner, any permissioned address, or a UserOp can upgrade (**Verified**).
- An upgrade survives an NFT transfer, is not blocked by the lock, and does not change `state()` (**Verified**).
- Anyone, including a contract, can read the ERC-1967 slot through the public view `extsload(bytes32)` (`SandboxExecutor.sol` lines 57-61) (**Verified**). So an escrow contract can check which implementation a TBA runs.

### 5.3 Guardian (trust assumption we must disclose)

- The guardian is baked in as an immutable in both the implementation and the proxy, and no account can opt out (**Verified**).
- Its owner, the Tokenbound 3-of-4 Safe, can (**Verified**):
  - (a) add implementations that any account executor may then upgrade to, or initialize with
  - (b) add trusted executors
- A trusted executor gets full power only over accounts whose token lives on a different chain (**Verified**, `AccountV3.sol` lines 232-241, `AccountCrossChain.t.sol` lines 91-112).
- On Monad, nothing is trusted today (**Verified**).
- **Consequence for us:** the same TBA address exists on other chains. On Ethereum the LayerZero executor `0x0F22...` is trusted (**Verified**, guardian event at block 19434674). So assets sent by mistake to our TBA address on Ethereum or on other chains with a trusted executor would be controlled by Tokenbound's trusted executor, not by the NFT holder (**Inferred**).

### 5.4 ERC-4337

- The TBA accepts only EntryPoint v0.6 `0x5FF1...` (immutable) (**Verified**).
- UserOp signatures are EIP-191 over `userOpHash`, and can come from the owner, the root owner or a permissioned address (`ERC4337Account.sol` lines 37-61) (**Verified**).
- Nonces are the EntryPoint's (**Verified**), and standard paymasters should work (**Inferred**).
- Two things may block this path (**Inferred**, open questions):
  - Strict ERC-7562 bundlers may reject TBA UserOps, because validation reads `ownerOf` from the NFT contract's storage.
  - Privy's Monad stack may only support EntryPoint v0.7 or v0.8.

### 5.5 Cross-chain

`FxChildExecutor` calls back into the root message sender. The OP-stack alias path and the SDK's LayerZero executor exist too. None are active for Monad-native TBAs, and Monad has no LayerZero entry in the SDK (**Verified**).

---

## 6. SDK public API and Monad setup

| Member | What it does |
|---|---|
| `new TokenboundClient({ chain or chainId, walletClient or signer, publicClient?, publicClientRPCUrl?, implementationAddress?, registryAddress?, version? })` | Builds a client. `chainId` alone throws for unknown chains, so pass a viem `chain` for Monad (`chainIdToChain.ts` line 53) |
| `getAccount({ tokenContract, tokenId, salt=0, chainId? })` | Computes the TBA address offline |
| `prepareCreateAccount` / `createAccount({ ..., appendedCalls? })` | Multicall of createAccount plus initialize plus optional calls; returns `{account, txHash}`. **Reverts if the account is already initialized** (**Inferred**) |
| `prepareExecution` / `execute({ account, to, value, data, chainId? })` | `execute(to, value, data, 0)`. Operation is always CALL. A `chainId` different from the client's switches to LayerZero |
| `transferETH`, `transferERC20`, `transferNFT` | Helpers that go through `execute`; amounts are JS numbers |
| `isValidSigner({ account })` | Checks whether the connected address is a valid signer |
| `signMessage({ message })` | Signs with the connected wallet. It does not produce a TBA ERC-1271 signature |
| `checkAccountDeployment`, `deconstructBytecode`, `getNFT`, `getSDKVersion` | Inspection helpers |
| `prepareExecuteCall`, `executeCall` | V2 only; throw on V3 |

- **Not in the SDK** (**Verified**): `setPermissions`, `lock`, `setOverrides`, `executeBatch`, `executeNested`, `upgradeTo`, `state`, `isValidSignature`, ERC-4337, and the guardian. We will need a small viem wrapper around the exported `erc6551AccountAbiV3`.
- **Monad setup:** pass `chain: monad` or `monadTestnet` from a recent viem (2.53 or later has them; 2.21.32 in the lockfile does not; **Inferred** from local installs), or use `defineChain`. All addresses are the same constants on every chain. Do not use ENS names or the cross-chain `chainId` parameter.
- The SDK tests fork Ethereum mainnet with `@viem/anvil`. The same harness can fork Monad (notes C section 6).

---

## 7. Security and edge cases

Severity is for our platform.

| # | Issue | What the code does | Severity for us |
|---|---|---|---|
| S1 | Override drain bypasses lock and state | Receive, fallback and 1155 hooks run the owner's override in the sandbox, which can call `extcall`; neither the lock nor `state()` is touched (`Overridable.sol` lines 60-75, `SandboxExecutor.sol` lines 26-32). **Verified** path; exploit **Inferred** | High |
| S2 | ERC-1271 ignores the lock | The owner or a permissioned signer can sign Permit2 or USDC v2.2 permits and authorizations during a lock. Monad USDC has the bytes-signature entry points (**Verified**) | High |
| S3 | Approvals outlive lock and transfer | No approval tracking or revocation anywhere in the account (**Verified** by absence) | High |
| S4 | Permissions are all-or-nothing | A permissioned address can execute anything, sign, and upgrade (`AccountV3.sol` lines 177, 252; `AccountV3Upgradable.sol` line 17). **Verified** | High if we permission a session key; none if we permission only a restricted contract |
| S5 | Grants come back when the NFT returns to a previous owner | Permissions and overrides are keyed by owner address and never cleared. **Verified** | Medium |
| S6 | The lock carries over to the buyer | `lockedUntil` is one slot; a lock lasts up to 365 days. **Verified** | Medium |
| S7 | Upgrades are not locked and do not bump state | Limited to guardian-trusted implementations; none trusted on Monad today. **Verified** | Medium (trust in Tokenbound) |
| S8 | Ownership cycles | Only a `safeTransferFrom` of the account's own NFT into itself is blocked (lines 115-119). `transferFrom` into itself, or two accounts owning each other, bricks the accounts (**Inferred**) | Medium; AgentNFT must block these transfers |
| S9 | Unsolicited tokens | All hooks accept everything by default; ERC-20 and plain ERC-721 transfers cannot be refused. **Verified** | Medium; builds must never be derived from balances |
| S10 | No domain separation in ERC-1271 | The raw hash is checked. **Verified**. Cross-account replay is possible for payloads that do not name the account | Medium |
| S11 | Nested root owner inert for canonical accounts | `__self` does not match the proxy. **Inferred** | Low; do not nest agents |
| S12 | Uninitialized proxy window | `initialize` is permissionless. **Verified** | Low if we create and initialize atomically |
| S13 | ERC-4337 prefund during a lock | `_payPrefund` does not check the lock. **Verified** | Low |
| S14 | No reentrancy guard | State is updated before the external call; only authorized executors can re-enter. **Verified** | Low for the account; guards belong in our Executor |
| S15 | Delegatecall is safe | It runs in the sandbox's storage, so it cannot plant permissions, lock values or the implementation slot. **Verified** by decoding the sandbox bytecode | Positive |

### Audits

- **Zellic** reviewed contracts commit `48155498` from August 29 to September 8, 2023 (report dated November 13, 2023; `contracts/audits/Tokenbound - Zellic Audit Report.pdf`). Findings (**Verified** from the PDF):
  - 3.1 proxy re-initialization: Critical, fixed
  - 3.2 `executeNested` lock bypass: Critical, fixed for the lock; intermediate state is still not bumped
  - 3.3 registry `initData` front-run: Medium, acknowledged; the v0.3 registry has no `initData`
  - 3.4 forgeable `isERC6551Account`: Low, fixed
  - 3.5 root owner forgeable: Informational, a warning comment was added
- 35 later commits are not covered, including `FxChildExecutor`.
- The audit's threat model assumed an outsider who never held authorization. It does not consider a seller abusing overrides, signatures or approvals (**Inferred** from its section 5.2).
- **CertiK** (July 3, 2023; `erc6551-reference/audits/certik-07-03.pdf`) covers only early reference contracts, not AccountV3. Two Major findings are acknowledged: centralized upgrade control, and the owner's full execution power. Two Minor findings are acknowledged: a fraudulent `ownerOf` and the dependency on the token contract (**Verified**).
