# Report 2: What changes in our StrategyVault and Executor design

Inputs: Report 1 (`01-codebase-report.md`) and working notes in `notes/`. Versions: BoringVault `c9c221f9` (SEL-1.0, patterns only, no code reuse), hypurrquant `79e41cdc` (Apache 2.0, unaudited).

Labels: **Verified** (code or live onchain read), **Inferred** (our reasoning). Verdicts: **Confirms**, **Improves** (with the change), **Missing from ours**, **Conflicts with our rules**.

**Bottom line.** Neither repository has anything like our offline exit. Both let an operator freeze every exit, so on that point both conflict with our non-negotiable rule, and our design is stricter. The typed-intent Executor holds up: Veda itself added a typed swap layer (BoringSwapper) on top of Merkle because Merkle cannot express amounts, oracles or rate limits. Live oracle valuation also holds up. The repositories mostly improve our design in the details: where delays are enforced, who can mint and burn, how swaps are checked after execution, how lockups are set, and how exits survive token-level failures.

---

## 2.1 Design comparison table

| Area | Our current decision | BoringVault | hypurrquant | Verdict |
|---|---|---|---|---|
| Custody contract | Our own StrategyVault, Morpho-inspired, not a fork | 141-line immutable vault with generic `manage`, caller-priced `enter`, and `exit` that burns from any address (`BoringVault.sol`) (Verified) | Monolithic UUPS vault (Verified) | **Improves:** keep custody small and non-upgradeable like BoringVault, but with **no generic `manage`**, no external mint, and no burn of another user's shares. `redeemInKind` lives in the custody contract. |
| Module separation | Executor is a separate contract called by a platform session key | Manager, Teller, Accountant, Queue, Swapper are separate modules with roles in a shared RolesAuthority (Verified) | Libraries only for code size; no module separation (Verified) | **Confirms** the split. **Improves:** the vault should re-check hard invariants after every Executor call (share supply unchanged, USDC floor, 40% cap), so an Executor bug cannot break them. BoringVault's Manager checks only `totalSupply` (Verified). |
| Strategist restrictions | Typed intents with percentage, oracle, slippage, count, deadline, epoch limits | Merkle leaves bind target, selector, address args and value flag only; BoringSwapper adds typed swaps with oracle checks (Verified) | None onchain; keeper trades via offchain agent wallet (Verified) | **Confirms.** **Improves:** adopt adapter-validated calldata, realized-output oracle check, and pull-exact/approve-exact/reset from BoringSwapper (section 2.3). |
| Per-role permission sets | Session key for trading, emergency role that only reduces risk | Separate root per strategist; narrow "one-way" roots; micro-managers (Verified) | Admin, keeper, guardian roles (Verified) | **Improves:** express reduce-only as a **directional route table** (non-USDC to USDC only) used by a separate risk role and by handover mode, not a flag inside the trading path. |
| Root or policy updates | Risky changes wait behind timelocks longer than the maximum lockup | `setManageRoot` is immediate; delay only if the owner is a timelock (0 s, 300 s, 48 h seen) (Verified) | Upgrades 48 h in code; role grants and most config instant (Verified) | **Confirms** our rule and shows why it must be **enforced in our contracts**, not by ownership convention. **Missing from ours:** a hard-coded maximum lockup constant so "longer than the maximum lockup" is a fixed number. |
| Exchange rate or valuation | Oracle-based multi-token valuation once per transaction, virtual shares, rounding for the vault, buy/sell spread | Offchain bot pushes a rate; bounds per update; violation stores the rate and pauses (Verified) | Live NAV from chain state; failed reads count as zero (Verified) | **Confirms** live valuation (section 2.4). **Improves:** revert on any failed read (never count zero), per-asset spread, larger virtual offset. |
| Rate movement limits | Oracle freshness and deviation checks | Upper/lower bound per update plus minimum delay, pause on violation (Verified) | 5% oracle vs mark divergence gate on deposits only (Verified) | **Missing from ours:** a vault-level circuit breaker on the **share price**. Adopt a time-scaled reference price that **rejects** (not pauses) deposits and USDC exits outside a band. Never applies to `redeemInKind`. |
| Fees and high-water mark | Deferred; must support performance fee over HWM | Platform fee on min(shares) at min(rate); global share-price HWM; owner can reset HWM; fee liability not netted onchain (Verified) | Per-user cost-basis fee at exit, fee rate snapshot, 24 h fee-change timelock, accrued fees excluded from NAV (Verified) | **Improves:** per-user entry price, fee taken in shares at exit, no HWM reset, fee changes timelocked and snapshotted (section 2.6). |
| Leader stake | Leader keeps at least 5% | None (Verified) | None (Verified) | **Missing from both repos.** We must design it; see change 9. |
| Deposits | Oracle-priced deposit with spread; leader can close deposits | Per-asset premium, `minimumMint`, share-supply cap, deny lists, role-gated third-party deposit (Verified) | Global and per-user caps; `receiver == msg.sender` (Verified) | **Improves:** add `minSharesOut`, an asset-denominated TVL cap for launch, and a `depositsOpen` flag that is separate from any pause. Both repos couple "close" to "pause", which also blocks exits. |
| Share locks and lockup | 1-day default, leader can extend | Per-address lock, hard max 3 days, reset by every deposit; lowering the period lets pending locks escape (Verified) | Redeem timelock 1 h to 7 days, snapshotted per request (Verified) | **Improves:** store each deposit's unlock time at deposit; extensions apply only to new deposits; hard max constant; do not let third parties relock someone else (require `receiver == msg.sender` or lock per lot). |
| Withdrawals | USDC while above the 10% floor, else pro-rata sale via allowlisted pools with oracle and user minimums; revert on failure | Single-asset at the stored rate; reverts if idle balance is short; operator can pause, deny, disable (Verified) | Keeper-gated async; `redeem` is pausable (Verified) | **Confirms**; ours has better availability. **Improves:** operators or relayers may trigger exits but proceeds always go to the owner (hypurrquant receiver = controller). |
| Queue | None planned | On-chain queue with solver, discounts, maturity up to 30 days (Verified) | ERC-7540 FIFO with reservation and ERC-7887 cancel (Verified) | **Confirms** no queue at launch (section 2.5). |
| Offline exit | `redeemInKind`: no oracle, DEX, Executor or platform; nothing can pause it | None. Every exit needs Teller, Accountant, roles and liquidity; pause, auto-pause, deny list and remediation can block it (Verified) | None. Needs keeper and unpaused vault (Verified) | **Conflicts with our rules:** both designs violate it; do not import their exit paths. **Missing from ours:** protection against a single token transfer reverting (USDC blacklist or pause) and blocking the whole in-kind exit (change 2). |
| Handover | Agent sale puts the vault into reduce-only handover until the new owner can trade | Nothing; changing a strategist root goes through the owner's timelock (48 h on vmUSD) (Verified) | Nothing | **Confirms** our epoch design. **Improves:** handover should switch the route table to reduce-only in the same transaction as the sale and bump the ownership epoch, with a new-owner delay at least the maximum lockup. |
| Upgradeability | Own contracts, Morpho-style timelocks | Immutable vault; modules replaced by re-pointing roles (Verified) | UUPS with 48 h in-code timelock and guardian veto; instant role grants undermine it (Verified) | **Improves:** immutable custody; the Executor address changes only via propose/accept with an in-vault delay longer than the maximum lockup; emergency role can only set Executor to none. No proxy on the vault. |

---

## 2.2 Recommended changes (ranked)

| Rank | Change | Why | Source |
|---|---|---|---|
| 1 | **`redeemInKind` must survive a failing token.** Add a `skipTokens` list (the caller forfeits those tokens to remaining holders) or credit skipped amounts to a pull-based claim. Never let one token's `transfer` revert the whole exit. | USDC on Monad (`0x754704Bc...`, Circle) can blacklist an address or pause. A blacklisted user, or a paused token, would otherwise block in-kind exit entirely. Neither repo has in-kind exits, so neither has faced this. hypurrquant's `test_redeem_stillWorksWhenFeeRecipientBlacklisted` shows the same concern for fee recipients. (Inferred risk; USDC blacklist and pause behavior is the standard Circle token design, not verified here) | `HQ/test/unit/UsdcVault.t.sol` |
| 2 | **Put `redeemInKind` in the custody contract with no auth modifier, no pause check, no hook, no authority lookup, no oracle, no external module.** It burns only `msg.sender`'s shares (or an approved owner's) and pays `balance * shares / totalSupply` of each held token. | In BoringVault, `exit` is role-gated and a reverting authority bricks every gated function (solmate `Auth.isAuthorized` asks the authority first). A pause, auto-pause, deny list or role change blocks all exits. | `BV/src/base/BoringVault.sol` `exit`; `lib/solmate/src/auth/Auth.sol`; `TellerWithMultiAssetSupport._withdraw` |
| 3 | **Share supply integrity.** No external MINTER or BURNER role; minting happens only in the vault's own deposit function, burning only in its own exit functions. Replacing the deposit logic, if ever allowed, waits behind the long timelock. | In-kind payouts are `shares / totalSupply`. BoringVault's `exit` burns from any `from` without allowance; `enter` mints any amount; `TellerWithRemediation` moves shares after 3 days. Any of these would let an operator steal through the ledger instead of the assets. | `BoringVault.enter/exit`; `TellerWithRemediation.completeRemediation` |
| 4 | **Enforce every delay in our own code.** Executor replacement, oracle changes, route-table additions, fee changes, lockup maximum and asset-list changes use propose/accept with an in-contract delay longer than the maximum lockup. No external timelock convention, no instant role grants that bypass it. | BoringVault delays exist only if the RolesAuthority owner is a timelock (0 s to 48 h across deployments). hypurrquant times upgrades but grants roles instantly, so the admin can remove the guardian's veto first. | `BV/script/DeployTimelock.s.sol`; `HQ/src/vault/UsdcVault.sol` `proposeUpgrade`, `_authorizeUpgrade`; OZ AccessControl |
| 5 | **Vault re-checks invariants after each Executor call.** `totalSupply` unchanged; only `tokenIn` down and `tokenOut` up; no allowance left; post-trade USDC floor and 40% cap hold. | Defense in depth: an Executor bug cannot break hard limits. BoringVault's Manager checks only supply. | `ManagerWithMerkleVerification.manageVaultWithMerkleVerification` |
| 6 | **Adopt the BoringSwapper swap pattern inside the Executor:** per-venue adapter parses router calldata and must match the typed intent; Executor pulls exactly `amountIn` from the vault, approves exactly, calls, resets to zero, measures the realized output delta, checks it against the oracle with 0.5% slippage (worst pair if multiple oracles), sends output to the vault, returns dust. The vault never approves a router. | Checks what was actually received, not what the router promised; approvals never linger; venue calldata is validated. | `BV/src/base/Periphery/BoringSwapper.sol` `_swapPreFlightCheck`, `_swapPostFlightCheck`; `adapters/UniswapV3Adapter.sol`; `adapters/price/PriceValidator.sol` |
| 7 | **Exact rolling trade counter.** Implement 20 trades per 24 h as a ring buffer of the last 20 trade timestamps. Config or epoch changes must not reset it. Optionally add a per-direction USD-volume token bucket as a second brake. | Veda's `UManager` uses `block.timestamp % period`, which is not a window and degrades into permanent denial; BoringSwapper's `setRouteConfig` refills the bucket on every config write. | `BV/src/micro-managers/UManager.sol` `enforceRateLimit`; `BoringSwapper.setRouteConfig` |
| 8 | **Share-price circuit breaker with a time-scaled reference.** Store `refPrice`; move it toward live NAV per share at most `maxMoveBps * elapsed / window`; permissionless `poke()`. Deposits and USDC exits **revert** when the live price is outside the band. There is no stored pause and no admin unpause. Optionally price deposits at `max(live, ref)` and USDC exits at `min(live, ref)`. `redeemInKind` never reads it. | Keeps the Accountant's rate-of-change protection against oracle manipulation without its freeze-everything failure mode. The Accountant stores bad rates and pauses; a true move beyond the band needs a human. | `AccountantWithRateProviders.updateExchangeRate`, `_beforeUpdateExchangeRate`; `AccountantWithYieldStreaming.postLoss` |
| 9 | **Leader stake rule.** After any deposit by someone else, require `leaderShares * 1e4 >= 500 * totalSupply` (reject the deposit or cap it). Block leader exits that would drop below 5% while other depositors remain. Never block others' exits on this ratio. Track leader shares as non-transferable (or separately) so the ratio cannot be gamed by transfers. | Neither repository enforces a manager stake; this is Hyperliquid parity we must build. | Not in either repo (Verified absence) |
| 10 | **Lockup mechanics.** Unlock time stored per deposit at deposit time; hard `MAX_LOCKUP` constant; leader extensions apply only to later deposits; no third-party relock (require `receiver == msg.sender`, or lock per lot). | BoringVault relocks the whole address on each deposit and role-gates `deposit(..., to)` because of relock griefing; hypurrquant forces `receiver == msg.sender`; lowering BoringVault's period lets pending locks shorten. | `TellerWithMultiAssetSupport._afterPublicDeposit`, `setShareLockPeriod` natspec; `HQ UsdcVault.deposit` |
| 11 | **Fail closed on any oracle or balance read** in deposits and USDC exits. | hypurrquant counts failed precompile reads as zero, which mints excess shares. Our brief already says revert; this confirms it with a concrete failure. | `HQ/src/vault/NavLib.sol` safe reads, `coreNAV` |
| 12 | **Deposit hygiene:** `minSharesOut`, asset-denominated TVL cap, per-asset spread (wider for WMON than USDC), `depositsOpen` flag separate from pause. | Oracle-priced deposits need user slippage protection; thin Monad liquidity argues for a cap; both repos couple closing to pause. | Teller `minimumMint`, `sharePremium`, `depositCap`; `HQ` `maxTotalDeposit` |
| 13 | **Operators never redirect proceeds.** Any relayer or session-key-triggered exit pays the share owner only. | Prevents a compromised platform relayer from diverting exits. | `HQ UsdcVault.redeem`, `claimCancelRedeemRequest` receiver = controller |
| 14 | **Oracle wrapper per feed** that enforces staleness and decimals once, reused by the Executor, deposits, USDC exits and the breaker; plus a second-source deviation check. Monad test configs use 6 h staleness; ours must be much tighter. | Single place to get freshness right. | `BV/src/helper/GenericRateProviderWithStalenessCheck.sol`; `BV/script/Test/DeployBoringSwapper.s.sol` |
| 15 | **Keep all value inside the vault.** No limit orders, lending buffers or escrow contracts at launch. If added later, the in-kind path must be able to reach those assets without the platform. | BoringSwapper limit orders move principal into the swapper; `TellerWithBuffer` moves idle funds into lending markets. Both would sit outside `redeemInKind`. | `BoringSwapper.submitOrder`, `pendingOrderPrincipal`; `TellerWithBuffer._afterDeposit` |
| 16 | **Emit old and new values on every config change** (Executor, routes, oracles, fees, lockup, leader) and full structs on deposit and exit. | Hyperliquid-style public visibility; Veda relies on events for queue state. | `ManageRootUpdated`, `BoringOnChainQueue` events |
| 17 | **Clean-room implementation.** Do not copy BoringVault source; cite patterns in design docs only. | SEL-1.0 forbids production use of the software or derivative works. | `BV/LICENSE.md` |

---

## 2.3 Executor decision revisited

**Recommendation: keep typed intents only. Do not add Merkle proofs. Borrow BoringSwapper's internals.**

Against our hard limits (Verified for what Veda supports):

| Hard limit | Merkle Manager | BoringSwapper | Typed Executor |
|---|---|---|---|
| 10% of vault per trade | Cannot | Cannot (volume in token units only) | Yes |
| 40% max non-USDC, 10% USDC floor | Cannot | Cannot | Yes (post-trade) |
| 0.5% slippage | Cannot | Yes, realized output vs oracle | Yes; adopt realized-delta check |
| Exact approvals reset | Cannot (approve amount unbound) | Yes | Yes; adopt pull-exact pattern |
| 20 trades per rolling 24 h | Cannot | Volume bucket only; UManager count limit broken | Yes; ring buffer |
| 2-minute deadline | Cannot | Not enforced | Yes; bound the intent's deadline to `now + 120 s` and pass it to the router |
| Oracle freshness and deviation | Cannot | Freshness in provider; implicit deviation via worst pair | Yes |
| Circuit breaker | Manager pause | Global and per-adapter pause, registry kill switch | Yes; add per-venue pause |
| Ownership and config epochs | Only by replacing a root (timelocked on vmUSD, too slow for a sale) | None | Yes |
| Recipient = vault, no native value, token allowlist | Yes | Yes | Yes (hardcoded) |

Why not a hybrid: for USDC and wrapped MON on one or two DEXes, a Merkle layer would pin what the typed intent already pins (router, selector, tokens, recipient, value) and add a root, leaf files and decoders to audit and govern. Veda's own trajectory shows the point: to make swaps safe they built a typed entry point with adapters and kept Merkle only as the outer "which tokens, which receiver" gate. That is our Executor plus adapters.

Where an allowlist would earn its place later: if we add many protocols that do not fit a typed swap (lending, LP, staking), an admin-only, timelocked extension path could use a plain onchain mapping `(target, selector, argsHash) -> allowed`. A mapping is easier for depositors to read than a root. All value-moving trading would still go through typed intents with our limits.

---

## 2.4 Valuation decision

**Keep per-transaction oracle valuation. Do not publish a manager-pushed exchange rate. Add the reference-price breaker from change 8.**

| Criterion | Bounded pushed rate (Accountant) | Our live oracle NAV |
|---|---|---|
| Who sets the price | Holder of UPDATE_EXCHANGE_RATE_ROLE | Oracles; no party sets it |
| Fit with an agent-owner manager | Conflict of interest: the owner is paid by the price (fee, own 5% stake). Breaks "managers steer but never take" | Neutral |
| Accuracy for a traded MON position | Moves at most ±band per update (vmUSD config ±0.2% per 6 h); MON can move far more in an hour, so the rate is usually stale and exploitable | Accurate to oracle precision each transaction |
| Failure mode | Store bad rate and pause all entries and exits until a human acts (Verified) | Oracle outage blocks deposits and USDC exits only; in-kind still works |
| Manipulation resistance | Immune to spot manipulation; exposed to the pusher | Exposed to oracle lag and manipulation; mitigated by freshness, two-source deviation, spread, lockup, and the new breaker |
| Offline exit | Irrelevant to in-kind, but BoringVault's pause blocks every exit | In-kind never reads price |

A bounded published rate suits Veda's slow-yield vaults with a trusted bot. It is the wrong tool for an actively traded vault whose manager benefits from the price. A platform-run bot would avoid the conflict but would make the platform a price-setter for every vault and still be stale. The one idea worth taking is rate-of-change limiting, implemented as a reject-only, time-scaled reference (change 8), with asymmetry borrowed from yield streaming ("losses instantly, gains cautiously") if we want deposits priced at the higher and USDC exits at the lower of live and reference.

Spread sizing (Inferred): the buy/sell spread should be at least the oracle's deviation-update threshold, because a push oracle can lag by up to that amount. The live Monad Chainlink USDC/USD feed used in Veda's swapper script (`0xf5F15f18...`) updated about 18 minutes before our read; the MON/USD feed and its thresholds are an open question.

---

## 2.5 Queue decision

**No withdrawal queue at launch.**

- Both launch assets are plain ERC-20s held by the vault, so in-kind exit always works in one transaction.
- The USDC path either pays from the floor or sells pro rata with oracle and user minimums, and reverts cleanly when a pool is too thin; the user then picks a smaller amount or `redeemInKind`. That is our onchain equivalent of Hyperliquid's proportional close, and it is strictly more available than either repository.
- A queue would add a trusted solver or keeper, a pause point, and a price-exposure window (hypurrquant's ready shares stay in supply while payout is frozen, so remaining holders carry the move). The lockup already covers the arbitrage that a queue's maturity period covers.

Add an ERC-7540-style async redeem **alongside** `redeemInKind` (never instead of it) when any of these holds:

1. The vault holds positions that cannot be split or transferred in kind (concentrated LP NFTs, lending positions with withdrawal delays, unbonding or vesting tokens, cross-chain positions).
2. Pro-rata sales for typical exit sizes routinely exceed the slippage bound because Monad pools are thin (measure: USDC-path revert rate and exit size relative to pool depth).
3. Perps or leveraged positions are added.

If we add one, keep these design points: payout fixed at request or `min(rate at request, rate now)` (`BV/src/archive/DelayedWithdraw.sol`); burn or exclude shares at the moment payout is fixed (avoid hypurrquant's exposure gap); reserve funds at readiness (`reservedEvmBalance`); user cancel never pausable; receiver = controller; per-user active request cap.

---

## 2.6 Fees

Design for the later phase (Inferred, built from the patterns in both repositories):

1. **Per-user basis in share-price terms.** On each deposit, update the user's weighted average entry share price `P_entry`. Track it for leader and depositors; migrate it on share transfers, rounding in the user's favor (hypurrquant `NavLib.migrateCostBasisOnTransfer` uses ceil for this reason).
2. **Performance fee at exit, paid in shares.** `feeShares = shares * max(0, P - P_entry) / P * feeBps / 1e4`, minted or transferred to the leader before the exit burns the rest. NAV is unchanged, no fee liability sits in the vault, and fee shares help the leader stay above 5%. This is a per-user high-water mark set at entry, which matches the Hyperliquid model we want (Inferred) and avoids BoringVault's global-HWM cohort unfairness.
3. **Which price `P`.** USDC exits use the live price already computed in that transaction. `redeemInKind` uses the last stored reference price (a storage read that cannot fail or be paused). Never call an oracle from the in-kind path. Whether in-kind exits pay the fee at all is an open product decision (fee-free in-kind invites fee avoidance).
4. **Fee changes.** Timelocked longer than the maximum lockup (stricter than hypurrquant's 24 h), and applied only to deposits or positions after the change, the equivalent of hypurrquant's snapshot at `markRedeemReady`. Hard-coded maximum (hypurrquant caps at 30%, BoringVault at 50%; we should cap near our 10% target, for example 20%).
5. **No HWM reset.** BoringVault's `resetHighwaterMark` lets the owner charge fees on recovery after a drawdown; do not provide it.
6. **Management fee, if ever.** Use BoringVault's conservative base: `min(shares now, shares at last accrual) * min(old price, new price)`, time-prorated, taken as minted shares. Any fee held as assets must be excluded from NAV the moment it accrues (hypurrquant `totalAssets` subtracts `accruedFees`).
7. **Loss carry-forward.** Decide explicitly. hypurrquant has none, so a user who exits at a loss and re-enters pays fee on the recovery.

---

## 2.7 Risks (ranked)

| Rank | Risk | Revealed by | Mitigation |
|---|---|---|---|
| 1 | A single token transfer reverting (USDC blacklist or pause, WMON issue) blocks `redeemInKind` for a user or everyone | Our in-kind design; not addressed by either repo | Change 1: skip list or pull-based credits; invariant test that in-kind works with any one token reverting |
| 2 | Share ledger manipulation (external mint, burn from any address, forced share moves) undermines in-kind math | `BoringVault.enter/exit`, `TellerWithRemediation` | Change 3: no external mint or burn roles; tests that no admin action reduces a user's balance |
| 3 | Delays that exist only by convention, or instant role grants that bypass them | BoringVault timelock ownership (0 s to 48 h); hypurrquant instant `grantRole` | Change 4: in-contract propose/accept with delay longer than the maximum lockup |
| 4 | Oracle lag or manipulation on deposits and USDC exits | hypurrquant zero-on-failure reads; Accountant bounds exist for this reason | Two-source deviation, freshness wrapper, per-asset spread at least the oracle update threshold, reject-only reference breaker, lockup |
| 5 | Executor bug or compromised session key moves value | BoringVault relies on role wiring; hypurrquant has no onchain trade limits | Typed intents plus vault-side post-trade invariants (change 5), realized-delta oracle check (change 6), epochs, per-venue pause |
| 6 | Lockup and in-kind interaction: exiting in kind during the lockup could arbitrage a lagging oracle; blocking it could be read as "pausing" the offline exit | Sub-agents A and D both raised it | Recommendation: apply a lockup fixed at deposit time with a hard maximum; it is deterministic and cannot be extended for existing deposits, so it is not a discretionary pause. **Needs explicit sign-off** because it touches the non-negotiable rule |
| 7 | Lockup griefing by third-party deposits | BoringVault role-gates `deposit(..., to)` for this reason | Change 10 |
| 8 | Rate-limit implementation errors | `UManager.enforceRateLimit` bug; `setRouteConfig` bucket refill | Change 7; time-warp tests across window edges and config changes |
| 9 | Leader stake gamed or diluted | Missing in both repos | Change 9; non-transferable leader balance; handover rules for the stake |
| 10 | Handover too slow or leaky on agent sale | BoringVault can only swap a root through its owner's timelock | Reduce-only route table set atomically with the sale; ownership epoch bump invalidates session keys; new owner waits at least the maximum lockup |
| 11 | Value outside the vault (limit orders, buffers, escrow) invisible to in-kind | BoringSwapper limit orders; TellerWithBuffer | Change 15 |
| 12 | Stray assets (native MON, airdrops, non-allowlisted tokens) excluded from in-kind and valuation | BoringVault accepts native value and NFTs | Reject native `receive` (or wrap on arrival) and document that only allowlisted tokens count toward valuation and in-kind payouts |
| 13 | Removing an asset from the allowlist while the vault holds it strands depositors' claim | Inferred | In-kind iterates over every token with a nonzero balance in a held-asset list that can only shrink once the balance is zero |
| 14 | Thin Monad liquidity makes USDC exits revert often, pushing users to in-kind | Our design plus Monad pool depth | TVL cap at launch; monitor revert rate; queue triggers in section 2.5 |
| 15 | Licensing: copying BoringVault code | `BV/LICENSE.md` (SEL-1.0) | Change 17: clean-room implementation |
| 16 | Documentation drift: repo config not matching live deployment | vmUSD timelock and fees differ between repo and chain | Our deployment scripts should assert final onchain state (roles, delays, fees) in a post-deploy check |
