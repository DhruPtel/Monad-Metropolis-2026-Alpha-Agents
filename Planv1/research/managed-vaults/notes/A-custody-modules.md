# Sub-agent A: Custody and module separation

Scope: how BoringVault separates a tiny custody contract from its logic modules (Manager, Teller, Accountant, Queue, Pauser), how permissions are wired and changed, what that means for our StrategyVault + Executor split and for the non-negotiable unpausable `redeemInKind`, and how hypurrquant HyperVault compares.

Versions: see `00-phase0-orientation.md` (BoringVault `c9c221f9`, hypurrquant `79e41cdc`). BoringVault is SEL-1.0 licensed: patterns only, no code copying.

Source notes:
- The BoringVault clone has **empty `lib/` submodules**. To read solmate `Auth` and `RolesAuthority` I cloned solmate at the exact pinned submodule commit (`c892309933b25c03d32b1b0d674df7ae292ba925`, from `git ls-tree HEAD lib/`) into the scratchpad (`scratchpad/solmate`), outside both repos. Solmate paths below are `lib/solmate/src/...` as the BoringVault remapping `@solmate/=lib/solmate/src/` resolves them.
- Live Monad state was read with plain `eth_call` against `https://rpc.monad.xyz` at block `0x670ccca` (108,055,754). Read only; nothing sent. Scripts: `scratchpad/rpcA.py`, `rpcA2.py`, `rpcA3.py`.

Legend: **V** = Verified (read in code or read onchain), **I** = Inferred. Portability: **P** = Portable, **A** = Adaptable, **CS** = Chain-specific. Verdict vs ours: **Confirms / Improves / Missing from ours / Conflicts**.

---

## 1. The core BoringVault contract

File: `src/base/BoringVault.sol` (141 lines, 0.8.21, last audited per header against `audit/sigma-prime-boring-vault-0.pdf`).

`contract BoringVault is ERC20, Auth, ERC721Holder, ERC1155Holder` (V, line 17). Solmate ERC20 is the share token; the vault holds all assets. State added on top of ERC20 + Auth is exactly one variable: `BeforeTransferHook public hook` (V, line 27).

### 1.1 Every external function

| Function | Gate | What it does | Label |
|---|---|---|---|
| `manage(address target, bytes data, uint256 value)` | `requiresAuth` | `target.functionCallWithValue(data, value)`: arbitrary call from the vault, any target, any calldata, any native value | V, P |
| `manage(address[] targets, bytes[] data, uint256[] values)` | `requiresAuth` | Batched version of the above | V, P |
| `enter(from, asset, assetAmount, to, shareAmount)` | `requiresAuth` | `safeTransferFrom(from -> vault)` if `assetAmount > 0`, then `_mint(to, shareAmount)`. Share amount is supplied by the caller; the vault does no pricing | V, P |
| `exit(to, asset, assetAmount, from, shareAmount)` | `requiresAuth` | `_burn(from, shareAmount)` then `safeTransfer(to, assetAmount)`. **No allowance check on `from`**: the authorized caller can burn anyone's shares | V, P |
| `setBeforeTransferHook(address)` | `requiresAuth` | Sets or clears (`address(0)`) the hook | V, P |
| `transfer`, `transferFrom` (overrides) | public | Call `hook.beforeTransfer(from, to, msg.sender)` if hook set, then solmate ERC20 | V, P |
| `receive()` | public payable | Accept native token | V, P |
| Inherited ERC20: `approve`, `permit`, `DOMAIN_SEPARATOR`, views | public | Standard solmate ERC20. `_mint`/`_burn` do **not** call the hook | V, P |
| Inherited `Auth`: `setAuthority`, `transferOwnership`, `owner()`, `authority()` | see 2.1 | Admin plumbing | V, P |
| Inherited `ERC721Holder.onERC721Received`, `ERC1155Holder.onERC1155Received/BatchReceived`, `supportsInterface` | public | Lets the vault receive NFTs (e.g. Uniswap V3 LP positions) | V, P |

Key properties (all V unless noted):
- **Not upgradeable.** Plain constructor (`constructor(_owner, _name, _symbol, _decimals)`), no proxy, no `delegatecall`, no initializer. Logic changes happen by pointing roles at new module contracts, not by changing vault bytecode.
- **No pricing, no accounting, no pause, no limits** inside the vault. `enter`/`exit` trust the caller for share math. The vault is "dumb custody + share ledger".
- **Hook scope:** `_callBeforeTransfer` is only in `transfer`/`transferFrom` (lines 124-136). Mint and burn bypass it. The hook is a `view` call (interface `src/interfaces/BeforeTransferHook.sol`), so a hook can only revert, not mutate.
- **`manage` is total power.** Anyone holding the `manage` capability can move every token, approve any spender, or call `transferFrom` on the vault's own share token via another contract. The only protection is who holds the capability.
- **`enter` and `exit` are total power over the share ledger.** MINTER can mint unbacked shares to anyone (dilution). BURNER can burn any holder's shares and send assets anywhere. Again only protected by role assignment.

Portability: the whole contract is standard EVM Solidity. **P**.

Verdict: **Confirms** the idea of a minimal custody contract. **Conflicts** if copied literally: a generic `manage` plus caller-trusted `enter`/`exit` means custody safety is 100% delegated to role wiring, which is changeable (section 3). Our StrategyVault must not expose unbounded `manage`/`exit`.

### 1.2 Sibling: BoringGovernance

`src/base/Governance/BoringGovernance.sol` (182 lines) is **not** a governance or timelock contract (V). It is a BoringVault clone whose share token is OpenZeppelin `ERC20Votes`, plus a second optional hook `ShareLocker shareLocker` checked via `_canTransfer` in `transfer`/`transferFrom`. Same `manage`/`enter`/`exit`/`setBeforeTransferHook` surface, plus `setShareLocker` (`requiresAuth`). Relevance to us: shows the custody core is reused unchanged across share-token flavors. **P**. Low priority.

### 1.3 Drones

`src/base/Drones/BoringDrone.sol`: sub-accounts that only accept calls from the vault (`if (msg.sender != boringVault) revert BoringDrone__OnlyBoringVault();`, line 66) (V). Used so one vault can hold several positions at separate addresses. Out of scope for launch. **P**.

---

## 2. Permission plumbing: solmate Auth + RolesAuthority

### 2.1 `Auth` (lib/solmate/src/auth/Auth.sol)

```solidity
function isAuthorized(address user, bytes4 functionSig) internal view virtual returns (bool) {
    Authority auth = authority;
    return (address(auth) != address(0) && auth.canCall(user, address(this), functionSig)) || user == owner;
}
function setAuthority(Authority newAuthority) public virtual {
    require(msg.sender == owner || authority.canCall(msg.sender, address(this), msg.sig));
    authority = newAuthority;
}
function transferOwnership(address newOwner) public virtual requiresAuth { owner = newOwner; }
```

- `owner` can call **every** `requiresAuth` function on its contract (V). On a BoringVault that includes `manage`, `enter`, `exit`.
- `setAuthority` can be called by the owner or by anyone the current authority allows (V). Swapping the authority replaces the entire permission table in one call.
- The authority is called before the `user == owner` check, so if the authority reverts, every `requiresAuth` function reverts for everyone, including the owner. The comment on lines 33-34 says so: "this makes protected functions uncallable even to the owner if the authority is out of order" (V). Only `setAuthority` checks the owner first. With `owner = address(0)` (the deployed setup, see 2.4), a broken authority permanently bricks all gated functions.
- Portability: **P**.

### 2.2 `RolesAuthority` (lib/solmate/src/auth/authorities/RolesAuthority.sol)

- `canCall(user, target, sig) = isCapabilityPublic[target][sig] || (getUserRoles[user] & getRolesWithCapability[target][sig]) != 0` (V).
- Up to 256 roles as a bitmap per user; capability is per `(target contract, 4-byte selector)`. No argument-level checks (V).
- Admin setters `setUserRole`, `setRoleCapability`, `setPublicCapability` are all `requiresAuth` on the RolesAuthority itself, i.e. its owner or whoever the RA's own authority allows (V). There is **no built-in delay** anywhere in solmate Auth/RolesAuthority (V).
- A single RolesAuthority instance serves all modules of one vault (V, deploy script and live reads).
- Portability: **P**.

Verdict: **Confirms** selector-level role checks as a cheap, auditable base layer. **Missing from ours** as an explicit design element: we should decide whether our StrategyVault uses a role table at all, or hard-codes the single Executor address behind a timelocked setter (recommended, section 5).

### 2.3 Role ids and selector map (deployment script)

Source: `script/ArchitectureDeployments/DeployArcticArchitectureWithConfig.s.sol`, constants lines ~139-159 and `_setupRoles()` (line 1032), `_setupPausers()` (line 911), `_finalizeSetup()` (line 1380). All V (read in script).

Role ids: MANAGER 1, MINTER 2, BURNER 3, MANAGER_INTERNAL 4, PAUSER 5, STRATEGIST 7, OWNER 8, MULTISIG 9, STRATEGIST_MULTISIG 10, UPDATE_EXCHANGE_RATE 11, SOLVER 12, GENERIC_PAUSER 14, GENERIC_UNPAUSER 15, PAUSE_ALL 16, UNPAUSE_ALL 17, SENDER_PAUSER 18, SENDER_UNPAUSER 19, CAN_SOLVE 31, ONLY_QUEUE 32, SOLVER_ORIGIN 33.

Capabilities granted (`_setupRoles`):

| Target | Selector | Role(s) |
|---|---|---|
| BoringVault | `manage(address,bytes,uint256)`, `manage(address[],bytes[],uint256[])` | MANAGER (1) |
| BoringVault | `enter` | MINTER (2) |
| BoringVault | `exit` | BURNER (3) |
| BoringVault | `setBeforeTransferHook`, `setAuthority`, `transferOwnership` | OWNER (8) |
| Manager | `setManageRoot`, `setAuthority`, `transferOwnership` | OWNER |
| Manager | `manageVaultWithMerkleVerification` | STRATEGIST (7), MANAGER_INTERNAL (4) |
| Manager | `pause`, `unpause` | PAUSER (5) |
| Accountant | `setRateProviderData`, `updateDelay`, `updateUpper`, `updateLower`, `updatePlatformFee`, `updatePerformanceFee`, `updatePayoutAddress`, `resetHighwaterMark` (variable rate), `setAuthority`, `transferOwnership` | OWNER |
| Accountant | `pause`, `unpause` | PAUSER |
| Accountant | `updateExchangeRate` | UPDATE_EXCHANGE_RATE (11) |
| Teller | `bulkDeposit`, `bulkWithdraw` | SOLVER (12) |
| Teller | `updateAssetData` | OWNER, STRATEGIST_MULTISIG (10) |
| Teller | `pause`, `unpause` | PAUSER |
| Teller | `setShareLockPeriod`, `setAuthority`, `transferOwnership` | OWNER |
| Teller | `refundDeposit` | STRATEGIST_MULTISIG |
| Teller | `deposit(address,uint256,uint256,address)`, `depositWithPermit` | **public** if `allowPublicDeposits` |
| Queue | `rescueTokens`, `setAuthority`, `transferOwnership` | OWNER |
| Queue | `updateWithdrawAsset`, `stopWithdrawsInAsset`, `setWithdrawCapacity` | MULTISIG (9) (+ STRATEGIST_MULTISIG for stop/capacity/`cancelUserWithdraws`) |
| Queue | `solveOnChainWithdraws` | CAN_SOLVE (31), SOLVER_ORIGIN (33) |
| Queue | `requestOnChainWithdraw(+WithPermit)`, `cancelOnChainWithdraw`, `replaceOnChainWithdraw` | **public** if `allowPublicWithdrawals` |
| QueueSolver | `boringSolve` | ONLY_QUEUE (32) |
| QueueSolver | `boringRedeemSolve`, `boringRedeemMintSolve` | SOLVER_ORIGIN |
| QueueSolver | `boringRedeemSelfSolve`, `boringRedeemMintSelfSolve` | **public** if `allowPublicSelfWithdrawals` |
| Pauser | `pauseAll` / `unpauseAll` / `senderPause` / `senderUnpause` / `pauseSingle`,`pauseMultiple` / `unpauseSingle`,`unpauseMultiple` | 16 / 17 / 18 / 19 / 14 / 15 |

User-role grants in `_finalizeSetup` (lines 1504-1509): Manager gets MANAGER + MANAGER_INTERNAL; Teller gets MINTER + BURNER; QueueSolver gets SOLVER + CAN_SOLVE. Then every module (vault, teller, manager, accountant, queue, solver, pauser) gets `setAuthority(rolesAuthority)` and `transferOwnership(address(0))` (lines 1383-1500). Vault also gets `setBeforeTransferHook(teller)` (the Teller is the share-lock/deny-list hook).

Notable: the script never grants the Pauser contract PAUSER_ROLE (V, grep found no such grant). It must be done outside this script for `Pauser.pauseAll()` to work (I). On live vmUSD the Pauser **does** hold role 5 (see 2.5), so it was granted separately.

Also V: `script/ArchitectureDeployments/DeploySkeleton.s.sol` (used for the Monad skeletons per `deployments/skeletons/`) only deploys contracts via the CREATE3 `Deployer` (`src/helper/Deployer.sol`, `deployContract` + `bundleTxs`); it contains no role wiring at all. Role wiring for the Monad deployments therefore happened through some process not in this repo (I).

### 2.4 End state after setup: owner is zero, RolesAuthority is the root

After `_finalizeSetup`, every module has `owner == address(0)` and `authority == rolesAuthority` (V, script). The effective root of trust is **whoever owns the RolesAuthority**, plus anyone given OWNER_ROLE (who can call `setAuthority` on each module). In the Arctic script, RA ownership starts at `deploymentOwner` and `_setupTestUser()` can transfer it to a test user and grant OWNER + STRATEGIST (lines 1512-1535) (V). Production handover to a timelock is not in the script (I, convention).

### 2.5 Live Monad vmUSD wiring (read onchain, V)

Addresses from `deployments/skeletons/addresses/Monad/vmUSD.json`.

| Contract | `owner()` | `authority()` |
|---|---|---|
| BoringVault `0x1C8a...D316` | `0x0` | RA `0xA129...1770` |
| Manager, Teller, Accountant, Queue, Pauser, QueueSolver | `0x0` | RA |
| RolesAuthority `0xA129...1770` | `0x16ba76503eebd5dea68c2785dd930bca27178c8e` | `0x0` |

- RA owner `0x16ba...8c8e` is a contract (6,577 bytes) that answers `getMinDelay() = 0x2a300 = 172,800 s = 48 h`, i.e. an OpenZeppelin `TimelockController` with a 48 h delay (V for delay, I for exact contract type). It is its own admin (`hasRole(DEFAULT_ADMIN_ROLE, self) = true`), and `address(0)` does not hold EXECUTOR (no open execution) (V).
- The timelock also holds OWNER_ROLE (bitmap `0x100`) (V). Whether any other address holds OWNER_ROLE is **unknown**: `eth_getLogs` over full history was rejected by the public RPC (HTTP 413). Open question.
- No role has capability on RA's own `setUserRole`/`setRoleCapability`/`setPublicCapability` (all bitmaps zero) (V). Combined with RA `authority() = 0`, **only the 48 h timelock can change roles or capabilities** on live vmUSD (V).
- Note the config file says `timelockConfiguration.shouldDeploy = false` with `minDelay 43200` (12 h), and the addresses file records `Timelock: 0x0` (V). The live owner is a 48 h timelock deployed some other way. The repo config does not match live reality; documentation is not reliable, only onchain state is.
- Role bitmaps: Manager `0x12` = MANAGER + MANAGER_INTERNAL; Teller `0x8_0000_000e` = MANAGER + MINTER + BURNER + role 35 (undocumented in the script); QueueSolver `0x8000_1000` = SOLVER + CAN_SOLVE; Pauser `0x20` = PAUSER (V).
- **Teller holds MANAGER_ROLE** (V). Reason: vmUSD uses `TellerWithYieldStreaming is TellerWithBuffer`, whose `_afterDeposit`/`_beforeWithdraw` call `vault.manage(targets, data, values)` with calldata produced by a "buffer helper" (`src/base/Roles/TellerWithBuffer.sol` lines 63-86) (V). This is a **second path to unrestricted `manage` that bypasses Merkle verification**. It is gated by a two-step allowlist: `allowBufferHelper` = OWNER (timelock), `setDeposit/WithdrawBufferHelper` = STRATEGIST_MULTISIG role 10 (V, live capability reads).
- Live capabilities: `manageVaultWithMerkleVerification` = roles 4 and 7; `setManageRoot` = OWNER; Teller `withdraw` and `deposit` are **public** (direct instant withdraw exists on vmUSD); `bulkWithdraw` = SOLVER; Teller/Accountant/Manager `pause` and `unpause` = PAUSER (5, held by the Pauser contract); Pauser `pauseAll` = role 16, `unpauseAll` = 17, `pauseSingle` = 14; Teller `denyAll`/`denyFrom` = role 50; `updateAssetData` = OWNER + STRATEGIST_MULTISIG; `setShareLockPeriod` = OWNER; share lock period = 15 s (V).
- Holders of roles 7, 10, 14, 16, 50 are unknown without logs (open question). These are the non-timelocked actors.

Portability: all of this is generic EVM. **P**.

### 2.6 Pauser

`src/base/Roles/Pauser.sol` (192 lines) (V):
- Holds a list `pausables` (constructor: Teller, Queue, Accountant, Manager per `_deployPauser`, line ~889).
- `pauseAll` / `unpauseAll` iterate the list; `pauseSingle/Multiple`, `unpauseSingle/Multiple` take arbitrary `IPausable` addresses; `senderPause` / `senderUnpause` pause the one pausable mapped to `msg.sender` (lets e.g. a monitoring bot pause only its own module).
- `addPausable`, `removePausable`, `updateSenderToPausable` are `requiresAuth` with no capability granted in the script, so owner-only; owner is set to 0, so effectively only through RA (I).
- The Pauser itself needs PAUSER_ROLE on each module. Pause and unpause are separate roles, so a hot key can pause but not unpause (V).
- The BoringVault core has **no pause** (V). Pausing happens only in modules.

**P**. Verdict: **Confirms** our "emergency role can only reduce risk" idea (pause-only keys). **Conflicts** in effect: in BoringVault, pause blocks exits (section 4).

### 2.7 Timelock usage

- `script/DeployTimelock.s.sol`: deploys OZ `TimelockController` with `minDelay = 0` for a Plasma vault, single EOA as proposer/executor/canceller (V). A zero-delay timelock is purely a routing convention.
- `script/ProposeTimelockTx.s.sol`: schedules a batch on a mainnet timelock with delay `300` s (V).
- `TimelockTxs/ebtc-timelock-tx-1.json`: eBTC batch with `delay: 300` whose payloads start `0x7d40583d` = `setRoleCapability(uint8,address,bytes4,bool)` (V: selector computed). So role-capability changes for eBTC went through a 5-minute timelock.
- Live Monad vmUSD: 48 h (section 2.5).

Conclusion: **the timelock is a deployment convention, not a property of the contracts.** Nothing in BoringVault, the modules, Auth or RolesAuthority enforces a delay; the delay exists only if the RA owner (and every OWNER_ROLE holder) happens to be a TimelockController, and its length varies from 0 to 48 h across Veda deployments (V). **P** mechanism. Verdict: **Conflicts** with our rule that risky changes wait behind timelocks longer than the maximum lockup, if we copied it; we need the delay enforced inside the vault's own code.

---

## 3. Who can change which module is attached

| Change | How | Who (script default) | Timelocked? |
|---|---|---|---|
| Replace the whole permission table of the vault | `BoringVault.setAuthority(newAuth)` | OWNER_ROLE or vault owner (0 after setup) | Only if all OWNER_ROLE holders are timelocks (convention) |
| Attach a new Manager / Executor-like module | `RA.setUserRole(newModule, MANAGER_ROLE, true)` | RA owner | Only by convention |
| Attach a new Teller (mint/burn) | `RA.setUserRole(newTeller, MINTER/BURNER, true)` | RA owner | Convention |
| Make `manage` or `exit` public or give it to a new role | `RA.setPublicCapability` / `setRoleCapability` | RA owner | Convention |
| Change or remove share-transfer hook | `BoringVault.setBeforeTransferHook` | OWNER_ROLE | Convention |
| Change strategist allowlist | `Manager.setManageRoot(strategist, root)` | OWNER_ROLE | Convention |
| Swap buffer helpers (arbitrary `manage` via Teller) | `allowBufferHelper` (OWNER) then `setDepositBufferHelper` (STRATEGIST_MULTISIG) | split | First step only, by convention |
| Upgrade vault code | Not possible (immutable) | n/a | n/a |
| Upgrade module code | Not possible in place; deploy new module and re-point roles | RA owner | Convention |

All V from code and script; timelock column is V for "no onchain enforcement", I for how any given deployment is actually run beyond vmUSD.

Module constructors bind the vault immutably (`BoringVault public immutable vault` in Manager line 82 and Teller line 180) (V), so a module can only ever act on one vault, but a vault can be served by any module the RA authorizes.

---

## 4. Can a user exit if admins misbehave? (interaction with `redeemInKind`)

BoringVault has **no user-callable exit on the vault itself** (V: every state-changing function is `requiresAuth`, except ERC20 `transfer/transferFrom/approve/permit`). All exits go through Teller/Queue/Solver, which call `vault.exit` using BURNER_ROLE.

Ways an exit can be blocked, all V:

| Blocker | Code | Who, speed |
|---|---|---|
| Teller paused | `_withdraw`: `if (isPaused) revert TellerWithMultiAssetSupport__Paused();` (TellerWithMultiAssetSupport.sol line 601) | PAUSER role (Pauser contract; pause-all/single role holders), instant |
| Accountant paused (manual or automatic) | Teller uses `accountant.getRateInQuoteSafe`, which reverts when `accountantState.isPaused` (AccountantWithRateProviders.sol lines 440-442). `updateExchangeRate` auto-pauses when the new rate is out of bounds or too early (lines 334-345, 509-521) | PAUSER instant; or the rate updater by submitting an out-of-bounds rate |
| Asset withdrawals disabled | `if (!asset.allowWithdraws) revert` (line 603), set by `updateAssetData` | OWNER or STRATEGIST_MULTISIG, instant for the multisig |
| User deny-listed | `withdraw` calls `beforeTransfer(msg.sender, address(0), msg.sender)` which reverts on `denyFrom`/`denyOperator` (lines 568, 379-417) | `denyAll`/`denyFrom` role (50 on vmUSD), instant |
| Teller loses BURNER_ROLE or a new Teller is swapped in | `RA.setUserRole` | RA owner |
| Authority swapped or broken | `vault.setAuthority`; a reverting authority bricks `exit` (Auth.sol lines 33-35) | OWNER_ROLE |
| Hook set to a reverting contract | Blocks `transfer`/`transferFrom`, so queue requests (which transfer shares into the queue) fail; direct Teller withdraw also calls the Teller's own `beforeTransfer` | OWNER_ROLE |
| Withdraw not made public | `withdraw` is `requiresAuth`; public only if the RA sets it | RA owner |

Also V: `exit` burns `from` without allowance, so a malicious BURNER can destroy a user's shares, and a malicious MINTER can dilute them. Any in-kind exit computed as `shares / totalSupply` is only as safe as the MINTER/BURNER assignment.

Verdict: **Conflicts with our non-negotiable offline exit.** In BoringVault, an admin with PAUSER alone can freeze all exits instantly and indefinitely, and the RA owner can reroute or remove the exit path. There is no in-kind path and no path that avoids the Accountant. This is the single most important difference to record.

---

## 5. What the tiny-custody split buys, and should we copy it?

### 5.1 Gains (V from structure, I for the benefits)

1. **Small audited surface for funds.** 141 lines hold every asset; audits of the core stay valid while modules churn (I). Veda has shipped many Teller/Accountant variants (`TellerWithRemediation`, `TellerWithBuffer`, `TellerWithYieldStreaming`, CCIP/LayerZero tellers, three Accountants, several queues) without redeploying vaults (V: directory listing).
2. **Immutable custody, swappable logic, without a proxy.** No storage-layout risk, no `delegatecall` into new code; upgrading means authorizing a new module (V).
3. **Least privilege per module.** Manager can only `manage`; Teller can only `enter`/`exit` (plus `manage` on buffer tellers); Accountant touches nothing in the vault (V: capability map). A bug in the Accountant cannot directly move funds (I), though it can misprice shares.
4. **Per-selector audit trail.** Every permission is an onchain `(role, target, selector)` fact with events `UserRoleUpdated`, `RoleCapabilityUpdated` (V, RolesAuthority).
5. **Multiple strategist gates can coexist** (Merkle Manager, micro-managers, BoringSwapper) each holding MANAGER-like power (V roles 1/4/7; I for how B's area uses it).

### 5.2 Costs

1. The generic `manage` makes the custody contract itself unconstrained: safety moved entirely into role wiring (V).
2. Role wiring is mutable and its delay is only a convention (V).
3. Exits depend on at least two modules (Teller + Accountant) and their pause flags (V).
4. Complexity: ~20 roles, 7 contracts, a bespoke deploy script with hundreds of txs; the repo's config for Monad vmUSD does not match live state (V, 2.5). Easy to misconfigure (I).

### 5.3 Recommendation for StrategyVault + Executor (I, design advice)

Adopt the split, but invert where the guarantees live:

| Element | Recommendation | Verdict |
|---|---|---|
| Custody contract | Small, non-upgradeable StrategyVault holding assets and shares (like BoringVault) | Confirms |
| Trading entry point | No generic `manage`. Expose one function, e.g. `execute(typedIntent)`, callable only by a single `executor` address stored in the vault. Better still, the vault itself enforces the invariants that must never break (post-trade: USDC floor, max 40% non-USDC, total value not dropping more than slippage), so a buggy Executor cannot violate them | Improves on BoringVault |
| Executor swap | `executor` changed only via propose / accept with an **onchain-enforced** delay longer than the max lockup, coded in the vault (like hypurrquant `proposeUpgrade`/`_authorizeUpgrade`), not via an external TimelockController convention. Emergency role may only set `executor = address(0)` (reduce risk) | Improves / Missing from BoringVault |
| Mint/burn | Keep deposit/withdraw math inside the vault or in a Teller-like module, but **`redeemInKind` must be in the custody contract**, with no auth modifier, no pause check, no hook call, no authority call, no oracle, no module call. It burns `msg.sender`'s own shares only | Confirms our rule; BoringVault Conflicts |
| Share supply integrity | Because in-kind exit is `shares / totalSupply`, minting must be impossible except through the vault's own deposit function (no external MINTER role, or a MINTER change behind the long timelock). No BURNER power over other users' shares | Missing from ours (make explicit) |
| Transfer hook | If we add a share-transfer hook (lockup), `redeemInKind` must not depend on it, and a reverting hook must not block redemption. Lockup check for in-kind should be a vault-internal timestamp, not an external contract | Missing from ours (make explicit) |
| Role table | A full RolesAuthority is not needed for one vault with one Executor. If used (e.g. platform-wide), the vault's critical selectors (`redeemInKind`) must not be `requiresAuth`, and `setAuthority` must be timelocked in-vault | Adaptable |
| Pause | Pauser pattern (pause and unpause as separate keys, sender-scoped pause) is good for deposits and Executor trading; it must never reach `redeemInKind` | Confirms with limits |
| NFT receivers, `receive()` | Only if we plan LP-NFT positions. For USDC + WMON launch, avoid `receive()` or handle native MON explicitly, since stray native balances are outside in-kind accounting | Adaptable |

Can a Teller burn be blocked? In BoringVault, yes, in every way listed in section 4 (V). In our design, `redeemInKind` bypasses all modules, so the only thing that could block it is the vault bytecode itself, which is immutable. The owner of any role table could still disable **normal** (USDC or sell-through) withdrawals if those live in a module; that is acceptable only because in-kind remains.

---

## 6. hypurrquant HyperVault structure

Files (V): `src/vault/UsdcVault.sol` (1,138 lines), `VaultStorage.sol`, logic libraries `NavLib.sol`, `RedeemLogic.sol`, `RedeemQueueLib.sol`, `DepositLogic.sol`, `HyperCoreBridgeLib.sol`; deploy `script/DeployUsdcVault*.s.sol`, `script/UpgradeUsdcVault.s.sol`.

| Aspect | hypurrquant | Label |
|---|---|---|
| Contract shape | One monolith: `UsdcVault is VaultStorage, ERC20Upgradeable, PausableUpgradeable, ReentrancyGuardUpgradeable, UUPSUpgradeable` (lines 29-35). The vault is the share token, the accountant, the teller and the queue | V, P |
| Proxy | `ERC1967Proxy(vaultImpl, initData)` in `DeployUsdcVault.s.sol` / `DeployUsdcVaultMainnet.s.sol`; constructor `_disableInitializers()` | V, P |
| Storage | `VaultStorage is AccessControlUpgradeable` holds all state, append-only, deprecated slots kept, `uint256[28] __gap` (VaultStorage.sol header and line 235); ERC20 uses ERC-7201 namespaced storage | V, P |
| External libraries | `public` library functions (e.g. `RedeemLogic.executeRequestRedeem`, `DepositLogic.executeDeposit`, `RedeemQueueLib.setRedeemDelay`) are linked and run via `delegatecall` in the vault's storage context, purely to fit EIP-170 (RedeemLogic.sol lines 13-16). Library addresses are baked into the implementation, so changing them requires an upgrade | V, P |
| Roles | OZ AccessControl: `DEFAULT_ADMIN_ROLE`, `ADMIN_ROLE`, `KEEPER_ROLE`, `GUARDIAN_ROLE` (lines 41-43). Keeper: bridge to/from HyperCore, `transferUsdClass`, `markRedeemReady`. Admin: config, fees, `emergencyRedeem`, `unpause`, `registerAgentWallet`, upgrades. Guardian: `pause`, `guardianCancelUpgrade` | V, P (roles), CS (HyperCore actions) |
| Upgrade timelock | `proposeUpgrade` (ADMIN) stores `pendingUpgradeImpl` + `upgradeProposedAt`; `_authorizeUpgrade` requires exact match and `block.timestamp >= upgradeProposedAt + 48 hours` (lines 1110-1137). **Onchain-enforced** | V, P |
| Guardian veto | `guardianCancelUpgrade()` (GUARDIAN) clears the pending upgrade (line 1125) | V, P |
| Fee timelock | `FEE_CHANGE_TIMELOCK = 24 hours`, permissionless `applyPendingPerformanceFee` (lines 66, 838-848) | V, P |
| Role changes | `grantRole`/`revokeRole` by `DEFAULT_ADMIN_ROLE` are **not** timelocked (inherited OZ AccessControl, no override) | V, P |
| Pause | `pause` GUARDIAN, `unpause` ADMIN (lines 698-709). `deposit`, `requestRedeem`, `redeem` are `whenNotPaused` (lines 372, 487, 579) | V, P |
| Trading custody | Keeper trades on HyperCore through an API "agent wallet" registered by `registerAgentWallet` (CoreWriter). Agent can sign orders but cannot withdraw; enforced by Hyperliquid, not by this contract (lines 745-756) | V (code), CS |
| Emergency paths | `emergencyRedeem` (ADMIN) bypasses timelock and fee for a queued request; `emergencyWithdrawToken` (ADMIN, only while paused) cannot touch USDC or the share token (lines 631-656, 715-727) | V, P |
| Deployment | `admin = keeper = guardian = deployer` in both deploy scripts (DeployUsdcVaultMainnet.s.sol lines 57-59) | V |

Weak points (V unless noted):
- Guardian veto is only meaningful if the guardian is independent; at deploy it is the same key as admin. Admin (DEFAULT_ADMIN) can also `revokeRole(GUARDIAN_ROLE, guardian)` instantly, removing the veto before proposing an upgrade (V: no override of AccessControl).
- 48 h upgrade delay vs exit: redeem delay can be set up to `MAX_REDEEM_TIMELOCK = 7 days` (line 54) and `redeem` is pausable by the guardian, so users cannot be sure to exit inside the 48 h window (V). This violates "timelocks longer than the maximum lockup" (I).
- A UUPS upgrade can change everything, including the redeem path, so any "unpausable" function is only as strong as the upgrade delay (I).
- No in-kind exit; single asset (USDC) with positions on HyperCore (V). Offline exit is impossible by construction (CS).

Portability: proxy, storage, libraries, roles and timelock are **P**; the trading-custody model (agent wallets, CoreWriter, precompile NAV) is **CS**.

---

## 7. Side-by-side comparison

| Question | BoringVault | hypurrquant | Ours (decided) | Verdict |
|---|---|---|---|---|
| Custody contract size | 141 lines, only custody + share ledger (V) | ~1,140 lines + libraries (V) | Not yet specified | BoringVault split **Confirms/Improves** our direction |
| Upgradeability | Vault immutable; modules swapped via roles (V) | UUPS with in-contract 48 h timelock + guardian veto (V) | Own vault, Morpho-style timelocks | Prefer immutable custody (BoringVault) + in-contract delays (hypurrquant) |
| Who may trade | MANAGER_ROLE via `manage`, arbitrary calldata; Merkle Manager, micro-managers, buffer Tellers can hold it (V) | Keeper via offchain agent wallet (V, CS) | Only our Executor via typed intents | **Confirms** ours; BoringVault shows the risk of multiple manage holders (Teller also holds MANAGER on vmUSD) |
| Delay on module/role changes | None in code; TimelockController convention, 0 s to 48 h (V) | Upgrade 48 h in code; role grants instant (V) | Delay longer than max lockup | Both **Conflict** in part; we must code delays in-vault for executor, authority, hook, minter |
| Emergency powers | Pause-only keys, separate unpause (V) | Guardian pause, admin unpause (V) | Emergency role reduces risk only | **Confirms** |
| Pause affects exits | Yes (Teller, Accountant) (V) | Yes (`redeem` whenNotPaused) (V) | `redeemInKind` never pausable | Both **Conflict** with our rule |
| In-kind exit | None (V) | None (V) | Required | **Missing from both**; our rule is stricter |
| Share mint/burn control | External MINTER/BURNER roles; burn without allowance (V) | Internal to vault (V) | Not specified | **Missing from ours**: state explicitly that no external module can mint or burn other users' shares |
| Transfer hook | Optional external view hook; can block transfers (V) | `_update` override, internal (V) | Lockup not yet specified | **Missing from ours**: keep lockup internal and independent of redeemInKind |

---

## 8. Open questions

1. Who else holds OWNER_ROLE (8), STRATEGIST (7), STRATEGIST_MULTISIG (10), GENERIC_PAUSER (14), PAUSE_ALL (16) and deny-list role 50 on Monad vmUSD? Needs `UserRoleUpdated` logs from an indexer or archive RPC with pagination (public RPC refused full-range `eth_getLogs`). If any non-timelock address has OWNER_ROLE, it can call `vault.setAuthority` and bypass the 48 h timelock entirely.
2. What is role 35 held by the vmUSD Teller? Not defined in the deployment script.
3. Who are the proposers, executors and cancellers of the 48 h timelock `0x16ba...8c8e`? (Requires role-member logs or known addresses.)
4. How were Monad role wirings applied, given `DeploySkeleton.s.sol` has no role setup and the repo config says `shouldDeploy: false` for the timelock? Is there an offchain or private script?
5. Does any Veda deployment enforce a delay inside the contracts rather than by timelock ownership? Nothing found in `src/`.
6. Should our Executor be a separate contract at all, or should the typed-intent checks live inside the StrategyVault? A separate Executor keeps the vault small but needs the vault to re-check the hard invariants post-trade; inside the vault means one larger audited contract. (Design question for Phase 2, coordinate with Sub-agent B findings on BoringSwapper.)
7. For `redeemInKind` over a lockup: if our 1-day lockup is enforced, is in-kind redemption also subject to it? Hyperliquid parity says yes; the offline-exit rule says nothing may block it. Needs an explicit product decision.
8. Native MON: should the StrategyVault reject native deposits (`receive`) to keep in-kind accounting to ERC20s only (wrapped MON)?
9. hypurrquant: is there any post-deploy script that rotates guardian away from admin? `script/PostDeploy.s.sol` only registers an agent wallet (V); nothing found.
