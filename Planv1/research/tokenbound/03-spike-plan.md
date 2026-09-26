# Report 3: Spike plan and open questions

Research date: 2026-09-25. Target: canonical Tokenbound v3 as deployed on Monad mainnet (chain 143). Source references: tokenbound/contracts `bce75f9` (v0.3.1 plus 15 commits, MIT), erc6551/reference `da16a63` (MIT), tokenbound/sdk `6244f1e` (0.5.5, ISC per package.json). Nothing below has been run yet; Foundry is not installed on the research machine.

Each step has commands or a test outline and a success condition. Several steps are there to confirm or refute **Inferred** findings from Reports 1 and 2; these are marked "Confirms".

---

## 0. Setup

Work in a new folder outside the cloned repos. Do not modify `tokenbound/`.

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
mkdir -p ~/agent_tool/spikes/tokenbound-fork && cd ~/agent_tool/spikes/tokenbound-fork
forge init --no-git .
forge install --no-git foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts@v4.9.3 \
  tokenbound/contracts erc6551/reference
# Pin a block so runs are reproducible
export MONAD_RPC=https://rpc.monad.xyz
export FORK_BLOCK=$(cast block-number --rpc-url $MONAD_RPC)
anvil --fork-url $MONAD_RPC --fork-block-number $FORK_BLOCK --chain-id 143 --port 8545
# In a second shell:
forge test --fork-url http://127.0.0.1:8545 -vvv
```

Constants used by every test:

```solidity
address constant REGISTRY = 0x000000006551c19487814612e58FE06813775758;
address constant PROXY    = 0x55266d75D1a14E4572138116aF39863Ed6596E7F; // "implementation" passed to registry
address constant IMPL     = 0x41C8f39463A868d3A88af00cd0fe7102F30E44eC;
address constant GUARDIAN = 0x2FE5ccb0d7Ea195FEb87987d3573F9fcCE2b5D57;
address constant USDC     = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603; // confirm with Circle (open question 1)
address constant PERMIT2  = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
bytes32 constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
```

The test fixture deploys a `MockAgentNFT` (OZ ERC721) and a `MockSkill1155` (OZ ERC1155) on the fork. `createTBA(id)` calls `IERC6551Registry(REGISTRY).createAccount(PROXY, 0, 143, nft, id)` and then `AccountProxy(tba).initialize(IMPL)` in the same test transaction.

**Pass if:** `anvil` forks chain 143 and `cast code $REGISTRY --rpc-url http://127.0.0.1:8545` returns code.

---

## 1. Mint, create the TBA, and match the SDK address

- **Test:** mint `nft#1` to `alice`, then `createTBA(1)`. Assert:
  - `tba == registry.account(PROXY, 0, 143, nft, 1)`
  - `tba.code.length == 0xAD`
  - `vm.load(tba, IMPL_SLOT) == IMPL`
  - `AccountV3(tba).owner() == alice`
  - `AccountV3(tba).token()` returns `(143, nft, 1)`
- **SDK parity:** in a scratch Node project (not the SDK repo), run `npm i @tokenbound/sdk viem@latest`. Then call `new TokenboundClient({ chain: monad, walletClient }).getAccount({ tokenContract: nft, tokenId: "1" })` and compare with the Foundry result.
- **Also:** call SDK `createAccount` a second time for the same token.

**Pass if:**
- The addresses are identical.
- The implementation slot is 0x41C8.
- The second SDK `createAccount` reverts with `AlreadyInitialized`. Confirms the Inferred claim that SDK creation is not idempotent.

## 2. Transfer an ERC-1155 skill in and read it back

- **Test:** mint skill id 7 to `alice`, then `alice` calls `safeTransferFrom(alice, tba, 7, 1, "")`. Assert `balanceOf(tba, 7) == 1`. Record `state()` before and after.
- **Variant:** create a TBA through the registry without `initialize`, then try the same transfer.

**Pass if:**
- The balance is 1 and `state()` is unchanged.
- The transfer into the uninitialized TBA reverts. Confirms the need to create and initialize atomically.

## 3. Owner executes; non-owner is rejected

- **Test:** `vm.prank(alice); AccountV3(tba).execute(address(skill), 0, abi.encodeCall(IERC1155.safeTransferFrom, (tba, alice, 7, 1, "")), 0)`.
- Then `vm.prank(bob)` does the same call and expects the revert `NotAuthorized()`.
- Also test `executeBatch` with two ops from `alice`, and op 1 (delegatecall) targeting a contract that tries `sstore` on slot 0. Afterwards assert `vm.load(tba, 0)` is unchanged and the sandbox's slot 0 changed.

**Pass if:**
- The owner succeeds and the non-owner reverts.
- The delegatecall writes only to sandbox storage. Confirms S15.

## 4. Grant a non-owner permission and map what it can do

- **Test:** `vm.prank(alice); AccountV3(tba).setPermissions([exec], [true])`. As `exec`:

| Action | Expected |
|---|---|
| `execute` arbitrary CALL, including moving the skill out | succeeds |
| `execute` op 2 CREATE | succeeds |
| `setPermissions`, `setOverrides`, `lock` | revert `NotAuthorized` |
| `upgradeTo(anyAddress)` | reverts `InvalidImplementation` (nothing trusted on Monad) |
| `isValidSigner(exec, "")` | returns magic `0x523e3260` |
| `isValidSignature(h, sigByExecKey)` where `exec` is an EOA | returns `0x1626ba7e` |

- **Also:** deploy a `ScopedExecutor` contract that only exposes `transferSkill(to)`, and permission it instead. Confirm that the only reachable action is the one its code exposes.

**Pass if:** the results match the table. That confirms S4 (all-or-nothing) and that restriction lives only in the permissioned contract's code.

## 5. Transfer the NFT; check old access, permissions, and revival

- **Test:**
  1. After step 4, `alice` transfers `nft#1` to `bob`.
  2. Assert `owner() == bob`. `alice` calling `execute` reverts. `exec` calling `execute` reverts. `permissions(alice, exec) == true` is still stored.
  3. `bob` transfers `nft#1` back to `alice`. Assert `exec` can execute again.
- **Our epoch:** repeat with a `MockAgentNFT` whose `_update` bumps `ownerEpoch`, and a `MockExecutor` that stores the epoch at session registration. After the round trip, the executor rejects the old session.

**Pass if:**
- Access switches in the same block.
- Old grants come back on return. Confirms S5.
- Our epoch model blocks the revival.

## 6. Lock during a simulated sale

- **Test A (baseline):**
  1. `alice` calls `lock(block.timestamp + 1 days)`.
  2. `execute`, `setPermissions` and `setOverrides` revert `AccountLocked`.
  3. `lock` again reverts.
  4. `vm.warp` past expiry, and everything works again.
  5. `lock(block.timestamp + 366 days)` reverts `ExceedsMaxLockTime`.
- **Test B (override bypass):**
  1. Before locking, `alice` calls `setOverrides([bytes4(0xdeadbeef)], [drainImpl])`. `drainImpl.fallback` calls `ISandboxExecutor(msg.sender).extcall(skill, 0, safeTransferFrom(tba, alice, 7, 1, ""))`.
  2. `alice` locks, then snapshots `state()`.
  3. Anyone calls `tba.call(abi.encodePacked(bytes4(0xdeadbeef)))`.
  4. Assert the skill moved, `state()` is unchanged, and `isLocked()` is still true.
- **Test C (lock persists):** transfer the NFT to `bob` while locked. Assert `bob` calling `execute` reverts `AccountLocked`.
- **Test D (escrow custody):**
  1. Repeat B, but before calling the override, move `nft#1` into a `MockEscrow` (owner = escrow).
  2. Calling `0xdeadbeef` returns empty success and moves nothing, because the override is keyed to `alice`.
  3. `alice` can no longer produce a valid `isValidSignature` for the TBA.

**Pass if:**
- A behaves as described.
- B moves funds while locked. Confirms S1.
- C confirms S6.
- D confirms escrow custody neutralizes both. This is the basis of the design in Report 2, section 2.3.

## 7. ERC-1271 before and after transfer

- **Test:**
  1. `h = keccak256("hello")`, `sig = vm.sign(aliceKey, h)`.
  2. Assert `isValidSignature(h, sig) == 0x1626ba7e`.
  3. Lock the account and assert it is still valid. Confirms that the lock ignores signatures.
  4. Create a second TBA for `nft#2`, also owned by `alice`. Assert the same `sig` is valid there too. Confirms S10, cross-account replay.
  5. Transfer `nft#1` to `bob`. Assert `sig` is now invalid for TBA 1 (`0xffffffff`), and a `bobKey` signature is valid.
  6. Pass a 64-byte signature and observe a revert, not `0xffffffff`.
- **USDC check (S2):**
  1. `deal(USDC, tba, 100e6)`.
  2. `alice` signs an EIP-3009 `TransferWithAuthorization` with `from = tba`.
  3. While the TBA is locked, call `USDC.transferWithAuthorization(tba, alice, 100e6, ..., bytes sig)` (the `bytes` overload).

**Pass if:**
- Steps 2 to 6 behave as described.
- The USDC call succeeds while the account is locked. This confirms S2 on Monad. If it fails, record why (for example, the token is not v2.2), and downgrade S2 for USDC.

## 8. Unsolicited tokens

- **Test:** from `mallory`:
  - `safeTransferFrom` of an unrelated ERC-1155
  - `safeTransferBatchFrom`
  - `safeTransferFrom` of an unrelated ERC-721
  - plain `transferFrom` of an ERC-721
  - ERC-20 `transfer`
  - native MON send
- Assert all succeed, and that `state()` is unchanged after each.
- **Cycles:**
  - `alice` calls `nft.safeTransferFrom(alice, tba, 1)`: expect a revert with `OwnershipCycle()`.
  - `alice` calls `nft.transferFrom(alice, tba, 1)`: it succeeds. Then assert no one can call `execute` any more (the account is bricked).
  - Two-account cycle: TBA1 owns `nft#2` and TBA2 owns `nft#1`, both through `transferFrom`. Assert both accounts are unusable.

**Pass if:** all incoming transfers succeed without changing `state()`, the safe self-transfer reverts, and the non-safe paths brick the accounts. Confirms S8 and S9 and justifies the AgentNFT transfer guard.

## 9. Extra checks that change the design

| Step | Test | Pass if |
|---|---|---|
| 9a Nested root owner | Mint `nft#3` to TBA1. Create TBA3. Check `TBA3.isValidSigner(alice)` and whether `alice` can call `TBA3.execute`. Then call `executeNested` from `alice` | `isValidSigner(alice)` is false and `execute` from `alice` reverts, which confirms S11 (the `__self` mismatch). If both work, update S11 |
| 9b Implementation readable by contracts | From a test contract, `AccountV3(tba).extsload(IMPL_SLOT)` | Returns 0x41C8, so the escrow implementation check works |
| 9c Guardian state | `cast call $GUARDIAN "owner()(address)"`, `isTrustedImplementation(addr)` for 0x41C8 and 0x5526, and `cast call 0x781b6A527482828bB04F33563797d4b696ddF328 "nonce()(uint256)"` | Owner is the Safe; nothing trusted; Safe nonce 0 |
| 9d Bytecode reproduction | `git checkout v0.3.1` in `lib/contracts`, then `forge build --use 0.8.17 --optimizer-runs 200`. Compare `keccak(creationCode ++ abi.encode(args))` with the Ethereum init code hashes in `notes/B-registry-deploy-trust.md` section 6(b) (Guardian `0x3aa68c80...`, Impl `0x746d3f5e...`, Proxy `0x428cee7f...`, Registry `0xfeeadc20...`) | All match, which closes the source-to-deployment gap |
| 9e ERC-4337 | Build a v0.6 UserOp with `sender = tba`, signed by `alice`, and submit through `EntryPoint.handleOps` on the fork. Also try a Privy-style bundler endpoint on testnet, if available | The UserOp executes on the fork. Record whether the bundler accepts it (ERC-7562 storage rule) |
| 9f Prefund during lock | Locked TBA holding MON; a UserOp with no paymaster | The UserOp's call reverts, but gas is taken from the TBA. Measures S13 |

---

## 10. Open questions

The code could not answer these.

| # | Question | Why it matters | How to resolve |
|---|---|---|---|
| 1 | Is `0x754704Bc...b603` Circle's official USDC on Monad, and is it FiatToken v2.2 (ERC-1271 in `permit` and `transferWithAuthorization`)? | Whether S2 applies to USDC; x402 token choice | Circle docs; spike step 7 |
| 2 | Which EntryPoint versions does Privy support on Monad, and do its bundlers accept TBA UserOps? | Gas sponsorship design | Privy docs and support; spike 9e |
| 3 | Will Tokenbound's Safe trust new implementations or executors on Monad, and will it announce changes? | Guardian trust (S7) | Ask Tokenbound; monitor guardian events |
| 4 | Guardian event history on Monad (the RPC caps `eth_getLogs` at a 100-block range; no Monad explorer API worked) | Confirms defaults directly instead of by Safe nonce | Indexer, Dune, or explorer API key |
| 5 | Does the nested root-owner walk really fail for canonical proxy accounts? | S11; whether agents may own agents | Spike 9a |
| 6 | Is there a newer `@tokenbound/sdk` or contracts release (after 0.5.5 and v0.3.1) with Monad support or a changed `AccountProxy`? | Tooling choice | Check npm and GitHub releases |
| 7 | Does anvil fork Monad reliably (block time, custom precompiles, gas model)? | Spike fidelity | Spike step 0 |
| 8 | ERC-8004: how is an agent wallet bound, and does it verify the wallet's signature through ERC-1271? | Whether the TBA can be the registered agent wallet | ERC-8004 spec and registry deployment on Monad |
| 9 | Which price oracle on Monad do we use for the 10%, 40% and 10% USDC limits and the drawdown breaker? | Executor correctness | Outside Tokenbound; separate research |
| 10 | Should AgentNFT transfers be restricted to our escrow and approved operators? | Sales outside escrow are not protected against drain | Product and legal decision |
| 11 | What cooldown and notice policy applies to strategy vault depositors when the agent is sold? | Depositor protection | Product decision |
| 12 | Unaudited changes after Zellic's commit `48155498` (35 commits, including FxChildExecutor) | Residual code risk in the TBA | Accept for a skills-only role; otherwise commission a review |
| 13 | Does Monad handle SELFDESTRUCT like EIP-6780? | Relevant to sandbox and override forging edge cases | Monad docs |
