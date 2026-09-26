# B. Registry, deployment, upgradeability, trust (working notes, Sub-agent B)

Date of onchain checks: 2026-09-25. All checks were read-only JSON-RPC (`eth_getCode`, `eth_call`, `eth_getStorageAt`, `eth_getTransactionByHash`, `eth_getLogs`) plus two read-only Blockscout API GETs for Ethereum history. Nothing was deployed or modified.

## Versions

| Repo | Commit | Tag | Last commit | License |
|---|---|---|---|---|
| tokenbound/contracts | `bce75f985558fad3d06ee1b86f224f0cfb783631` | v0.3.1-15-gbce75f9 | 2024-03-11 | SPDX MIT |
| erc6551/reference | `da16a63fb53db6375175a9dca22f1e19e652a193` | v0.3.0-17-gda16a63 | 2023-10-24 | SPDX MIT |
| contracts/lib/erc6551 | `882159c` | v0.3.0~1 | 2023-10-18 | MIT |
| contracts/lib/openzeppelin-contracts | v4.9.3 | | | MIT |
| contracts/lib/multicall-authenticated | `653b2bc9cb3199816fdf1bcf17c1b026c7238217` | | 2023-10-10 | MIT |
| tokenbound/sdk | `6244f1e` | @tokenbound/sdk 0.5.5 | 2024-10-22 | ISC (package.json) |

Compiler config: `contracts/foundry.toml` and `erc6551-reference/foundry.toml` both `solc_version = "0.8.17"`, optimizer on, 200 runs (Verified). The CBOR metadata tail of the deployed Tokenbound and registry init code ends in `64736f6c6343 000811` = solc 0.8.17 (Verified from init code, see section 6). Multicall forwarder metadata says solc 0.8.12 (`...0008 0c 0033`, Verified).

Tool note: keccak was computed with `python3` + `Crypto.Hash.keccak` (pycryptodome, already installed). All hashes below are keccak-256 unless stated.

---

## 1. Registry: how account addresses are computed and created

Source: `erc6551-reference/src/ERC6551Registry.sol`, `createAccount` (lines 54-128) and `account` (lines 130-161). The copy in `contracts/lib/erc6551/src/ERC6551Registry.sol` differs only by a comment typo ("bytedcode"), Verified by `diff`.

Mechanism (Verified, `createAccount` assembly lines 81-93):

```solidity
calldatacopy(0x8c, 0x24, 0x80) // salt, chainId, tokenContract, tokenId
mstore(0x6c, 0x5af43d82803e903d91602b57fd5bf3) // ERC-1167 footer
mstore(0x5d, implementation) // implementation
mstore(0x49, 0x3d60ad80600a3d3981f3363d3d373d3d3d363d73) // ERC-1167 constructor + header
mstore8(0x00, 0xff) // 0xFF
mstore(0x35, keccak256(0x55, 0xb7)) // keccak256(bytecode)
mstore(0x01, shl(96, address())) // registry address
mstore(0x15, salt) // salt
let computed := keccak256(0x00, 0x55)
```

- Init code (0xb7 = 183 bytes) = 10-byte ERC-1167 constructor + 45-byte ERC-1167 runtime pointing at `implementation` + 128 bytes of appended data `abi.encode(salt, chainId, tokenContract, tokenId)`. Deployed runtime is 173 bytes (0xAD). `ERC6551AccountLib.isERC6551Account` checks `account.code.length != 0xAD` (`contracts/lib/erc6551/src/lib/ERC6551AccountLib.sol` line 31). (Verified)
- The CREATE2 deployer is the registry itself, and the CREATE2 salt is the same `salt` argument. So the address is a pure function of **(registry address, implementation, salt, chainId, tokenContract, tokenId)**. Nothing about the current NFT owner, msg.sender, or block data enters it. (Verified)
- `chainId` is a parameter, not `block.chainid`. The same five inputs give the same address on every chain where the registry sits at the same address. (Verified from code; cross-chain consequences in section 5.)
- Idempotency: `if iszero(extcodesize(computed))` deploy and emit `ERC6551AccountCreated`; otherwise return the computed address with no event and no revert (lines 96-126). Anyone can call `createAccount` for any token; there is no access control. (Verified)
- `account(...)` (view) computes the same address without deploying (lines 130-161). (Verified)
- Account context is read back from the clone's own code: `ERC6551AccountLib.token()` does `extcodecopy(account, ..., 0x4d, 0x60)` (lib lines 59-68), `salt()` reads offset 0x2d, `implementation()` reads the 20 bytes at offset 0x0a of the clone (lines 47-53). The token binding is therefore immutable per account address. (Verified)

Onchain confirmation of the formula (Verified). I called `account(proxy, 0x0, 143, 0x1111...1111, 42)` on Monad mainnet and recomputed the same thing in Python:

```
curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x000000006551c19487814612e58FE06813775758","data":"0x246a002100000000000000000000000055266d75d1a14e4572138116af39863ed6596e7f0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008f0000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000000002a"},"latest"]}' https://rpc.monad.xyz
-> 0x...1148814ab544bde0011a52acbcf656de44bc4572
Python keccak(0xff ++ registry ++ salt ++ keccak(initcode183))[12:] -> 0x1148814ab544bde0011a52acbcf656de44bc4572   (match)
```

### The implementation passed to the registry is the AccountProxy, not AccountV3Upgradable (Verified)

- SDK `packages/sdk/src/constants/tokenboundAddresses.ts` lines 30-43: `ACCOUNT_PROXY 0x55266d75...` with comment "Proxy for the upgradeable implementation, initialization lives here"; `IMPLEMENTATION 0x41C8f394...` "Upgradeable".
- `packages/sdk/src/TokenboundClient.ts` lines 150-152: `this.implementationAddress = implementationAddress ?? ERC_6551_DEFAULT.ACCOUNT_PROXY?.ADDRESS`. So the ERC-1167 clone points to the AccountProxy.
- `TokenboundClient.prepareCreateAccount` (lines 211-296) returns a Multicall3 `aggregate3` to `MULTICALL_AUTHENTICATED_ADDRESS` (`src/constants/multicall.ts`, `0xcA1167915584462449EE5b4Ea51c37fE81eCDCCD`) with two calls, both `allowFailure: false`: `registry.createAccount(...)` then `account.initialize(0x41C8...)` (AccountProxy ABI). Custom implementations skip initialization (lines 263-266).
- Call chain at runtime: TBA (ERC-1167 clone) -> DELEGATECALL AccountProxy code -> DELEGATECALL implementation from the ERC-1967 slot in the TBA's own storage. (Verified from `contracts/src/AccountProxy.sol` and OZ `Proxy._delegate`.)
- Inferred consequence: calling `createAccount` via the SDK for an account that already exists and is initialized will revert, because `initialize` reverts with `AlreadyInitialized` and `allowFailure` is false. Use `account(...)` / check code first.

### Side finding: nested-ownership helpers assume the clone points to the implementation, not the proxy (Inferred)

`NestedAccountExecutor` sets `address immutable __self = address(this)` (`contracts/src/abstract/execution/NestedAccountExecutor.sol` line 25), which is the AccountV3Upgradable address (0x41C8...) because immutables are baked in at the implementation's construction. `AccountV3._rootTokenOwner` walks up the tree only while `ERC6551AccountLib.isERC6551Account(_owner, __self, erc6551Registry)` (`contracts/src/AccountV3.sol` line 332), and that function rejects accounts whose clone implementation != `__self` (lib line 39). Canonical V3 TBAs are clones of the proxy (0x5526...), so the root-owner walk and `executeNested` address derivation (NestedAccountExecutor line 67) would not recognize proxy-based parent TBAs. Tests only exercise nesting with a direct `AccountV3` implementation; the only proxy test is `testAccountUpgrade` (`contracts/test/Account.t.sol` ~line 650). Effect for us: if an AgentNFT is ever held by another TBA, the parent TBA address itself is the "owner" (single-level control still works through the parent's `execute`), but root-owner shortcuts and root-keyed permissions/overrides would key on the parent TBA, not the human. Open question for the spike.

---

## 2. Upgradeability

### AccountProxy (`contracts/src/AccountProxy.sol`, Verified)

```solidity
function initialize(address implementation) external {
    if (implementation != initialImplementation) {
        if (!IAccountGuardian(guardian).isTrustedImplementation(implementation)) {
            revert InvalidImplementation();
        }
    }
    if (ERC1967Upgrade._getImplementation() != address(0)) revert AlreadyInitialized();
    ERC1967Upgrade._upgradeTo(implementation);
}
function _implementation() internal view override returns (address) {
    return ERC1967Upgrade._getImplementation();
}
```
(lines 22-34)

- `initialize` has **no caller check**. Anyone can initialize any uninitialized TBA, but only to `initialImplementation` (0x41C8..., immutable) or a guardian-trusted implementation. One-shot (`AlreadyInitialized`). (Verified)
- `_implementation()` at this commit does **not** default to `initialImplementation`; it returns the raw ERC-1967 slot. If uninitialized the slot is zero and `Proxy._delegate(address(0))` (OZ `contracts/proxy/Proxy.sol` lines 22-44) delegatecalls an empty account, which succeeds with empty return data. (Verified from code.) The onchain AccountProxy runtime is byte-identical to the Ethereum one built from this source (section 6), so this applies on Monad. (Verified by hash equality; behavior Inferred from source.)
- Inferred consequences of an uninitialized TBA: plain ETH/MON and ERC-20 transfers into it succeed (and are recoverable once anyone initializes it); `safeTransferFrom` of ERC-721 / ERC-1155 into it reverts because `onERC*Received` returns empty data. For our mint flow, create and initialize atomically (the SDK multicall does this) before transferring skill NFTs in.
- A later "defaulting" `_implementation` (falls back to `initialImplementation`) is not present in this source. Open question whether a newer Tokenbound release changed this (irrelevant to Monad because the deployed bytecode equals this source).

### AccountV3Upgradable (`contracts/src/AccountV3Upgradable.sol` lines 15-18, Verified)

```solidity
function _authorizeUpgrade(address implementation) internal virtual override {
    if (!guardian.isTrustedImplementation(implementation)) revert InvalidImplementation();
    if (!_isValidExecutor(_msgSender())) revert NotAuthorized();
}
```

- Entry points: OZ 4.9.3 `UUPSUpgradeable.upgradeTo` / `upgradeToAndCall` (`lib/openzeppelin-contracts/contracts/proxy/utils/UUPSUpgradeable.sol` lines 68, 83) with `onlyProxy`, then `_upgradeToAndCallUUPS` requires the new implementation to return the ERC-1967 slot from `proxiableUUID()` (`ERC1967Upgrade.sol` lines 71-85). (Verified)
- **Who can upgrade**: anyone for whom `_isValidExecutor(_msgSender())` is true (`AccountV3.sol` lines 226-255): the ERC-4337 EntryPoint (so a UserOp signed by any valid signer), the NFT owner, the root owner, any address the root owner granted via `setPermissions`, and, only for accounts whose token lives on another chain, the OP L1 alias of the account and guardian-trusted executors. So **not owner-only**: permissioned callers can upgrade. (Verified)
- **Target must be guardian-trusted**: yes, `isTrustedImplementation` is checked first. The owner cannot pick an arbitrary implementation. (Verified)
- **Can the owner switch implementations?** Only among guardian-trusted ones (via `upgradeTo`) or, at creation, by choosing a different registry `implementation` argument, which yields a **different TBA address** (section 1). For the canonical address, the implementation is whatever is in that TBA's ERC-1967 slot. (Verified)
- **Can DELEGATECALL be used to bypass the allowlist?** No. `LibExecutor._execute` with operation 1 runs the target inside a per-account sandbox contract via CALL, not a real delegatecall in the TBA's storage (`contracts/src/lib/LibExecutor.sol` lines 18-22, `LibSandbox.sandbox` line 15). Overrides also run via the sandbox (`Overridable._handleOverride` lines 60-75). So the ERC-1967 slot cannot be written except through `upgradeTo*` or `initialize`. (Verified from code; Inferred that no other SSTORE path exists after reading all `src/` files in scope.)
- **Does an upgrade survive NFT transfer?** Yes. The implementation pointer lives in the TBA's own storage (ERC-1967 slot `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`), not keyed by owner. A seller can upgrade to any guardian-trusted implementation before a sale and the buyer inherits it, including any storage written by `upgradeToAndCall` data. (Verified mechanism; Inferred impact.)
- **Lock does not block upgrades, and upgrades do not bump `state()`** (Verified): `_authorizeUpgrade` has no `isLocked()` check and does not call `_updateState()`, unlike `_beforeExecute`, `_beforeLock`, `_beforeSetOverrides`, `_beforeSetPermissions` (`AccountV3.sol` lines 268-297). A marketplace or our sale flow that relies on `lock()` + `state()` to freeze the account would not detect an upgrade (Inferred impact).
- **Current Monad exposure**: `isTrustedImplementation` is false for 0x41C8 and 0x5526 on Monad mainnet and testnet, and the guardian owner Safe has nonce 0 on Monad (section 3). So today no `upgradeTo` can succeed on Monad and every initialized canonical TBA must point at 0x41C8 (Inferred from these facts). This can change at any time if the Tokenbound Safe trusts a new implementation on Monad.
- Recommended sale check (Inferred): off-chain, read the TBA's ERC-1967 slot with `eth_getStorageAt(tba, 0x3608...2bbc)` and require `0x41C8f39463A868d3A88af00cd0fe7102F30E44eC`. On-chain, a sale/escrow contract cannot read another contract's storage slot directly, so it would need either (i) a check that the guardian still has no trusted implementations we have not approved, or (ii) a lock-free design where our own contracts never rely on TBA logic staying fixed. To be decided in the spike.
---

## 3. Guardian

Source `contracts/src/AccountGuardian.sol` (Verified): `Ownable2Step`; two public mappings `isTrustedImplementation` and `isTrustedExecutor`; `setTrustedImplementation` and `setTrustedExecutor` are `onlyOwner`; constructor `_transferOwnership(owner)`. `IAccountGuardian` also declares `defaultImplementation()` which `AccountGuardian` does not implement and nobody calls (Verified, harmless mismatch).

Guardian is immutable in both the implementation (`AccountV3.guardian`, line 34) and the proxy (`AccountProxy.guardian`, line 11). There is no way for an account owner to change or opt out of the guardian. (Verified)

### What the guardian can do

1. **Implementation allowlist**: decides which implementations `initialize` (other than the initial one) and `upgradeTo` may target. It cannot force an upgrade; an authorized account executor still has to call `upgradeTo`. (Verified)
2. **Trusted executors** (`AccountV3._isValidExecutor` lines 232-241):

```solidity
// Allow cross chain execution
if (chainId != block.chainid) {
    // Allow execution from L1 account on OPStack chains
    if (OPAddressAliasHelper.undoL1ToL2Alias(_msgSender()) == address(this)) {
        return true;
    }
    // Allow execution from trusted cross chain bridges
    if (guardian.isTrustedExecutor(executor)) return true;
}
```

- A trusted executor passes `_isValidExecutor` for **every account using this implementation whose bound token's `chainId` differs from the current chain**. That grants `execute` (any CALL, sandboxed DELEGATECALL, CREATE, CREATE2), `executeBatch`, `executeNested`, and `upgradeTo` (to trusted implementations), with full value. The executor contract itself is what restricts what it relays; the account does not check the origin message. (Verified; `contracts/test/AccountCrossChain.t.sol` `testCrossChainCalls` lines 91-95 shows a trusted executor EOA draining 0.1 ether from a foreign-chain account.)
- It gives **no power over accounts whose token is on the current chain** (same test, lines 103-112: trusted executor reverts `NotAuthorized` on the native account). Our AgentNFT lives on Monad and we will create TBAs with `chainId = 143`, so on Monad trusted executors have no power over our TBAs. (Verified from code + test.)
- Where it matters for us (Inferred): the same TBA address exists (counterfactually or deployed) on every chain with the canonical registry. On any other chain (Ethereum, Base, etc.), a TBA with `chainId = 143` is a foreign account, so the Tokenbound Safe's trusted executors (and the OP alias path on OP-stack chains) control whatever sits at that address there. Funds accidentally sent to our TBA address on another chain are under Tokenbound's executor trust, not the NFT holder's. Also a foreign-chain account has `owner() == address(0)` (`_tokenOwner` line 350), so the real NFT holder cannot act on it directly.

### Guardian onchain (Monad)

Guardian address derivation (Verified): searched the runtime bytecode of AccountProxy and AccountV3Upgradable for PUSH32 immutables (`0x7f` + 12 zero bytes + 20-byte address). Both contain `0x2FE5ccb0d7Ea195FEb87987d3573F9fcCE2b5D57`. CREATE2 recomputation from the Ethereum init code also gives this address (section 6). EIP-55 checksum computed in Python.

Commands (pattern; `pad` = 12 zero bytes + address):

```
G=0x2FE5ccb0d7Ea195FEb87987d3573F9fcCE2b5D57; SAFE=0x781b6A527482828bB04F33563797d4b696ddF328
curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"'$G'","data":"0x8da5cb5b"},"latest"]}' $RPC   # owner()
... data 0xe30c3978                    # pendingOwner()
... data 0x1506fd4d<pad(addr)>         # isTrustedImplementation(addr)
... data 0x672657ca<pad(addr)>         # isTrustedExecutor(addr)
... to SAFE data 0xe75235b8 / 0xa0e67e2b / 0xaffed0e0 / 0xffa1ad74 / 0xcc2f8452(0x1,10)   # getThreshold, getOwners, nonce, VERSION, getModulesPaginated
eth_getStorageAt(SAFE, 0x0)            # Safe singleton
```

Results (Verified):

| Check | Monad mainnet (143) | Monad testnet (10143) | Ethereum (1) |
|---|---|---|---|
| guardian code | 1211 bytes | 1211 bytes | 1211 bytes |
| guardian `owner()` | 0x781b...F328 | 0x781b...F328 | 0x781b...F328 |
| guardian `pendingOwner()` | 0 | 0 | 0 |
| `isTrustedImplementation(0x41C8...)` | false | false | false |
| `isTrustedImplementation(0x5526...)` | false | false | false |
| `isTrustedExecutor(EntryPoint v0.6)` | false | false | false |
| `isTrustedExecutor(0x0F22...F22C)` (SDK `LZ_MAINNET_EXECUTOR`) | false (no code there) | false | **true** (5650 bytes code) |
| `isTrustedExecutor(0xEF7B...3f1f)` (SDK `LZ_TESTNET_EXECUTOR`) | false | false | false |
| Safe 0x781b... code | 171 bytes (Safe proxy) | **0 bytes, not deployed** | 171 bytes |
| Safe `VERSION()` | "1.3.0" | n/a | "1.3.0" |
| Safe singleton (slot 0) | 0x3e5c63644e683549055b9be8653de26e0b4cd36e | n/a | same |
| Safe threshold / owners | 3 of 4: 0xa75b7833..., 0x11620498..., 0x41146fca..., 0x7a551d29... | n/a | identical 3 of 4 |
| Safe `nonce()` | **0** | n/a | 1 |
| Safe modules | none (sentinel only) | n/a | none |

Interpretation:
- Monad mainnet: guardian is owned by the Tokenbound 3-of-4 Safe (same signers as Ethereum). Safe nonce 0 and no modules means the Safe has never executed a transaction on Monad, so no `setTrustedImplementation`, `setTrustedExecutor`, or ownership transfer has ever happened there; all guardian mappings are at their default false. (Inferred with high confidence; residual caveat: a Safe `setup` delegatecall at deployment could in theory have made calls, which is very unlikely.)
- Monad testnet: the guardian owner address has no code. Nobody can currently call `onlyOwner`, so testnet guardian config is frozen at defaults unless that Safe is later deployed at the same address (only possible by replaying the same Safe factory deployment, which reproduces the same owners). (Inferred)
- Ethereum: Blockscout log history shows exactly three guardian events: OwnershipTransferred(0 -> factory 0x4e59...), OwnershipTransferred(factory -> Safe) at block 18382216, and TrustedExecutorUpdated(0x0F220412..., true) at block 19434674 (0x1288cb2, 2024-03-14). This executor is the SDK's LayerZero executor (`packages/sdk/src/constants/crossChain.ts` line 2). (Verified via `curl "https://eth.blockscout.com/api?module=logs&action=getLogs&address=0x2FE5...&fromBlock=0&toBlock=latest"`.)
- Monad event history via RPC was not possible: `eth_getLogs` on rpc.monad.xyz is "limited to a 100 range"; `monad.blockscout.com` 404s and Routescan returns "chain not supported". The Safe-nonce argument above replaces the event scan.

---

## 4. ERC-4337

Source `contracts/src/abstract/ERC4337Account.sol` and `lib/account-abstraction` (v0.6.0) `contracts/core/BaseAccount.sol` (Verified).

- **EntryPoint version**: v0.6 (`UserOperation` struct import, `BaseAccount.validateUserOp(UserOperation, bytes32, uint256)`). Address is an immutable `_entryPoint` set in the constructor (ERC4337Account lines 20-25), deployed value `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` (found 4 times in the implementation runtime bytecode). It cannot be changed without an upgrade. (Verified)
- **validateUserOp**: `_requireFromEntryPoint`, `_validateSignature`, `_validateNonce` (empty), `_payPrefund` (BaseAccount). (Verified)
- **Signature scheme**: `_getUserOpSignatureHash` returns `userOpHash.toEthSignedMessageHash()` (EIP-191 personal_sign over the userOpHash, ERC4337Account lines 54-61). Then `AccountV3._isValidSignature` (lines 185-217): if `v == 0` it is a contract signature with signer address in `r` and offset in `s`, verified via ERC-1271 and allowed if the signer is a valid signer or the account itself; else ECDSA recover. Valid signers (`_isValidSigner`, lines 159-178): the NFT owner, the root owner, or anyone the root owner has granted via `setPermissions`. So **UserOps can be signed by the owner, root owner, or a permissioned address** (including a smart wallet via ERC-1271). Returns 1 (SIG_VALIDATION_FAILED) on failure; no validUntil/validAfter packing. (Verified)
- **Execution**: the EntryPoint is an unconditional valid executor (`_isValidExecutor` line 228), so the UserOp callData calls `execute`/`executeBatch`/`upgradeTo` on the account. (Verified)
- **Nonce**: no custom logic; EntryPoint v0.6 2D nonces (`getNonce` key 0 helper in BaseAccount). (Verified)
- **Paymasters**: nothing account-specific; standard v0.6 paymasters work and `_payPrefund` pays from the account balance when there is no paymaster. (Verified from code; paymaster behavior Inferred.)
- **Ownership check at validation time**: signer validity is evaluated when `validateUserOp` runs, via live `ownerOf`. A UserOp signed by the seller that lands after the NFT transfer fails; one that lands before it succeeds. Root-owner-keyed permissions stop applying after transfer. (Inferred from code.)
- **Bundler compatibility risk** (Inferred, open question): validation reads `tokenContract.ownerOf(tokenId)` and `permissions[rootOwner][signer]`. Under ERC-7562 storage rules, reading another contract's storage slot not associated with the sender is normally forbidden for unstaked accounts; the NFT's `_owners[tokenId]` slot is not associated with the TBA address. Many strict bundlers may reject TBA UserOps unless the account/factory is staked or the bundler is permissive.
- **Monad**: EntryPoint v0.6 has code at 0x5FF137D4... (23689 bytes, keccak equal to Ethereum). EntryPoint v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032` (16035 bytes) and v0.8 `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` (21738 bytes) also have code on Monad mainnet and testnet (Verified by `eth_getCode`). The TBA only trusts v0.6. If Privy's smart-wallet / paymaster stack on Monad is v0.7 or v0.8 only, it cannot drive the TBA directly as a 4337 sender; the practical pattern would be a Privy smart wallet (or EOA) that is the NFT owner or a permissioned address calling `execute` on the TBA (Inferred; open question on Privy's supported EntryPoints on Monad).

---

## 5. Cross-chain

- `AccountV3._tokenOwner` returns `address(0)` if `chainId != block.chainid` or the token contract has no code (lines 344-358), so `owner()` is zero on foreign chains and the NFT holder has no direct control there. (Verified)
- `_isValidExecutor` foreign branch (lines 233-241): OP-stack path allows `msg.sender` whose un-aliased address equals the account itself (i.e., the same TBA address on L1 sending through the OP portal; note it uses `_msgSender()` not `executor`), and guardian trusted executors. (Verified; `AccountCrossChain.t.sol` `testCrossChainCallsOPStack` lines 115-161.)
- `contracts/src/cross-chain/FxChildExecutor.sol`: `processMessageFromRoot` requires `msg.sender == fxChild`, then `rootMessageSender.call(data)`. It calls the address that sent the L1 message, which for a TBA is the same address as the L2 counterpart. Correctness relies on the executor only ever calling `rootMessageSender`. (Verified)
- `contracts/src/lib/OPAddressAliasHelper.sol`: standard OP offset `0x1111000000000000000000000000000000001111`. (Verified)
- On Monad, no trusted executor is set (section 3), and our TBAs are native (chainId 143), so the cross-chain branch is inert for our accounts on Monad (Inferred from code + onchain state). The residual risk is our TBA address on other chains (section 3).

---

## 6. Deterministic deployment and verification of the Monad deployment

Scripts (Verified): `contracts/script/DeployAccountV3.s.sol` (salt `0x6551...6551` x8, factory `0x4e59b44847b379578588920cA78FbF26c0B4956C`, order Guardian -> AccountV3Upgradable -> AccountProxy, constructor args as in the orientation doc). Registry: `erc6551-reference/script/DeployRegistry.s.sol` (also `contracts/lib/erc6551/script/`), `new ERC6551Registry{salt: 0x...fd8eb4e1dca713016c518e31}()`; `vm.startBroadcast` + `new X{salt}` goes through the 0x4e59 CREATE2 deployer.

### (a) Runtime bytecode comparison, Monad vs Ethereum (done, Verified, keccak-256)

Command (repeated per address and RPC):
```
curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["<addr>","latest"]}' <rpc>
RPCs: https://rpc.monad.xyz, https://testnet-rpc.monad.xyz, https://eth.drpc.org
(eth.llamarpc.com and publicnode returned empty; rpc.ankr.com needs a key; cloudflare-eth.com works for eth_chainId but failed on eth_getLogs)
```

| Address | Role | Size | keccak256(runtime) | Mon main | Mon test | Eth |
|---|---|---|---|---|---|---|
| 0x000000006551c19487814612e58FE06813775758 | Registry | 571 | 0xda1d5b06...ecd6735 | = | = | = |
| 0x55266d75D1a14E4572138116aF39863Ed6596E7F | AccountProxy | 902 | 0x7f2b4bea...8afdb0 | = | = | = |
| 0x41C8f39463A868d3A88af00cd0fe7102F30E44eC | AccountV3Upgradable | 14924 | 0xdf5eeb80...09f0f85b | = | = | = |
| 0xcA1167915584462449EE5b4Ea51c37fE81eCDCCD | Multicall3 authenticated | 4126 | 0xb074cd81...c8895c | = | = | = |
| 0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789 | EntryPoint v0.6 | 23689 | 0xc93c806e...91c8e70 | = | = | = |
| 0x4e59b44847b379578588920cA78FbF26c0B4956C | CREATE2 factory | 69 | 0x2fa86add...f7e4989 | = | = | = |
| 0x2FE5ccb0d7Ea195FEb87987d3573F9fcCE2b5D57 | AccountGuardian | 1211 | 0x852cc932...d88093f2 | = | = | = |

Full hashes: registry `0xda1d5b06e579f9e42e59b00fbc22939896ecb38dc8830d40de0a2508fecd6735`, proxy `0x7f2b4bea519ba5fe0e8e3cf054654f18480c4416fc71370b31f37848688afdb0`, implementation `0xdf5eeb80b53e48dfd667fff5264976de4004fdd27eef4f6b954d182109f0f85b`, forwarder `0xb074cd81f36845a40a1136f7d599dadb52c3e7486eab525722d38e6696c8895c`, EntryPoint `0xc93c806e738300b5357ecdc2e971d6438d34d8e4e17b99b758b1f9cac91c8e70`, factory `0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989`, guardian `0x852cc93231fd7a7d35a225fb5f357e69db966935de05627095f906f7d88093f2`.

### (b) CREATE2 recomputation (partly done without forge)

Ethereum creation data came from `curl "https://eth.blockscout.com/api?module=contract&action=getcontractcreation&contractaddresses=<5 addrs>"` (creator EOA `0x7da00f9b7997da14793b73712e037fd9484b3e15`, factory `0x4e59...` for all five). I recomputed `keccak(0xff ++ factory ++ salt ++ keccak(initcode))[12:]` in Python (Verified):

| Contract | Eth block | Salt | Init code keccak | CREATE2 result | Constructor args at tail of init code |
|---|---|---|---|---|---|
| AccountGuardian | 18382216 | 0x6551..6551 | 0x3aa68c80...355640 | match 0x2fe5...5d57 | `781b6a52...f328` (tokenboundSafe) |
| AccountV3Upgradable | 18429164 | 0x6551..6551 | 0x746d3f5e...04de81 | match 0x41c8...44ec | EntryPoint 0x5ff1..., forwarder 0xca11679..., registry 0x0000..5758, guardian 0x2fe5... |
| AccountProxy | 18429165 | 0x6551..6551 | 0x428cee7f...485623 | match 0x5526...6e7f | guardian 0x2fe5..., impl 0x41c8... |
| ERC6551Registry | 18429101 | 0x...fd8eb4e1dca713016c518e31 | 0xfeeadc20...cc540d | match 0x0000...5758 | none |
| Multicall forwarder | 18382200 | 0xb55ea26c...f1acb77a (from tx input) | 0x1132bd1c...a6cb17 | match 0xca11...dccd | none |

Why this covers Monad (Inferred, strong): the CREATE2 address commits to (factory, salt, keccak(init code)). The factory runtime is identical on Monad, and the Monad contracts sit at the same addresses with identical runtime hashes, so they were created from the same init code, including the same constructor arguments (barring a keccak collision). Caveat: this assumes Monad deployment also went through 0x4e59 rather than a CREATE from an EOA with a coincidentally matching nonce, which is not plausible for these vanity/CREATE2 addresses.

Remaining spike step (needs Foundry): check out `contracts` at tag `v0.3.1` (HEAD differs by `virtual` keywords and import paths, which changes the metadata hash), build with solc 0.8.17, optimizer 200, then assert `keccak(type(X).creationCode ++ abi.encode(args)) == ` the init code hashes above for Guardian, AccountV3Upgradable, AccountProxy; do the same for `erc6551-reference` registry at the commit Tokenbound deployed from. Alternatively compare against Etherscan-verified source for the Ethereum addresses. Metadata in the init code shows solc 0.8.17 (`...736f6c63430008110033`) for Guardian, Proxy, Registry, Implementation.

### (c) Immutables in runtime bytecode (Verified)

Searched for each 20-byte address in the hex runtime (Monad mainnet):

| Address | In AccountV3Upgradable runtime | In AccountProxy runtime |
|---|---|---|
| guardian 0x2fe5... | yes (PUSH32 immutable) | yes |
| EntryPoint 0x5ff1... | 4 occurrences | 0 |
| multicall forwarder 0xca1167... | 1 | 0 |
| registry 0x0000...5758 | 3 | 0 |
| implementation self 0x41c8... | 7 (`__self` of NestedAccountExecutor and OZ UUPSUpgradeable) | 1 (`initialImplementation`) |
| tokenboundSafe 0x781b... | 0 (only lives in guardian storage) | 0 |

### Multicall forwarder (`contracts/lib/multicall-authenticated/src/Multicall3.sol`, Verified)

A fork of Multicall3 where every sub-call is `target.call(abi.encodePacked(callData, msg.sender))` (lines 49, 73, 121, 162). `TokenboundExecutor` inherits OZ `ERC2771Context(multicallForwarder)` (`contracts/src/abstract/execution/TokenboundExecutor.sol` lines 158-183); `ERC2771Context._msgSender` returns the last 20 bytes of calldata when `msg.sender` is the trusted forwarder (OZ `metatx/ERC2771Context.sol` lines 24-34). Why it matters: batching through the forwarder preserves the real caller identity for `_isValidExecutor`, so the SDK can do create + initialize + execute in one transaction, and since the forwarder always appends its own `msg.sender`, nobody can spoof another caller through it (Inferred). Every account authorization decision uses `_msgSender()`, so the forwarder address is a hard-coded trust root in the implementation. Note: the repo README advertises `0xca11de82...` as the deploy address, but Tokenbound uses `0xcA1167915584...` (different salt, recovered above); `0xca11de82...` has no code on Monad. Code equality with Ethereum is Verified; that its init code equals this repo's `Multicall3.sol` at 653b2bc (solc 0.8.12) is not yet verified (spike step).

---

## Trust assumptions table

| # | Trusted party / component | Power | Scope for our Monad-native TBAs | Evidence |
|---|---|---|---|---|
| T1 | Tokenbound Safe 0x781b... (3 of 4) as guardian owner | Add/remove trusted implementations and trusted executors; transfer guardian ownership | Implementations: can enable new upgrade targets that any account executor (owner, permissioned address, 4337 UserOp) may then opt into. Executors: no power over chainId=143 accounts on Monad | `AccountGuardian.sol`; onchain `owner()`; Safe nonce 0 on Monad |
| T2 | Guardian-trusted executors | Full `execute`/`upgradeTo` on any account whose token is on another chain | None on Monad today (no executor trusted). On Ethereum the LZ executor 0x0F22... is trusted, so our TBA addresses on Ethereum (chainId 143 foreign accounts) are controlled by it | `AccountV3._isValidExecutor` 232-241; `AccountCrossChain.t.sol` |
| T3 | Any guardian-trusted implementation | Becomes the account logic after an authorized upgrade; persists across NFT transfer | None trusted on Monad today | `AccountV3Upgradable._authorizeUpgrade`; onchain `isTrustedImplementation` |
| T4 | EntryPoint v0.6 0x5FF137D4... | Unconditional valid executor | All TBAs; gated by UserOp signature from owner/root/permissioned | `AccountV3` line 228; `ERC4337Account` |
| T5 | Multicall forwarder 0xcA1167... | Its appended 20 bytes are taken as `_msgSender()` | All TBAs | `TokenboundExecutor`, OZ `ERC2771Context` |
| T6 | Registry 0x0000...5758 | Address derivation; used in nested-account checks | All TBAs | `ERC6551Registry.sol`, `NestedAccountExecutor` |
| T7 | The NFT contract (our AgentNFT) | `ownerOf` defines control | All TBAs | `AccountV3._tokenOwner` |
| T8 | Permissioned addresses granted by the root owner | Execute and **upgrade** and sign (ERC-1271, UserOps) | All TBAs, reset when root owner changes | `_isValidExecutor`, `_isValidSigner`, `Permissioned.permissions[owner][caller]` |
| T9 | AccountProxy `initialize` (no caller check) | First caller picks implementation among initial or trusted | Uninitialized TBAs; harmless today since only 0x41C8 is allowed | `AccountProxy.initialize` |

## Open questions

1. Monad guardian event history: RPC `eth_getLogs` is capped at 100 blocks and no working Monad explorer API was found. The Safe nonce 0 argument covers it, but a direct event scan (via an indexer, Dune, or an explorer with a Monad API key) would confirm it. Also set up monitoring for `TrustedImplementationUpdated` / `TrustedExecutorUpdated` on 0x2FE5... on Monad.
2. Tokenbound's policy for trusting future implementations on Monad (and whether they would trust implementations that change owner semantics). Need a statement from Tokenbound, or we must enforce an implementation-slot check in our sale flow.
3. Is the lock-bypass of `upgradeTo` (no `isLocked` check, no `state` bump) acknowledged in the Zellic audit (`contracts/audits/Tokenbound - Zellic Audit Report.pdf`)? Not read here.
4. Nested ownership with proxy-based clones (`__self` = implementation, clone points to proxy): confirm with a fork test that `_rootTokenOwner` and `executeNested` do not work for AccountProxy-based TBAs.
5. Bundler acceptance of v0.6 UserOps from TBAs (ERC-7562 storage access for `ownerOf`), and which EntryPoint versions Privy's smart wallets and paymaster support on Monad (v0.6 vs v0.7/v0.8, all three are deployed on Monad).
6. Compile-and-match spike: build `contracts@v0.3.1` and the registry with solc 0.8.17 / 200 runs and assert init code hashes equal those in section 6(b); same for multicall-authenticated at 653b2bc.
7. Monad testnet: guardian owner Safe is not deployed. Confirm Tokenbound does not intend to deploy it there, or that it would be deployed with the same signers.
8. Whether a later Tokenbound AccountProxy version defaults `_implementation()` to `initialImplementation` (not in this source, not deployed on Monad).
