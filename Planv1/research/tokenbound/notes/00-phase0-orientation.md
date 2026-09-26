# Phase 0: Orientation (Tokenbound research)

Written by the lead researcher. Every sub-agent must read this whole file first.

## Repositories and versions

| Repo | Local path | Commit | Nearest tag | Last commit date | License |
|---|---|---|---|---|---|
| tokenbound/sdk | `/home/dhrupatel/agent_tool/tokenbound` (monorepo; package in `packages/sdk`) | `6244f1e3a1027e1e411574df166fa5d3302eff64` | package `@tokenbound/sdk` 0.5.5 | 2024-10-22 | No LICENSE file in repo. Root `package.json` says `"license": "ISC"` (Verified). |
| tokenbound/contracts | `$SRC/contracts` | `bce75f985558fad3d06ee1b86f224f0cfb783631` | `v0.3.1-15-gbce75f9` (15 commits after v0.3.1, tagged 2023-10-25) | 2024-03-11 | SPDX MIT headers; no LICENSE file at root |
| erc6551/reference | `$SRC/erc6551-reference` | `da16a63fb53db6375175a9dca22f1e19e652a193` | `v0.3.0-17-gda16a63` | 2023-10-24 | SPDX MIT headers |
| erc6551 as submodule of contracts | `$SRC/contracts/lib/erc6551` | `882159c9dea648f0eb3947895fb6f87f7b24f669` (v0.3.0~1) | | 2023-10-18 | MIT |

`$SRC` = `/tmp/claude-1000/-home-dhrupatel-agent-tool-tokenbound/404d6eb5-45d4-440d-b858-7d92c55c4f32/scratchpad/src`

Important: only the SDK was cloned by the user. The lead researcher cloned `tokenbound/contracts` (with submodules) and `erc6551/reference` read-only into the scratchpad above. In reports, cite contract files as `contracts/src/...` and `erc6551-reference/src/...` with the commit hash, not the /tmp path.

Contracts submodules: account-abstraction v0.6.0 (EntryPoint v0.6), openzeppelin-contracts v4.9.3, multicall-authenticated (main @653b2bc), forge-std.

### Source diff between v0.3.1 tag and HEAD (Verified via `git diff v0.3.1 HEAD -- src`)
Only: `virtual` keyword added to `owner()`, `_isValidSignature`, `_beforeExecute`, `_beforeLock`, `_beforeSetOverrides`, `_beforeSetPermissions` in `AccountV3.sol`; import path changes in `ERC4337Account.sol` and `LibSandbox.sol`; new `src/package.json`. `virtual` does not change bytecode behavior, so HEAD logic equals v0.3.1 (Inferred; bytecode could still differ due to import paths/metadata hash).

## Contract inventory (`contracts/src`, 1355 lines total)

- `AccountV3.sol` (359 lines): main account. Inherits ERC721Holder, ERC1155Holder, Lockable, Overridable, Permissioned, ERC6551Account, ERC4337Account, TokenboundExecutor. Immutable `guardian`. Constructor(entryPoint, multicallForwarder, erc6551Registry, guardian).
- `AccountV3Upgradable.sol`: AccountV3 + UUPS; `_authorizeUpgrade` (line 15).
- `AccountProxy.sol`: ERC-1967 proxy, `initialize(address implementation)`, constructor(guardian, defaultImplementation).
- `AccountGuardian.sol`: Ownable; `setTrustedImplementation`, `setTrustedExecutor` (onlyOwner).
- `abstract/ERC6551Account.sol`: `isValidSigner`, `token()`, `state()`, supportsInterface.
- `abstract/ERC4337Account.sol`: entryPoint, `_validateSignature`, `_getUserOpSignatureHash`.
- `abstract/Lockable.sol`: `lock(uint256)`, `isLocked()`.
- `abstract/Overridable.sol`: `setOverrides(bytes4[], address[])`, `_handleOverride`, `_handleOverrideStatic`. Comment says overrides keyed by root owner address.
- `abstract/Permissioned.sol`: `setPermissions(address[], bool[])`, `hasPermission(caller, owner)`.
- `abstract/Signatory.sol`: ERC-1271 `isValidSignature`.
- `abstract/execution/`: BaseExecutor, ERC6551Executor (`execute(to,value,data,operation)`), BatchExecutor (`executeBatch`), NestedAccountExecutor (`executeNested`), SandboxExecutor (`extcall`, `extcreate`, `extcreate2`, `extsload`), TokenboundExecutor (combines, ERC-2771 style `_msgSender` via multicall forwarder).
- `cross-chain/FxChildExecutor.sol`, `lib/OPAddressAliasHelper.sol`: cross-chain executors (Polygon Fx, OP alias).
- `lib/LibExecutor.sol`, `lib/LibSandbox.sol`, `utils/Errors.sol`, `interfaces/`.
- Tests: `test/Account*.t.sol` (core, CrossChain, ERC1155, ERC20, ERC4337, ERC721, ETH, Overrides, Permissions), mocks.
- Audit: `contracts/audits/Tokenbound - Zellic Audit Report.pdf`; `erc6551-reference/audits/certik-07-03.pdf`.

Registry: `erc6551-reference/src/ERC6551Registry.sol` (assembly, CREATE2 of an ERC-1167 proxy with appended immutable data salt, chainId, tokenContract, tokenId). Deployed by `script/DeployRegistry.s.sol` via the deterministic factory `0x4e59b44847b379578588920cA78FbF26c0B4956C` with salt `0x...fd8eb4e1dca713016c518e31`.

## Deployment (`contracts/script/DeployAccountV3.s.sol`, Verified)
Salt `0x6551...6551`, factory `0x4e59b448...956C`. Constructor inputs: tokenboundSafe `0x781b6A527482828bB04F33563797d4b696ddF328` (guardian owner), EntryPoint `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` (v0.6), multicallForwarder `0xcA1167915584462449EE5b4Ea51c37fE81eCDCCD`, registry `0x000000006551c19487814612e58FE06813775758`. Order: AccountGuardian(tokenboundSafe) -> AccountV3Upgradable(entryPoint, forwarder, registry, guardian) -> AccountProxy(guardian, implementation).

SDK canonical addresses (`packages/sdk/src/constants/tokenboundAddresses.ts`, `ERC_6551_DEFAULT`): ACCOUNT_PROXY `0x55266d75D1a14E4572138116aF39863Ed6596E7F`, IMPLEMENTATION `0x41C8f39463A868d3A88af00cd0fe7102F30E44eC`, REGISTRY `0x000000006551c19487814612e58FE06813775758`. Legacy V2 implementation `0x2d25602551487c3f3354dd80d76d54383a243358`, registry `0x02101dfB77FDE026414827Fdc604ddAF224F0921`.

### Onchain check (read-only `eth_getCode` via curl, 2026-09-25, Verified)
Monad mainnet (`https://rpc.monad.xyz`, chainId 0x8f = 143) and testnet (`https://testnet-rpc.monad.xyz`, 0x279f = 10143) both have code at:

| Address | Role | Code size (bytes), both chains |
|---|---|---|
| 0x000000006551c19487814612e58FE06813775758 | ERC6551Registry | 571 |
| 0x55266d75D1a14E4572138116aF39863Ed6596E7F | AccountProxy | 902 |
| 0x41C8f39463A868d3A88af00cd0fe7102F30E44eC | AccountV3Upgradable | 14924 |
| 0xcA1167915584462449EE5b4Ea51c37fE81eCDCCD | Multicall forwarder | 4126 |
| 0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789 | EntryPoint v0.6 | 23689 |

Code hashes are identical across Monad mainnet and testnet. Not yet compared with Ethereum mainnet (publicnode RPC failed); guardian address not yet derived. Foundry (`cast`, `forge`, `anvil`) is NOT installed; use `curl` JSON-RPC and `python3` for read-only checks. Monad SDK support: `grep -i monad` in SDK src returned nothing (Verified); SDK chain resolution is in `src/utils/chainIdToChain.ts`.

## SDK inventory (`packages/sdk`)
- `src/TokenboundClient.ts`: main public class.
- `src/functions/viemV2.ts`, `viemV3.ts`, `crossChain.ts`: address computation, prepare calls.
- `src/constants/`: addresses, interfaces, multicall, crossChain (LayerZero), eip1167Implementation.
- `src/utils/`: chainIdToChain, segmentBytecode, resolvePossibleENS, normalizeEthersMessage, etc.
- `abis/`: V2 ABIs, ERC20/721/1155, MultiCallAuthenticated. V3 ABIs come from `src/test/wagmi-cli-hooks/generated.ts`.
- Deps: viem ^2.21.32, @layerzerolabs/lz-v2-utilities. ethers v5 and v6 supported via adapters (devDeps). Examples in `examples/`.
- CHANGELOG: 0.5.0 integrated V3; 0.5.4 moved to viem 2.
