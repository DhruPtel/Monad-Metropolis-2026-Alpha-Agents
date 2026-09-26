# Decisions and Open Questions

*The record behind `FINAL_PLAN.md` and `BUILD_PLAN.md`. Revision 1.*

Sources are named as follows. `Register`: the decision register supplied with the planning brief (conversation decisions). `Answer n`: an answer given during planning, numbered as in the question list. Planv1 documents are named by file. Research findings are cited to the working notes in `notes/`, which cite the research reports. `Assumption`: a choice the plan had to make without a source; every assumption is also listed in section 3.

---

## 1. Decision register

### 1.1 Product and scope

| ID | Decision | Source |
|---|---|---|
| D-001 | The platform is an onchain financial management platform where AI agents are NFTs, customized with skill NFTs shown as robotic components on a 3D creature; agents act as an onchain CFO; others can watch, follow and invest | Register |
| D-002 | Launch is a live mainnet product on Monad (chain 143) used with real money; testnet (10143) and forks are for testing only | Register |
| D-003 | The hackathon stays a target: Monad Metropolis (Onchain Finance and Trading track) and Colosseum; the live product is the demo; the definition of done includes the submission deliverables | Answer 3 |
| D-004 | Solana gets the same depth, built after the Monad chain layer, on a separate branch, sharing the chain-agnostic core | Register |
| D-005 | Launch features: personal accounts and public Hyperliquid-style vaults | Register |
| D-006 | First strategy: token allocation from USDC; limit downside while earning a return; no benchmark | Register |
| D-007 | Base currency USDC; launch assets USDC and wrapped MON only | Register |
| D-008 | Venue undecided; measure depth on Uniswap v3, Uniswap v4 and Kuru, then pick one | Register, Answer 45 |
| D-009 | No lending, borrowing, leverage, LP positions or perps at launch | Register |
| D-010 | Goal input is structured form fields only: template, risk preset, allowed assets, optional stricter limits, model choice, credit settings; no free text, no chat | Register, Answer 9 |
| D-011 | One strategy per account at launch; no multi-goal buckets | Answer 10 |
| D-012 | Following is view-only and free; real-time signals paid via x402; auto-copy deferred | Register, Answer 7 |
| D-013 | Fees deferred; the fee mechanism and per-depositor entry prices are built now with the rate at zero, activation later behind the timelock | Register, Answer 5 |
| D-014 | Privacy claim wording deferred; the technical definition is "private from owners and other users, not from the platform or model vendor" | Register, Answer 24 |
| D-015 | First customer deferred; working hypothesis is an experienced onchain user wanting a bounded allocation with transparent controls | Register, revised-project-overview.md |
| D-016 | Emergency reserve deferred to Phase 9; a paused spot-only agent simply holds | Register |
| D-017 | Launch is sold on control, ownership and the build experience, not returns; "why the agent did not trade" is a first-class display | Answer to the assessment |
| D-018 | All unrun spikes, including E2B egress injection, are unverified until they pass | Answer to the assessment |
| D-019 | Trades within hard limits execute automatically after a one-time arming approval; approval cards apply to workflow steps set to require approval and to parameter changes | Answer 8, PHASES.md Phase 2 reconciled |
| D-020 | Parameter changes proposed by the agent pass schema bounds plus owner notification or approval per the workflow mode; the shadow and canary ladder is deferred | Answer 14 |
| D-021 | No simulation or backtest on the configure page at launch; the stat sheet shows capability deltas, not return deltas | Answer 12, Answer 13 |
| D-022 | Synergies and set bonuses deferred | Answer 11 |
| D-023 | Creator uploads invite-only at launch with the creator portal live | Answer 15 |
| D-024 | WorkflowNFT contract plus platform-published built-ins at launch; third-party workflow listings deferred | Answer 16 |
| D-025 | Skills resell only through the marketplace escrow | Answer 17 |
| D-026 | Mint and skill prices in USDC; MON only for gas | Answer 18 |
| D-027 | Watchers stored offchain, free, no gas, with the anti-gaming rules | Answer 20, technical-report.html section 10 |
| D-028 | Leaderboard at launch with "not enough data" states; seasons and leagues deferred | Answer 21 |
| D-029 | Band allocation is a target WMON weight with rebalance bands inside the limits; DCA is scheduled USDC to WMON buys | Answer 23 |
| D-030 | Submission material distinguishes mainnet, testnet, fork and simulated activity; demo activity is labeled and excluded from external demand | PHASES.md Phase 5, preview.html revised build manual section 14 |

### 1.2 Tiers

| ID | Decision | Source |
|---|---|---|
| D-031 | Every agent gets the full baseline toolset: web search, X, Dune, chain tools, plus the free sources DefiLlama, CoinGecko and HyperSync | Register, Answer 57 |
| D-032 | Tiers differ by skill slots, built-in playbooks, premium curated data and faster execution rails | Register |
| D-033 | Not tier-based: model choice (paid via credits), credit pricing, vault deposit limits | Register |
| D-034 | Skill slots are 3, 5 and 8 for base, medium and pro; a distinct 3D body per tier, visual only | Answer 19 |
| D-035 | Turn and time budgets are uniform across tiers | Answer 55 |
| D-036 | All tool and data calls are metered through credits; a price table per tool call with `cacheHit` recorded | Register, notes/monad-agent-kit.md section 3.8 |
| D-037 | The user picks one model for reasoning stages; Scan and Test use a disclosed cheap platform model | Answer 53 |

### 1.3 Accounts, contracts and the Executor

| ID | Decision | Source |
|---|---|---|
| D-038 | Three separate capital accounts: PersonalAccount, StrategyVault, operating wallet; never mixed | Register |
| D-039 | The ERC-6551 token-bound account holds skills and identity only, never capital; canonical Tokenbound v3 on Monad | Register |
| D-040 | The platform never sets permissions or overrides on any token-bound account for any address, including the Executor | Answer 48 |
| D-041 | Own Executor with typed intents; no Zodiac Roles, no Merkle-verified calldata | Register |
| D-042 | Approval mechanics: the Executor pulls the exact amount, approves the venue exactly, the venue pays the account directly, approval resets to zero, the account checks balance deltas | Register, Answer 41 |
| D-043 | Ownership and configuration epochs on every action; old permissions never return for platform authority | Register |
| D-044 | Session key submits directly as `msg.sender`; the owner registers a grant of key, both epochs and expiry in the Executor; no relayed signatures at launch | Answer 42 |
| D-045 | KMS-backed platform signer for agent keys; Privy stays for login and embedded wallets | Answer 43 |
| D-046 | Agent sales only through the marketplace escrow at launch; AgentNFT transfers restricted onchain to the escrow | Register, Answer 50 |
| D-047 | OpenSea and Blur later, once a custom account implementation closes the skill-drain paths; the TBA address migration is accepted then | Register, Answer 49 |
| D-048 | PersonalAccount is the custody core in single-owner mode, one clone per agent and owner, withdraw always on, no share token, internal units for flow-adjusted valuation | Answer 37, Answer 38 |
| D-049 | PersonalAccount funds never travel with the NFT; the seller keeps withdrawal rights | Answer 37, notes/tokenbound.md section 4 |
| D-050 | Hard limits at launch: max 10% of account value per trade; max 40% in any non-USDC asset; at least 10% USDC; max 0.5% slippage; rolling 20 trades per 24 hours; 2-minute deadlines; oracle under 5 minutes old and within 2% of pool price; circuit breaker at 10% (reduce-only) and 20% (pause) from the 7-day peak; recipient always the source account; exact approvals only; platform-wide deposit cap until reviewed; external reviews before public deposits | Register |
| D-051 | Rolling 24-hour turnover cap at 100% of NAV to start | Answer 39 |
| D-052 | Trades whose output is USDC always pass the 40% and 10% post-checks | Answer 40 |
| D-053 | Pool price is the spot price of the traded pool, pairwise within 2% of the oracle; slippage is measured against the oracle-implied output plus a post-trade NAV-loss bound | Answer 46 |
| D-054 | Rolling counter is a ring buffer of 20 timestamps, never reset by config or epoch changes; the deadline is set at signing and forwarded | notes/managed-vaults.md section 4, notes/monad-agent-kit.md section 4 |
| D-055 | Oracle: Chainlink feeds primary, staleness per feed from measured heartbeat, USDC treated as 1 with a depeg guard; any asset without a reliable feed is dropped from the buy allowlist | Register, Answer 44 |
| D-056 | Held-asset list is separate from the buy allowlist; dropping a feed never removes an asset from in-kind payouts | Answer 35 |
| D-057 | Vault-side backstops slightly looser than the Executor limits (12%, 45%, 1%) with post-trade invariant checks in the vault | Answer 36 |
| D-058 | Circuit-breaker peak: per-share NAV for vaults, flow-adjusted for PersonalAccount, tracked in the account through `poke()`, read by the Executor | Answer 38 |
| D-059 | Loosening of Executor policy and vault configuration waits the risk timelock; tightening is instant; the emergency role can only reduce risk with an enumerated function list | Answer 33, Answer 34 |
| D-060 | ProtocolRegistry pins the venue's code hash and fails closed on mismatch; hookless v4 pools only if v4 is chosen | notes/zodiac-roles.md section 7, notes/morpho-vault.md section 3.3 |
| D-061 | One intent per transaction; no batching at launch | notes/zodiac-roles.md section 4 |
| D-062 | Deposit cap: per-vault cap plus a platform total in VaultFactory, tighten instantly, loosen by timelock | Answer 47 |
| D-063 | Billing holds prepaid USDC credits per agent with capped, sequenced settlement; the operating wallet holds MON for gas and USDC for x402 | Register, preview.html revised technical plan section 10 |
| D-064 | ERC-8004 identity registered at mint through an IdentityBinder that owns the registry token; reputation and validation deferred | Answer 22 |
| D-065 | WorkflowNFT is held in the token-bound account like skills with the same transfer restrictions | Answer 51 |
| D-066 | SkillNFT refuses operator transfers out of agent accounts and `setApprovalForAll` for agent-account holders | notes/tokenbound.md section 4 |
| D-067 | Two-step ownership on every admin contract; reentrancy guards on every state-changing entry point | notes/zodiac-roles.md section 4 |
| D-068 | Clean-room rule: no code copied from BoringVault, Morpho, Zodiac or monad-agent-kit | Answer 63 |

### 1.4 StrategyVault

| ID | Decision | Source |
|---|---|---|
| D-069 | Own contract borrowing Morpho and BoringVault patterns, not a fork; small custody core; timelocks in code longer than the maximum lockup; emergency role reduce-only; valuation once per transaction; virtual shares; rounding in the vault's favor; buy/sell spread; time-scaled reference price band; limits on buys only; no external mint or burn | Register |
| D-070 | Withdrawals in USDC above the 10% floor, otherwise the withdrawer's share is sold through allowlisted pools with oracle and user minimums, reverting on failure; `redeemInKind` in the custody contract with no pause, hook or role check | Register |
| D-071 | A reverting token in `redeemInKind` becomes a claimable credit excluded from NAV | Answer 30 |
| D-072 | Lockups: minimum 24 hours, default 24 hours, hard maximum 7 days; unlock set at deposit; self top-up sets the later unlock with a UI warning; the lockup applies to `redeemInKind` | Register |
| D-073 | Share transfers disabled at launch | Answer 25 |
| D-074 | Third-party deposits to a receiver are rejected | Answer 26 |
| D-075 | Lockups waived in handover, wind-down and guardian pause | Answer 27 |
| D-076 | "Leader changes apply only to new deposits" means lockup-length changes by the leader; increases wait the new duration plus notice and apply only to later deposits; decreases are instant | Register, Answer 28 |
| D-077 | Handover on sale: deposits closed, reduce-only, locks waived, old owner exits freely, new owner posts a fresh 5% stake and accepts after the handover period | Answer 28, Answer 29 |
| D-078 | Leader stake of 5%, enforced against diluting deposits and the leader's own exits only; leader shares non-transferable; seed required before deposits open; wind-down lifts the rule | Answer 6 |
| D-079 | No withdrawal queue at launch | Register |
| D-080 | Unpause after the 20% breaker by the owner, never the emergency role; pause blocks deposits and new-risk swaps, never exits; for public vaults the owner may unpause only after one lockup period | Answer 31 |
| D-081 | Timelock constants: notice 2 days, risk timelock 9 days, handover 3 days, all set in the constructor and never zero | Answer 32 |
| D-082 | Timelocked changes: Executor replacement, oracle or venue or asset additions, fee changes, lockup maximum, guardian appointment and removal, any Executor policy loosening | Answer 33 |
| D-083 | Emergency role powers: pause trading and deposits, set reduce-only, cancel pending proposals, set the Executor to none, tighten backstops; nothing else | Answer 34 |
| D-084 | Per-depositor high-water mark: entry share price recorded from launch; fee charged on exit in shares moved from the exiter to the leader; fee changes timelocked, capped at 20%, applied to later deposits only | Answer 5, notes/managed-vaults.md section 3 |
| D-085 | Spread per asset, at least the feed deviation threshold, sized from the heartbeat and lag-arbitrage spikes; the reference band parameters from the breaker spike | notes/morpho-vault.md section 4, notes/managed-vaults.md section 4 |
| D-086 | Every priced path fails closed on any oracle or balance read; nothing counts as zero | notes/managed-vaults.md section 4 |
| D-087 | Deployment scripts assert the final onchain state against the intended configuration as a launch gate | notes/managed-vaults.md section 4 |

### 1.5 Agent runtime, tools and skills

| ID | Decision | Source |
|---|---|---|
| D-088 | Hermes Agent pinned at commit 085d9ee, wrapped, unmodified; our orchestrator owns scheduling and the discovery loop; Hermes self-improvement off; turn limits and timeouts in the wrapper; hard budgets in LiteLLM | Register |
| D-089 | "Self-improvement off" also blocks foreground `skill_manage` (read-only mount, write approval, hook), keeps `USER.md` off and `MEMORY.md` foreground-only, exported encrypted | Answer 56, notes/hermes.md section 4 |
| D-090 | Agents evolve by gaining tools and knowledge through skills and by tuning parameters of approved strategy templates; no arbitrary code generation | Register |
| D-091 | All Hermes state is as confidential as skills; encrypted exports; error dumps die with the sandbox; `sessions/` on tmpfs | Register, notes/hermes.md section 4 |
| D-092 | Both per-agent secrets (tool token and LiteLLM key) are injected at egress; nothing secret exists in the sandbox | Answer 52 |
| D-093 | Five discovery stages as separate Hermes runs with the Thesis Board on the platform server; sequential Dives; one sandbox per cycle; Hermes cron unused | Answer 54 |
| D-094 | The bot runner is a deterministic template runner plus workflow step executor; no LLM, no generated code | Answer 58 |
| D-095 | Three MCP servers (chain, data, platform) built with the MCP TypeScript SDK, viem and zod, platform-side; identity, tier and metering bind to the injected token; limits are read from the Executor; tools return intent IDs, never calldata | Register, notes/hermes.md section 4 |
| D-096 | Rebalance legs above the per-trade cap split into sequential legs, each consuming a trade slot | Answer 59 |
| D-097 | `get_pool_depth` and `simulate_rebalance` are baseline, metered; only curated data tools are tier-gated | notes/monad-agent-kit.md section 4 |
| D-098 | The goal translator is deterministic; the narrator reads only the action log and ledger and its text is explanatory only | Register, preview.html revised technical plan section 9 |
| D-099 | Skills use the skill.json spec v1 from the Bankr research: immutable content-hash versions, signed publisher, required tools, intents, slot cost, privacy; the platform generates Hermes frontmatter and never emits env-var, credential, config, blueprint, deps or inline-shell fields; only the active build is mounted, read-only | Register, Planv1/research/bankr-skills/02-platform-mapping.md section 2.1 |
| D-100 | Launch skill set of nine, all platform-published: monad-assets-basics, one swap skill for the chosen venue, the band allocation strategy, the DCA strategy, deep-dive-research, token-risk-screen, defi-regime-read, narrative-and-flow-tracker, wallet-intel; lending and LP skills removed; scheduling moved to workflows | Register, Answer 2 |
| D-101 | The DCA skill holds sizing, drawdown pause and budget logic only; its schedule lives in Recurring Buys | notes/bankr-skills.md section 7 |
| D-102 | The audit pipeline is the Bankr research's F1 to F8, S1 to S15, L1 to L8, dynamic test and human review for strategy skills and first-time publishers; badges state their scope | 02-platform-mapping.md section 2.6, preview.html revised build manual section 7 |
| D-103 | Launch gates on a skill selection spike with all nine descriptions; skills are merged if selection fails | Answer 60 |
| D-104 | A workflow that depends on a revoked or swapped skill version pauses at its next run and the owner is told | notes/bankr-skills.md section 7 |
| D-105 | Vendor zero-retention terms and gateway logging off are requirements | Answer 62 |
| D-106 | Skills needed for Phase 3 research mount first as platform built-in folders; Phase 6 turns them into NFTs | BUILD_PLAN.md reconciliation |
| D-107 | Built-in workflows at launch: Rebalancer, Recurring Buys, Risk Sentinel (as a deterministic service), Parameter change review | Register, PHASES.md Phase 4, preview.html revised technical plan section 7 |
| D-108 | The `token-risk-screen` requirement before buying a non-core asset is a policy rule, not a workflow NFT | notes/bankr-skills.md section 7 |

### 1.6 Marketplace, social and frontend

| ID | Decision | Source |
|---|---|---|
| D-109 | The escrow checks `isLocked`, the implementation slot against an allowlist, holdings, `buildHash` and `state`; it has no generic call path and no ERC-1271; listing bumps the epoch and pauses the seller's agent | notes/tokenbound.md sections 3.5, 4, 6 |
| D-110 | x402 payments come from the operating wallet through the platform payer with EIP-3009 USDC; `@x402/evm` at or above 2.22.0; per-agent daily caps; delivery recorded by request ID | notes/tokenbound.md section 3.9, risk-review.md dependency verification |
| D-111 | Agent-to-agent interaction uses fixed message types only; every incoming message is untrusted | PHASES.md Phase 5 |
| D-112 | The buyer agent runs on a different model from the sellers with its own budget; its results are labeled simulated | PHASES.md Phase 5 |
| D-113 | Build cards carry four distinct badges: publisher signature, static review, platform-attested build, independent runtime attestation (later) | preview.html revised technical plan section 12 |
| D-114 | Every return shows period, basis, costs and drawdown; short histories show "not enough data" | risk-review.md R20, preview.html revised technical plan section 12 |
| D-115 | Frontend: Next.js, React, TypeScript, wagmi and viem, Privy, TanStack Query, React Three Fiber with drei, GLB models with named sockets, a static fallback so GPU failure never blocks a withdrawal | build-manual.md section 10, preview.html revised technical plan section 12 |
| D-116 | Marketplace and creator content is sanitized before rendering; upload URLs and logs are tenant-scoped | preview.html revised technical plan section 12 |

### 1.7 Build process

| ID | Decision | Source |
|---|---|---|
| D-117 | Build in the ten phases of PHASES.md, including Phase 5; each phase: build, stabilize, playtest checkpoint, tune; tracking files in `plans/`; the unit prompt template and session rules | Register, PHASES.md |
| D-118 | Documents consolidated: three plan documents plus working notes kept in `Planv2/notes/` | Register, Answer 4 |
| D-119 | Dependency labels PROPOSED, DOCUMENTED, SPIKE_PASSED, INTEGRATED, RELEASED; evidence advances a label | preview.html revised build manual section 1 |
| D-120 | Cut order: visual complexity, broad social sources, additional venues, open uploads, arbitrary live code, auto-copy, escrow jobs and the second chain before any weakening of custody, accounting, emergency handling or data provenance | preview.html revised build manual section 15 |
| D-121 | The founders own the legal review of pooled discretionary management; it gates public deposits | Answer 61 |
| D-122 | A capped mainnet canary through the real signer, Executor and venue precedes public use | notes/monad-agent-kit.md section 7 |
| D-123 | The Solana branch starts from the chain adapter interface and conformance suite built in Phase 2 | PHASES.md Phase 2, preview.html revised build manual section 11 |

---

## 2. Resolved conflicts

| ID | Conflict | Sources involved | Resolution |
|---|---|---|---|
| C-01 | PHASES.md is missing; the initial plan was written for a hackathon while the register targets a live product | Brief Part 2, PHASES.md (supplied later), Answer 3 | PHASES.md was supplied and reconciled; the hackathon stays a target with the live product as the demo (D-003) |
| C-02 | The skill.json spec was referenced but absent from the repository | Register, Bankr research folder (supplied later) | The Bankr research folder was added; its section 2.1 is the spec (D-099) |
| C-03 | The owner's wallet holds funds and a sale moves them (initial plan) versus the token-bound account never holds capital (register) | project-overview.md, technical-report.html section 3, Register | Register wins: three separate capital accounts, the account holds skills and identity only (D-038, D-039) |
| C-04 | The brain writes and evolves bot code with fork backtests (initial plan) versus no arbitrary code generation and parameter tuning of approved templates (register) | technical-report.html section 6, build-manual.md section 4.5, Register | Register wins; the evolution timeline becomes build history by config epoch (D-090, D-020) |
| C-05 | Withdrawals "at any time" versus lockups of 24 hours to 7 days | project-overview.md, Register | Register wins (D-072) |
| C-06 | "The owner earns a cut" versus "fees deferred" | Register (two sentences) | Build the mechanism with the rate at zero; activation later (D-013) |
| C-07 | Leader stake of 5% assumed by every vault source, silent in the register | technical-report.html section 8, notes/morpho-vault.md, notes/managed-vaults.md | Included, scoped to diluting deposits and the leader's own exits (D-078) |
| C-08 | "Limits checked on buys only, never on exits" versus a leader-stake rule that blocks the leader's exits | Register, notes/managed-vaults.md section 4 | The rule applies to the leader only; depositors' exits are never blocked (D-078) |
| C-09 | Share transfers propagate the later unlock (register) versus a dust transfer can extend anyone's lock and break cost basis (both vault notes) | Register, notes/morpho-vault.md section 4, notes/managed-vaults.md section 4 | Transfers disabled at launch (D-073) |
| C-10 | Top-ups set the later unlock (register) versus third-party deposits can relock a victim | Register, notes/managed-vaults.md section 4 | Self top-ups keep the rule; third-party deposits rejected (D-074) |
| C-11 | "Leader changes apply only to new deposits" was ambiguous against the research's handover design | Register, notes/tokenbound.md section 4 item 9, notes/morpho-vault.md section 3.9 | Read as lockup-length changes; the researched handover adopted (D-076, D-077) |
| C-12 | Handover: cooldown plus redeem window plus acceptance (Tokenbound research) versus reduce-only plus epoch bump plus delay (managed vaults research) | notes/tokenbound.md, notes/managed-vaults.md, notes/morpho-vault.md | Combined: handover mode with deposits closed, reduce-only, locks waived, fresh stake and acceptance after the handover period (D-077) |
| C-13 | Leader stake moves through the escrow versus the buyer posts fresh | notes/morpho-vault.md section 7 | Buyer posts fresh (D-077) |
| C-14 | Skip-list forfeit versus claimable credit for a reverting token in `redeemInKind` | notes/managed-vaults.md section 7, notes/morpho-vault.md section 7 | Claimable credit (D-071) |
| C-15 | "Pause" in both vault codebases meant no exits; the register's 20% pause needed an exit carve-out and an unpause authority | notes/managed-vaults.md section 4, Register | Pause blocks deposits and new-risk swaps only; owner unpauses after one lockup period for public vaults (D-080) |
| C-16 | Dropping an asset without a feed from the allowlist would strand in-kind claims | Register, notes/managed-vaults.md section 4 | Buy allowlist separate from the held-asset list (D-056) |
| C-17 | "The Executor approves the exact amount" cannot be literal if the account holds the tokens (Zodiac note) versus pull-exact into the Executor (managed vaults note) | notes/zodiac-roles.md section 6, notes/managed-vaults.md section 4, Register | Pull exact, approve exact, venue pays the account, reset, account checks deltas (D-042) |
| C-18 | Deadline set in the policy step versus at signing time | notes/monad-agent-kit.md section 4 (internal inconsistency in the research) | Signing time (D-054) |
| C-19 | Tool specs hard-code limits versus "read limits from the Executor" | notes/monad-agent-kit.md section 4, Register | Schema bounds generated per session from Executor views (D-095) |
| C-20 | Premium chain tools per tier (monad-agent-kit research) versus full baseline for every tier (register) | notes/monad-agent-kit.md section 4, Register | Chain tools baseline; only curated data tools gated (D-097) |
| C-21 | Model aliases per stage in the tier overlay (Hermes research) versus model choice not tier-based (register) | notes/hermes.md section 4, Register | User picks one model; a disclosed cheap platform model for Scan and Test; no tier link (D-037) |
| C-22 | MCP token in the sandbox `.env` (Hermes research) versus egress injection (register) | notes/hermes.md section 4, Register | Egress injection for both secrets, with a spike (D-092) |
| C-23 | Hermes cron as an option for Scan and Zoom out versus orchestrator-owned scheduling | notes/hermes.md section 4, Register | Hermes cron unused; the `cronjob` toolset removed (D-093) |
| C-24 | Python FastMCP mock in the Hermes spike versus the MCP TypeScript SDK | notes/hermes.md section 4, Register | Spike server built with the TypeScript SDK (D-095) |
| C-25 | "Self-improvement off" covering only the background review versus foreground `skill_manage` and memory paths | notes/hermes.md section 4, Register | Foreground paths blocked too (D-089) |
| C-26 | Privy session wallets with policies (initial plan, research) versus unverified policy scoping on Monad | build-manual.md section 3.1, notes/monad-agent-kit.md section 7, notes/zodiac-roles.md section 7 | KMS-backed platform signer; Privy for login only (D-045) |
| C-27 | Venue: only Uniswap v3 de-risked by research versus v4 or Kuru in the register | notes/zodiac-roles.md section 6, notes/morpho-vault.md section 6, Register | v3 added to the depth spike; the spike decides (D-008) |
| C-28 | Launch assets USDC, WMON, WETH and an LST (research briefs) versus USDC and WMON (register) | notes/zodiac-roles.md section 8, notes/morpho-vault.md section 8, Register | Register wins (D-007) |
| C-29 | Twenty trades per calendar day versus a rolling 24-hour window | notes/zodiac-roles.md section 8, Register | Rolling window with a ring buffer (D-054) |
| C-30 | No turnover cap in the register while 20 trades at 10% permit about 200% NAV churn per day | notes/zodiac-roles.md section 4, Register | Rolling turnover cap at 100% of NAV (D-051) |
| C-31 | Post-trade 40% and 10% checks could strand an account after a price move | notes/zodiac-roles.md section 4 | Reduce-only exemption (D-052) |
| C-32 | Custom account "for personal capital" (Tokenbound research) versus "to close skill-drain paths for open marketplaces" (register) | notes/tokenbound.md section 4 item 8 | The register's rationale carried; the same implementation would serve both (D-047) |
| C-33 | "Never grants permissions to platform keys" was insufficient because any permissioned contract can upgrade and sign | notes/tokenbound.md section 4 item 1, Register | Tightened to no permissions or overrides for anyone (D-040) |
| C-34 | Escrow implementation check as a constant versus an allowlist | notes/tokenbound.md section 7 item 15 | Allowlist with one entry at launch (D-109) |
| C-35 | Notes B in the Tokenbound research said an escrow cannot read another contract's storage; the final report says `extsload` makes it possible | notes/tokenbound.md section 6 | The final report's position, confirmed by spike TB-9b before the escrow depends on it |
| C-36 | BuildRegistry sketch with `uint32` versions and count-based slots versus content-hash versions and slot cost | notes/tokenbound.md section 4 item 10, Register | Content hashes and slot cost read from SkillRegistry (D-099) |
| C-37 | `wallet-intel` at tier base in one section and medium in another; research skills at medium and pro | notes/bankr-skills.md section 5 | All nine at base (Assumption A-01) |
| C-38 | Slot cost 1 to 3 (research) versus slots 3, 5, 8 (answer) | notes/bankr-skills.md section 7, Answer 19 | Both kept; builds are a choice by design (D-034, D-099) |
| C-39 | The DCA skill's "scheduled" wording would trip audit rule S8 | notes/bankr-skills.md section 7 | Schedule moved to Recurring Buys (D-101) |
| C-40 | Goal form fields: amount, horizon, priority, risk level (PHASES.md) versus the agreed field list | PHASES.md Phase 3, Answer 9 | Agreed list (D-010) |
| C-41 | Owner approves allocation proposals before rebalancing (PHASES.md) versus automatic trades within limits | PHASES.md Phase 3, Answer 8, Answer 14 | Parameter proposals approved per workflow mode; trades automatic after arming (D-019, D-020) |
| C-42 | Goal buckets on the CFO dashboard (PHASES.md) versus one strategy per account | PHASES.md Phase 4, Answer 10 | Single-goal progress (D-011) |
| C-43 | Phase 7 described as "ERC-4626 accounting and direct withdrawals" versus the full register vault design | PHASES.md Phase 7, Register | Full design in three units (BUILD_PLAN.md Phase 7) |
| C-44 | Encrypted upload precedes audit (technical report) versus plaintext review precedes encryption (build manual) | technical-report.html section 5, build-manual.md section 11, risk-review.md | TLS upload to quarantine, review of exact bytes, then encryption (D-102) |
| C-45 | Ownership read only through the indexer versus directly from chain | build-manual.md sections 1.2 and 3.2, risk-review.md | Indexer for discovery and UI; block-tagged chain checks and onchain validation for authorization (FINAL_PLAN.md section 3) |
| C-46 | `withdraw(uint256 shares)` described as ERC-4626 style (technical report) versus standard signatures | technical-report.html section 8, risk-review.md | Standard ERC-4626 signatures plus the safe overload and `redeemInKind` (FINAL_PLAN.md section 4.7.5) |
| C-47 | Langfuse proposed for tracing (build manual) versus "captures full prompts" (Hermes research) and gateway logging off (answer) | build-manual.md section 12, notes/hermes.md section 2.8, Answer 62 | Metadata-only tracing; no prompt capture (BUILD_PLAN.md P9-U2) |
| C-48 | `@x402/evm` 2.12.0 floor (initial plan) versus 2.22.0 (risk review) | technical-report.html section 12, risk-review.md | 2.22.0 or later, pinned (D-110) |
| C-49 | Research notes recommend dropping vendor zero-retention as a launch requirement given the privacy definition | notes/bankr-skills.md section 7, Answer 62 | Answer 62 stands: zero-retention terms and logging off are requirements (D-105) |
| C-50 | Live `balanceOf` versus internal balance tracking for donations (Morpho research internally inconsistent) | notes/morpho-vault.md section 6 | Live `balanceOf` of allowlisted tokens only (FINAL_PLAN.md section 4.7.3) |
| C-51 | Fee shares in the in-kind path: pending fee shares (Morpho model) versus per-depositor exit fees | notes/morpho-vault.md section 6 | Per-depositor exit fees; no pending shares (D-084) |

---

## 3. Open questions

Type: `Open` needs a decision or a measurement; `Assumption` is a choice the plan made that must be confirmed or overturned.

### 3.1 Assumptions made in the plan

| ID | Assumption | Who decides | What it blocks |
|---|---|---|---|
| A-01 | All nine launch skills carry `required_tier: base`; the research's medium and pro assignments are superseded | Founders | P6-U3 listing; BuildRegistry tier checks |
| A-02 | Medium tier's execution rails are a dedicated RPC endpoint only; pro gets dedicated RPC, nearby runner placement and a larger priority fee cap | Founders | P2-U4 signer fee policy; P1-U5 provisioning |
| A-03 | Premium curated data tools are pro-only at launch | Founders | P3-U2 tier gating; pricing |
| A-04 | In-kind exits pay the (dormant) performance fee at the stored reference price; the leader's own stake is exempt; no loss carry-forward across a full exit and re-entry | Founders | P7-U1 fee storage layout |
| A-05 | When credits are exhausted, the deterministic template runner and the Risk Sentinel keep running on the operating wallet's gas until the Phase 9 emergency reserve exists | Founders | P1-U6 pause behavior; P4-U2 |
| A-06 | Virtual share offset 1e12 for USDC as the starting value | Contract engineer after spike M-03 and MV-V24 | P7-U1 |
| A-07 | ERC-8004 registration is built in Phase 5 with back-registration of earlier mints rather than in P1-U3 | Founders | P5-U1 |
| A-08 | At launch the allowed intent set for an agent is the union of the active build's manifests; per-skill attribution is added only if Hermes exposes the active skill | Runtime engineer after spike B-02 | P2-U5 policy |
| A-09 | PersonalAccount uses internal non-transferable units for flow-adjusted valuation and has no share token | Contract engineer | P2-U1 |
| A-10 | The escrow's implementation allowlist has a single entry at launch | Founders | P8-U1 |
| A-11 | The `token-risk-screen` guardrail lives in policy rather than as a workflow NFT | Founders | P4-U2 |
| A-12 | "Playbooks" per tier are a rendered `SOUL.md` block plus an auto-loaded playbook skill plus starter workflows; base gets the two strategy playbooks, higher tiers add starter workflows | Founders | P1-U5 config layers |
| A-13 | The demo cast is five platform-run agents with small real capital, labeled as platform-run | Founders | P9-U4, P9-U6 |
| A-14 | Build cards carry four badge classes as in the revised technical plan | Founders | P5-U1 |
| A-15 | The chain adapter interface and conformance suite is a Phase 2 unit (P2-U8) so the Solana branch starts from a tested seam | Founders | S-U1 |
| A-16 | The minimal data tool in Phase 1 is web search only; the full data server arrives in Phase 3 | Founders | P1-U7 |
| A-17 | Kuru addresses, mechanics and a "pool price" definition for an orderbook are supplied by the depth spike, since no research covers Kuru | Execution engineer | P2-U0 |
| A-18 | The address book verified on 2026-09-25 is correct until re-verified before deployment | Contract engineer | Every contract unit |

### 3.2 Open questions needing a decision or a measurement

| ID | Question | Who decides | What it blocks |
|---|---|---|---|
| Q-01 | Which venue: Uniswap v3, Uniswap v4 or Kuru, by measured depth at the reference size inside 0.5% slippage | Founders after spike MK-K05 | P2-U2 adapter, the swap skill's name, `get_quote` shape |
| Q-02 | Chainlink MON/USD heartbeat and deviation on Monad; is the 5-minute staleness target meetable, and what spread and band parameters follow | Execution engineer after M-33, M-28, MV-S8 | P2-U3, P7-U1 |
| Q-03 | Is `0x7547...b603` Circle's official USDC on Monad, and does it carry blacklist and pause functions | Founders (confirm with Circle) | P5-U4 x402 token; MV-S1 credit design |
| Q-04 | Is E2B per-host egress header injection available on the chosen plan, and which second factor (IP allowlist, mTLS, HMAC header) proves a request came through E2B | Runtime engineer after MK-S1b | P1-U1; fallback is a platform egress proxy |
| Q-05 | Hermes unknowns at 085d9ee: MCP config keys, `structuredContent` handling, `list_changed`, tool call timeout, index truncation at 57 characters, `requires_tools` with MCP tools, `skill_manage` write paths, cross-session caching after a version swap | Runtime engineer after H-01 to H-16, B-02, B-05 | P1-U1, P3-U7, P6-U2 |
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
| Q-25 | Image-to-3D tool with commercial license and hard-surface quality | Art track | P6-U6 |
| Q-26 | IPFS or Arweave for public token metadata and art | Founders | P6-U3, P8-U2 |
| Q-27 | Project name and logo | Founders | P9-U6 |
| Q-28 | The evals format for strategy skills and the parameter schemas for `rebalance_bands@1` and `dca@1` | Quant and runtime engineers | P3-U3, P6-U5 dynamic test |
| Q-29 | Turnover cap tuning after live data (100% of NAV to start) | Founders | Policy hash updates |
| Q-30 | Whether formal verification (at least offline-exit liveness) is required before external review | Founders | P7-U3, P9-U3 |
| Q-31 | Solana price feed provider and DEX venues | Solana engineer after S-U1 | S-U2 |
| Q-32 | How the buyer agent's willingness to pay maps to launch prices for real-time signals | Founders after P5-U7 | P8-U4 pricing |
| Q-33 | Which monitoring stack replaces Langfuse for metadata-only tracing | Runtime engineer | P9-U2 |
| Q-34 | Report templates and notification frequency defaults after the Phase 4 playtest | Founders | P4-U4, P4-U6 tuning |
| Q-35 | Uniswap v4 hook policy (hookless only) and the size guard threshold, if v4 is chosen | Execution engineer | P2-U2, P7-U1 |

---

## 4. Risk register

Ranked by consequence if the failure occurs, then by likelihood as the research rated it. "Owner" is the component or unit that carries the mitigation.

| Rank | Risk | Why it matters | Mitigation | Owner | Source |
|---|---|---|---|---|---|
| 1 | New, unaudited custody and enforcement code (custody core, Executor, escrow, oracle adapter) | All enforcement moves into new code; nothing has been run | Small immutable custody core, ported invariants and adversarial tests, spikes as gates, two external reviews, low caps, mandatory seed, canary before public use | P2-U1, P2-U2, P7-U3, P9-U3, P9-U4 | notes/zodiac-roles.md section 6, notes/morpho-vault.md section 3.11 |
| 2 | No reliable MON/USD feed, or a heartbeat above the 5-minute target | The whole limit set, vault valuation and USDC exits depend on it; with two launch assets a missing feed leaves nothing to trade | Heartbeat spike first; staleness per feed; drop assets without a feed; USDC treated as 1 with a depeg guard; in-kind exit never reads an oracle | P2-U0, P2-U3 | notes/managed-vaults.md section 6, notes/monad-agent-kit.md section 6 |
| 3 | Thin Monad liquidity makes trades and USDC exits fail often; agents look broken | Three research runs rate this the most likely failure | Depth spike chooses the venue; `get_quote.limitCheck` and `get_prices.tradable` before proposals; "why the agent did not trade" display; size guard routes exits in kind; TVL caps | P2-U0, P2-U5, P7-U1, frontend | notes/monad-agent-kit.md section 3.13, notes/zodiac-roles.md section 6 |
| 4 | Oracle-priced entry and exit lets informed users extract value from a lagging feed | Morpho's accepted findings made daily | Spread per asset at least the deviation threshold; time-scaled reference band; lockup stops same-block round trips; async deposits as the named fallback | P7-U1 | notes/morpho-vault.md section 3.11 |
| 5 | Executor or session key compromise | Critical impact even if unlikely | Per-trade, slippage and turnover caps bound loss per day; vault-side backstops; guardian pause and Executor-to-none; KMS signer signs only Executor calls; epochs | P2-U2, P2-U4, P7-U2 | notes/monad-agent-kit.md section 3.13, notes/zodiac-roles.md section 4 |
| 6 | Seller-drain paths during an agent sale (overrides, ERC-1271 signatures, approvals, plain execute) | Every finding that shapes the escrow is inferred, not executed | Escrow custody, no generic call path or ERC-1271 in the escrow, implementation allowlist, SkillNFT operator-transfer restriction, epoch bump on listing, spikes TB-6B and TB-6D as gates | P8-U1, P6-U1 | notes/tokenbound.md section 6 |
| 7 | Private skill text leaks to owners or other users through the model's outputs, tool arguments or memory | The paid product is the strategy text; the agent can quote it | Narrator filter, marker leak test as a release gate, L3 exfiltration review, tool argument scanning, value concentrated in templates plus parameters, exports encrypted | P6-U2, P6-U5, narrator | notes/hermes.md section 6, 02-platform-mapping.md section 2.8 |
| 8 | Prompt injection through skill text, web pages, chain strings or agent messages reaches a model that proposes value-moving intents | Skill text always reaches the model; anyone can deploy a token whose name carries instructions | Audit rules S9 to S11 and L2; enums and registry values instead of chain strings; untrusted wrapping; the Executor never trusts model claims; fixed message types | P6-U5, tool servers, P5-U2 | notes/monad-agent-kit.md section 2, 02-platform-mapping.md section 2.8 |
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
| 23 | Mutable or remote skill content after audit | Audited content replaced later | Content hash pinned in BuildRegistry; S3 blocks remote loading; loader mounts only hashed content; revocation | P6-U2 | 02-platform-mapping.md section 2.8 |
| 24 | Weak publisher trust and impersonation | Brand claims in names | PublisherRegistry with keys; signed packages; S15; verified badge only after offchain verification | P6-U1, P6-U5 | 02-platform-mapping.md section 2.8 |
| 25 | Metrics that mislead: hover deltas, 30-day figures before 30 days, self-reported performance | Trust in the interface is the product | Capability deltas; "not enough data"; performance derived from onchain facts; badges with scope | Frontend, P7-U6 | risk-review.md R20 |
| 26 | Demand signals gamed through shell wallets | Seen on Virtuals' leaderboard | Hold periods, watcher eligibility, funding-source filtering, self-purchase exclusion, demo exclusion | P7-U5 | technical-report.html section 10 |
| 27 | x402 payer design mismatch (payer, token, domain, facilitator) or double charge on retry | Payment must bind to a request | Operating wallet with EIP-3009, pinned package version, delivery ledger by request ID, one real testnet cycle, mainnet verified separately | P5-U4, P8-U4 | notes/tokenbound.md section 3.9, risk-review.md R18 |
| 28 | Sandbox startup latency and footprint make one-sandbox-per-cycle too slow | Debian image with Python 3.14 and Chromium | Footprint spike; template trimmed; cadence set after measurement | P1-U1, P1-U5 | notes/hermes.md section 6 |
| 29 | Legal classification of pooled discretionary management | Public deposits could be an offering | Founders' legal review gates public deposits; `depositsEnabled` is an explicit launch parameter | P9-U3, P9-U5 | risk-review.md |
| 30 | License contamination from studied codebases | SEL-1.0, GPL, LGPL, BUSL and an unlicensed kit | Clean-room rule with a reviewer checklist item | All contract units | Answer 63 |
| 31 | Solana treated as EVM-equivalent | Metaplex delegation is broad and persists across transfers | Program-restricted delegate, own probes and conformance suite, independent launch approval | S-U1 to S-U5 | risk-review.md R21 |
| 32 | Zero fees at launch give no economic reason to run a public vault | Reputation only until fees activate | Stated plainly; fee mechanism ready; activation behind the timelock | Product | Answer to the assessment |
