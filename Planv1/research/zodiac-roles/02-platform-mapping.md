# Report 2: How Zodiac Roles fits our platform

Source baseline: repo `gnosisguild/zodiac-modifier-roles`, `main` at `820e5bc975d1817bdd4bc4a95226f553f7b67b68` (2026-08-25, tag `zodiac-roles-sdk-v4.1.3`). Deployed Roles is **v2.1.1** (`origin/v2@218a5164`, mastercopy `0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5`, present on Monad chain 143). v2 license LGPL-3.0+. Unreleased v3 (`origin/contracts-v3@47dd69bd`) is BUSL-1.1 and unaudited. See Report 1 for details and citations.

Labels: **Verified** = read in code or observed on chain. **Inferred** = reasoning or design proposal. All architecture and configuration in sections 2.2 to 2.6 is design proposal and therefore Inferred unless a Roles behavior is cited.

---

## 2.1 Limit coverage

"Roles v2" = deployable today on Monad. "v2 + Custom" = Roles plus an `ICustomCondition` contract we write and audit (still counted as Partial because the logic is ours). v3 is shown for reference only (unaudited, BUSL).

| Hard limit | Roles v2 | How (or why not) | v3 (reference) |
|---|---|---|---|
| Allowed assets: USDC, WMON, WETH, one LST | **Native** | `Or` of `EqualTo` on `tokenIn` / `tokenOut`; only those token addresses scoped for `approve` (`PermissionChecker._walk`, `_or`, `_compare`) | Native |
| One swap venue: Uniswap | **Native** | Only SwapRouter02 is `scopeTarget`-ed; every other address has `Clearance.None` (`_transaction`) | Native |
| Swap recipient = source account | **Native** | `EqualToAvatar` on `recipient` (`PermissionLoader._load`). Requires avatar == the account and no router side doors (`sweepToken`, `unwrapWETH9`, `multicall` unscoped) | Native |
| Exact-amount approvals only | **Partial** | `approve(spender = EqualTo router, amount = LessThan cap or WithinAllowance)`. Roles cannot bind the approve amount to the swap's `amountIn` (each call is evaluated independently, `_multiEntrypoint`), and cannot require the approval to be reset afterwards | Partial (Pluck context is per call) |
| Max 10% of account value per trade | **Not supported** | No balance or price reads. Only an absolute per-token `LessThan` cap. A `Custom` checker could compute NAV pre-trade | Not supported natively |
| Max 40% of account value in any non-USDC asset | **Not supported** | Needs post-trade holdings vs NAV. Roles has no post-execution hook (`Roles.sol` runs only `_flushCommit` after exec). A `Custom` checker can only project pre-trade | Not supported |
| At least 10% in USDC | **Not supported** | Same as above | Not supported |
| Max 0.5% slippage | **Not supported** | `amountOutMinimum` can only be compared to a constant. `Custom` checker with an oracle could enforce it | Partial: `WithinRatio` + pricing adapter (adapter unmerged) |
| Max 20 trades per day | **Partial** | `CallWithinAllowance`, `refill = maxRefill = 20`, `period = 86400`. Fixed windows (`_accruedAllowance`) allow up to 40 trades across a window boundary; a strict rolling cap needs a smaller bucket (for example 10 max, 1 per 9,600 s) | Partial |
| 2-minute transaction deadline | **Not supported** | No operator reads `block.timestamp`. SwapRouter02 `exactInputSingle` has no deadline field; `multicall(uint256 deadline, bytes[])` deadline can only be compared to a constant. Needs `Custom` | Not supported |
| Oracle price under 5 minutes old | **Not supported** | `Custom` only | Partial: `ChainlinkPricing.maxAge` (unmerged branch) |
| Oracle within 2% of pool price | **Not supported** | `Custom` only (read oracle and pool `slot0`) | Partial: `ConsensusPricing` (unmerged, uses TWAP not spot) |
| Circuit breaker: -10% from 7-day peak reduce-only, -20% pause | **Not supported** | Needs persistent NAV history; custom checkers are view-only and stateless | Not supported |
| No delegatecall | **Native** | `ExecutionOptions.None` on every grant (`_executionOptions`) | Native |
| No arbitrary calls | **Native** | `scopeTarget` + explicit `scopeFunction` only; never `allowTarget` / `allowFunction` | Native (avoid `allowFunctionGlobally`) |
| No native value sends | **Native** | `ExecutionOptions.None`; use WMON, not native MON | Native |
| No leverage, no lending | **Native** | Lending and perp contracts are simply never scoped | Native |
| Owner epoch and config epoch binding | **Not supported** | No epochs; membership is a boolean. Emulate with a fresh role key per epoch plus off-chain revocation, or a `Custom` epoch check | Partial (membership start/end/uses) |
| Stale permissions must never come back | **Partial** | Possible only by never reusing role keys, because `revokeTarget` keeps function scopes (`PermissionBuilder.revokeTarget`) and re-granting a role restores everything | Partial |
| Owner can always withdraw | **Not a Roles concern** | Must be enforced by the account contract, independent of Roles | Same |
| Depositor funds never withdrawn or redirected (vault) | **Partial** | Roles can scope the session key tightly, but the Roles **owner** can grant anything; vault must enforce its own invariants | Same |

**Summary:** of the 13 launch limits in the brief, Roles v2 natively covers 4 (allowed assets, one venue, recipient = source account, and the ban on delegatecall, arbitrary calls, leverage and lending), partially covers 2 (exact approvals, 20 trades per day), and covers none of the 7 value-, price- or time-based limits (10% per trade, 40% cap, 10% USDC floor, slippage, deadline, oracle age and deviation, circuit breaker). Every percentage, oracle, deadline, circuit breaker and epoch rule must be built by us regardless of which option we choose.

---

## 2.2 Architecture options

### Option 1: Safe plus Roles

PersonalAccount and the vault's execution account are Safe 1.4.1 proxies (deployed on Monad). A Roles 2.1.1 proxy is enabled as a Safe module; the Privy session key is a role member; a `Custom` condition contract handles oracle, deadline and NAV checks.

| Aspect | Assessment |
|---|---|
| Security | Battle-tested Safe and audited Roles core. But Safe owners are fixed addresses: they do not follow NFT transfers, so we need an extra module or guard that rotates Safe owners on every transfer. Any Safe owner can bypass Roles entirely with a direct Safe transaction. |
| Roles enforces | Assets, venue, recipient, no delegatecall or value, selector scoping, trade count (fixed window) |
| We build | Custom condition (NAV, 10% per trade, slippage, deadline, oracle freshness and deviation, epoch check), post-trade 40% / 10% checks (impossible inside Roles: needs a final "assert" call in a MultiSend batch or a wrapper), circuit breaker state, owner-rotation module, Roles owner contract with instant-revoke and delayed-grant paths, diff and apply tooling (SDK v4 dropped it) |
| Owner withdrawals | Natural for PersonalAccount if the Safe owner is the NFT owner, but that requires the owner-rotation module to be correct. |
| ERC-4626 | Poor fit. The vault would be a separate ERC-4626 contract whose assets sit in a Safe. Whoever owns that Safe, or the Roles modifier, can move depositor funds. To satisfy "never withdraw depositor funds" the Safe must have no human owners, which removes the reason to use a Safe. |
| Epochs and transfers | Role key per `(agent, ownerEpoch, configEpoch)`; a keeper or the transfer hook must call `assignRoles(..., false)` and rotate Safe owners. Not automatic; a missed revoke leaves the old key live. |
| Gas | Safe `execTransactionFromModule` + Roles checks (estimated 40k to 70k) + custom checker (oracle reads) + post-check batch. Highest of the three. |
| Complexity | High: Safe, Roles, custom checker, owner-rotation module, admin contract, MultiSend unwrapper for post-checks. |
| Audit burden | Our custom checker, rotation module, admin contract and the Roles configuration. Roles 2.1.1 fixes are unaudited but small. |

### Option 2: Roles in front of our own accounts

PersonalAccount and StrategyVault are our contracts that implement `execTransactionFromModule(address,uint256,bytes,uint8)` and `...ReturnData`, callable only by their Roles proxy. Roles owner is our policy-admin contract.

| Aspect | Assessment |
|---|---|
| Security | Our accounts expose a generic "execute any call" function whose only guard is the Roles configuration. A single mis-scoped function (`allowFunction` on a token, a wildcarded router method) or a compromised Roles owner exposes everything. Our account must also reject delegatecall itself. |
| Roles enforces | Same as Option 1 |
| We build | Same custom checker and post-check workaround as Option 1, plus the `IAvatar` surface on both accounts, plus the Roles owner contract. Epochs still external. |
| Owner withdrawals | Clean: `withdraw` on our account checks `AgentNFT.ownerOf` live, independent of Roles. |
| ERC-4626 | Better than Option 1: the vault can refuse any call that would move assets out except through known paths. But once the vault has a generic execute function, enforcing "depositor funds never leave" means re-implementing target and selector checks inside the vault, which duplicates Roles. |
| Epochs and transfers | Same emulation as Option 1, but the owner-rotation problem disappears because withdrawals read `ownerOf` live. |
| Gas | Roles overhead + custom checker + post-check. Slightly below Option 1 (no Safe). |
| Complexity | Medium-high. Two permission systems (Roles and our checker) with state split between them. |
| Audit burden | Our accounts' `IAvatar` surface, custom checker, admin contract, Roles configuration. Also integration risk: Roles' generic calldata model is exactly what the pitfalls in Report 1 section 7.2 attack. |

### Option 3: Our own Executor, borrowing Roles' design (recommended)

A purpose-built `Executor` accepts **typed intents** (not arbitrary calldata) from the session key, validates every hard limit, and calls a narrow `executeSwap` function on the account. The account builds the Uniswap calldata itself, so there is no generic call surface to scope. The Executor copies the Roles patterns we need and adds what Roles lacks.

| Aspect | Assessment |
|---|---|
| Security | Smallest attack surface: no arbitrary calldata, no selector tables, no delegatecall path, no unwrappers. Recipient, exact approval and approval reset are hard-coded in the account's swap function. Post-trade balance checks run in the same transaction. Main risk shifts to our own code quality and to the oracle. |
| Roles enforces | Nothing at runtime. We borrow its designs (section "What we borrow" below). |
| We build | Executor, PolicyRegistry, SessionGrant (epoch-bound), valuation and oracle module, circuit breaker, account swap functions. All limits live in one place. |
| Owner withdrawals | `PersonalAccount.withdraw` checks `AgentNFT.ownerOf(agentId)` live; no dependency on Executor, Privy, or our backend. |
| ERC-4626 | Best fit. The vault has no generic execute; it only exposes `executeSwap` to the Executor, and the Executor post-checks that NAV did not fall by more than the slippage bound and that every token balance change is exactly `-amountIn` of tokenIn and `+>=minOut` of tokenOut. `totalAssets()` uses the same oracle valuation. |
| Epochs and transfers | Native: grants are keyed by `(agentId, ownerEpoch, configEpoch)` and checked on every call. A transfer bumps `ownerEpoch` inside `AgentNFT._update`, so old grants die in the same transaction as the transfer, with no keeper. Epochs are monotonic, so returning an NFT never revives an old grant. |
| Gas | Inferred: roughly 60k to 110k overhead (4 cold oracle reads, pool `slot0`, 4 to 8 balance reads, one or two SSTOREs for rate limits and peak tracking). Similar to the oracle-checking part of Options 1 and 2, without the Roles overhead on top. Must be measured. |
| Complexity | Medium: fewer moving parts, but all custom. |
| Audit burden | Full audit of our contracts (unavoidable in every option, because the price, NAV, deadline, epoch and circuit-breaker logic is ours anyway). No need to audit a Roles configuration or our integration with Roles' generic call model. |

### Recommendation: Option 3

Reasons:
1. Roles covers only the easy half of our limits (allowlists, recipient, no delegatecall). Those are trivial to hard-code when the account builds its own calldata. The hard half (percentages, oracle, slippage, deadline, circuit breaker, epochs, post-trade checks) must be written by us in every option.
2. Roles' generality is a liability for us: its most serious pitfalls (wildcards, `allowTarget`, router side doors, delegatecall grants, stale scopes after `revokeTarget`, the owner being a full controller) only exist because it accepts arbitrary calldata. Typed intents remove that class of bugs.
3. Epochs must invalidate grants atomically with NFT transfers, including transfers on outside marketplaces later. Roles has no hook for that; our own Executor reads epochs on every call.
4. ERC-4626 vault safety needs vault-level invariants anyway. With Roles in front, we would implement them twice.
5. Roles' code base on `main` diverges from what is deployed and audited, and the parts that would help (v3 pricing, memberships) are unaudited and BUSL.

What we borrow from Roles (reimplemented, not copied, to avoid LGPL obligations; Inferred design):

| Roles pattern | Source (Verified) | How we use it |
|---|---|---|
| Recipient bound to the account (`EqualToAvatar`) | `PermissionLoader._load` | Account passes `recipient = address(this)` itself, plus a post-trade balance-delta check |
| Target + selector allowlist, deny by default | `PermissionChecker._transaction`, `_Core._key` | Venue registry: `(adapter or router address, action type)` must be enabled for the agent's policy |
| Token-bucket allowance with debit before exec and restore on failure | `AllowanceTracker._accruedAllowance`, `_flushPrepare`, `_flushCommit` | Daily turnover budgets. For trade count we use a stricter rolling ring buffer |
| Membership with start, end and uses left | v3 `core/Membership.sol` (idea only, BUSL) | Session grant has `validUntil` and optional `usesLeft` in addition to epochs |
| Content-addressed, write-once policy blobs | `WriteOnce.store`, dedupe via CREATE2 | Policy sets stored once and referenced by hash from tiers and skills |
| `ExecutionOptions.None` everywhere | `_executionOptions` | No value, no delegatecall paths exist at all |
| Regression cases (ArraySome, Bitmask padding, MultiSend smuggling, ERC-1271 revert) | `origin/v2` tests, `test/*` | Port as adversarial tests for our Executor |

---

## 2.3 Permission design for launch (Option 3)

### Contracts (Inferred design)

| Contract | Responsibility |
|---|---|
| `AgentNFT` | ERC-721. `ownerEpoch[agentId]++` in `_update` on every mint and transfer. |
| `PolicyRegistry` | Stores policy sets by hash, maps tier and equipped skills to policy hashes, holds `configEpoch[agentId]`. Loosening changes go through a timelock; tightening is instant. |
| `SessionGrants` | `grant[agentId] = { sessionKey, ownerEpoch, configEpoch, validUntil, usesLeft }`, written only by the current NFT owner (direct call or EIP-712 signature). |
| `Executor` | Only entry point for the session key. Validates intents, calls the account, runs post-checks, updates rate limits and peak tracking. |
| `Valuation` | Oracle reads (freshness, deviation from pool), NAV in USDC terms. |
| `PersonalAccount` | Holds owner funds. `withdraw` for the live NFT owner. `executeSwap` only for the Executor. |
| `StrategyVault` | ERC-4626 (asset = USDC). `totalAssets()` from `Valuation`. `executeSwap` only for the Executor. No other asset-moving function except `withdraw` / `redeem` for share holders. |

### Launch policy (pseudo-configuration)

```yaml
policy: launch-v1
chainId: 143
assets:                              # allowlist; all others rejected
  USDC:  0x754704Bc059F8C67012fEd69BC8A327a5aafb603   # verified on Monad
  WMON:  0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A   # verified (SwapRouter02.WETH9)
  WETH:  TBD                                           # open question
  LST:   TBD                                           # open question (one LST)
venues:
  uniswap_v3_swaprouter02:
    router: 0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900   # verified on Monad
    factory: 0x204faca1764b154221e35c0d20abb3c525710498
    actions: [exactInputSingle]      # selector 0x04e45aaf; no exactInput, no multicall,
                                     # no sweepToken/unwrapWETH9/refundETH, no UniversalRouter
    feeTiers: [500, 3000]            # pinned per pair after liquidity review
    pairs: any two distinct allowed assets
    recipient: self                  # hard-coded address(this) in the account
    sqrtPriceLimitX96: 0
approvals:
  mode: exact                        # forceApprove(router, amountIn) then approve(router, 0) after
  spender: router only
limits:
  maxTradeValueBps: 1000             # amountIn value <= 10% of NAV (pre-trade, oracle priced)
  maxNonUsdcAssetBps: 4000           # post-trade, each non-USDC asset <= 40% of NAV
  minUsdcBps: 1000                   # post-trade USDC >= 10% of NAV
  maxSlippageBps: 50                 # minAmountOut >= oracleOut * (1 - 0.5%)
  maxTradesPer24h: 20                # rolling ring buffer of last 20 trade timestamps
  maxDeadlineSeconds: 120            # now <= deadline <= now + 120
oracle:
  maxAgeSeconds: 300
  maxPoolDeviationBps: 200           # |poolSpot - oracle| / oracle <= 2%, pool read from slot0
  sources: TBD                       # Chainlink / Pyth / Redstone on Monad: open question
circuitBreaker:
  peakWindowDays: 7                  # 7 daily max-NAV-per-share buckets
  reduceOnlyDrawdownBps: 1000        # tokenOut must be USDC
  pauseDrawdownBps: 2000             # all trades blocked until owner resumes
forbidden: [delegatecall, nativeValue, arbitraryCall, lending, leverage]
```

### Intent and checks

```solidity
struct SwapIntent {
    address account;        // PersonalAccount or StrategyVault
    uint256 agentId;
    uint64  ownerEpoch;     // must equal AgentNFT.ownerEpoch(agentId)
    uint64  configEpoch;    // must equal PolicyRegistry.configEpoch(agentId)
    address tokenIn;
    address tokenOut;
    uint24  fee;
    uint256 amountIn;
    uint256 minAmountOut;
    uint64  deadline;
}
```

`Executor.swap(SwapIntent)`:
1. `msg.sender == grant.sessionKey`, grant epochs equal current epochs, `block.timestamp < validUntil`, `usesLeft > 0`.
2. `account` is bound to `agentId`; circuit breaker is not paused; in reduce-only mode `tokenOut == USDC`.
3. Assets, fee tier and pair allowed by the agent's policy hash.
4. `block.timestamp <= deadline <= block.timestamp + 120`.
5. Oracle prices for tokenIn and tokenOut are fresh (under 300 s) and within 2% of the pool's `slot0` price.
6. `value(amountIn) <= 10% * NAV`.
7. `minAmountOut >= amountIn * pIn / pOut * (1 - 0.5%)` (decimals normalized).
8. Rolling trade count: the oldest of the last 20 timestamps is more than 24 h ago.
9. Snapshot balances; call `account.executeSwap(router, tokenIn, tokenOut, fee, amountIn, minAmountOut)`. The account does `forceApprove(router, amountIn)`, `exactInputSingle(... recipient: address(this) ...)`, `approve(router, 0)`.
10. Post-checks: tokenIn balance fell by exactly `amountIn`; tokenOut balance rose by at least `minAmountOut`; no other allowed asset balance changed; router allowance is 0; each non-USDC asset is at most 40% of NAV; USDC is at least 10% of NAV; NAV fell by no more than `value(amountIn) * 0.5%` plus pool fee.
11. Update trade ring buffer, daily turnover bucket, and 7-day peak bucket. Emit an event with the intent hash.

### Reference: the same scope in Roles SDK format (for Option 1 or 2, or as a comparison)

This is what the Roles-enforceable part would look like on 2.1.1. It does not cover the Not supported rows in 2.1.

```ts
import { c } from "zodiac-roles-sdk"
const ROUTER = "0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900"
const TOKENS = [USDC, WMON, WETH, LST]
const anyToken = c.or(...TOKENS.map((t) => c.eq(t)))

const permissions = [
  // SwapRouter02.exactInputSingle, selector 0x04e45aaf
  {
    targetAddress: ROUTER,
    signature:
      "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
    condition: c.calldataMatches(
      [
        c.matches({
          tokenIn: anyToken,
          tokenOut: anyToken,
          fee: c.or(c.eq(500), c.eq(3000)),
          recipient: c.avatar,                 // EqualToAvatar
          amountIn: c.lte(MAX_AMOUNT_IN_RAW),  // absolute only; % of NAV not expressible
          // amountOutMinimum and sqrtPriceLimitX96 left unconstrained (v2 limitation)
        }),
      ],
      ["(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)"],
      { callWithinAllowance: "trades-per-day" } // CallWithinAllowance
    ),
    // send and delegatecall omitted = ExecutionOptions.None
  },
  // approve(router, amount) on each allowed token; amount capped, not bound to the swap
  ...TOKENS.map((token) => ({
    targetAddress: token,
    signature: "approve(address,uint256)",
    condition: c.calldataMatches(
      [c.eq(ROUTER), c.lte(MAX_APPROVE_RAW[token])],
      ["address", "uint256"]
    ),
  })),
]
// setAllowance("trades-per-day", balance 20, maxRefill 20, refill 20, period 86400, anchor 00:00 UTC)
// Never: allowTarget, allowFunction, multicall, sweepToken, unwrapWETH9, UniversalRouter, MultiSend delegatecall.
```

---

## 2.4 Epochs, transfers and tiers

### Epoch changes (Option 3)

| Event | What changes | Effect on session key |
|---|---|---|
| NFT transfer (any path, including OpenSea later) | `AgentNFT._update` increments `ownerEpoch` | Every existing grant fails check 1 immediately, in the same transaction as the transfer. No keeper or backend call needed. |
| NFT returns to a former owner | `ownerEpoch` increments again | Old grants carry an older epoch and can never match. |
| Build or policy change (skill equipped, tier change, owner edits limits) | `PolicyRegistry` increments `configEpoch` | Grants fail until the owner (new or current) signs a new grant for the current epochs. |
| Owner wants to stop the agent | Owner calls `SessionGrants.revoke(agentId)` or bumps `configEpoch` | Next call fails. Owner withdrawal never depends on this. |
| Emergency (platform) | Platform guardian can only **tighten**: pause an agent, pause a venue, or pause all trading | No loosening path without the timelock and owner signature. |

Comparison with Roles: in Options 1 and 2 the same outcome needs a role key per `(agentId, ownerEpoch, configEpoch)`, an explicit `assignRoles(sessionKey, [oldKey], [false])` for every transfer, and a rule that old keys are never re-granted (`revokeTarget` keeps function scopes, Report 1 section 4.1). A transfer on an outside marketplace would not trigger that revoke by itself, so the old key would stay live until a keeper acts. **Verified** for Roles behavior; mitigation Inferred.

### Agent sale through our escrow (launch)

1. Seller lists. Escrow records the agent's accounts, balances and policy hash at listing.
2. At settlement, escrow re-checks: no pause in effect, PersonalAccount balances match what the listing declared (or the account was swept to the seller, per the listing terms), vault state within declared bounds, no pending timelocked policy changes.
3. Escrow transfers the NFT. `ownerEpoch` increments in the same transaction, killing the seller-era session grant.
4. The buyer signs a new grant for the new epochs; the backend provisions or rebinds the Privy session key.

Outside marketplaces later: safety does not depend on the escrow, because the epoch bump happens in `AgentNFT._update`. The escrow only adds sale-fairness checks (balances and policy as advertised). Whether PersonalAccount funds travel with the NFT is a product decision (open question in Report 3); the safe default is that the listing must declare it and escrow enforces it.

### Tiers and skills without redeploying

- `PolicyRegistry` holds policy sets as data: asset lists, venues, fee tiers, limit parameters. A tier maps to a base policy hash; equipped skills map to extension hashes (for example "add lending venue X with LTV 0"). The effective policy is the base narrowed or extended by skills, computed and stored when the build changes (which bumps `configEpoch`).
- New **parameters** (more assets, another fee tier, a higher trade cap for a tier) need no new contracts: add a policy set through the timelock.
- New **action types** (lending) need new code for the action itself: deploy a new audited venue adapter and register it through the timelock; accounts reach it through a generic but typed `executeAction(adapter, ActionIntent)` path with the same post-trade balance checks. Accounts and Executor are not redeployed. At launch, keep only `executeSwap` and add the adapter path when lending is enabled.
- In Roles terms (Options 1 or 2), this maps to separate role keys per tier or skill and content-addressed condition blobs (`WriteOnce` dedupe), which does work without redeploys, but each new permission set is a set of `scopeFunction` transactions on every account's Roles proxy.

---

## 2.5 Full authorization flow (Option 3)

```mermaid
sequenceDiagram
    autonumber
    participant H as Hermes (AI, no keys)
    participant P as Policy service (off-chain)
    participant S as Simulator (Monad fork / eth_call)
    participant K as Session key (Privy server wallet + Privy policies)
    participant E as Executor (on-chain)
    participant R as PolicyRegistry / SessionGrants / AgentNFT
    participant V as Valuation (oracle + pool)
    participant A as PersonalAccount or StrategyVault
    participant U as Uniswap SwapRouter02

    H->>P: Typed SwapIntent (unsigned)
    Note over P: Mirrors all on-chain limits early:<br/>assets, venue, 10% trade, 40% / 10% USDC,<br/>0.5% slippage, 20/day, deadline, breaker state
    P->>S: Build tx and simulate
    S-->>P: Success, balance deltas, gas
    P->>K: Approved tx (to = Executor only)
    Note over K: Privy policy: only Executor.swap selector,<br/>chainId 143, value 0, gas cap
    K->>E: swap(intent)
    E->>R: grant, ownerEpoch, configEpoch, policy hash
    Note over E: Enforces: session key and epochs, grant expiry,<br/>asset / venue / fee allowlist, deadline <= now+120s,<br/>20 trades per rolling 24h, breaker (reduce-only / pause)
    E->>V: prices, freshness, pool deviation, NAV
    Note over E,V: Enforces: oracle < 5 min, within 2% of pool,<br/>amountIn <= 10% NAV, minOut >= oracle * 99.5%
    E->>A: executeSwap(router, tokenIn, tokenOut, fee, amountIn, minOut)
    Note over A: Enforces: caller is Executor, exact approve,<br/>recipient = address(this), approval reset to 0,<br/>no delegatecall / value / arbitrary call exists
    A->>U: exactInputSingle(recipient = account)
    U-->>A: tokenOut
    A-->>E: amountOut
    E->>V: post-trade NAV
    Note over E: Post-checks: exact balance deltas, allowance 0,<br/>each non-USDC <= 40%, USDC >= 10%,<br/>NAV loss within bound; update counters and 7-day peak
    E-->>K: success event (intent hash)
```

Owner withdrawal is a separate path: `NFT owner -> PersonalAccount.withdraw(token, amount, to)`, checked only against `AgentNFT.ownerOf`, with no Executor, Privy or backend involvement.

---

## 2.6 Risks (ranked)

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Oracle failure or manipulation.** Every percentage, slippage and breaker rule depends on prices. A stale or manipulated feed lets a compromised key trade at bad prices within limits, or lets vault depositors enter or exit at wrong NAV. | Freshness (5 min) and pool-deviation (2%) checks on every trade; fail closed on missing feeds; use a second source (TWAP or second provider) for vault deposits and withdrawals; confirm feed availability on Monad before build (open question). |
| 2 | **Session key compromise.** An attacker trading within limits can still bleed value (fees plus 0.5% slippage per leg: about 1.1% of the account per day at our limits, Inferred from Report 1 section 7.2). | Circuit breaker at 10% / 20%; grant `validUntil` and `usesLeft`; daily turnover budget below tolerable loss; Privy policy restricts the key to `Executor.swap`; anomaly monitoring and instant owner or guardian pause. |
| 3 | **Our own Executor bugs.** Option 3 moves all enforcement into unaudited new code. | Keep it small and non-generic; port Roles' adversarial tests; formal invariants (balance deltas, allowance zero, no value); two independent audits before mainnet; bug bounty; launch with low caps. |
| 4 | **Vault NAV and share-price attacks.** Trades, deposits and withdrawals in the same block around price moves; donation and inflation attacks on ERC-4626. | Oracle-based `totalAssets`; virtual shares and decimals offset; deposit/withdraw fees or delays; block trades and deposits in the same block if needed. |
| 5 | **Post-trade limits vs pool behavior.** The 40% / 10% checks can make valid trades revert after a price move, stranding the account above 40%. | Reduce-only trades (toward USDC) always allowed when limits are breached; policy service pre-checks with simulation. |
| 6 | **Epoch or grant logic mistakes** (for example a transfer path that skips `_update`, or a grant signed for a future epoch). | Only increment in `_update`; require exact epoch equality; test mint, burn, transfer, safeTransfer, and escrow paths; fuzz. |
| 7 | **Admin key risk.** PolicyRegistry and venue registry owners could loosen limits. | Timelock for any loosening (for example 48 h) with owner-visible events; guardian can only tighten; accounts' withdraw path never depends on admin. |
| 8 | **Venue changes.** Router or pool behavior change, liquidity migrating to Uniswap v4 or another venue on Monad. | SwapRouter02 is immutable (Inferred); pin fee tiers per pair after a liquidity review; new venues only through audited adapters. |
| 9 | **Monad specifics.** Gas charged on gas limit, repriced cold state access, block ordering and mempool visibility (front-running revocations or sandwiching). | Measure gas on fork; set tight gas limits; slippage bound limits sandwich profit. |
| 10 | **If Option 1 or 2 is chosen instead:** Roles misconfiguration (wildcards, side doors, `revokeTarget` revival), the Roles owner being a full controller, SDK diff tooling removed, `main` not matching deployed code. | Pin to 2.1.1 (`0xF2964...`), audit configuration against `origin/v2`, fresh role key per epoch, owner = policy contract with instant revoke and delayed grant. |
