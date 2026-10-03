# Decisions and Open Questions

*The record behind `FINAL_PLAN.md` and `BUILD_PLAN.md`. Revision 2. Revision 1 was the consolidated planning record; revision 2 records the owner decisions and fixes from the orientation session of 2026-09-27.*

Every decision below is self-contained: the row states the decision itself. The source column carries exactly one of four labels: `planning answer` (an answer given during planning), `conversation decision` (the decision register supplied with the planning brief), `owner decision, orientation` (a decision made in the orientation session of 2026-09-27), or a document name (a Planv1 file or a working note in `notes/`, which cite the research reports). `Assumption`: a choice the plan had to make without a source; every assumption is listed in section 3.1. This file is the plan record and is updated only when a decision changes; day-to-day tracking lives in `LOGS.md` and `LESSONS.md` at the repository root (D-124).

---

## 1. Decision register

### 1.1 Product and scope

| ID | Decision | Source |
|---|---|---|
| D-001 | The platform is an onchain financial management platform where AI agents are NFTs, customized with skill NFTs shown as robotic components on a 3D creature; agents act as an onchain CFO; others can watch, follow and invest | conversation decision |
| D-002 | Launch is a live mainnet product on Monad (chain 143) used with real money, first as a guarded beta (D-133) and then publicly; testnet (10143) and forks are for testing, and for labeled beta items not ready for mainnet | conversation decision, amended by owner decision, orientation |
| D-003 | The hackathon stays a target: Monad Metropolis (Onchain Finance and Trading track) and Colosseum; the hackathon beta on mainnet is the demo and the submission; the definition of done includes the submission deliverables | planning answer, amended by owner decision, orientation |
| D-004 | Solana gets the same depth, built after the Monad chain layer, on a separate branch, sharing the chain-agnostic core | conversation decision |
| D-005 | Launch features: personal accounts and public Hyperliquid-style vaults | conversation decision |
| D-006 | First strategy: token allocation from USDC; limit downside while earning a return; no benchmark | conversation decision |
| D-007 | Base currency USDC; launch assets USDC and wrapped MON only | conversation decision |
| D-008 | Venue undecided; measure depth on Uniswap v3, Uniswap v4 and Kuru, then pick one | conversation decision, planning answer |
| D-009 | No lending, borrowing, leverage, LP positions or perps at launch | conversation decision |
| D-010 | Goal input is structured form fields only: template, risk preset, allowed assets, optional stricter limits, model choice, credit settings; no free text, no chat | conversation decision, planning answer |
| D-011 | One strategy per account at launch; no multi-goal buckets | planning answer |
| D-012 | Following is view-only and free; real-time signals paid via x402; auto-copy deferred | conversation decision, planning answer |
| D-013 | Fees deferred; the fee mechanism and per-depositor entry prices are built now with the rate at zero, activation later behind the timelock | conversation decision, planning answer |
| D-014 | Privacy claim wording deferred; the technical definition is "private from owners and other users, not from the platform or model vendor" | conversation decision, planning answer |
| D-015 | First customer deferred; working hypothesis is an experienced onchain user wanting a bounded allocation with transparent controls | conversation decision, revised-project-overview.md |
| D-016 | Emergency reserve deferred to Phase 9; a paused spot-only agent simply holds | conversation decision |
| D-017 | Launch is sold on control, ownership and the build experience, not returns; "why the agent did not trade" is a first-class display | planning answer |
| D-018 | All unrun spikes, including E2B egress injection, are unverified until they pass | planning answer |
| D-019 | Trades within hard limits execute automatically after a one-time arming approval; approval cards apply to workflow steps set to require approval and to parameter changes | planning answer, PHASES.md |
| D-020 | Parameter changes proposed by the agent pass schema bounds plus owner notification or approval per the workflow mode; the shadow and canary ladder is deferred | planning answer |
| D-021 | No simulation or backtest on the configure page at launch; the stat sheet shows capability deltas, not return deltas | planning answer |
| D-022 | Synergies and set bonuses deferred | planning answer |
| D-023 | Creator uploads invite-only at launch with the creator portal live | planning answer |
| D-024 | WorkflowNFT contract plus platform-published built-ins at launch; third-party workflow listings deferred | planning answer |
| D-025 | Skills resell only through the marketplace escrow | planning answer |
| D-026 | Mint and skill prices in USDC; MON only for gas | planning answer |
| D-027 | Watchers stored offchain, free, no gas, with the anti-gaming rules | planning answer, technical-report.html section 10 |
| D-028 | Leaderboard at launch with "not enough data" states; seasons and leagues deferred | planning answer |
| D-029 | Band allocation is a target WMON weight with rebalance bands inside the limits; DCA is scheduled USDC to WMON buys | planning answer |
| D-030 | Submission material distinguishes mainnet, mainnet-beta, testnet, fork and simulated activity; demo activity is labeled and excluded from external demand; the beta is labeled "unaudited beta" everywhere | PHASES.md Phase 5, preview.html revised build manual section 14, owner decision, orientation |

### 1.2 Tiers

| ID | Decision | Source |
|---|---|---|
| D-031 | Every agent gets the full baseline toolset: web search, X, Dune, chain tools, plus the free sources DefiLlama, CoinGecko and HyperSync | conversation decision, planning answer |
| D-032 | Tiers differ by skill slots, built-in playbooks, premium curated data and faster execution rails | conversation decision |
| D-033 | Not tier-based: model choice (paid via credits), credit pricing, vault deposit limits | conversation decision |
| D-034 | Skill slots are 3, 5 and 8 for base, medium and pro; a distinct 3D body per tier, visual only | planning answer |
| D-035 | Turn and time budgets are uniform across tiers | planning answer |
| D-036 | All tool and data calls are metered through credits; a price table per tool call with `cacheHit` recorded | conversation decision, notes/monad-agent-kit.md section 3.8 |
| D-037 | The user picks one model for reasoning stages; Scan and Test use a disclosed cheap platform model | planning answer |

### 1.3 Accounts, contracts and the Executor

| ID | Decision | Source |
|---|---|---|
| D-038 | Three separate capital accounts: PersonalAccount, StrategyVault, funding address; never mixed | conversation decision |
| D-039 | The ERC-6551 token-bound account holds skills and identity only, never capital; canonical Tokenbound v3 on Monad | conversation decision |
| D-040 | The platform never sets permissions or overrides on any token-bound account for any address, including the Executor | planning answer |
| D-041 | Own Executor with typed intents; no Zodiac Roles, no Merkle-verified calldata | conversation decision |
| D-042 | Approval mechanics: the Executor pulls the exact amount, approves the venue exactly, the venue pays the account directly, approval resets to zero, the account checks balance deltas | conversation decision, planning answer |
| D-043 | Ownership and configuration epochs on every action; old permissions never return for platform authority | conversation decision |
| D-044 | Session key submits directly as `msg.sender`; the owner registers a grant of key, both epochs and expiry in the Executor; no relayed signatures at launch | planning answer |
| D-045 | KMS-backed platform signer for agent keys; Privy stays for login and embedded wallets | planning answer |
| D-046 | Agent sales only through the marketplace escrow at launch; AgentNFT transfers restricted onchain to the escrow | conversation decision, planning answer |
| D-047 | OpenSea and Blur later, once a custom account implementation closes the skill-drain paths; the TBA address migration is accepted then | conversation decision, planning answer |
| D-048 | PersonalAccount is the custody core in single-owner mode, one clone per agent and owner, withdraw always on, no share token, internal units for flow-adjusted valuation | planning answer |
| D-049 | PersonalAccount funds never travel with the NFT; the seller keeps withdrawal rights | planning answer, notes/tokenbound.md section 4 |
| D-050 | Hard limits at launch: max 10% of account value per trade; max 40% in any non-USDC asset; at least 10% USDC; max 0.5% slippage; rolling 20 trades per 24 hours; 2-minute deadlines; oracle under 5 minutes old and within 2% of pool price; circuit breaker at 10% (reduce-only) and 20% (pause) from the 7-day peak; recipient always the source account; exact approvals only; platform-wide deposit cap until reviewed; external reviews before public deposits | conversation decision |
| D-051 | Rolling 24-hour turnover cap at 100% of NAV to start | planning answer |
| D-052 | Trades whose output is USDC always pass the 40% and 10% post-checks | planning answer |
| D-053 | Pool price is the spot price of the traded pool, pairwise within 2% of the oracle; slippage is measured against the oracle-implied output plus a post-trade NAV-loss bound | planning answer |
| D-054 | Rolling counter is a ring buffer of 20 timestamps, never reset by config or epoch changes; the deadline is set at signing and forwarded | notes/managed-vaults.md section 4, notes/monad-agent-kit.md section 4 |
| D-055 | Oracle: Chainlink feeds primary, staleness per feed from measured heartbeat, USDC treated as 1 with a depeg guard; any asset without a reliable feed is dropped from the buy allowlist | conversation decision, planning answer |
| D-056 | Held-asset list is separate from the buy allowlist; dropping a feed never removes an asset from in-kind payouts | planning answer |
| D-057 | Vault-side backstops slightly looser than the Executor limits (12%, 45%, 1%) with post-trade invariant checks in the vault | planning answer |
| D-058 | Circuit-breaker peak: per-share NAV for vaults, flow-adjusted for PersonalAccount, tracked in the account through `poke()`, read by the Executor | planning answer |
| D-059 | Loosening of Executor policy and vault configuration waits the risk timelock; tightening is instant; the emergency role can only reduce risk with an enumerated function list | planning answer |
| D-060 | ProtocolRegistry pins the venue's code hash and fails closed on mismatch; hookless v4 pools only if v4 is chosen | notes/zodiac-roles.md section 7, notes/morpho-vault.md section 3.3 |
| D-061 | One intent per transaction; no batching at launch | notes/zodiac-roles.md section 4 |
| D-062 | Deposit caps: per-vault cap, per-PersonalAccount cap and a platform total in AccountFactory (which deploys both account modes), tighten instantly, loosen by timelock; AccountFactory also holds the beta depositor allowlist (D-145) | planning answer, amended by owner decision, orientation |
| D-063 | Superseded by D-144: there is no Billing contract; credits are the USDC balance of the agent's funding address, metered offchain and settled by signer-executed sweeps under a period ceiling with a sequence and usage hash; the funding address also holds the MON the platform tops up for gas and pays x402 from the same USDC | owner decision, orientation (replaces conversation decision, preview.html revised technical plan section 10) |
| D-064 | ERC-8004 identity registered at mint through an IdentityBinder that owns the registry token; reputation and validation deferred | planning answer |
| D-065 | WorkflowNFT is held in the token-bound account like skills with the same transfer restrictions | planning answer |
| D-066 | SkillNFT refuses operator transfers out of agent accounts and `setApprovalForAll` for agent-account holders | notes/tokenbound.md section 4 |
| D-067 | Two-step ownership on every admin contract; reentrancy guards on every state-changing entry point | notes/zodiac-roles.md section 4 |
| D-068 | Clean-room rule: no code copied from BoringVault, Morpho, Zodiac or monad-agent-kit | planning answer |

### 1.4 StrategyVault

| ID | Decision | Source |
|---|---|---|
| D-069 | Own contract borrowing Morpho and BoringVault patterns, not a fork; small custody core; timelocks in code longer than the maximum lockup; emergency role reduce-only; valuation once per transaction; virtual shares; rounding in the vault's favor; buy/sell spread; time-scaled reference price band; limits on buys only; no external mint or burn | conversation decision |
| D-070 | Withdrawals in USDC above the 10% floor, otherwise the withdrawer's share is sold through allowlisted pools with oracle and user minimums, reverting on failure; `redeemInKind` in the custody contract with no pause, hook or role check | conversation decision |
| D-071 | A reverting token in `redeemInKind` becomes a claimable credit excluded from NAV | planning answer |
| D-072 | Lockups: minimum 24 hours, default 24 hours, hard maximum 7 days; unlock set at deposit; self top-up sets the later unlock with a UI warning; the lockup applies to `redeemInKind` | conversation decision |
| D-073 | Share transfers disabled at launch | planning answer |
| D-074 | Third-party deposits to a receiver are rejected | planning answer |
| D-075 | Lockups waived in handover, wind-down and guardian pause | planning answer |
| D-076 | "Leader changes apply only to new deposits" means lockup-length changes by the leader; increases wait the new duration plus notice and apply only to later deposits; decreases are instant | conversation decision, planning answer |
| D-077 | Handover on sale: deposits closed, reduce-only, locks waived, old owner exits freely, new owner posts a fresh 5% stake and accepts after the handover period | planning answer |
| D-078 | Leader stake of 5%, enforced against diluting deposits and the leader's own exits only; leader shares non-transferable; seed required before deposits open; wind-down lifts the rule | planning answer |
| D-079 | No withdrawal queue at launch | conversation decision |
| D-080 | Unpause after the 20% breaker by the owner, never the emergency role; pause blocks deposits and new-risk swaps, never exits; for public vaults the owner may unpause only after one lockup period | planning answer |
| D-081 | Timelock constants: notice 2 days, risk timelock 9 days, handover 3 days, all set in the constructor and never zero | planning answer |
| D-082 | Timelocked changes: Executor replacement, oracle or venue or asset additions, fee changes, lockup maximum, guardian appointment and removal, any Executor policy loosening | planning answer |
| D-083 | Emergency role powers: pause trading and deposits, set reduce-only, cancel pending proposals, set the Executor to none, tighten backstops; nothing else | planning answer |
| D-084 | Per-depositor high-water mark: entry share price recorded from launch; fee charged on exit in shares moved from the exiter to the leader; fee changes timelocked, capped at 20%, applied to later deposits only | planning answer, notes/managed-vaults.md section 3 |
| D-085 | Spread per asset, at least the feed deviation threshold, sized from the heartbeat and lag-arbitrage spikes; the reference band parameters from the breaker spike | notes/morpho-vault.md section 4, notes/managed-vaults.md section 4 |
| D-086 | Every priced path fails closed on any oracle or balance read; nothing counts as zero | notes/managed-vaults.md section 4 |
| D-087 | Deployment scripts assert the final onchain state against the intended configuration as a launch gate | notes/managed-vaults.md section 4 |

### 1.5 Agent runtime, tools and skills

| ID | Decision | Source |
|---|---|---|
| D-088 | Hermes Agent locked to a tested commit (085d9ee at planning; re-pinnable per D-143), wrapped, unmodified; our orchestrator owns scheduling and the discovery loop; Hermes self-improvement off; turn limits and timeouts in the wrapper; hard budgets in LiteLLM; in-sandbox toolsets enabled per D-143 | conversation decision, amended by owner decision, orientation |
| D-089 | "Self-improvement off" also blocks foreground `skill_manage` (read-only mount, write approval, hook), keeps `USER.md` off and `MEMORY.md` foreground-only, exported encrypted; memory writes outside these paths are off (D-143) | planning answer, notes/hermes.md section 4 |
| D-090 | Agents evolve by gaining tools and knowledge through skills and by tuning parameters of approved strategy templates; no arbitrary code generation | conversation decision |
| D-091 | All Hermes state is as confidential as skills; encrypted exports; error dumps die with the sandbox; `sessions/` on tmpfs | conversation decision, notes/hermes.md section 4 |
| D-092 | Both per-agent secrets (tool token and LiteLLM key) are injected at egress; nothing secret exists in the sandbox | planning answer |
| D-093 | Five discovery stages as separate Hermes runs with the Thesis Board on the platform server; sequential Dives; one sandbox per cycle; Hermes cron unused | planning answer |
| D-094 | The bot runner is a deterministic template runner plus workflow step executor; no LLM, no generated code | planning answer |
| D-095 | Three MCP servers (chain, data, platform) built with the MCP TypeScript SDK, viem and zod, platform-side; identity, tier and metering bind to the injected token; limits are read from the Executor; tools return intent IDs, never calldata | conversation decision, notes/hermes.md section 4 |
| D-096 | Rebalance legs above the per-trade cap split into sequential legs, each consuming a trade slot | planning answer |
| D-097 | `get_pool_depth` and `simulate_rebalance` are baseline, metered; only curated data tools are tier-gated | notes/monad-agent-kit.md section 4 |
| D-098 | The goal translator is deterministic; the narrator reads only the action log and ledger and its text is explanatory only | conversation decision, preview.html revised technical plan section 9 |
| D-099 | Skills use the skill.json spec v1 from the Bankr research: immutable content-hash versions, signed publisher, required tools, intents, slot cost, privacy; the platform generates Hermes frontmatter and never emits env-var, credential, config, blueprint, deps or inline-shell fields; only the active build is mounted, read-only | conversation decision, Planv1/research/bankr-skills/02-platform-mapping.md section 2.1 |
| D-100 | Launch skill set of nine, all platform-published: monad-assets-basics, one swap skill for the chosen venue, the band allocation strategy, the DCA strategy, deep-dive-research, token-risk-screen, defi-regime-read, narrative-and-flow-tracker, wallet-intel; lending and LP skills removed; scheduling moved to workflows | conversation decision, planning answer |
| D-101 | The DCA skill holds sizing, drawdown pause and budget logic only; its schedule lives in Recurring Buys | notes/bankr-skills.md section 7 |
| D-102 | The audit pipeline is the Bankr research's F1 to F8, S1 to S15, L1 to L8, dynamic test and human review for strategy skills and first-time publishers; badges state their scope | 02-platform-mapping.md section 2.6, preview.html revised build manual section 7 |
| D-103 | Launch gates on a skill selection spike with all nine descriptions; skills are merged if selection fails | planning answer |
| D-104 | A workflow that depends on a revoked or swapped skill version pauses at its next run and the owner is told | notes/bankr-skills.md section 7 |
| D-105 | Vendor zero-retention terms and gateway logging off are requirements | planning answer |
| D-106 | Skills needed for Phase 3 research mount first as platform built-in folders; Phase 6 turns them into NFTs | BUILD_PLAN.md reconciliation |
| D-107 | Built-in workflows at launch: Rebalancer, Recurring Buys, Parameter change review; the Risk Sentinel is a deterministic service with its own key (D-138), built as P4-U2 and listed beside the workflows because it runs on the same cadence machinery | conversation decision, PHASES.md Phase 4, preview.html revised technical plan section 7, owner decision, orientation |
| D-108 | The `token-risk-screen` requirement before buying a non-core asset is a policy rule, not a workflow NFT | notes/bankr-skills.md section 7 |

### 1.6 Marketplace, social and frontend

| ID | Decision | Source |
|---|---|---|
| D-109 | The escrow checks `isLocked`, the implementation slot against an allowlist, holdings, `buildHash` and `state`; it has no generic call path and no ERC-1271; listing bumps the epoch and pauses the seller's agent | notes/tokenbound.md sections 3.5, 4, 6 |
| D-110 | x402 payments come from the funding address through the platform payer with EIP-3009 USDC; `@x402/evm` at or above 2.22.0; per-agent daily caps; delivery recorded by request ID | notes/tokenbound.md section 3.9, risk-review.md dependency verification |
| D-111 | Agent-to-agent interaction uses fixed message types only; every incoming message is untrusted | PHASES.md Phase 5 |
| D-112 | The buyer agent runs on a different model from the sellers with its own budget; its results are labeled simulated | PHASES.md Phase 5 |
| D-113 | Build cards carry four distinct badges: publisher signature, static review, platform-attested build, independent runtime attestation (later) | preview.html revised technical plan section 12 |
| D-114 | Every return shows period, basis, costs and drawdown; short histories show "not enough data" | risk-review.md R20, preview.html revised technical plan section 12 |
| D-115 | Frontend: Next.js, React, TypeScript, wagmi and viem, Privy, TanStack Query, React Three Fiber with drei, GLB models with named sockets, a static fallback so GPU failure never blocks a withdrawal | build-manual.md section 10, preview.html revised technical plan section 12 |
| D-116 | Marketplace and creator content is sanitized before rendering; upload URLs and logs are tenant-scoped | preview.html revised technical plan section 12 |

### 1.7 Build process

| ID | Decision | Source |
|---|---|---|
| D-117 | Build in the ten phases of PHASES.md plus Phase B (the hackathon beta) between Phase 8 and Phase 9; each phase: build one unit at a time, stabilize, mid-phase playtest, end-of-phase playtest, tune; tracking in `LOGS.md` and `LESSONS.md`; the unit prompt template and session rules in `BUILD_PLAN.md` section 1 | conversation decision, PHASES.md, amended by owner decision, orientation |
| D-118 | Documents consolidated: three plan documents plus working notes kept in `Planv2/notes/`, plus the two append-only tracking files `LOGS.md` and `LESSONS.md` at the repository root and the unit prompts in `Planv2/units/` | conversation decision, planning answer, amended by owner decision, orientation |
| D-119 | Dependency labels PROPOSED, DOCUMENTED, SPIKE_PASSED, INTEGRATED, RELEASED; evidence advances a label | preview.html revised build manual section 1 |
| D-120 | Cut order: visual complexity, broad social sources, additional venues, open uploads, arbitrary live code, auto-copy, escrow jobs and the second chain before any weakening of custody, accounting, emergency handling or data provenance | preview.html revised build manual section 15 |
| D-121 | The founders own the legal review of pooled discretionary management; it gates public deposits | planning answer |
| D-122 | A capped mainnet canary through the real signer, Executor and venue precedes public use | notes/monad-agent-kit.md section 7 |
| D-123 | The Solana branch starts from the chain adapter interface and conformance suite built in Phase 2 | PHASES.md Phase 2, preview.html revised build manual section 11 |

### 1.8 Orientation decisions (2026-09-27)

| ID | Decision | Source |
|---|---|---|
| D-124 | This repository is the code repository; all code, plan documents and tracking files live here. The tracking files are `LOGS.md` (one entry after every unit and every playtest, newest at the bottom, so it reads as a chain of development) and `LESSONS.md` (one entry for every bug found and fixed, newest at the bottom), both at the repository root. There is no `plans/` directory and no `STATUS.md`, `BUGS.md` or `PLAYTEST.md`. This file stays the plan record and is updated only when a decision changes | owner decision, orientation |
| D-125 | The project name is Alpha Agents; the local folder name does not matter | owner decision, orientation |
| D-126 | Foundry: the latest stable release that includes Monad execution support (v1.8 or later); P0-U2 pins the exact version and the mainnet fork block number at the time it runs and records both in `LOGS.md` | owner decision, orientation |
| D-127 | All nine launch skills are available at base tier (`required_tier: base`); tiers still differ by slot count, and by playbooks, premium data and rails per D-032. Resolves A-01 | owner decision, orientation |
| D-128 | Fees are zero at launch, so fee treatment on in-kind exits is deferred; when fees activate they are charged in kind, proportionally across the tokens paid out, against the same high-water mark as USDC exits; the leader's own stake stays exempt. Resolves A-04 | owner decision, orientation |
| D-129 | At zero credits, everything that uses the LLM stops: research, proposals and the narrator. The deterministic bot runner, the circuit breaker, reduce-only protection and monitoring keep running, since they cost almost nothing. Withdrawals always work. The agent state is `RESTRICTED` while credits are exhausted. Resolves A-05 | owner decision, orientation |
| D-130 | Phase 0 is environment and accounts setup plus repo scaffolding. It starts with the owner setup checklist listing every tool, account and API key the full build needs, which phase first uses each, and a spending cap on every paid key | owner decision, orientation |
| D-131 | Every phase gets two playtests: a mid-phase playtest once the core pieces are built and connected (terminal output is acceptable) and an end-of-phase playtest once the feature is fully assembled. `BUILD_PLAN.md` sections 3 and 4 mark where each falls | owner decision, orientation |
| D-132 | The build runs one unit at a time. Each unit gets its own prompt, is built and tested alone, and is reviewed by the owner before the next unit starts. No session builds a whole phase | owner decision, orientation |
| D-133 | Two-stage definition of done. Hackathon beta (the October 13, 2026 submission): deployed on Monad mainnet as a guarded beta, allowlisted wallets only, small platform-wide and per-account deposit caps, and a clear "unaudited beta" label throughout; external audits and the legal gate are not required for this stage because access is limited to allowlisted testers with capped funds; testnet is used, clearly labeled, for anything not ready for mainnet. Public launch: external audits, the legal gate, raised caps and open deposits, as Phase 9 describes. The beta must demonstrate the nine items in `FINAL_PLAN.md > 2.1`; `BUILD_PLAN.md` section 4 marks the cut line with each unit full or reduced; PB-U1 is the beta deployment unit and does not depend on the audit or legal units; `BUILD_PLAN.md` section 7.2 carries the beta cut order | owner decision, orientation |
| D-134 | Every unit prompt ends with two lines: add a `LOGS.md` entry, and add a `LESSONS.md` entry for every bug fixed. Every unit session reads `LESSONS.md` first | owner decision, orientation |
| D-135 | `Reference/` holds a lessons file from Alpha Markets, a different project (AI agents trading prediction markets). Its product, contracts and design decisions do not apply here, and nothing in it overrides this plan or this register. Only its technical lessons carry over; they are listed in `BUILD_PLAN.md` section 8 with the unit or phase each affects. A unit session reads `Reference/` only when those lessons are relevant to that unit. Nothing is ever added to `Reference/` | owner decision, orientation |
| D-136 | One canonical tool registry (`FINAL_PLAN.md > 4.4.5`) lists every tool ID across the chain, data and platform servers as `<server>.<tool>@<major>`. The chain server gains `read_contract`, `balance` and `get_code`. Every tool the nine launch skills declare maps to a registry entry; the research's `data.dex_quote`, `data.pool_state`, `data.price_feed`, `data.yields`, `data.tvl` and `platform.portfolio` are replaced. No skill may declare a tool that is not in the registry | owner decision, orientation |
| D-137 | One canonical mode model (`FINAL_PLAN.md > 4.12`): the account mode onchain (`NORMAL`, `REDUCE_ONLY`, `PAUSED`, `HANDOVER`, `WIND_DOWN`), the agent state offchain (`UNCONFIGURED`, `READY`, `RUNNING`, `RESTRICTED`, `INCIDENT`), and display flags (awaiting approval, evaluated, stale data, partially settled, exit pending). The contract, Risk Sentinel, lifecycle and chain-tools vocabularies map onto it, and every other mention in the plan uses these names | owner decision, orientation |
| D-138 | The Risk Sentinel service holds its own narrow sentinel key, separate from the guardian key. The sentinel key can only tighten: set reduce-only, pause new risk, and pause deposits. It can never unpause, loosen limits, move funds or touch exits. Unpausing stays with the owner; the guardian key keeps its existing powers. The custody core exposes `setReduceOnly`, `pause` and `closeDeposits` to the owner or manager, the guardian and the sentinel key, and `unpause` to the owner or manager only | owner decision, orientation |
| D-139 | Every page in `FINAL_PLAN.md > 4.10` has an owning unit: the landing page with live counters and the mint page in P1-U10, the workflows page in P4-U8, the agent gallery in P7-U7, the agent profile page in P5-U1; the full page-to-unit table is in `FINAL_PLAN.md > 4.10` | owner decision, orientation |
| D-140 | Every decision in this register is self-contained and states the decision itself; its source is one of `planning answer`, `conversation decision`, `owner decision, orientation`, or a document name. `FINAL_PLAN.md` and `BUILD_PLAN.md` use the same labels | owner decision, orientation |
| D-141 | Unit IDs follow build order. Phase 6: P6-U1 3D asset pipeline, P6-U2 SkillNFT, registries and BuildRegistry, P6-U3 packaging, privacy and loader, P6-U4 audit pipeline and creator upload service, P6-U5 launch skills as NFTs and premium data, P6-U6 configure page. Phase 4 around the new sentinel unit: P4-U1 workflow runner, P4-U2 Risk Sentinel service, P4-U3 built-in workflows, P4-U4 CFO dashboard, P4-U5 reports, P4-U6 tax lot ledger, P4-U7 notifications, P4-U8 workflows page. New units: P1-U10, P7-U7, PB-U1, PB-U2; P9-U4 becomes the public launch deployment and P9-U6 the evidence bundle refresh | owner decision, orientation |
| D-142 | The skills marketplace and custom skills are core to the idea and are prominent in `FINAL_PLAN.md` sections 1 and 2. The hackathon beta includes the full creator loop: an invited creator uploads a custom skill through the invite-only creator portal, it passes the audit pipeline, it is listed as an NFT in the marketplace, a user buys it and equips it to their agent on the configure page, where it appears as a part on the 3D model, and the agent uses its new capability. Every unit this needs is on the cut line in full or reduced form; the item escrow is built before the agent escrow so the beta needs no agent sales | owner decision, orientation |
| D-143 | Hermes capability policy. "Pinned" means locked to a tested version, not reduced; Hermes may be re-pinned to a newer commit after that commit passes the Hermes spike (H-01 to H-16 and H-45) again. Hermes' built-in tools that run only inside the sandbox (terminal, code execution, file operations in `/workspace`) are enabled, because the sandbox has no network egress except the gateway and our tool servers. Self-improvement, skill writing and memory writes outside the approved paths stay off, because they would let one cycle change what the next cycle runs without an audit, a build activation or an owner decision. Browser, web, search, delegation, cron and connection toolsets stay off because each needs egress or duplicates a metered platform path. `FINAL_PLAN.md > 4.3.8` is the capability table | owner decision, orientation |
| D-144 | Credits are Bankr-style. Each agent has one funding address, the KMS-held EOA that was the operating wallet. Any USDC sent to it is the agent's credit balance, attributed automatically from the indexed transfer with no extra steps. The agent spends credits on its own for inference, tool and data calls, sandbox and runner time, gas and x402 purchases, and pauses LLM activity at zero per D-129. The Billing contract, the allowance and the batch-settlement flow are replaced; per-agent metering records are kept; settlement is a signer-executed sweep to the platform treasury under a period ceiling with a sequence and usage hash; refunds of unspent credits go only to the current owner. Trading capital stays separate in the PersonalAccount. In the UI a single "Fund your agent" action shows two balances, Credits and Trading. The signer's allowlist becomes exactly four transaction kinds: Executor calls, x402 authorizations, settlement sweeps, refunds | owner decision, orientation |
| D-145 | Beta guard: a mint allowlist in AgentNFT, a depositor allowlist and per-account caps in AccountFactory, an API-level allowlist, and the "unaudited beta" label on every page, on build cards, in the API environment field (`mainnet-beta`) and in the README. Adding to an allowlist and enabling it are instant; only the admin timelock can disable one. No exit is ever gated by an allowlist or a cap. The dev console kill switch is wired to the guardian key at PB-U1 | owner decision, orientation |
| D-146 | Before every end-of-phase playtest, a seam sweep: every unit in the phase names what calls its output by a route a real user would take; a unit whose only caller is a test or a demo script is a finding. Carried from the Alpha Markets lessons | owner decision, orientation |

### 1.9 Owner decisions during the build

| ID | Decision | Source |
|---|---|---|
| D-147 | Owner decision: all units commit directly to `main` in small, incremental commits; there is no branch per unit. This replaces "one branch per unit" in the session rules of `BUILD_PLAN.md` section 1. The Solana track keeps its separate branch (D-004, D-123). The owner pushes | Planv2/units/P0-U1-repo-and-tooling.md |
| D-148 | Solidity dependencies install with Soldeer, Foundry's built-in package manager, not git submodules or `forge install`, so no nested git repository enters this repository. Versions are exact (forge-std 1.16.2 at P0-U2), `chains/*/soldeer.lock` is committed with each dependency's checksum and integrity hash, `dependencies/` is gitignored, remappings are written by hand in `remappings.txt` and not regenerated, and CI restores dependencies with `forge soldeer install` | Planv2/units/P0-U2-local-environment.md |
| D-149 | Owner decision: there are three environments, selected by `APP_ENV`: `local`, the anvil fork of Monad mainnet (chain 143, record label `fork`); `testnet`, Monad testnet (chain 10143, label `testnet`); and `beta`, Monad mainnet as a guarded beta (chain 143, label `mainnet-beta`), as built in P0-U3. The public `mainnet` environment is added in Phase 9, at P9-U4. Every record carries the environment label. This replaces the five environment templates (local, fork, testnet, mainnet-beta, mainnet) in the P0-U3 row of `BUILD_PLAN.md` | Planv2/units/P0-U5-shared-packages.md |
| D-150 | Owner decision: a new unit, P0-U6 Web foundation and design system, is built after P0-U5 and before P0-U4. It creates `apps/web` (Next.js App Router, TypeScript, Tailwind CSS, shadcn/ui), design tokens defined once as CSS variables, the base components, the app shell and a `/design` page. Every later page is built only from these components and tokens (the frontend rule in `CLAUDE.md`), and P0-U4, the dev console, depends on P0-U6 and uses its components | Planv2/units/P0-U6-web-foundation.md |
| D-151 | Owner decision: "oracle price under 5 minutes old" is strict. A price exactly 300 seconds old fails the offchain pre-check with `ORACLE_STALE`; every other maximum in the hard limits still passes at exactly its value | Planv2/units/P0-U6-web-foundation.md |
| D-152 | Owner decision: an agent swap on a StrategyVault in `HANDOVER` is rejected with its own reason code, `VAULT_IN_HANDOVER` ("The vault is changing hands, so the agent cannot trade it until the new owner accepts management."), not `EPOCH_MISMATCH`, so the owner sees why the agent did not trade | Planv2/units/P0-U6-web-foundation.md |
| D-153 | Owner decision: the canonical tool registry of `FINAL_PLAN.md > 4.4.5` is defined in `packages/domain`, and `packages/skills` re-exports the same objects rather than keeping a copy | Planv2/units/P0-U6-web-foundation.md |
| D-154 | Owner decision: the prototype at `~/Monad-Test` ("Apiary") is the visual spec for the product. The token changes proposed in `Planv2/notes/prototype-review.md` section 2.3 are adopted in full: the cool graphite palette, off-white, ash, lime, the new lime-dim, red, brass, amber and steel palette steps, the new semantic tokens (`primary-muted`, `warning`, `rare`, `viewer-glow`), flat cards with the new shadow set, the type scale shifted down one step with a dense `2xs` step and label tracking, a 13px body with tabular numbers, the new radii, the motion tokens and the reduced-motion rule, and the component changes that section names (Button sizes 28, 36 and 40px, a `secondary-accent` Button variant, `Tag`, `SectionLabel`). Geist is replaced by Inter (400, 500, 600) and JetBrains Mono (400, 500), loaded through `next/font/google` so the files are served from our own origin. The prototype supplies values only; nothing from its CSS is copied. This is a new unit, P0-U7 Design tuning, built after P1-U1 and before P1-U2, so every Phase 1 page is built on the tuned tokens | Planv2/notes/prototype-review.md |
| D-155 | Owner decision: a new unit, P1-U11 Prototype port, is built after P1-U3 and before P1-U10. Its scope is exactly: the agent portal (the Configure page layout, panels and cards); the visual style (outlines, borders and panel framing) expressed through our tokens and `packages/ui`; the 3D model and its animations (the rigged body, its animations and the 3D scene, with a base body per tier); skill slots that keep the prototype's hexagon look but are anchored each to a named socket on the model so they follow it; the NFT connector experience (wallet connection, the mint flow and its button states, the ownership check, and the agent NFT shown in its card), rebuilt on Privy (P1-U2) and our AgentNFT (P1-U3), not copied; and any supporting code those pieces need. P1-U11 absorbs the body, scene and socket part of the reduced P6-U1 (one base body with a variant per tier, with sockets). P6-U1 keeps the skill part models, the generic part, thumbnails and further bodies and builds on P1-U11's sockets; P6-U6 wires P1-U11's portal to BuildRegistry; P1-U10 reuses P1-U11's mint flow and tier bodies | Planv2/notes/prototype-review.md |
| D-156 | Owner decision: nothing else from the prototype is ported. Its contract (`ApiaryAgents`, its tests and deploy script), RainbowKit and its wallet helpers, the mock skills, publishers and agent stats, the "Run backtest" button and every unlabeled demo number (vault TVL, depositors, watchers, signal buyers, the canned test run) are dropped. RainbowKit is never installed alongside Privy | Planv2/notes/prototype-review.md |
| D-157 | Owner decision: Q-25 is resolved for the bee model. The owner confirmed that the Meshy plan used to generate the mesh allows commercial use, that the concept art's source is recorded by the owner, and that UniRig's license permits our use of the rig it produced. The bee mesh, rig and concept art may ship in the beta. Any later asset made with a different tool or plan needs the same confirmation before it ships | Planv2/notes/prototype-review.md |
| D-158 | Owner decision: unit prompts are no longer saved to `Planv2/units/` from P0-U4 on; the prompts of the units before P0-U4 stay there, and a later unit's `LOGS.md` entry and commits are its record. This supersedes Assumption A-25. Both Next.js apps set `agentRules: false` in `next.config.ts`, so `next dev` no longer writes `AGENTS.md` and `CLAUDE.md` into them; the related `.gitignore` entry and the note in the root `CLAUDE.md` are removed | LOGS.md (P0-U4 housekeeping entry) |

---

## 2. Resolved conflicts

| ID | Conflict | Sources involved | Resolution |
|---|---|---|---|
| C-01 | PHASES.md is missing; the initial plan was written for a hackathon while the register targets a live product | Brief Part 2, PHASES.md (supplied later), planning answer | PHASES.md was supplied and reconciled; the hackathon stays a target with the live product as the demo (D-003) |
| C-02 | The skill.json spec was referenced but absent from the repository | conversation decision, Bankr research folder (supplied later) | The Bankr research folder was added; its section 2.1 is the spec (D-099) |
| C-03 | The owner's wallet holds funds and a sale moves them (initial plan) versus the token-bound account never holds capital (register) | project-overview.md, technical-report.html section 3, conversation decision | conversation decision wins: three separate capital accounts, the account holds skills and identity only (D-038, D-039) |
| C-04 | The brain writes and evolves bot code with fork backtests (initial plan) versus no arbitrary code generation and parameter tuning of approved templates (register) | technical-report.html section 6, build-manual.md section 4.5, conversation decision | conversation decision wins; the evolution timeline becomes build history by config epoch (D-090, D-020) |
| C-05 | Withdrawals "at any time" versus lockups of 24 hours to 7 days | project-overview.md, conversation decision | conversation decision wins (D-072) |
| C-06 | "The owner earns a cut" versus "fees deferred" | conversation decision (two sentences) | Build the mechanism with the rate at zero; activation later (D-013) |
| C-07 | Leader stake of 5% assumed by every vault source, silent in the register | technical-report.html section 8, notes/morpho-vault.md, notes/managed-vaults.md | Included, scoped to diluting deposits and the leader's own exits (D-078) |
| C-08 | "Limits checked on buys only, never on exits" versus a leader-stake rule that blocks the leader's exits | conversation decision, notes/managed-vaults.md section 4 | The rule applies to the leader only; depositors' exits are never blocked (D-078) |
| C-09 | Share transfers propagate the later unlock (register) versus a dust transfer can extend anyone's lock and break cost basis (both vault notes) | conversation decision, notes/morpho-vault.md section 4, notes/managed-vaults.md section 4 | Transfers disabled at launch (D-073) |
| C-10 | Top-ups set the later unlock (register) versus third-party deposits can relock a victim | conversation decision, notes/managed-vaults.md section 4 | Self top-ups keep the rule; third-party deposits rejected (D-074) |
| C-11 | "Leader changes apply only to new deposits" was ambiguous against the research's handover design | conversation decision, notes/tokenbound.md section 4 item 9, notes/morpho-vault.md section 3.9 | Read as lockup-length changes; the researched handover adopted (D-076, D-077) |
| C-12 | Handover: cooldown plus redeem window plus acceptance (Tokenbound research) versus reduce-only plus epoch bump plus delay (managed vaults research) | notes/tokenbound.md, notes/managed-vaults.md, notes/morpho-vault.md | Combined: handover mode with deposits closed, reduce-only, locks waived, fresh stake and acceptance after the handover period (D-077) |
| C-13 | Leader stake moves through the escrow versus the buyer posts fresh | notes/morpho-vault.md section 7 | Buyer posts fresh (D-077) |
| C-14 | Skip-list forfeit versus claimable credit for a reverting token in `redeemInKind` | notes/managed-vaults.md section 7, notes/morpho-vault.md section 7 | Claimable credit (D-071) |
| C-15 | "Pause" in both vault codebases meant no exits; the register's 20% pause needed an exit carve-out and an unpause authority | notes/managed-vaults.md section 4, conversation decision | Pause blocks deposits and new-risk swaps only; owner unpauses after one lockup period for public vaults (D-080) |
| C-16 | Dropping an asset without a feed from the allowlist would strand in-kind claims | conversation decision, notes/managed-vaults.md section 4 | Buy allowlist separate from the held-asset list (D-056) |
| C-17 | "The Executor approves the exact amount" cannot be literal if the account holds the tokens (Zodiac note) versus pull-exact into the Executor (managed vaults note) | notes/zodiac-roles.md section 6, notes/managed-vaults.md section 4, conversation decision | Pull exact, approve exact, venue pays the account, reset, account checks deltas (D-042) |
| C-18 | Deadline set in the policy step versus at signing time | notes/monad-agent-kit.md section 4 (internal inconsistency in the research) | Signing time (D-054) |
| C-19 | Tool specs hard-code limits versus "read limits from the Executor" | notes/monad-agent-kit.md section 4, conversation decision | Schema bounds generated per session from Executor views (D-095) |
| C-20 | Premium chain tools per tier (monad-agent-kit research) versus full baseline for every tier (register) | notes/monad-agent-kit.md section 4, conversation decision | Chain tools baseline; only curated data tools gated (D-097) |
| C-21 | Model aliases per stage in the tier overlay (Hermes research) versus model choice not tier-based (register) | notes/hermes.md section 4, conversation decision | User picks one model; a disclosed cheap platform model for Scan and Test; no tier link (D-037) |
| C-22 | MCP token in the sandbox `.env` (Hermes research) versus egress injection (register) | notes/hermes.md section 4, conversation decision | Egress injection for both secrets, with a spike (D-092) |
| C-23 | Hermes cron as an option for Scan and Zoom out versus orchestrator-owned scheduling | notes/hermes.md section 4, conversation decision | Hermes cron unused; the `cronjob` toolset removed (D-093) |
| C-24 | Python FastMCP mock in the Hermes spike versus the MCP TypeScript SDK | notes/hermes.md section 4, conversation decision | Spike server built with the TypeScript SDK (D-095) |
| C-25 | "Self-improvement off" covering only the background review versus foreground `skill_manage` and memory paths | notes/hermes.md section 4, conversation decision | Foreground paths blocked too (D-089) |
| C-26 | Privy session wallets with policies (initial plan, research) versus unverified policy scoping on Monad | build-manual.md section 3.1, notes/monad-agent-kit.md section 7, notes/zodiac-roles.md section 7 | KMS-backed platform signer; Privy for login only (D-045) |
| C-27 | Venue: only Uniswap v3 de-risked by research versus v4 or Kuru in the register | notes/zodiac-roles.md section 6, notes/morpho-vault.md section 6, conversation decision | v3 added to the depth spike; the spike decides (D-008) |
| C-28 | Launch assets USDC, WMON, WETH and an LST (research briefs) versus USDC and WMON (register) | notes/zodiac-roles.md section 8, notes/morpho-vault.md section 8, conversation decision | conversation decision wins (D-007) |
| C-29 | Twenty trades per calendar day versus a rolling 24-hour window | notes/zodiac-roles.md section 8, conversation decision | Rolling window with a ring buffer (D-054) |
| C-30 | No turnover cap in the register while 20 trades at 10% permit about 200% NAV churn per day | notes/zodiac-roles.md section 4, conversation decision | Rolling turnover cap at 100% of NAV (D-051) |
| C-31 | Post-trade 40% and 10% checks could strand an account after a price move | notes/zodiac-roles.md section 4 | Reduce-only exemption (D-052) |
| C-32 | Custom account "for personal capital" (Tokenbound research) versus "to close skill-drain paths for open marketplaces" (register) | notes/tokenbound.md section 4 item 8 | The register's rationale carried; the same implementation would serve both (D-047) |
| C-33 | "Never grants permissions to platform keys" was insufficient because any permissioned contract can upgrade and sign | notes/tokenbound.md section 4 item 1, conversation decision | Tightened to no permissions or overrides for anyone (D-040) |
| C-34 | Escrow implementation check as a constant versus an allowlist | notes/tokenbound.md section 7 item 15 | Allowlist with one entry at launch (D-109) |
| C-35 | Notes B in the Tokenbound research said an escrow cannot read another contract's storage; the final report says `extsload` makes it possible | notes/tokenbound.md section 6 | The final report's position, confirmed by spike TB-9b before the escrow depends on it |
| C-36 | BuildRegistry sketch with `uint32` versions and count-based slots versus content-hash versions and slot cost | notes/tokenbound.md section 4 item 10, conversation decision | Content hashes and slot cost read from SkillRegistry (D-099) |
| C-37 | `wallet-intel` at tier base in one section and medium in another; research skills at medium and pro | notes/bankr-skills.md section 5 | All nine at base (D-127, which resolved Assumption A-01) |
| C-38 | Slot cost 1 to 3 (research) versus slots 3, 5, 8 (answer) | notes/bankr-skills.md section 7, planning answer | Both kept; builds are a choice by design (D-034, D-099) |
| C-39 | The DCA skill's "scheduled" wording would trip audit rule S8 | notes/bankr-skills.md section 7 | Schedule moved to Recurring Buys (D-101) |
| C-40 | Goal form fields: amount, horizon, priority, risk level (PHASES.md) versus the agreed field list | PHASES.md Phase 3, planning answer | Agreed list (D-010) |
| C-41 | Owner approves allocation proposals before rebalancing (PHASES.md) versus automatic trades within limits | PHASES.md Phase 3, planning answer | Parameter proposals approved per workflow mode; trades automatic after arming (D-019, D-020) |
| C-42 | Goal buckets on the CFO dashboard (PHASES.md) versus one strategy per account | PHASES.md Phase 4, planning answer | Single-goal progress (D-011) |
| C-43 | Phase 7 described as "ERC-4626 accounting and direct withdrawals" versus the full register vault design | PHASES.md Phase 7, conversation decision | Full design in three units (BUILD_PLAN.md Phase 7) |
| C-44 | Encrypted upload precedes audit (technical report) versus plaintext review precedes encryption (build manual) | technical-report.html section 5, build-manual.md section 11, risk-review.md | TLS upload to quarantine, review of exact bytes, then encryption (D-102) |
| C-45 | Ownership read only through the indexer versus directly from chain | build-manual.md sections 1.2 and 3.2, risk-review.md | Indexer for discovery and UI; block-tagged chain checks and onchain validation for authorization (FINAL_PLAN.md section 3) |
| C-46 | `withdraw(uint256 shares)` described as ERC-4626 style (technical report) versus standard signatures | technical-report.html section 8, risk-review.md | Standard ERC-4626 signatures plus the safe overload and `redeemInKind` (FINAL_PLAN.md section 4.7.5) |
| C-47 | Langfuse proposed for tracing (build manual) versus "captures full prompts" (Hermes research) and gateway logging off (answer) | build-manual.md section 12, notes/hermes.md section 2.8, planning answer | Metadata-only tracing; no prompt capture (BUILD_PLAN.md P9-U2) |
| C-48 | `@x402/evm` 2.12.0 floor (initial plan) versus 2.22.0 (risk review) | technical-report.html section 12, risk-review.md | 2.22.0 or later, pinned (D-110) |
| C-49 | Research notes recommend dropping vendor zero-retention as a launch requirement given the privacy definition | notes/bankr-skills.md section 7, planning answer | planning answer stands: zero-retention terms and logging off are requirements (D-105) |
| C-50 | Live `balanceOf` versus internal balance tracking for donations (Morpho research internally inconsistent) | notes/morpho-vault.md section 6 | Live `balanceOf` of allowlisted tokens only (FINAL_PLAN.md section 4.7.3) |
| C-51 | Fee shares in the in-kind path: pending fee shares (Morpho model) versus per-depositor exit fees | notes/morpho-vault.md section 6 | Per-depositor exit fees; no pending shares (D-084); in-kind fee treatment deferred and defined by D-128 |
| C-52 | The October 13, 2026 deadline versus a definition of done that required external audits and the legal gate before any mainnet deployment | BUILD_PLAN.md revision 1 Phase 9; orientation review | Two-stage definition of done: a guarded mainnet beta without audits, then the public launch with them (D-133) |
| C-53 | The nine skills declared tool IDs (`chain.read_contract`, `chain.balance`, `chain.get_code`, `data.price_feed`, `data.dex_quote`, `platform.portfolio`) that no server exposed, while P3-U3 required every ID to resolve | FINAL_PLAN.md revision 1 sections 4.4.2 and 4.5.4 | Canonical registry; three tools added to the chain server; every skill declaration rewritten (D-136) |
| C-54 | P2-U2's dependencies in the Phase 2 table (P2-U0, P2-U1) versus the build order and dependency graph (also P2-U3) | BUILD_PLAN.md revision 1 sections 2, 3 and 4 | The table matches the graph and the build order; P2-U3 is built before P2-U2 |
| C-55 | Three mode vocabularies (custody core, Risk Sentinel, P9-U1 lifecycle) plus a chain-tools subset, with no mapping between them | FINAL_PLAN.md revision 1 sections 4.1.6, 4.6.2 and 4.10; BUILD_PLAN.md revision 1 P4-U2 and P9-U1 | Canonical mode model with a mapping table (D-137) |
| C-56 | The Risk Sentinel acted "through the guardian path" while the guardian was described as a separate security key held for emergencies | FINAL_PLAN.md revision 1 sections 4.6.2 and 4.7.1 | The sentinel holds its own tighten-only key (D-138) |
| C-57 | The landing page, mint page, agent gallery and workflows page appeared in section 4.10 and the definition of done but in no unit | FINAL_PLAN.md revision 1 section 4.10; BUILD_PLAN.md revision 1 | Units P1-U10, P4-U8 and P7-U7 added; the profile page assigned to P5-U1 (D-139) |
| C-58 | Register entries pointed to "Answer n" and "Register", neither of which exists in the repository | DECISIONS_AND_OPEN_QUESTIONS.md revision 1 | Four source labels; every entry self-contained (D-140) |
| C-59 | Phase 6 unit IDs did not follow the build order | BUILD_PLAN.md revision 1 Phase 6 | Renumbered (D-141) |
| C-60 | A Billing contract with owner deposits, allowances and batch settlement versus the owner's Bankr-style single funding address | FINAL_PLAN.md revision 1 section 4.1.10; owner decision, orientation | Funding address model; the Billing contract is removed; the platform custody of credits is disclosed (D-144) |
| C-61 | The Hermes research disabled every built-in toolset for confinement versus the owner's capability policy | notes/hermes.md section 4; owner decision, orientation | In-sandbox toolsets enabled; network-dependent and self-modifying paths stay off (D-143) |
| C-62 | The Risk Sentinel sat inside the built-in workflows unit, which the beta could not carry without the workflow runner | BUILD_PLAN.md revision 1 P4-U2 | The sentinel is its own unit, P4-U2, with its own key; the workflows become P4-U3 (D-141) |

---

## 3. Open questions

Type: `Open` needs a decision or a measurement; `Assumption` is a choice the plan made that must be confirmed or overturned.

### 3.1 Assumptions made in the plan

Resolved in the orientation session and struck from the open list: A-01 (all nine skills at base tier, now D-127), A-04 (in-kind fee treatment, now D-128), A-05 (behavior at zero credits, now D-129).

| ID | Assumption | Who decides | What it blocks |
|---|---|---|---|
| A-02 | Medium tier's execution rails are a dedicated RPC endpoint only; pro gets dedicated RPC, nearby runner placement and a larger priority fee cap | Founders | P2-U4 signer fee policy; P1-U5 provisioning |
| A-03 | Premium curated data tools are pro-only at launch | Founders | P3-U2 tier gating; pricing |
| A-06 | Virtual share offset 1e12 for USDC as the starting value | Contract engineer after spike M-03 and MV-V24 | P7-U1 |
| A-07 | ERC-8004 registration is built in Phase 5 with back-registration of earlier mints rather than in P1-U3 | Founders | P5-U1 |
| A-08 | At launch the allowed intent set for an agent is the union of the active build's manifests; per-skill attribution is added only if Hermes exposes the active skill | Runtime engineer after spike B-02 | P2-U5 policy |
| A-09 | PersonalAccount uses internal non-transferable units for flow-adjusted valuation and has no share token | Contract engineer | P2-U1 |
| A-10 | The escrow's implementation allowlist has a single entry at launch | Founders | P8-U1 |
| A-11 | The `token-risk-screen` guardrail lives in policy rather than as a workflow NFT | Founders | P4-U3 |
| A-12 | "Playbooks" per tier are a rendered `SOUL.md` block plus an auto-loaded playbook skill plus starter workflows; base gets the two strategy playbooks, higher tiers add starter workflows | Founders | P1-U5 config layers |
| A-13 | The demo cast is five platform-run agents with small real capital, labeled as platform-run | Founders | PB-U1, PB-U2, P9-U4 |
| A-14 | Build cards carry four badge classes as in the revised technical plan | Founders | P5-U1 |
| A-15 | The chain adapter interface and conformance suite is a Phase 2 unit (P2-U8) so the Solana branch starts from a tested seam | Founders | S-U1 |
| A-16 | The minimal data tool in Phase 1 is web search only; the full data server arrives in Phase 3 | Founders | P1-U7 |
| A-17 | Kuru addresses, mechanics and a "pool price" definition for an orderbook are supplied by the depth spike, since no research covers Kuru | Execution engineer | P2-U0 |
| A-18 | The address book verified on 2026-09-25 is correct until re-verified before deployment | Contract engineer | Every contract unit |
| A-19 | The platform gas treasury tops up MON at each funding address automatically and meters the cost against credits, so owners send only USDC; MON sent directly is used as gas and never counted as credits; during zero credits the platform advances gas for protection actions up to a small per-agent cap and recovers it from the next top-up | Founders | P1-U6, P2-U4, P4-U2 |
| A-20 | Unspent credits are refundable to the current owner through the signer as a platform-serviced action; on a sale the seller is prompted to refund first, and any remainder stays with the agent | Founders | P1-U6, P8-U3 |
| A-21 | The beta allowlists are enforced onchain in AgentNFT (mint) and in AccountFactory (deposits into both account modes) and offchain in the API; AccountFactory replaces the earlier VaultFactory and deploys PersonalAccount clones as well as vaults | Contract engineer | P1-U3, P2-U1, P7-U4, PB-U1 |
| A-22 | The sentinel's tighten path is `setReduceOnly`, `pause` and `closeDeposits` on the custody core, callable by the owner or manager, the guardian and the sentinel key, with `unpause` owner-only; the Executor exposes nothing to the sentinel key | Contract engineer | P2-U1, P4-U2 |
| A-23 | The reduced versions of the beta units described in `BUILD_PLAN.md` section 4 are the plan's proposal; the owner confirms or adjusts them at the Phase 0 end-of-phase review | Founders | PB-U1 |
| A-24 | The chain tools `read_contract`, `balance` and `get_code` take an arbitrary `target` address but return typed values only (strings and bytes as length and hash), so they add no free-text injection path and do not conflict with the identity lint rule | Runtime engineer | P2-U5, P3-U3 |
| A-25 | Superseded by D-158. The prompts of the units before P0-U4 are stored in `Planv2/units/`, one file per unit, named like `P0-U2-local-environment.md`; from P0-U4 on, unit prompts are not saved, and the unit's `LOGS.md` entry and commits are its record | Founders | P0-U1 |
| A-26 | The mid-phase playtest placements in `BUILD_PLAN.md` sections 3 and 4 are the plan's proposal; the owner may move them | Founders | every phase |

### 3.2 Open questions needing a decision or a measurement

| ID | Question | Who decides | What it blocks |
|---|---|---|---|
| Q-01 | Which venue: Uniswap v3, Uniswap v4 or Kuru, by measured depth at the reference size inside 0.5% slippage | Founders after spike MK-K05 | P2-U2 adapter, the swap skill's name, `get_quote` shape |
| Q-02 | Chainlink MON/USD heartbeat and deviation on Monad; is the 5-minute staleness target meetable, and what spread and band parameters follow | Execution engineer after M-33, M-28, MV-S8 | P2-U3, P7-U1 |
| Q-03 | Is `0x7547...b603` Circle's official USDC on Monad, and does it carry blacklist and pause functions | Founders (confirm with Circle) | P5-U4 x402 token; MV-S1 credit design |
| Q-04 | Is E2B per-host egress header injection available on the chosen plan, and which second factor (IP allowlist, mTLS, HMAC header) proves a request came through E2B | Runtime engineer after MK-S1b | P1-U1; fallback is a platform egress proxy |
| Q-05 | Hermes unknowns at 085d9ee: MCP config keys, `structuredContent` handling, `list_changed`, tool call timeout, index truncation at 57 characters, `requires_tools` with MCP tools, `skill_manage` write paths, cross-session caching after a version swap | Runtime engineer after H-01 to H-16, B-02, B-05 | P1-U1, P3-U7, P6-U3 |
| Q-06 | Does the model still obey goals and limits when they arrive wrapped as untrusted tool results | Runtime engineer after H-26 | P3-U4 |
| Q-07 | Do the nine skills' 60-character descriptions select reliably; which skills merge if not | Founders after H-44 and B-02 | P3-U7 (launch gate) |
| Q-08 | Which model providers offer zero-retention terms, and which models are on the user-selectable list with which credit prices | Founders | P1-U6 price table, P3-U4 aliases |
| Q-09 | The tool-call price table and the per-tier credit quotas for premium data | Founders | P1-U6, P3-U2 |
| Q-10 | Anvil fork fidelity for Monad: gas charged on the limit, cold access repricing, sub-second timestamps, RPC differences | Execution engineer after TB-0 and MV-V26 | Every fork-based spike's interpretation |
| Q-11 | Does Monad support EIP-1153 transient storage, and EIP-6780 SELFDESTRUCT semantics | Contract engineer after ZR-Z12 | P2-U1 reentrancy guard; P7-U1 once-per-transaction cache |
| Q-12 | Monad mempool visibility and private order flow, which set sandwich and revocation-race exposure | Execution engineer | P2-U2 caps, P9-U2 latency targets |
| Q-13 | ERC-8004 registry address and ABI on Monad, and whether wallet verification goes through ERC-1271 | Contract engineer | P5-U1 |
| Q-14 | Will the Tokenbound Safe ever trust a new implementation on Monad, and will it announce it | Founders (ask Tokenbound) | Escrow allowlist governance; monitoring |
| Q-15 | Accept the 35 unaudited Tokenbound commits and the missing seller-as-attacker audit model for a skills-only account, in writing | Founders | P1-U3 |
| Q-16 | Do canonical proxy accounts walk the nested-owner tree (TB-9a), which decides whether agents may ever own agents | Contract engineer | Deferred feature only |
| Q-17 | Public wording of the privacy claim | Founders | Marketplace and creator copy; submission material |
| Q-18 | First customer segment | Founders | Landing copy; pricing |
| Q-19 | Legal classification of pooled discretionary management and the offering structure per jurisdiction | Founders with counsel | P9-U5 public deposits |
| Q-20 | Exact x402 payer tuple on Monad mainnet: payer address, token, domain, signature scheme, facilitator | Execution engineer after P5-U4 on testnet and P8-U4 on mainnet | P8-U4 |
| Q-21 | Per-tier priority fee caps and gas caps from the latency spike | Execution engineer after MK-S7 | P2-U4, P9-U2 |
| Q-22 | Emergency reserve sizing and funding policy | Founders | P9-U1 |
| Q-23 | RPC providers (two) for Monad with latency and rate limits; the bot runner host by latency to the RPC | Runtime engineer | P1-U5, P2-U4 |
| Q-24 | Web search provider (Exa or Tavily), X API budget, whether Token Terminal covers Monad | Founders | P3-U2 |
| Q-25 | Image-to-3D tool with commercial license and hard-surface quality. Resolved for the bee model by D-157 (Meshy on a plan that allows commercial use, the UniRig rig, the concept art source recorded by the owner); open only for any later asset made with another tool or plan | Art track | P1-U11, P6-U1 |
| Q-26 | IPFS or Arweave for public token metadata and art | Founders | P6-U5, P8-U2 |
| Q-27 | Project logo (the name is settled: Alpha Agents, D-125) | Founders | PB-U2 |
| Q-28 | The evals format for strategy skills and the parameter schemas for `rebalance_bands@1` and `dca@1` | Quant and runtime engineers | P3-U3, P6-U4 dynamic test |
| Q-29 | Turnover cap tuning after live data (100% of NAV to start) | Founders | Policy hash updates |
| Q-30 | Whether formal verification (at least offline-exit liveness) is required before external review | Founders | P7-U3, P9-U3 |
| Q-31 | Solana price feed provider and DEX venues | Solana engineer after S-U1 | S-U2 |
| Q-32 | How the buyer agent's willingness to pay maps to launch prices for real-time signals | Founders after P5-U7 | P8-U4 pricing |
| Q-33 | Which monitoring stack replaces Langfuse for metadata-only tracing | Runtime engineer | P9-U2 |
| Q-34 | Report templates and notification frequency defaults after the Phase 4 playtest | Founders | P4-U5, P4-U7 tuning |
| Q-35 | Uniswap v4 hook policy (hookless only) and the size guard threshold, if v4 is chosen | Execution engineer | P2-U2, P7-U1 |
| Q-36 | The beta allowlist (which testers and wallets) and the beta cap values: platform total, per PersonalAccount, per vault | Founders | PB-U1 |
| Q-37 | Hosting: which long-running host runs the orchestrator, tool servers, sentinel and bot runner, which managed Postgres and Redis, and which web host; serverless function ceilings rule out request-scoped functions for anything that calls a model | Founders | Phase 0 checklist, P1-U4, PB-U1 |
| Q-38 | Which Hermes commit to pin at P1-U1: 085d9ee or a newer commit that passes the spike | Runtime engineer after H-01 to H-16 | P1-U1 |
| Q-39 | The configuration keys at the pinned commit that enable the terminal, code execution and file toolsets inside the sandbox, and how their working directory is pinned to `/workspace`; confirmed by reading who consumes each key, not the schema | Runtime engineer after H-05 and H-12 | P1-U1 |
| Q-40 | Gas sponsorship mechanics: the top-up threshold, the per-agent advance cap during zero credits, and whether the platform gas treasury is one address or one per environment | Founders | P1-U6, P2-U4 |
| Q-41 | The creator invited for the beta and the custom skill they will publish, so the creator loop in `FINAL_PLAN.md > 2.1` item 9 has a real author | Founders | P8-U2, PB-U1 |

---

## 4. Risk register

Ranked by consequence if the failure occurs, then by likelihood as the research rated it. "Owner" is the component or unit that carries the mitigation.

| Rank | Risk | Why it matters | Mitigation | Owner | Source |
|---|---|---|---|---|---|
| 1 | New, unaudited custody and enforcement code (custody core, Executor, escrow, oracle adapter) | All enforcement moves into new code; nothing has been run | Small immutable custody core, ported invariants and adversarial tests, spikes as gates, two external reviews, low caps, mandatory seed, canary before public use | P2-U1, P2-U2, P7-U3, P9-U3, P9-U4 | notes/zodiac-roles.md section 6, notes/morpho-vault.md section 3.11 |
| 2 | No reliable MON/USD feed, or a heartbeat above the 5-minute target | The whole limit set, vault valuation and USDC exits depend on it; with two launch assets a missing feed leaves nothing to trade | Heartbeat spike first; staleness per feed; drop assets without a feed; USDC treated as 1 with a depeg guard; in-kind exit never reads an oracle | P2-U0, P2-U3 | notes/managed-vaults.md section 6, notes/monad-agent-kit.md section 6 |
| 3 | Thin Monad liquidity makes trades and USDC exits fail often; agents look broken | Three research runs rate this the most likely failure | Depth spike chooses the venue; `get_quote.limitCheck` and `get_prices.tradable` before proposals; "why the agent did not trade" display; size guard routes exits in kind; TVL caps | P2-U0, P2-U5, P7-U1, frontend | notes/monad-agent-kit.md section 3.13, notes/zodiac-roles.md section 6 |
| 4 | Oracle-priced entry and exit lets informed users extract value from a lagging feed | Morpho's accepted findings made daily | Spread per asset at least the deviation threshold; time-scaled reference band; lockup stops same-block round trips; async deposits as the named fallback | P7-U1 | notes/morpho-vault.md section 3.11 |
| 5 | Executor or session key compromise | Critical impact even if unlikely | Per-trade, slippage and turnover caps bound loss per day; vault-side backstops; guardian pause and Executor-to-none; the KMS signer signs only the four transaction kinds; epochs | P2-U2, P2-U4, P7-U2 | notes/monad-agent-kit.md section 3.13, notes/zodiac-roles.md section 4 |
| 6 | Seller-drain paths during an agent sale (overrides, ERC-1271 signatures, approvals, plain execute) | Every finding that shapes the escrow is inferred, not executed | Escrow custody, no generic call path or ERC-1271 in the escrow, implementation allowlist, SkillNFT operator-transfer restriction, epoch bump on listing, spikes TB-6B and TB-6D as gates | P8-U1, P6-U2 | notes/tokenbound.md section 6 |
| 7 | Private skill text leaks to owners or other users through the model's outputs, tool arguments or memory | The paid product is the strategy text; the agent can quote it | Narrator filter, marker leak test as a release gate, L3 exfiltration review, tool argument scanning, value concentrated in templates plus parameters, exports encrypted | P6-U3, P6-U4, narrator | notes/hermes.md section 6, 02-platform-mapping.md section 2.8 |
| 8 | Prompt injection through skill text, web pages, chain strings or agent messages reaches a model that proposes value-moving intents | Skill text always reaches the model; anyone can deploy a token whose name carries instructions | Audit rules S9 to S11 and L2; enums and registry values instead of chain strings; untrusted wrapping; the Executor never trusts model claims; fixed message types | P6-U4, tool servers, P5-U2 | notes/monad-agent-kit.md section 2, 02-platform-mapping.md section 2.8 |
| 9 | E2B egress header injection unavailable or incompatible with Hermes' HTTP transport | The whole identity and secret model rests on it | Spike MK-S1b before P1-U1 closes; fallback is a platform egress proxy that adds the header | P1-U1 | notes/hermes.md section 6, notes/monad-agent-kit.md section 6 |
| 10 | Hermes upstream churn and doc drift; the pin is 2,142 commits past the last tag | Config keys and defaults could change under a re-pin | Pin commit, lockfile and image digest; the contract suite H-45 on every re-pin; the thin custom loop as the fallback | P1-U1 | notes/hermes.md section 1 |
| 11 | Model-driven skill selection from 60-character descriptions fails with nine overlapping skills | The description is the only trigger | Selection spike as a launch gate; merge skills if needed; description standard "Does X. Use when Y." | P3-U7 | notes/hermes.md section 6 |
| 12 | Policy drift between server pre-checks and Executor limits | Silent losses or constant reverts | Limits read from Executor views per config epoch; invariant test MK-K02 in CI | P2-U5 | notes/monad-agent-kit.md section 3.13 |
| 13 | Cross-agent data access in the shared tool servers | Critical if it happens | Identity only from `authInfo`; repository layer keyed by agent ID with row-level security; strict schemas; session binding; fuzz tests in CI | P1-U7, P2-U5 | notes/monad-agent-kit.md section 3.13 |
| 14 | Duplicate or lost economic actions on retries, restarts and RPC timeouts | A retry could spend twice; an indexer lag could grant a sold skill | Transactional outbox, fenced writer, idempotent action IDs, unknown-not-failed submissions, receipt-based settlement, chain reconciliation | P2-U4, P2-U6 | preview.html revised technical plan section 5, risk-review.md R12 |
| 15 | Budget exhaustion misclassified by Hermes, so a run is retried or fails over instead of pausing | Hidden model calls also bill the agent | LiteLLM returns 402; orchestrator subscribes to budget alerts; auxiliary tasks pinned | P1-U6 | notes/hermes.md section 6 |
| 16 | Guardian or platform admin abuse | An admin with instant loosening power is a full controller | Loosening only behind the risk timelock; guardian can only tighten; guardian appointment timelocked; two-step ownership; abdication of final selectors | P2-U2, P7-U1 | notes/zodiac-roles.md section 4, notes/morpho-vault.md section 4 |
| 17 | Lock griefing and cost-basis corruption through transfers or third-party deposits | Any stranger could extend a victim's lock | Transfers disabled; third-party deposits rejected | P7-U1 | notes/managed-vaults.md section 4 |
| 18 | In-kind exit blocked by a token that reverts (USDC blacklist or pause) | A single token must never block the whole exit | Claimable credit design; spike MV-S1; held-asset list | P7-U1 | notes/managed-vaults.md section 6 |
| 19 | Handover edge cases (transfer outside the escrow, manager-triggered handover, pending actions) | Depositors could be stranded or a buyer could act early | Epoch detection independent of the escrow; pending actions epoch-scoped; spike M-24 with the bypass variant | P7-U2, P8-U1 | notes/morpho-vault.md section 6 |
| 20 | Monad execution model unknowns: gas on the limit, cold access repricing, transient storage, SELFDESTRUCT, mempool | Timing tests and gas caps could be wrong | Fork fidelity spike; testnet gas measurement; storage guard unless TSTORE confirmed; private order flow investigation | P2-U0, P2-U2 | notes/zodiac-roles.md section 6, notes/morpho-vault.md section 6 |
| 21 | The 20% pause and the emergency worker interacting badly with exits or reduce-only selling | "Pause" meant "no exits" in every codebase studied | Pause defined as deposits plus new-risk swaps only; exits never pausable; owner unpause after a lockup period | P7-U1, P4-U2 | notes/managed-vaults.md section 6 |
| 22 | Intent spam or cost blowups from paid data sources | Credits drained by a looping agent | Reservation before jobs, per-agent rate limits tighter on `propose_*`, per-skill data-source budgets, turn caps | P1-U6, P3-U2 | notes/monad-agent-kit.md section 3.13, 02-platform-mapping.md section 2.8 |
| 23 | Mutable or remote skill content after audit | Audited content replaced later | Content hash pinned in BuildRegistry; S3 blocks remote loading; loader mounts only hashed content; revocation | P6-U3 | 02-platform-mapping.md section 2.8 |
| 24 | Weak publisher trust and impersonation | Brand claims in names | PublisherRegistry with keys; signed packages; S15; verified badge only after offchain verification | P6-U2, P6-U4 | 02-platform-mapping.md section 2.8 |
| 25 | Metrics that mislead: hover deltas, 30-day figures before 30 days, self-reported performance | Trust in the interface is the product | Capability deltas; "not enough data"; performance derived from onchain facts; badges with scope | Frontend, P7-U6 | risk-review.md R20 |
| 26 | Demand signals gamed through shell wallets | Seen on Virtuals' leaderboard | Hold periods, watcher eligibility, funding-source filtering, self-purchase exclusion, demo exclusion | P7-U5 | technical-report.html section 10 |
| 27 | x402 payer design mismatch (payer, token, domain, facilitator) or double charge on retry | Payment must bind to a request | Funding address with EIP-3009, pinned package version, delivery ledger by request ID, one real testnet cycle, mainnet verified separately | P5-U4, P8-U4 | notes/tokenbound.md section 3.9, risk-review.md R18 |
| 28 | Sandbox startup latency and footprint make one-sandbox-per-cycle too slow | Debian image with Python 3.14 and Chromium | Footprint spike; template trimmed; cadence set after measurement | P1-U1, P1-U5 | notes/hermes.md section 6 |
| 29 | Legal classification of pooled discretionary management | Public deposits could be an offering | Founders' legal review gates public deposits; `depositsEnabled` is an explicit launch parameter | P9-U3, P9-U5 | risk-review.md |
| 30 | License contamination from studied codebases | SEL-1.0, GPL, LGPL, BUSL and an unlicensed kit | Clean-room rule with a reviewer checklist item | All contract units | planning answer |
| 31 | Solana treated as EVM-equivalent | Metaplex delegation is broad and persists across transfers | Program-restricted delegate, own probes and conformance suite, independent launch approval | S-U1 to S-U5 | risk-review.md R21 |
| 32 | Zero fees at launch give no economic reason to run a public vault | Reputation only until fees activate | Stated plainly; fee mechanism ready; activation behind the timelock | Product | planning answer |
| 33 | Platform-custodied credits at the funding address: a signer bug or compromise could sweep more than owed or refund to the wrong address | Credits are a prepaid platform balance, not contract-held | The signer allowlist of four transaction kinds, with the treasury and the current owner as the only non-payee destinations; period ceilings; sequence and usage hash; refunds only to `AgentNFT.ownerOf`; balances small by design; the custody is disclosed in the product | P1-U6, P2-U4 | owner decision, orientation (D-144) |
| 34 | Unaudited custody code holding real, if capped, funds during the hackathon beta | The beta runs before any external review | Allowlists, small per-account and platform caps, the beta label, the state-assertion script, the canary, M-13 and the core vault spikes before PB-U1, the kill switch, exits never gated | PB-U1, P7-U3 | owner decision, orientation (D-133) |
| 35 | In-sandbox code execution used to attack the sandbox or probe the tool servers | The agent can now run arbitrary code inside the sandbox | Egress deny-by-default; tool identity from the injected token bound to the lease; the skill mount read-only; tmpfs wiped per cycle; the H-12 confinement spike; per-agent rate limits on the servers | P1-U1, P1-U7 | owner decision, orientation (D-143) |
