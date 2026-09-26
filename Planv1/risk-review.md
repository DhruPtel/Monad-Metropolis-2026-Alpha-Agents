# Risk review: autonomous agent trading platform

Review date: 24 September 2026. Inputs: project-overview.md (O), build-manual.md (B), technical-report.html (T), design-brief.md (D). Read in the requested order, with D used to check product promises. Recommendations below are proposed changes, not claims that the original requirements have been abandoned.

## Verdict

The product concept is coherent; the capital-management architecture is not yet executable. The documents describe many useful components but omit the rules that keep those components safe when ownership changes, transactions time out, prices move, code is replaced, or funds become illiquid. I would proceed with implementation discovery and a bounded demonstration. I would not treat this plan as authorization-ready for public deposits or unattended leveraged trading.

The strongest foundation is the slow research loop separated from deterministic execution, private skill distribution, and visible build history. The weakest claim is that those pieces collectively produce an improving, self-funding, verifiable trading agent. None of profitability, continuous safety, strategy confidentiality, or execution provenance follows automatically from the selected tooling.

This is a document and dependency review, not a code audit. No contracts, test results, deployed bytecode, provider accounts, live transaction receipts, or strategy dataset were supplied or tested. External evidence below establishes documented capabilities only. Severity ranks the consequence if a failure occurs; it is not an invented estimate of probability.

## The decisions that must change first

| Priority | Decision | Why it precedes development |
|---|---|---|
| Critical | Separate personal capital, public pool, and operating expenses | Database labels cannot isolate custody, liabilities, or withdrawal rights. |
| Critical | Specify exactly what the executor permits and how risk is measured | “Approved adapter” and “daily loss limit” are not implementable safety specifications. |
| Critical | Make transfer, unequip, pause, expiry, and recovery explicit state transitions | A valid old permission or resting order can outlive the UI state. |
| Critical | Separate contract simulation from strategy validation | A fork shows executable behavior at a state; it does not establish predictive edge. |
| Critical | Preserve a separately funded emergency path | Turning everything off when billing is empty can leave debt and orders unmanaged. |
| High | Replace “proof of what ran” with clearly scoped attestations | Code hashes and platform signatures do not independently verify private execution. |
| High | Gate arbitrary generated code behind a release process | A bot can pass a favorable test while retaining malicious or incorrect behavior. |
| High | Start with a precisely specified economic strategy | The architecture currently has no demonstrated reason to earn more than its costs. |

## Contradictions inside the supplied files

| References | Conflict | Resolution proposed |
|---|---|---|
| O “Money”; B §2.2; T §§8,13 | Owner capital is in the wallet in T, two balances inside one vault in B; withdrawals are “at any time” in O and conditional on locks elsewhere. | Separate PersonalAccount and StrategyVault; define redeemable liquidity and queued exits explicitly. |
| B §§1.2,3.2 | Ownership is read only through the indexer in one section, directly from chain in another. | Indexer for discovery/UI; block-tagged chain checks and onchain validation for authorization. |
| B §§1.3,3.2,11 | Only the sandbox supposedly sees plaintext, but the orchestrator decrypts and the audit worker reads it. | Document the actual plaintext boundary, including model providers and telemetry. |
| T §§5,16; B §11 | Encrypted upload precedes audit in T; plaintext review precedes encryption in B. | TLS upload to isolated quarantine; review exact package bytes; encrypt the reviewed immutable artifact. |
| O “The agent”; T §6; D product rules | Strict form input conflicts with a free-text goal translator. | Use validated fields for initial release; any later text translator produces a separate untrusted proposal. |
| T §20; B §14 | Audit, billing, and risk sentinel come after trading/private skills, yet the security and self-funding story depends on them. | Minimal budgets, audit gate, emergency handling, and observability precede unattended execution. |
| D Configure; T §§13–15 | D omits the expanded CFO dashboard, multiple goals, workflows, and approval lifecycle. | Treat D as incomplete; add these views with real operating states and backend contracts. |
| T §8 | `withdraw(uint256 shares)` is described as ERC-4626-style. | Use standard `withdraw(assets,receiver,owner)` and `redeem(shares,receiver,owner)`, or explicitly label a custom interface. [S1] |
| T §3; B §2.2 | Custom AgentNFT plus ERC-8004 registration implies two identities without a binding/ownership design. | Define the canonical product identity, registry ID mapping, control of the registry NFT, and transfer synchronization. |

## Critical failure scenarios

### R01 — Shared custody breaks the personal/public boundary

**Evidence:** B §§2.2,5.3 and T §13. **Failure:** the debt guardian adds “long-term growth” collateral while public depositors request redemptions. If balances share a fungible account or collateral position, the personal loan can encumber pool assets despite separate database labels. An owner-controlled token-bound account with arbitrary execution must not have unrestricted withdrawal authority over depositor capital.

**Fix:** physically separate PersonalAccount, StrategyVault, and OperatingEscrow. No public funds as personal collateral; no cross-account netting. Public vault management authority permits constrained strategy actions, never arbitrary transfers to the owner. Identify the address that owns each lending position and order-book subaccount. **Closure:** adversarial integration tests show that a personal repayment, owner transfer, billing debit, and compromised operator cannot debit the public pool. Owner withdrawals remain possible only against valid owned shares.

### R02 — The executor is a label, not yet a security boundary

**Evidence:** B §2.2, T §8. **Failure:** an approved router accepts arbitrary recipients, multicalls, callbacks, permit signatures, or unlimited approvals. A compromised bot uses valid calldata to transfer value out, buy an attacker-controlled illiquid asset, or leave dangerous allowances. A per-call limit is bypassed through repeated small calls.

**Fix:** typed action schemas; pinned adapter versions, target contracts and selectors; fixed account recipients; asset/market allowlists; bounded approvals; aggregate exposure and turnover reservations; deadlines; action IDs; policy/build/ownership epochs. Do not expose general delegatecall or generic arbitrary router execution. Inspect downstream upgradeability as well as adapter code hashes. **Closure:** malicious-recipient, approval, callback, multicall, repeat-call, asset-substitution, and stale-policy tests all reject. A valid approved venue still carries market and protocol risk.

### R03 — A daily loss limit cannot guarantee maximum loss

**Evidence:** O “Money”, B §2.2, T §8. **Failure:** a held asset gaps down, a lending oracle updates late, or a perp liquidates without any executor call. A 3% trigger can be crossed before the next permitted action. Checking wallet balances alone misses debt, unrealized PnL, pending fills, and locked margin. Refusing all trades after the breach can also prevent closing risk.

**Fix:** define valuation, numeraire, observation time, cash-flow adjustment, and loss window. Enforce measurable pre-trade limits onchain; use a separate sentinel for continuously observed risk. Breach stops new exposure and permits bounded risk reduction. Present the limit as a circuit-breaker trigger, never a loss guarantee. **Closure:** gap, stale-price, donation/deposit, midnight-reset, liquidation, and blocked-exit scenarios produce accurate breach states and no unsafe new positions.

### R04 — Withdrawability, NAV, and performance fees are unspecified

**Evidence:** O “Money”; B §2.2; T §8. **Failure:** a depositor redeems at a price including uncollectible rewards or optimistic perp marks; remaining investors absorb forced-exit costs. A withdrawal competes with orders reserving the same cash. New deposits dilute the owner's required stake. A raw-assets high-water mark mistakes deposits for profits.

**Fix:** define net asset value (NAV), liability and fee accruals, haircuts, realizable liquidity, order reserves, deposit capacity, and an exit queue. ERC-4626 is an interface, not this accounting implementation; asynchronous request/claim flows have a separate extension, ERC-7540. [S1,S2] Crystallize fees using a defined per-share or series/equalization method. A single global high-water mark can disadvantage entrants who join below a prior peak. **Closure:** changing deposits, partial redemption, donation attacks, first deposit, zero shares, rounding, loss/recovery, locked funds, and fee dilution all reconcile. Hyperliquid's own documented model includes lockups and venue-specific liquidation of positions for withdrawals; it is not a portable cross-protocol liquidity guarantee. [S3,S4]

### R05 — “Backtest on a fork” is not a strategy evaluation system

**Evidence:** B §4.5, T §§6–7. **Failure:** historical events are replayed against today's state, causing future information leakage; fictitious limit fills ignore queue position; market impact disappears because the bot's hypothetical trades do not change later history. Repeated LLM revisions overfit the same test window. The generated bot can alter the test harness or output its own metrics.

**Fix:** separate transaction correctness tests, point-in-time historical simulation, and forward shadow/canary trading. Preserve data availability timestamps, protocol versions, prices, costs and fill assumptions. The evaluator and hidden holdout are outside the candidate sandbox's write authority. Count all evaluated candidates, including failures. Judge net results against cash/hold/simple fixed-policy baselines, not merely the previous bot. **Closure:** known losing and future-looking candidates fail; reported metrics reproduce from immutable fills and datasets. No historical order-book data means no credible order-book backtest claim.

### R06 — Billing pause can abandon live financial obligations

**Evidence:** B §7.3 explicitly stops the bot and workflows at zero balance. **Failure:** a debt guardian stops with an open leveraged position; resting orders continue filling; fees or gas reserves run out during an unwind. Settling usage every few hours also permits spending that was never funded.

**Fix:** reserve budget before work starts. Separate research/trading permissions from a prepaid emergency worker and gas reserve. Use `RESTRICTED`, `REDUCE_ONLY`, and `EXIT_PENDING` before full shutdown. Keep deterministic position monitoring alive while obligations exist, with an explicit operator funding policy if the reserve is insufficient. **Closure:** drain operating credits during an open position and demonstrate cancellation, bounded exit, reconciliation, and an actionable residual-risk alert.

### R07 — Ownership and permission revocation are incomplete

**Evidence:** O transfer promise; B §§2.3,3.1,4.8; T §§3–4. **Failure:** an NFT changes hands while an old approval, session wallet, workflow, or bot still operates. An unequipped paid skill survives inside generated code or memory. Raw ERC-1155 transfers bypass slot limits and allow unsolicited tokens to alter a build. Revoking a key does not cancel existing orders or allowances.

**Fix:** explicit active-build registry distinct from inventory; immutable skill-version selection; owner/config epochs checked on every action; atomic transfer invalidation; cancel-and-reconcile handover; fresh buyer authorization. On unequip, invalidate the active build and stop using derived artifacts; technical deletion cannot prove that a model has “forgotten” a strategy. Define creator license rights for derivatives. **Closure:** transfer and unequip during a pending trade/approval reject stale actions and preserve exits. On Solana this is especially concrete: Metaplex documents broad execution-delegate authority and persistence across asset transfers. [S5]

### R08 — Generated code leaves the protected environment

**Evidence:** B §§3.4,4.2–4.3,4.5. **Failure:** a malicious skill writes a bot that passes tests, then runs in a less restricted always-on container. It leaks skill-derived code, probes internal services, mines compute, or exploits a signer endpoint. Auditing the original skill does not audit every later generated artifact.

**Fix:** treat both build outputs and live bots as untrusted. Enforce isolation, resource caps, explicit network routes, and scoped API authentication in both environments. Prefer generated parameters/DSL over arbitrary live code in the initial release; retain arbitrary generation as a gated capability. Build reproducibly, scan the actual artifact, sign its digest, and promote only through an independent controller. **Closure:** malicious generated bot fixtures cannot reach keys, other agents, internal metadata, arbitrary network targets, or modify evaluator results.

## High-risk and underexplored areas

| ID / evidence | Failure and consequence | Recommended control / evidence needed |
|---|---|---|
| R09 — T §11, O proof claim | Platform can sign a false account of which hidden code ran. Hashes only commit bytes; a registered identity does not verify performance. | Name claim classes: chain-confirmed outcome, reproducible accounting, platform-attested build, independently attested runtime. Retain signed manifests, tx links, and verifier trust assumptions. TEE adds a hardware trust boundary, not proof of trading quality. |
| R10 — B §§3,11,12 | LLM provider, gateway, Langfuse, backups, support staff, audit logs, or allowed RPC/API request fields expose private skills. No-chat and a narrator cannot close every channel. | Data-flow inventory; creator consent to model-provider processing; metadata-only traces by default; retention and access rules; typed read proxies; block direct sandbox chain writes. Canary-secret exfiltration tests including encoded output and approved-domain abuse. |
| R11 — B §§4.6–4.7 | Simulation, threat screen, remote signing, and RPC submission exceed the opportunity window. A simulated success becomes a failed or adverse real fill. | Measure the whole decision-to-inclusion path under load. Maintain a slower validated path and a separately gated deterministic fast path with onchain protections and short-lived bounds. No sub-block claim until measured. |
| R12 — B §§1.2,5.1,8 | Queue retry submits a second trade; indexer lag grants a sold skill; two bot versions spend the same cash. | Durable action ledger, transactional outbox, per-account fencing, idempotent action IDs, chain reconciliation, and explicit pending reserves. BullMQ retries require application-level idempotency. [S6] |
| R13 — B §§5.1–5.4, T §14 | Debt guardian, rebalancer, sweep, and bot act independently. Guardian adds volatile collateral while sweep removes repayment cash. | One portfolio coordinator with priority: emergency, exits, committed workflows, discretionary trades. Protocol-specific liquidation metrics; protected emergency buckets; mutually exclusive reservations. Model partially completed refinance and failed second legs. |
| R14 — B §5.2 | Approval UI authorizes an action that changes before execution; narrator omits recipient or leverage. | Owner signs or authenticates an immutable intent hash, maximum amounts, account, chain, policy epoch and expiry. Requote outside bounds requires new approval. Render material amounts deterministically; narrator is explanatory only. |
| R15 — B §§2.2,6.1 | Oracle choice left for later, though it defines risk, NAV, slippage and allowable assets. | Per-asset oracle specification: address/feed, decimals, freshness, confidence/deviation checks, update cost, fallback, and failure behavior. Do not mark USDC as always $1 in USD risk reports. Oracle directories establish providers, not coverage or suitability. [S7] |
| R16 — O skills, B §2.2 | Creators get paid for being equipped, not demonstrated contribution. Late equip captures old profits; splitting one skill into many captures more royalties. Limited NFT supply does not cap capital using a strategy. | Fixed aggregate fee ceiling, versioned fee schedules, active-build epochs, explicit allocation rules and strategy capacity limits. Do not describe association as causal attribution. Freeze economics for existing deposits or provide a governed migration/exit. |
| R17 — B §7, O self-funding | Profitable pool lacks enough owner's fee income to run the agent; all startup/service costs are omitted. Offchain metering hash proves integrity, not honest billing. | Prepaid capped operating escrow, deduplicated usage receipts, per-provider reconciliation and user spend ceilings. Separate treasury cash flow from trading PnL and track fixed cost allocation. |
| R18 — B §9, T §12 | Privy session wallet, TBA, vault, USDC payer, and x402 signer are treated as one wallet. An EOA signing for a smart account may not match the supported payment scheme. | Prove the exact payer/token/domain/signature/facilitator tuple. Use a dedicated capped commerce wallet if needed, disclose its control, and keep it out of trading capital. Handle paid-but-undelivered responses with stable request IDs. |
| R19 — O discovery/economy | Public settled transactions already expose the “real-time” feed. Copying loses price and queue priority; two agents can recursively copy each other. | Sell normalization, evidence, or actionable analysis, not secrecy of public fills. Include source IDs, TTL, max slippage, copy-depth limits and independent risk approval. Model revenue from external demand separately from seeded agents. |
| R20 — D stats and leaderboard | Hover deltas suggest a skill guarantees return; median equipped-agent returns are confounded by capital, time and other skills. “30d” may be shown before 30 days exist. | Separate live, simulated and scenario metrics; show observation period/sample and costs; use “not enough data.” Use comparable cohorts and survival-inclusive histories. Verified publisher is identity, not audited safety or proven alpha. |
| R21 — T §§18–19, B §§13–14 | Copying repos creates fixes that diverge; generic chain adapter hides Solana account locking, CPI permissions, expiry and PDA behavior. | Shared versioned core plus chain-specific conformance tests; capability flags, not pretend parity. Keep chain/environment IDs on every object. Validate hackathon rules separately; supplied weights and reuse rules are not verified here. |
| R22 — B §§2.2,12 | Admin can change adapters/policies or cannot recover during platform failure; global pause traps withdrawals. | Role matrix, scoped pauses, immediate revocation and delayed privilege expansion, owner exits independent of hosted UI, key-loss and backup recovery drills. Avoid upgradeable custody in the first release unless essential. |
| R23 — T §13, B §5.5 | FIFO buy/sell table cannot reconcile deposits with unknown basis, staking receipts, wrapping, gas, bridges, liquidation, rewards or debt. | Complete transaction ledger first; provenance-aware lots and explicit unknown basis; reconcile owner capital separately from pooled shares. Label CSV an activity/cost-basis aid; jurisdictional treatment remains undecided. |
| R24 — B §§2.2,11; D creator portal | “Audited” badge and creator stake imply coverage without defined malicious conduct, appeal, slash authority, or adequate stake. | Publish review scope, immutable reviewed hash, dependency pinning, remediation process and adjudication rules. Stake is an incentive, not insurance. Curate initial listings; hostile packages include archive traversal and dependency install scripts. |
| R25 — O positioning, T §20 | No first customer or testable source of edge. Return-target slider can push an optimizer toward unsupported leverage. | First persona: an experienced owner managing a bounded onchain allocation. Treat return target as aspiration; hard risk constraints always win. Document strategy entry/exit, benchmark, capacity and invalidation before coding its bot. |

## Dependency verification: what the evidence actually supports

All checks were web-documentation checks on 24 September 2026. “Documented” does not mean installed, funded, tested, or safe in this application.

| Dependency | Result | Build consequence |
|---|---|---|
| Monad Foundry | Current official page confirms upstream Foundry v1.8+ Monad support, explicit local network setting and fork detection. Search snippets still surfaced the older custom fork. [S8] | Original claim is supported. Pin toolchain and historical hardfork/block; do not replace it based on stale search snippets. |
| ERC-6551 on Monad | Official guide documents canonical v3 stack on both networks, explicit viem chain object and SDK caveats. [S9] | Supported at documentation level; still test deployed bytecode, session permissions and transfer behavior. |
| ERC-8004 | Monad guide labels Validation Registry “coming soon.” The EIP defines its own identity NFT, registration schema, wallet verification and feedback restrictions. [S10,S11] | Do not build P0 around validation availability; app build-card JSON is not by itself a compliant registration file. Keep platform attestations separately. |
| x402 | Monad guide now recommends `@x402/evm >=2.22.0`, including mainnet USDC domain configuration; testnet requires explicit asset setup. [S12] | The plan's 2.12-era floor is insufficient as the current integration instruction. Pin a tested compatible package set and verify mainnet/testnet independently. |
| Privy | Official security page documents policy controls on transactions and calldata. [S13] | Capability exists; composed contract calls, typed signing, policy-admin privileges and gas sponsorship still require exact-path tests. |
| Metaplex agents | Official docs confirm PDA wallet and delegates, but broad authority and persistent delegate records across transfers. [S5] | Solana is not security-equivalent to a narrowly capped session key without additional program-level enforcement. |
| E2B | Official material documents egress controls and secret handling; some proxy/identity capabilities are private beta. [S14] | Prove availability on the selected account/SDK. The exact header-injection API and session economics in B are not validated here. Use a controlled broker if needed; never silently relax isolation. |
| Hermes | Official repository confirms the proposed framework exists. [S15] | Headless sandbox operation, disabled shell/network tools, gateway compatibility, memory export and restart are untested. Pin and spike before coupling it to custody. |
| Envio | Official Monad page documents chain indexing. [S16] | Event access is supported, not a ready-made historical state/queue/impact simulator. |
| Tenderly | Official matrix is dynamically loaded; retrieved page did not expose a usable Monad product row. [S17] | Simulation, fork, RPC, traces and alerts remain separate acceptance probes; this is uncertainty, not evidence of absence. |
| Protocol deployments, feeds, Enso, Blockaid, FastLane | No exact application-specific manifest or measured round trips supplied. | Remain unverified for this build. A directory listing, launch article, or SDK method name does not close these dependencies. |
| X pricing, E2B prices, competition weights, reuse eligibility | Not verified in this review. | Remove hardcoded assumptions from acceptance criteria; confirm before purchase/submission. They are not substitutes for resolving custody and execution blockers. |

## Economics and trading validity

There is currently no defined strategy edge. Start with one strategy whose entry, exit, data latency, costs and failure conditions are written down. A bounded spot rebalance is a useful correctness baseline, but is not evidence of alpha. If market making is the desired first trading product, capture order-book history and implement inventory limits, adverse-selection measurement, partial fills and cancel/fill races before optimizing it. Lending APY scanning is slower portfolio allocation; it cannot validate the fast-trading thesis.

The self-funding equation depends on who pays. Let A be pool capital, r monthly net trading return before performance fee and operating cost, f the performance fee rate, s the owner's fraction of that fee after creator shares, and C monthly agent cost. When only the owner's fee pays expenses, the optimistic break-even is A ≥ C/(r f s), assuming profitable eligible crystallization and sufficient cash. **Illustration, not a forecast:** C=$100, r=1%, f=10%, s=50% implies A=$200,000. A losing month produces no such funding. Initial sale proceeds, subsidies and unrealized PnL must not be counted as recurring trading income.

The launch protocol list is a catalogue of opportunities, not a strategy. Each added venue expands position valuation, approvals, exit mechanics, accounting and incident response. Add venues only when their whole position lifecycle passes conformance tests. The proposed smaller first release is a capital-risk recommendation, not a critique of the team's size or calendar.

## Recommended build direction

Preserve agent ownership, skill NFTs, private runtime, evolution history, discovery, workflows, pooled participation, signals, creator economics, 3D configuration and the Solana branch. Change when each is permitted to touch capital. The companion overview gives the resulting product; the technical plan specifies boundaries and data contracts; the build manual provides dependency-ordered work packages and acceptance gates.

The critical path is: custody and permissions → valuation and exits → deterministic trade lifecycle → reconciliation and emergency recovery → private skill entitlement → independent evaluation and controlled bot promotion → pooled accounting → commerce and broader automation. Build the UI against those states as they stabilize. A compelling demo can show a rejected risky action and a successful recovery; it does not need invented evidence of profitability.

## Primary source register

- **S1:** [ERC-4626 Tokenized Vaults](https://eips.ethereum.org/EIPS/eip-4626) — interface semantics and withdrawal limits.
- **S2:** [ERC-7540 Asynchronous Vaults](https://eips.ethereum.org/EIPS/eip-7540) — request and claim model.
- **S3:** [Hyperliquid vault depositors, legacy](https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/vaults/for-vault-depositors-legacy) — lockups in the referenced model.
- **S4:** [Hyperliquid vault leaders, legacy](https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/vaults/for-vault-leaders-legacy) — stake and position handling on withdrawals.
- **S5:** [Metaplex: What is an agent?](https://www.metaplex.com/docs/agents/what-is-an-agent) — delegation and transfer semantics.
- **S6:** [BullMQ idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs) — application responsibility on retry.
- **S7:** [Monad oracles](https://docs.monad.xyz/tooling-and-infra/oracles) — provider support, not asset suitability.
- **S8:** [Monad Foundry](https://docs.monad.xyz/tooling-and-infra/toolkits/foundry) — current toolchain guidance.
- **S9:** [Monad ERC-6551](https://docs.monad.xyz/guides/erc-6551) — canonical account deployment and SDK use.
- **S10:** [Monad ERC-8004](https://docs.monad.xyz/guides/erc-8004) — documented registry availability.
- **S11:** [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) — registration, ownership and feedback specification.
- **S12:** [Monad x402](https://docs.monad.xyz/guides/x402) — package and payment-domain configuration.
- **S13:** [Privy policies and controls](https://docs.privy.io/security/wallet-infrastructure/policy-and-controls) — policy capability.
- **S14:** [E2B enterprise security and deployment](https://e2b.dev/enterprise) — isolation, egress and capability availability.
- **S15:** [Nous Research Hermes Agent](https://github.com/NousResearch/hermes-agent) — framework source.
- **S16:** [Envio Monad](https://envio.dev/chains/monad) — indexing support.
- **S17:** [Tenderly supported networks](https://docs.tenderly.co/platform/supported-networks) — product-specific verification still required.

No legal classification is concluded here. Pooled discretionary management, paid strategies and public distribution require a jurisdiction-specific launch decision before outside deposits; the user's jurisdiction and offering structure are unspecified.
