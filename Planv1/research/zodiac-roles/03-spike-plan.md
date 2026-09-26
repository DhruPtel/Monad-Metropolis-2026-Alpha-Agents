# Report 3: Spike plan and open questions

Source baseline: `gnosisguild/zodiac-modifier-roles` `main` at `820e5bc975d1817bdd4bc4a95226f553f7b67b68` (2026-08-25, tag `zodiac-roles-sdk-v4.1.3`, LGPL-3.0+). The spike targets the **deployed Roles 2.1.1** mastercopy `0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5` (source `origin/v2@218a5164`), not `main`. v3 (`origin/contracts-v3@47dd69bd`, BUSL-1.1) is out of scope.

Purpose: prove on a Monad mainnet fork that Roles 2.1.1 enforces what Report 2 section 2.1 marks Native or Partial, measure its gas cost, and collect the numbers needed to confirm or overturn the Option 3 recommendation. The spike lives **outside this repository** (for example `~/spikes/roles-monad`), so the research checkout stays read-only.

All addresses below were **Verified** on chain 143 during this study unless marked TBD. Enum values and function signatures are **Verified** from `origin/v2:packages/evm/contracts/Types.sol`, `PermissionBuilder.sol`, `Roles.sol`, `PermissionChecker.sol`.

---

## 0. Setup

```bash
# Foundry is not installed on the research machine
curl -L https://foundry.paradigm.xyz | bash && foundryup
forge init ~/spikes/roles-monad && cd ~/spikes/roles-monad

# Fork Monad mainnet (use a dedicated RPC if the public one rate-limits)
anvil --fork-url https://rpc.monad.xyz --chain-id 143 --port 8545
# Tests can also fork directly: forge test --fork-url https://rpc.monad.xyz -vvv

# Sanity checks against the fork
cast chain-id --rpc-url http://127.0.0.1:8545                                   # 143
cast code 0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5 --rpc-url http://127.0.0.1:8545 | wc -c
cast call 0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5 "owner()(address)" --rpc-url http://127.0.0.1:8545   # 0x...01
cast call 0x204faca1764b154221e35c0d20abb3c525710498 \
  "getPool(address,address,uint24)(address)" \
  0x754704Bc059F8C67012fEd69BC8A327a5aafb603 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A 500 \
  --rpc-url http://127.0.0.1:8545                                                # 0x5bc3...34e9
cast call 0x5bc39a29ea5d8315263ec8939d6ad393debc34e9 "liquidity()(uint128)" --rpc-url http://127.0.0.1:8545
```

Constants used in tests:

| Name | Address |
|---|---|
| `ROLES_MASTERCOPY` (2.1.1) | `0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5` |
| `MODULE_PROXY_FACTORY` | `0x000000000000aDdB49795b0f9bA5BC298cDda236` |
| `MULTISEND_CALLONLY_141` | `0x9641d764fc13c8B624c04430C7356C1C7C8102e2` |
| `MULTISEND_UNWRAPPER` (2.1.1) | `0xB4Cd4bb764C089f20DA18700CE8bc5e49F369efD` |
| `SWAP_ROUTER_02` | `0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900` |
| `USDC` | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` |
| `WMON` | `0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A` |
| `WETH`, `LST` | TBD (open question 3) |

Enum values (Roles 2.1.1): `ParameterType { None=0, Static=1, Dynamic=2, Tuple=3, Array=4, Calldata=5, AbiEncoded=6 }`. `Operator { Pass=0, And=1, Or=2, Nor=3, Matches=5, EqualToAvatar=15, EqualTo=16, GreaterThan=17, LessThan=18, WithinAllowance=28, EtherWithinAllowance=29, CallWithinAllowance=30 }`. `ExecutionOptions { None=0, Send=1, DelegateCall=2, Both=3 }`. `Status` (in `ConditionViolation(uint8 status, bytes32 info)`): `DelegateCallNotAllowed=1, TargetAddressNotAllowed=2, FunctionNotAllowed=3, SendNotAllowed=4, OrViolation=5, ParameterNotAllowed=7, ParameterLessThanAllowed=8, ParameterGreaterThanAllowed=9, ParameterNotAMatch=10, AllowanceExceeded=17, CallAllowanceExceeded=18`.

Minimal interface (hand-written; or generate with `cast interface` from the `abi` in `origin/v2:packages/evm/mastercopies.json`):

```solidity
struct ConditionFlat { uint8 parent; uint8 paramType; uint8 operator; bytes compValue; }
interface IRoles {
    function assignRoles(address module, bytes32[] calldata roleKeys, bool[] calldata memberOf) external;
    function scopeTarget(bytes32 roleKey, address targetAddress) external;
    function allowTarget(bytes32 roleKey, address targetAddress, uint8 options) external;
    function scopeFunction(bytes32 roleKey, address targetAddress, bytes4 selector, ConditionFlat[] calldata conditions, uint8 options) external;
    function setAllowance(bytes32 key, uint128 balance, uint128 maxRefill, uint128 refill, uint64 period, uint64 timestamp) external;
    function setTransactionUnwrapper(address to, bytes4 selector, address adapter) external;
    function execTransactionWithRole(address to, uint256 value, bytes calldata data, uint8 operation, bytes32 roleKey, bool shouldRevert) external returns (bool);
}
interface IModuleProxyFactory {
    function deployModule(address masterCopy, bytes memory initializer, uint256 saltNonce) external returns (address proxy);
}
```

---

## 1. Spike steps

### Step 1: Deploy a Roles proxy and attach it to a test account

Test account (`src/SpikeAccount.sol`): a minimal avatar that implements `execTransactionFromModule(address,uint256,bytes,uint8)` and `execTransactionFromModuleReturnData(...)`, callable **only** by its Roles proxy, supporting `call` and (for the batch test only) `delegatecall`. This mirrors Option 2. Optional variant: repeat with a Safe 1.4.1 proxy (`0x4e1D...ec67` factory, `0x29fc...C762` SafeL2) and `enableModule(roles)` to mirror Option 1.

```solidity
function setUp() public {
    vm.createSelectFork("https://rpc.monad.xyz");
    account = new SpikeAccount();
    bytes memory init = abi.encodeWithSignature(
        "setUp(bytes)", abi.encode(address(this) /*owner*/, address(account) /*avatar*/, address(account) /*target*/));
    roles = IRoles(IModuleProxyFactory(MODULE_PROXY_FACTORY).deployModule(ROLES_MASTERCOPY, init, 1));
    account.setModule(address(roles));
    deal(address(account), 0);                     // native balance irrelevant
    vm.deal(address(this), 1000 ether);
    IWMON(WMON).deposit{value: 1000 ether}();
    IERC20(WMON).transfer(address(account), 1000 ether);
    _fundUsdc(address(account), 10_000e6);         // deal() or prank a holder; USDC is a proxy (open question 9)
}
```

**Success:** proxy has code; `owner()` = test contract; `avatar()` and `target()` = account; account balances funded.

### Step 2: Grant a role scoped to one Uniswap swap function

Role `SWAPPER = keccak256("agent-1/owner-epoch-1/config-epoch-1")`, member `sessionKey = makeAddr("session")`.

`exactInputSingle` (`0x04e45aaf`) condition tree in BFS order (tokens limited to USDC and WMON until WETH and LST are known):

| idx | parent | paramType | operator | compValue |
|---|---|---|---|---|
| 0 | 0 | Calldata (5) | Matches (5) | |
| 1 | 0 | Tuple (3) | Matches (5) | |
| 2 | 0 | None (0) | CallWithinAllowance (30) | `bytes32("trades-per-day")` |
| 3 | 1 | None | Or (2) | tokenIn |
| 4 | 1 | None | Or (2) | tokenOut |
| 5 | 1 | None | Or (2) | fee |
| 6 | 1 | Static (1) | EqualToAvatar (15) | recipient |
| 7 | 1 | Static | WithinAllowance (28) | `bytes32("usdc-turnover")` on amountIn |
| 8 | 1 | Static | Pass (0) | amountOutMinimum |
| 9 | 1 | Static | Pass (0) | sqrtPriceLimitX96 |
| 10, 11 | 3 | Static | EqualTo (16) | `abi.encode(USDC)`, `abi.encode(WMON)` |
| 12, 13 | 4 | Static | EqualTo | same |
| 14, 15 | 5 | Static | EqualTo | `abi.encode(uint24(500))`, `abi.encode(uint24(3000))` |

Token `approve` (`0x095ea7b3`) on USDC and WMON: `[0: Calldata Matches, 1: Static EqualTo abi.encode(SWAP_ROUTER_02), 2: Static LessThan abi.encode(cap + 1)]`.

```solidity
roles.assignRoles(sessionKey, _one(SWAPPER), _oneTrue());
roles.scopeTarget(SWAPPER, SWAP_ROUTER_02);
roles.scopeFunction(SWAPPER, SWAP_ROUTER_02, 0x04e45aaf, swapTree, 0 /*None*/);
roles.scopeTarget(SWAPPER, USDC);  roles.scopeFunction(SWAPPER, USDC, 0x095ea7b3, approveTree(1_000e6), 0);
roles.scopeTarget(SWAPPER, WMON);  roles.scopeFunction(SWAPPER, WMON, 0x095ea7b3, approveTree(100 ether), 0);
roles.setAllowance("trades-per-day", 20, 20, 20, 86400, 0);
roles.setAllowance("usdc-turnover", 5_000e6, 5_000e6, 5_000e6, 86400, 0);
```

**Success:** all `scopeFunction` calls pass `Integrity.enforce` (a revert here means the BFS layout, especially the position of the `CallWithinAllowance` node, is wrong; compare with the SDK output of `c.calldataMatches(..., { callWithinAllowance })` run through `flattenCondition`).

### Step 3: An allowed swap succeeds

```solidity
function test_allowedSwap() public {
    vm.startPrank(sessionKey);
    roles.execTransactionWithRole(USDC, 0, abi.encodeCall(IERC20.approve, (SWAP_ROUTER_02, 100e6)), 0, SWAPPER, true);
    roles.execTransactionWithRole(SWAP_ROUTER_02, 0, abi.encodeWithSelector(0x04e45aaf,
        Params(USDC, WMON, 500, address(account), 100e6, minOut, 0)), 0, SWAPPER, true);
    vm.stopPrank();
    assertEq(IERC20(USDC).balanceOf(address(account)), usdcBefore - 100e6);
    assertGe(IERC20(WMON).balanceOf(address(account)), wmonBefore + minOut);
    assertEq(IERC20(USDC).allowance(address(account), SWAP_ROUTER_02), 0);
}
```

**Success:** swap executes, output lands in the account, allowance counters drop by 1 trade and 100e6 USDC (`cast call roles "allowances(bytes32)"` shows new balances; note the getter shows stored, not accrued, values).

### Step 4: Each forbidden action is rejected

Each test uses `vm.prank(sessionKey)` and `vm.expectRevert(abi.encodeWithSelector(ConditionViolation.selector, <status>, <info>))` (or a bare `expectRevert` where noted).

| # | Case | Call | Expected |
|---|---|---|---|
| 4a | Wrong recipient | `exactInputSingle` with `recipient = attacker` | `ParameterNotAllowed` (7) |
| 4b | Router special recipient | `recipient = address(2)` (router) | `ParameterNotAllowed` (7) |
| 4c | Disallowed token | `tokenOut = random ERC-20` | `OrViolation` (5) |
| 4d | Disallowed fee tier | `fee = 100` | `OrViolation` (5) |
| 4e | Unlimited approval | `approve(router, type(uint256).max)` | `ParameterGreaterThanAllowed` (9) |
| 4f | Approval to other spender | `approve(attacker, 1)` | `ParameterNotAllowed` (7) |
| 4g | Delegatecall | same allowed swap with `operation = 1` | `DelegateCallNotAllowed` (1) |
| 4h | Native value | allowed swap with `value = 1` (fund account with MON first) | `SendNotAllowed` (4) |
| 4i | Unscoped selector | `sweepToken`, `unwrapWETH9`, `multicall(uint256,bytes[])`, `exactInput` | `FunctionNotAllowed` (3) |
| 4j | Unscoped target | `USDC.transfer(attacker, 1)` via a token with only `approve` scoped | `FunctionNotAllowed` (3); any other address: `TargetAddressNotAllowed` (2) |
| 4k | Batch hiding a forbidden call | Owner calls `setTransactionUnwrapper(MULTISEND_CALLONLY_141, 0x8d80ff0a, MULTISEND_UNWRAPPER)`. Member sends delegatecall to MultiSendCallOnly with `[approve(router, 100e6) (allowed), USDC.transfer(attacker, 1) (forbidden)]` | `FunctionNotAllowed` (3), whole batch reverts |
| 4l | Batch without unwrapper | Same batch, unwrapper not registered | `TargetAddressNotAllowed` (2) |
| 4m | Batch splitting to beat allowance | 6 swaps of 1,000e6 USDC inside one MultiSend (budget 5,000e6) | `AllowanceExceeded` (17) |
| 4n | Exceeding turnover allowance | Sequential swaps totaling more than 5,000e6 in one day | `AllowanceExceeded` (17) on the swap that crosses |
| 4o | Exceeding trade count | 21st swap in the window | `CallAllowanceExceeded` (18) |
| 4p | Boundary burst | 20 swaps just before the refill boundary, `vm.warp` 1 s past it, 20 more | Documents the Partial rating: expect all 40 to pass |
| 4q | Non-member | Same allowed swap from `makeAddr("stranger")` | Bare revert (not an enabled module) |
| 4r | amountOutMinimum = 0 | Allowed swap with `minOut = 0` | **Passes** (documents that Roles cannot enforce slippage) |

**Success:** every row behaves as expected. 4p and 4r are expected to pass and are recorded as evidence for the Partial and Not supported ratings.

### Step 5: Revoke and confirm the next call fails in the same block

In Foundry (no block advance between calls, so both are in one block):

```solidity
function test_revokeSameBlock() public {
    uint256 blk = block.number;
    roles.assignRoles(sessionKey, _one(SWAPPER), _oneFalse());   // owner revokes
    vm.prank(sessionKey);
    vm.expectRevert();                                            // NoMembership()
    roles.execTransactionWithRole(SWAP_ROUTER_02, 0, swapData, 0, SWAPPER, true);
    assertEq(block.number, blk);
}
```

On anvil with real block building:

```bash
cast rpc evm_setAutomine false --rpc-url http://127.0.0.1:8545
cast send $ROLES "assignRoles(address,bytes32[],bool[])" $SESSION "[$SWAPPER]" "[false]" --private-key $OWNER_PK --priority-gas-price 2gwei --rpc-url http://127.0.0.1:8545 --async
cast send $ROLES "execTransactionWithRole(address,uint256,bytes,uint8,bytes32,bool)" $ROUTER 0 $SWAP_DATA 0 $SWAPPER true --private-key $SESSION_PK --priority-gas-price 1gwei --rpc-url http://127.0.0.1:8545 --async
cast rpc evm_mine --rpc-url http://127.0.0.1:8545
cast receipt <swapTxHash> status   # 0 (reverted), same block number as the revoke
```

Also test: revoke, then `scopeTarget` again and re-assign the old key, and confirm old function scopes come back (documents why role keys must never be reused). Then repeat with ordering reversed (member tx with higher priority fee) to show that a front-running member transaction succeeds.

**Success:** member call reverts in the same block once the revoke is ordered first; the reuse test shows revival.

### Step 6: Gas, scoped versus unscoped

Measure the same 100e6 USDC to WMON `exactInputSingle` four ways, using `vm.startSnapshotGas` / `vm.stopSnapshotGas` (or `gasleft()` deltas) and `forge test --gas-report`:

| Variant | Setup |
|---|---|
| A. Direct | Account owner path calls the router directly (no Roles) |
| B. Roles, unscoped | `allowTarget(SWAPPER, SWAP_ROUTER_02, 0)` |
| C. Roles, scoped | Step 2 tree without allowances |
| D. Roles, scoped + allowances | Step 2 tree with `CallWithinAllowance` and `WithinAllowance` |
| E. (Optional) Option 3 prototype | A 150-line `Executor.swap(intent)` with epoch check, 2 oracle reads, `slot0`, 4 balance reads, ring buffer write, post-checks |

Report C minus A and D minus A as the Roles overhead, and E minus A as the Option 3 overhead. Also measure the one-off cost of `scopeFunction` for the swap tree the first time (blob deploy) and the second time on a new proxy (dedupe).

Caveat: anvil applies the standard Ethereum gas schedule, not Monad's repricing, and Monad charges on gas limit rather than gas used (Inferred). Repeat C, D and E with `eth_estimateGas` on Monad testnet (10143) or a small mainnet deployment to get real numbers.

**Success:** a table of overheads for C, D and E, and confirmation that Report 1's 25k to 70k estimate holds or is corrected.

### Step 7: Checks specific to our design

| Test | Purpose |
|---|---|
| `setAvatar(other)` by owner flips every `EqualToAvatar` | Confirms the owner is a full controller |
| Custom condition prototype: `ICustomCondition` that reads `block.timestamp` and a mock oracle, placed on `amountOutMinimum` | Confirms a `Custom` checker can enforce deadline and slippage, and measures its cost |
| Two Roles proxies scoping the same tree | Confirms `WriteOnce` dedupe (same pointer in both headers) |
| Swap through ArraySome-dependent config on 2.1.0 vs 2.1.1 mastercopy | Confirms 2.1.1 fix and that 2.1.0 must not be used |

---

## 2. Open questions

| # | Question | Why it matters | How to resolve |
|---|---|---|---|
| 1 | Is a price oracle available on Monad for MON, WETH and our LST (Chainlink, Pyth, Redstone, Chronicle), and what are the heartbeats and deviation thresholds? | Every percentage, slippage and breaker rule depends on it; a 5-minute freshness rule needs a heartbeat under 5 minutes or a pull oracle | Provider docs; read feeds on chain |
| 2 | How deep is liquidity in the Monad Uniswap v3 pools for each allowed pair and fee tier? Is liquidity migrating to Uniswap v4 or other venues? | Fee-tier pinning, slippage bound realism, manipulation cost | Read `liquidity()` and ticks per pool; DEX analytics |
| 3 | Which WETH and which LST addresses do we use on Monad? | Asset allowlist | Product decision plus on-chain verification |
| 4 | Is `origin/v2@218a5164` exactly the source of `0xF2964...`, and is there any review of the 2.1.1 delta? | Audit baseline for Options 1 and 2 | Recompile with the recorded `compilerInput`; ask Gnosis Guild |
| 5 | Will Gnosis Guild merge 2.1.1 into `main`, and will the `main` refactor (new `AbiDecoder`, EIP-712) ever be audited or deployed? | Which code line to track | Ask maintainers |
| 6 | Is v3 going to be audited and released, and under what BUSL "Additional Use Grant"? | v3's memberships and pricing close some gaps | Legal review; maintainer roadmap |
| 7 | Does `@zodiac-os/sdk` or the Zodiac API support chain 143, and do they gate features behind a license? | Diff and apply tooling for Options 1 and 2 | Ask Zodiac; test |
| 8 | Monad gas: exact schedule for cold SLOAD, cold account access, `extcodecopy`, and the effect of charging on gas limit | Real cost of Roles checks and of our Executor | Step 6 on testnet; Monad docs |
| 9 | Does forge-std `deal` work for Monad USDC (proxy storage layout), or do we need a holder to impersonate? | Test setup | Try in Step 1 |
| 10 | Monad mempool and ordering: can a compromised key see and front-run a revoke? Are there private transaction paths? | Revocation race, sandwich risk | Monad docs; Step 5 on testnet |
| 11 | Does Monad support EIP-1153 transient storage? | Needed if we ever use v3 or our own transient reentrancy guard | Monad docs; quick test |
| 12 | Should PersonalAccount funds travel with the NFT on sale, or must they be swept to the seller first? | Escrow rules, buyer expectations | Product decision |
| 13 | For the StrategyVault, who does "owner review" after a 20% drawdown: the agent owner, the platform, or depositors (via a vote or withdrawal window)? | Circuit breaker design for third-party funds | Product and legal decision |
| 14 | Do Privy server-wallet policies support restricting a key to one contract and selector on chain 143, with gas caps? | Defense in depth before the on-chain Executor | Privy docs; test |
| 15 | Is `0xd54895B1121A2eE3f37b502F507631FA1331BED6` on Monad the canonical Zodiac Delay mastercopy, and is the ModuleProxyFactory byte-identical to the canonical build? | Only relevant if we layer a Delay module (Options 1 and 2) | Byte-compare with zodiac-core artifacts |
| 16 | Does `CallWithinAllowance` placed per element inside a `multicall(bytes[])` array (via `ArrayEvery`) count each inner swap? | Only relevant if router `multicall` is ever allowed | Add to Step 4 |
