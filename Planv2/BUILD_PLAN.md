# Build Plan

*What has to be built, in what order. Revision 1, reconciled with `Planv1/PHASES.md` and the planning answers.*

Companion to `FINAL_PLAN.md` (what we are building) and `DECISIONS_AND_OPEN_QUESTIONS.md` (the record). Order is by dependency only; there are no time estimates anywhere in this document. The October 13, 2026 hackathon deadline is a constraint on the definition of done (`FINAL_PLAN.md > 2.2`), not a schedule.

---

## 1. Build rules

Carried from `PHASES.md > How every phase works`, `> Files that track the work`, `> Unit prompt template` and `> Rules for every Claude Code session`, plus the rules added during planning.

**Every phase runs four steps.** Build (units executed by Claude Code from a unit prompt), stabilize (tests pass together, bugs logged and fixed), playtest checkpoint (the owner uses the feature as a real user and writes notes), tune (small adjustments, no new features). A phase is locked before the next starts.

**Tracking files** live in `plans/` in the code repository: `PHASES.md`, `STATUS.md` (unit state, updated at the end of every unit), `BUGS.md` (reproduction, cause, fix, status), `DECISIONS.md` (every build decision with its reason), `PLAYTEST.md` (checkpoint notes and tuning changes), `units/` (one prompt per unit, named like `P1-U3-agentnft.md`), and `research/` (the research reports). `Planv2/` is the source these files start from.

**Unit prompt template** (verbatim from PHASES.md): `UNIT`, `GOAL`, `READ FIRST`, `DEPENDS ON`, `IN SCOPE`, `OUT OF SCOPE`, `DELIVERABLES`, `ACCEPTANCE TESTS`, `HOW THE OWNER TESTS IT`, `WHEN DONE`.

**Session rules** (from PHASES.md): read `STATUS.md`, `DECISIONS.md` and the unit prompt before writing code; stay inside the unit's scope and put extras in `STATUS.md` as suggestions; one branch per unit, small commits; tests with the code, not after; reproduce, log, fix and note every bug; never put real private keys or real funds anywhere before Phase 9; end every session by updating the tracking files.

**Rules added during planning:**

- Clean room: no code copied from BoringVault (SEL-1.0), Morpho Vault V2 (GPL-2.0-or-later), Zodiac Roles (LGPL-3.0 and BUSL-1.1) or monad-agent-kit (no license); patterns only, on an MIT base; a reviewer checklist item on every contract PR (`Answer 63`).
- Labels for every dependency: PROPOSED, DOCUMENTED, SPIKE_PASSED, INTEGRATED, RELEASED. Evidence advances a label; a source link is never a substitute for observed output (`preview.html > Revised build manual > 1`).
- Every spike is unverified until it passes, including E2B egress injection (`Answer` to the assessment). A unit that depends on a spike cannot close before the spike passes.
- A new security boundary or capital permission requires an entry in `plans/DECISIONS.md` before implementation (`preview.html > Revised build manual > 1`).
- Every record carries an environment ID (local fork, testnet, mainnet); a fork RPC is never wired to a mainnet signer (`preview.html > Revised technical plan > 11`).
- Never mark a mocked or fork-only integration as mainnet complete (`preview.html > Revised build manual > 1`).
- Pin versions and image digests that passed; do not use unbounded "latest" (`preview.html > Revised build manual > 1`).
- Demo and simulated activity is labeled at origin and excluded from external demand totals (`PHASES.md > Phase 5`).

---

## 2. Dependency graph

```mermaid
flowchart TB
  DOM[Shared domain and policy packages P0-U5]
  ENV[Local environment and fork P0-U2]
  HERM[Hermes and E2B spike P1-U1]
  NFT[AgentNFT and token-bound accounts P1-U3]
  IDX[Indexer and API P1-U4]
  PROV[Agent provisioning P1-U5]
  CRED[Billing, operating wallet, metering P1-U6]
  TOOLS0[Minimal tool servers and narrator P1-U7]
  SPIKE2[Venue and oracle spikes P2-U0]
  CUST[Custody core and PersonalAccount P2-U1]
  EXE[Executor, ProtocolRegistry, adapter P2-U2]
  ORA[Oracle adapter and breaker P2-U3]
  SIGN[KMS signer, grants, ledger P2-U4]
  CT[Chain tools server P2-U5]
  TRADE[Trade flow P2-U6]
  ADAPT[Chain adapter interface P2-U8]
  GOALS[Goals form and translator P3-U1]
  DT[Data tools server P3-U2]
  TPL[Strategy templates and tool registry P3-U3]
  DISC[Discovery loop P3-U4]
  TB[Thesis Board P3-U5]
  PROP[Parameter proposals P3-U6]
  SKF[Launch skills as folders P3-U7]
  WFR[Workflow runner and coordinator P4-U1]
  WFB[Built-in workflows and Risk Sentinel P4-U2]
  DIR[Directory, build cards, IdentityBinder P5-U1]
  MSG[Structured messages P5-U2]
  SIG[Signal feed P5-U3]
  X402[x402 payer P5-U4]
  BUY[Buyer agent P5-U5]
  SKC[SkillNFT, registries, BuildRegistry P6-U1]
  SKP[Packaging, privacy, loader P6-U2]
  AUD[Audit pipeline P6-U5]
  SKN[Launch skills as NFTs P6-U3]
  CFG[Configure page P6-U4]
  ART[3D asset pipeline P6-U6]
  VLT[StrategyVault core P7-U1]
  VEX[Vault Executor integration P7-U2]
  VSP[Vault invariants and spikes P7-U3]
  VUI[VaultFactory, caps, vault UI P7-U4]
  WATCH[Watchers and demand signals P7-U5]
  LB[Leaderboard P7-U6]
  ESC[AgentEscrow P8-U1]
  MKT[Marketplace and creator portal P8-U2]
  SALE[Agent sale flow P8-U3]
  SAFE[Safety modes and reserve P9-U1]
  MON[Monitoring, kill switch, runbooks P9-U2]
  REV[External reviews and legal gate P9-U3]
  MAIN[Mainnet deployment P9-U4]
  PUB[Public deposits P9-U5]
  SUB[Submission deliverables P9-U6]
  SOL[Solana track S-U1 to S-U5]
  DOM --> NFT
  DOM --> CUST
  DOM --> CT
  ENV --> HERM
  ENV --> NFT
  NFT --> IDX
  IDX --> PROV
  HERM --> PROV
  PROV --> CRED
  CRED --> TOOLS0
  SPIKE2 --> EXE
  SPIKE2 --> ORA
  CUST --> EXE
  ORA --> EXE
  EXE --> SIGN
  SIGN --> CT
  TOOLS0 --> CT
  CT --> TRADE
  CT --> ADAPT
  TRADE --> GOALS
  TOOLS0 --> DT
  DT --> DISC
  TPL --> DISC
  TPL --> SKF
  DISC --> TB
  TB --> PROP
  SKF --> DISC
  PROP --> WFR
  WFR --> WFB
  WFB --> DIR
  DIR --> MSG
  MSG --> SIG
  SIG --> X402
  X402 --> BUY
  NFT --> SKC
  SKC --> SKP
  SKP --> AUD
  AUD --> SKN
  SKF --> SKN
  SKN --> CFG
  ART --> CFG
  CUST --> VLT
  EXE --> VEX
  VLT --> VEX
  VEX --> VSP
  VSP --> VUI
  DIR --> WATCH
  WATCH --> LB
  SKC --> ESC
  VLT --> ESC
  ESC --> MKT
  MKT --> SALE
  WFB --> SAFE
  SALE --> MON
  VUI --> MON
  MON --> REV
  REV --> MAIN
  MAIN --> PUB
  MAIN --> SUB
  BUY --> SUB
  ADAPT --> SOL
  VUI --> SOL
```

---

## 3. Phases, reconciled with PHASES.md

Each phase lists its goal, build units (ID, name, components touched, dependencies, acceptance tests), the playtest checkpoint, and what changed from `PHASES.md` and why.

### Phase 0: Foundations

**Goal.** Every later unit starts from a working base (`PHASES.md > Phase 0`).

| Unit | Name | Components touched | Depends on | Acceptance tests |
|---|---|---|---|---|
| P0-U1 | Repo, tooling and tracking files | Monorepo layout (`apps/web`, `apps/control-api`, `services/*`, `packages/*`, `chains/monad`, `chains/solana`, `infra`, `evidence`, `docs/adr`, `plans/`), pnpm workspaces, lint, format, CI | none | CI runs lint, typecheck and an empty test suite; `plans/` holds the tracking files and the unit template |
| P0-U2 | Local environment | Foundry pinned at a version with Monad support, anvil fork script of Monad mainnet at a pinned block, local Postgres and Redis, one command that starts everything | P0-U1 | The fork answers `eth_chainId` 143, the canonical ERC-6551 registry has code at the fork block, Postgres and Redis reachable, one command boots all |
| P0-U3 | Config, secrets and environment IDs | Environment templates for local, fork, testnet and mainnet; secrets out of the repo; an environment ID stamped on every record type in the domain package | P0-U1 | No secret in git history; every environment template validates; a fork environment cannot load a mainnet signer reference |
| P0-U4 | Dev console | Internal admin page: every agent's status, spend, last action; reset an agent; add test funds; trigger tasks; kill switch placeholder wired in Phase 9 | P0-U1 | Console lists agents from the database and triggers a no-op task |
| P0-U5 | Shared domain and policy packages | `packages/domain` (IDs, integer base-unit amounts, epochs, action and event types, state transitions, environment labels), `packages/policy` (the hard-limit semantics as pure functions with fixtures shared by the server pre-checks and the contract tests), `packages/skills` (manifest schema), `packages/workflows` (spec schema), `packages/accounting` (journal and valuation types) | P0-U1 | Schemas validate the fixtures; the policy package rejects each hard-limit breach fixture; amounts never pass through floating point |

**Checkpoint.** One command boots the stack locally, the fork runs, the dev console loads.

**What changed and why.** P0-U5 is new: the revised technical plan and every research note assume shared domain, policy, skill and workflow schemas that the server, the contracts' tests and the audit service all use; without them the "read limits from the Executor, never hard-code" rule has no place to live (`preview.html > Revised build manual > 2`, `notes/monad-agent-kit.md > 4`). P0-U3 gains environment IDs on every record (`preview.html > Revised technical plan > 11`).

### Phase 1: The agent comes alive

**Goal.** Connect a wallet, mint an agent, fund it with credits, watch it use them (`PHASES.md > Phase 1`).

| Unit | Name | Components touched | Depends on | Acceptance tests |
|---|---|---|---|---|
| P1-U1 | Hermes and E2B spike | E2B template with Hermes at `085d9ee` pinned (source checkout, lockfile, image digest), bootstrap supervisor, base `config.yaml` with every switch from `FINAL_PLAN.md > 4.3.2`, LiteLLM proxy with a virtual key, a minimal platform tools server (`get_goals_and_limits`, `propose_allocation` stub, `complete_stage`), one skill folder mounted read-only, egress deny-by-default, egress header injection | P0-U2 | Spikes H-01 to H-06, H-08 to H-14, H-16, H-21, H-22, H-33 pass; MK-S1a and MK-S1b (egress injection) pass or the fallback proxy is chosen; B-04 marker leak table produced; the run's deliverable is a schema-valid tool call; replaying the idempotency key returns the same run |
| P1-U2 | Wallet login | Privy login with MetaMask and OKX in the web app; API session bound to address, current ownership and epoch | P0-U1 | Login works with both wallets on testnet; a session cannot act for an agent the address does not own |
| P1-U3 | AgentNFT and token-bound accounts on testnet | AgentNFT (tier, USDC mint price, atomic TBA create plus initialize, `ownerEpoch` bump on every `_update`, no-agent-in-TBA guard, no burn while holding, transfers restricted to the escrow address which is unset until Phase 8), a viem module with copied Tokenbound constants and the V3 ABI | P0-U5, P0-U2 | Spikes TB-1, TB-2, TB-3, TB-5, TB-8, TB-9b, TB-9c pass on the fork; mint emits `AgentMinted`; the implementation slot equals AccountV3Upgradable after mint; a transfer by anyone but the escrow reverts; the epoch bumps on every transfer path (ZR-Z17) |
| P1-U4 | Indexer and API basics | Envio HyperIndex handlers for `AgentMinted`, `OwnerEpochBumped`, Tokenbound guardian `TrustedImplementationUpdated`, `PermissionUpdated` and `OverrideUpdated`; API returns a user's agents with the projection watermark | P1-U3 | Indexer stores block height and hash per record; a gap or reorg is detected and reported; API lists agents for a connected address |
| P1-U5 | Agent provisioning | Orchestrator: agent record, LiteLLM virtual key, KMS operating wallet key, per-agent tool token, config renderer (base, tier overlay, agent overrides, JSON-schema validated), sandbox start and stop, state export and restore (encrypted) | P1-U1, P1-U4 | Two agents run in two sandboxes with different keys and tokens; export then restore continues a session (H-14); tokens rotate on demand; a second sandbox for the same agent is refused by the lease |
| P1-U6 | Credits | Billing contract (deposit, withdraw unspent, capped period settlement with sequence and usage hash, `BalanceDepleted`), operating wallet funding (MON for gas), metering ledger v1 (LiteLLM spend, sandbox minutes) with the price table, LiteLLM budgets set from the balance, pause at zero | P1-U5 | Owner deposits test USDC and sees the balance; usage settles in batches under the period ceiling; a repeated settlement cannot charge twice; at zero the gateway returns 402, the run ends with a billing reason (H-10), the orchestrator pauses the agent and exports state |
| P1-U7 | Minimal tool servers and narrator | Data tools server with `web_search` and `read_url` only (metered), platform tools server with `get_goals_and_limits` (goal stub), `complete_stage`, `write_thesis` stub; narrator v1 that renders action log entries; shared conventions from `FINAL_PLAN.md > 4.4.1` (identity from the token, error shapes, structured output, lint rule) | P1-U6 | MK-S4 tenant isolation and MK-K01 fuzz pass for the servers that exist; a call without the injected token gets 401; every paid call has a ledger row with `cacheHit` |
| P1-U8 | First task | A scheduled Scan-style task using `web_search`, driven by the orchestrator, ending in `complete_stage`; the narrator writes an activity entry | P1-U7 | The task runs on schedule, spends credits visibly, produces one feed entry, and stops when credits reach zero |
| P1-U9 | My Agents page | Status, credit balance, operating wallet balance, spend breakdown by kind, activity feed, pause | P1-U8 | Page shows live values from the ledger and the chain projection with their watermark |

**Checkpoint.** Connect a wallet, mint an agent, add credits, trigger or wait for a task, see the balance drop, read the entry, see the agent pause when credits run out. Look at minting feel, credit display, spend breakdown clarity, feed wording, step latency (`PHASES.md > Phase 1`).

**What changed and why.** P1-U7 is split out of the old P1-U7 "First task" so that the tool servers (which every later phase extends) are a unit of their own; the old first task becomes P1-U8 and the page P1-U9. P1-U3 gains the epoch bump, the escrow-only transfer restriction and the no-nesting guard now, because retrofitting them into a deployed NFT is impossible (`Answer 48`, `Answer 50`, `notes/tokenbound.md > 3.2`). P1-U4 indexes Tokenbound guardian events because the public RPC caps `eth_getLogs` (`notes/tokenbound.md > 6`). P1-U5 uses a KMS operating wallet rather than a Privy server wallet (`Answer 43`). P1-U6 adds the operating wallet and the capped settlement design from the revised plan.

### Phase 2: First trades

**Goal.** The agent makes its first real trades on test funds, safely (`PHASES.md > Phase 2`).

| Unit | Name | Components touched | Depends on | Acceptance tests |
|---|---|---|---|---|
| P2-U0 | Venue and oracle spikes | Depth measurement on Uniswap v3, Uniswap v4 and Kuru for a trade of 10% of a typical account inside 0.5% slippage (MK-K05, M-32, plus Kuru); Chainlink MON/USD and USDC/USD heartbeat and deviation over a sample window (M-33); Permit2 route dependency (TB-T04); anvil fork fidelity for Monad gas, reserve rules and timestamps (TB-0, MV-V26); EIP-1153 availability (ZR-Z12) | P0-U2 | A venue is chosen with recorded depth; per-feed staleness bounds are set from measured heartbeats; if no feed meets the 5-minute target the asset list and rule are escalated as an open question; fork differences that affect timing tests are documented |
| P2-U1 | Custody core and PersonalAccount | The custody core contract in single-owner mode: held-asset list, owner deposit and withdraw always on, Executor-only `executeSwap` and `pullForSwap`, post-trade invariants, internal units for flow-adjusted valuation, `poke()`, mode, no `receive()`, reentrancy guard, events with old and new values; one clone per `(agentId, owner)` | P0-U5, P1-U3 | M-06 no-escape-paths on the personal mode; withdraw works with every other contract etched to revert; a stale-epoch trade reverts; MV-S5 vault-side invariants catch a buggy Executor |
| P2-U2 | Executor, ProtocolRegistry and one venue adapter | Executor with the full check list from `FINAL_PLAN.md > 4.1.7`, session grants, ring buffer, turnover cap, policy sets by hash, timelocked loosening, guardian tighten and pause-all; ProtocolRegistry with code-hash pinning and statuses; the chosen venue's adapter with pinned pool, recipient set to the account, no side doors | P2-U0, P2-U1 | ZR-3, ZR-4a to 4j (adapted), ZR-4n, ZR-4o, ZR-4p inverted, ZR-4q, ZR-4r inverted, ZR-5, ZR-Z01, ZR-Z05, ZR-Z06, ZR-Z16, ZR-Z17, ZR-Z18; MV-S6 swap path and MV-S7 counter; M-04 and M-05; gas measured (ZR-6A, ZR-6E, ZR-Z04); MK-K02 policy versus Executor invariants |
| P2-U3 | Oracle adapter and circuit breaker | Chainlink wrapper per feed with staleness, decimals and sign checks, USDC as 1 with a depeg guard, pool spot read and pairwise deviation, `tradable` with reasons, asset drop; per-share peak tracking and the 10% and 20% modes in the account; reduce-only exemption for USDC output | P2-U0, P2-U1 | MV-S11 fail-closed reads; M-25, M-26, M-27, M-29, M-30; M-35 peak basis replay without false triggers; a 3% pool move blocks trades; a stale feed blocks trades but never withdrawals |
| P2-U4 | KMS signer, session grants and the execution ledger | Signer service (KMS keys, chain ID pin, `to` allowlist of the Executor, no contract creation, gas cap per tier, fenced nonce writer, replacement policy), transactional outbox, submission states (unknown is not failed), receipt finality policy, full balance reconciliation, simulation through `eth_call` with state overrides (anvil if MK-S2 shows it reliable) | P2-U2 | MK-K03 adapted: the signer refuses any call to another address or selector; crash after send and before write reconciles rather than spends twice; duplicate queue jobs converge on one action (`preview.html > Revised build manual > 5`) |
| P2-U5 | Chain tools server | All tools in `FINAL_PLAN.md > 4.4.2` with schema bounds generated from Executor views per session, the intent pipeline, reservations, rejection codes | P2-U4, P1-U7 | MK-S2, MK-S3, MK-S5 (with the hard-coded literals replaced by read bounds), MK-K02; no schema field named `address`, `agentId`, `owner`, `wallet`, `to`, `data`; a repeated `clientRequestId` returns the same intent |
| P2-U6 | Trade flow | Arming approval for the first trade, automatic trades within limits afterward, settlement only after receipt and reconciliation, "why the agent did not trade" from reason codes, activity feed entries | P2-U5 | Deposit, trade, exit and withdraw reconcile; duplicate, reordered and missing events, a dropped RPC response, a process restart and a stale indexer all produce correct state or "unknown" (`preview.html > Revised build manual > 5`); a blocked trade shows its reason |
| P2-U7 | Portfolio UI | Positions, trade history, deposit and withdraw, the arming card with deterministic financial fields, blocked-trade explanations, environment and account labels | P2-U6 | The owner can do every checkpoint action; the card shows account, chain, asset addresses, max input, min output, expiry |
| P2-U8 | Chain adapter interface and conformance suite | `ChainAdapter` interface over the domain package (ownership, account scope, epochs, action idempotency, precision, receipts, position reads); Monad implementation; the conformance test suite that Solana must later pass; capability flags | P2-U5 | The Monad implementation passes the suite; the suite fails on a stub that fakes a receipt |

**Checkpoint.** Deposit test USDC, see the agent propose a trade, approve it (arming), watch it settle, see the position update, try a trade that breaks a limit and see it blocked with a reason, withdraw directly. Look at the card's clarity, position and PnL display, blocked-trade explanations, cycle speed (`PHASES.md > Phase 2`). Trades run on the mainnet fork and on testnet where liquidity allows.

**What changed and why.** P2-U0 is new because the Executor's adapter and the oracle wrapper cannot be specified before a venue is chosen and heartbeats are measured (`Answer 44`, `Answer 45`). P2-U1 becomes the custody core that Phase 7 extends (`Answer 37`). P2-U2 adds the turnover cap, the reduce-only exemption, code-hash pinning and timelocked loosening (`Answer 39`, `Answer 40`, `notes/zodiac-roles.md > 4`). P2-U4 replaces the Privy session wallet with the KMS signer and absorbs the deterministic execution and reconciliation work package from the revised build manual's G2 (`Answer 43`). P2-U6 keeps the owner's first approval as arming and makes later trades automatic (`Answer 8`). P2-U8 is new so the Solana branch starts from a tested interface rather than a copy (`PHASES.md > Phase 2` Solana note, `preview.html > Revised build manual > 11`).

### Phase 3: Planning and research

**Goal.** The agent understands the owner's goal, researches, and proposes parameters (`PHASES.md > Phase 3`).

| Unit | Name | Components touched | Depends on | Acceptance tests |
|---|---|---|---|---|
| P3-U1 | Goals form and goal translator | Structured form (template, risk preset, allowed assets, optional stricter limits, model choice, credit settings); deterministic translator to template parameters within bounds, a policy hash and the `SOUL.md` block; config epoch bump on change | P2-U6 | No free-text field exists; every preset maps inside template bounds; stricter limits can never loosen the hard limits; a change bumps `configEpoch` and stale intents die |
| P3-U2 | Data tools server | Every baseline tool in `FINAL_PLAN.md > 4.4.3`, the read broker, shared cache, timeouts and backoff honored from headers in code, `STALE_DATA` and `UPSTREAM_UNAVAILABLE`, the platform x402 payer for paid sources, tier gating for premium tools (pro), Hermes `web`, `search` and `x_search` disabled | P1-U7 | MK-S6 gating and ledger; every result carries `asOf`; a 429 is retried per its header; no free-text chain string reaches the model |
| P3-U3 | Strategy templates and the tool registry | Templates `rebalance_bands@1` and `dca@1` with JSON-schema parameters and bounds and the evals format; the template runner in the bot runner; the tool and intent registry with every ID the nine skills declare (`chain.read_contract`, `chain.balance`, `chain.get_code`, `data.dex_quote`, `data.pool_state`, `data.price_feed`, `data.volatility`, `data.web_search`, `data.x_search`, `data.dune_query`, `data.holders`, `data.yields`, `data.tvl`, `data.unlocks`, `data.wallet_portfolio`, `data.wallet_positions`, `data.wallet_pnl`, `platform.portfolio`, `intent.propose_swap`) at major version 1; accepted parameter sets recorded in the ledger by hash until BuildRegistry exists | P2-U5, P3-U2 | Each template runs on the fork against fixtures and obeys its bounds; a parameter set outside bounds is rejected; every registered tool ID resolves to a live tool |
| P3-U4 | Discovery loop | Orchestrator stage machine (Scan, Dive, Challenge, Test, Zoom out) with fresh sessions, stage prompts, turn caps, run budgets, sequential Dives, one sandbox per cycle, the skeptic playbook, model aliases (user model, cheap platform model) | P3-U3, P3-U7 | A full cycle completes with each stage ending in its terminal tool call; cost per cycle recorded; a stage that overruns its budget is stopped by the orchestrator; H-42 and H-43 behaviors documented |
| P3-U5 | Thesis Board | Platform tools `write_thesis`, `update_thesis`, `list_theses`, `get_thesis`; storage with status, evidence, confidence, expiry, recheck trigger, event and retrieval times; profile UI cards grouped by status | P3-U4 | Expired theses require recheck or retirement; evidence text is never served to owners; every observation stores its source and times |
| P3-U6 | Parameter proposals | `propose_strategy_update` and `no_change`; the deterministic evaluator (bounds, owner limits, policy); proposal states `pending_policy`, `pending_owner`, `accepted`, `rejected`; recording of accepted parameters; trial counts including rejections | P3-U5 | A within-bounds proposal reaches the owner; an out-of-bounds one is rejected with a code; acceptance records a new parameter hash and bumps the config epoch; rejected candidates are counted |
| P3-U7 | Launch skills as built-in folders | The nine skills authored to the skill.json spec (with the DCA skill holding sizing, drawdown pause and budget logic only, no schedule), frontmatter generated, mounted read-only through the loader path; `monad-assets-basics/data/` carries the platform address book | P3-U3, P1-U1 | B-01 (format validation on all nine plus the negative cases); B-02 selection spike with all nine descriptions (at least 7 of 8 positive prompts, 0 of 2 negative); H-11 read-only; H-30 index size recorded |

**Checkpoint.** Set a goal, watch the agent research over a few cycles, see thesis cards appear and change status, receive a parameter proposal, approve it, and see the template runner act on the new parameters. Look at research depth versus cost, proposal format, thesis card layout, cadence, system prompt adjustments (`PHASES.md > Phase 3`).

**What changed and why.** P3-U1's fields follow the agreed list and a single strategy per account (`Answer 9`, `Answer 10`); the translator is deterministic (`Register`). P3-U3 moves ahead of the discovery loop and absorbs the tool registry and evals format that the Bankr research shows are missing (`notes/bankr-skills.md > 9`). P3-U5 "allocation proposals with owner approval before rebalancing" becomes P3-U6 parameter proposals with approval per workflow mode (`Answer 14`). P3-U7 is new so research runs with the launch skills before SkillNFTs exist (`FINAL_PLAN.md > 4.5.4`).

### Phase 4: Financial management and reports

**Goal.** The agent manages money over time and reports on it clearly (`PHASES.md > Phase 4`).

| Unit | Name | Components touched | Depends on | Acceptance tests |
|---|---|---|---|---|
| P4-U1 | Workflow runner and portfolio coordinator | Spec schema and validator, BullMQ runner with triggers, steps, guardrails, approval modes, timeouts, compensation; the coordinator with reservations and the priority order; approvals bound to intent hashes with expiry | P3-U6 | A hostile spec (unbounded loop, undeclared tool, missing account scope) is rejected; two workers cannot reserve the same funds; a crash between database commit and enqueue is recovered by the outbox |
| P4-U2 | Built-in workflows and the Risk Sentinel service | Rebalancer, Recurring Buys and the Parameter change review as workflows; Risk Sentinel as a deterministic, separately budgeted service with the mode state machine (RESTRICTED, REDUCE_ONLY, EXIT_PENDING, PAUSED, INCIDENT) and breach reasons (stale feed, insufficient gas, signer down, unknown submission, mandate expired); the `token-risk-screen` guardrail rule in policy | P4-U1 | Rebalance and guardian contention test; Recurring Buys respects the budget and drawdown pause; drills: kill the bot, kill the queue, expire the key, remove credits, delay the feed, partially fill during cancel, transfer the agent, disable an adapter; each preserves bounded exits (`preview.html > Revised build manual > 6`) |
| P4-U3 | CFO dashboard | Net worth, single goal progress, pending approvals, the emergency view (mode, exposure, outstanding intents, operating runway, which account pays for an action) | P4-U2 | Every state from `FINAL_PLAN.md > 4.10` renders; an approval card's financial fields are deterministic |
| P4-U4 | Reports | Narrator-generated daily, weekly and monthly reports from ledger data with a few templates to compare; returns always carry period, basis, costs and drawdown | P4-U3 | Reports reconcile to the ledger; short histories show "not enough data" |
| P4-U5 | Tax lot ledger | Per-purchase lots for personal capital, gains and losses per position, unknown basis preserved, CSV export labeled an activity aid | P2-U6 | Export reconciles to positions; wraps, gas and transfers are classified, not dropped |
| P4-U6 | Notifications | Alerts for approvals, big moves, circuit breaker events, low credits, handover events | P4-U3 | Each event type produces one notification; frequency is tunable |

**Checkpoint.** Let the agent run with time fast-forwarded on the fork, read its reports, check the dashboard, respond to approvals, trigger the Risk Sentinel with a simulated price drop. Look at report structure, tone, charts, goal progress, notification frequency (`PHASES.md > Phase 4`).

**What changed and why.** Goal buckets become single-goal progress (`Answer 10`). Lending-based workflows stay out (`Register`). The Risk Sentinel is a deterministic service rather than an LLM workflow, per the revised technical plan's emergency worker (`preview.html > Revised technical plan > 7`). P4-U2 carries the drills from the revised build manual's G3.

### Phase 5: Agent interaction and value test

**Goal.** Two or more agents interact in the same market, and a buyer agent honestly judges whether what the platform offers is worth paying for (`PHASES.md > Phase 5`).

| Unit | Name | Components touched | Depends on | Acceptance tests |
|---|---|---|---|---|
| P5-U1 | Agent directory, build cards and IdentityBinder | Build cards served by the API with periods, sample sizes and badges; `directory_search` platform tool; IdentityBinder registering ERC-8004 identities at mint with back-registration of earlier mints (address and ABI confirmed first) | P4-U2, P1-U3 | A card is a standards-compliant registration document linking the richer card; TB-9 open question 8 (wallet verification) answered; cards exclude simulated activity from external counters |
| P5-U2 | Structured agent messages | Fixed message types (`offer_signal`, `request_quote`, `share_research_note`, `accept`, `decline`) as platform tools; untrusted handling; narrator rendering to owners | P5-U1 | A message with free text or an injection payload is rejected or neutralized; only declared types are accepted |
| P5-U3 | Signal feed | Per-agent trade publication after settlement; delayed feed free; real-time priced resource with 402 requirements | P5-U2 | No trade appears before settlement; the delayed feed lags by the configured window |
| P5-U4 | x402 payer and first purchases | Platform-side payer from the operating wallet (EIP-3009 USDC), `@x402/evm` at or above 2.22.0 pinned, Monad facilitator on testnet, per-agent daily cap, delivery ledger by request ID, facilitator receipt reconciliation, wrong-chain and wrong-payee rejection | P5-U3, P2-U4 | One real capped purchase, delivery, retry-without-double-charge and settlement receipt cycle on testnet (`preview.html > Revised build manual > 3` x402 probe); the token-bound account never signs |
| P5-U5 | Buyer agent | Separate evaluator agent on a different model and key with a directive, a budget and no stake; offer review and buy or decline decisions with the maximum price and reasons | P5-U4 | The buyer produces a decision and a reason for every offer; it runs on a different model from every seller |
| P5-U6 | Trial and renewal | Trial period tracking of results after costs; renew or cancel with reasons | P5-U5 | Net value after costs is computed from the ledger, not self-reported |
| P5-U7 | Value report | Summary of offers, decisions, acceptable prices, renewals and net value, labeled simulated | P5-U6 | Report excludes buyer activity from external demand totals |

**Checkpoint.** Run two agents in the same market, watch them discover each other, see one offer a signal and the other accept or decline, see a paid purchase settle, read the buyer's verdicts. Look at whether the reasons sound like a skeptical customer, which offers are declined, what price it would pay, whether anything delivered value after costs (`PHASES.md > Phase 5`).

**What changed and why.** P5-U1 absorbs ERC-8004 registration through the binder (`Answer 22`). P5-U4 fixes the payer as the operating wallet with the KMS signer and the package floor from the risk review (`notes/tokenbound.md > 3.9`, `risk-review.md`). Auto-copy is not built (`Answer 7`).

### Phase 6: Skills and customization

**Goal.** Skill NFTs change what an agent can do, and equipping them feels like building a character (`PHASES.md > Phase 6`).

| Unit | Name | Components touched | Depends on | Acceptance tests |
|---|---|---|---|---|
| P6-U1 | SkillNFT, SkillRegistry, PublisherRegistry, WorkflowNFT, BuildRegistry | Contracts per `FINAL_PLAN.md > 4.1.3` to `> 4.1.5`: content-hash versions, statuses, onchain copies of slot cost, tier, type and privacy, transfer restrictions for agent accounts, publisher keys and verification, BuildRegistry with slots 3, 5, 8 by sum of slot cost, holdings and status checks, config epoch bump, epoch log, built-in workflows registered | P1-U3 | A version with a reused number and a different hash is rejected; a revoked version cannot be activated; an operator transfer out of an agent account reverts; slot overflow reverts; `setBuild` by a non-owner reverts; a build change kills stale intents (ZR-Z17 extended) |
| P6-U2 | Skill packaging, privacy and loader | Validator for F1 to F8, frontmatter generator, canonical content hash, publisher signing, envelope encryption with authenticated metadata, key broker gated on ownership and the runtime lease, loader that materializes exactly the active build and refuses tampered or revoked versions, decryption into the per-cycle tmpfs | P6-U1, P1-U5 | B-01 negatives; B-05 version swap (only the new version reaches the model, tampered hash refused, revoked refused, mid-session rule applied at the next run); H-13 and B-04 leak table shows no marker on disk after teardown, none in tool arguments outside the platform, none in the owner feed |
| P6-U5 | Audit pipeline and creator upload service | Quarantine and safe unpack, S1 to S15, L1 to L8 on a separate model, the dynamic test sandbox (canaries, sinkhole, mock tools, evals), human review queue, continuous checks and version diffs, revocation path, invite registration in PublisherRegistry | P6-U2 | B-03: the clean skill passes, the synthetic risky skill is blocked with every planted pattern caught including the paraphrased override, calibration results recorded with the false-positive rate on defensive text |
| P6-U3 | Launch skills as NFTs and premium data | The nine skills published through the pipeline as platform skills with attestations; the premium curated data tool set for pro tier gated by the token; the swap skill named for the chosen venue | P6-U5, P3-U7 | Each of the nine passes the pipeline; a pro agent sees the premium tools and a base agent does not (MK-S6); the effect of an equipped skill is visible in the next cycle's tool calls |
| P6-U4 | Configure page | 3D agent with sockets, drag-equip from inventory, proposed versus active build, capability deltas, slot arithmetic by tier, goal form embedded, "Activate build" sending `setBuild`, build history | P6-U3, P6-U6 | Equip, activate, see the capability used, unequip, confirm it is gone at the next cycle; the running build and the proposal are visually distinct; the static fallback renders without WebGL |
| P6-U6 | 3D asset pipeline (art track plug-in) | Concept art to base models per tier, socket naming convention, nine skill part models, GLB export and compression, thumbnails, loading in React Three Fiber | P0-U1 | Every base body loads with named sockets; every skill part parents to its socket; file sizes within the budget set in the unit |

**Checkpoint.** Equip a skill, see the build change, see the new capability used in the next research cycle, unequip it, confirm it is gone. Look at equip feedback, slot layout, capability descriptions, build history (`PHASES.md > Phase 6`).

**What changed and why.** Unit order within the phase is U1, U2, U5, U3, U4 with U6 in parallel, because listing the nine skills should pass the same audit the creator portal uses. P6-U1 absorbs PublisherRegistry, WorkflowNFT and the transfer restrictions from the Tokenbound and Bankr notes (`Answer 17`, `Answer 51`). P6-U6 is new to give the parallel NFT and 3D work a place to plug in (`PHASES.md > header`).

### Phase 7: Vaults and social

**Goal.** Other users can deposit into an agent's vault and follow agents (`PHASES.md > Phase 7`).

| Unit | Name | Components touched | Depends on | Acceptance tests |
|---|---|---|---|---|
| P7-U1 | StrategyVault core | The custody core in public-vault mode per `FINAL_PLAN.md > 4.7`: shares with virtual offset, once-per-transaction valuation, spread and the time-scaled reference band, deposits with guards, lock buckets, USDC exit path with proportional close and size guard, `redeemInKind` with claimable credits, leader stake, dormant fee storage with per-depositor entry prices, roles, timelocks, guardian powers, handover mode, wind-down, pause and breaker modes, share transfers disabled | P2-U1, P2-U3 | M-01 to M-03, M-07 to M-12, M-14 to M-23, M-25 to M-28, MV-S1 to MV-S4, MV-S8 to MV-S12, MV-S14 |
| P7-U2 | Vault Executor integration and backstops | `executeSwap` path for vault accounts, vault-side backstops (12%, 45%, 1%), reduce-only route table, per-share peak, guardian and admin paths, handover checks in the Executor | P7-U1, P2-U2 | M-04 to M-06 on the vault, MV-S5, MV-S13 and M-24 handover, MV-S7 on vault counters, separate counters per account |
| P7-U3 | Vault invariant and spike suite | Handler-based Foundry invariants with depositor, leader, session key, emergency, oracle mover, pool mover and sale actors; M-13 offline exit; M-34 ported Morpho invariants; MV-V16 to MV-V25; gas measurements M-31 | P7-U2 | M-13 holds over the invariant run with everything else etched to revert; no unexplained ledger difference; per-trade loss bounded by the slippage limit |
| P7-U4 | VaultFactory, caps and vault UI | Factory with deterministic deployment, per-vault and platform caps, `depositsEnabled` parameter, deployment state-assertion script (MV-S15); vault panel and deposit and withdraw modal (NAV and freshness, lockup, leader stake, mode, handover state, in-kind option, claimable credits, warnings before top-ups) | P7-U3 | MV-S15 fails on any mismatch; the modal shows every state; a top-up warns before extending the lock |
| P7-U5 | Watchers and demand signals | Offchain follows, anti-gaming rules (hold period for deposits, watcher eligibility, funding-source filtering, self-purchase exclusion, demo exclusion), demand counters on cards | P5-U1 | Counters exclude filtered and simulated activity; a watcher without an agent or deposit does not count |
| P7-U6 | Leaderboard | Ranking by risk-adjusted return with drawdown, deposits, watchers and demand; periods, sample sizes, "not enough data"; comparable cohorts | P7-U5 | No agent shows a 30-day figure before 30 days of history; every return shows its period and basis |

**Checkpoint.** Deposit into another wallet's agent vault, watch it trade, withdraw in USDC and in kind, follow agents, read the leaderboard. Look at vault panel clarity, leaderboard layout, how demand counters feel (`PHASES.md > Phase 7`).

**What changed and why.** PHASES.md described "ERC-4626 accounting and direct withdrawals"; the phase now carries the full register vault design, the leader stake, handover, dormant fees and the invariant suite as gates before external review (`Register`, `Answer 5`, `Answer 6`, `Answer 25` to `Answer 36`). Three units (U1 to U3) replace one because the vault is the largest custody surface.

### Phase 8: Marketplace and agent economy

**Goal.** Skills and agents are bought and sold, and agents pay each other (`PHASES.md > Phase 8`).

| Unit | Name | Components touched | Depends on | Acceptance tests |
|---|---|---|---|---|
| P8-U1 | AgentEscrow | `list`, `cancel`, `buy` with the Tokenbound checks (`isLocked`, `extsload` implementation allowlist, holdings, `buildHash`, `state` snapshot), epoch bumps, no generic call path, no ERC-1271; AgentNFT escrow address set through the timelock; item escrow for skills and workflows | P6-U1, P7-U1 | TB-6A to TB-6D, TB-7 and TB-7-USDC, TB-9a; a listing pauses the seller's sessions; cancel bumps the epoch; a locked or upgraded account cannot be listed; the vault enters handover on listing |
| P8-U2 | Skill and workflow marketplace and creator portal | Listing pages, primary and secondary sales through the escrow, derived labels, the creator portal (upload, findings with evidence lines, review status, appeal, pricing and supply, art upload, earnings) | P8-U1, P6-U5 | List and buy a skill; resale only through the escrow; an unsanitized creator description cannot inject markup; earnings reconcile to sales |
| P8-U3 | Agent sale flow end to end | UI for listing and buying; orchestrator reaction to `AgentSold` (cancel proposals, rotate tool token, LiteLLM key and API server key, reset goals, keep `MEMORY.md`, delete `USER.md`); buyer onboarding (build confirm, session registration, incoming stake, acceptance) | P8-U1 | Sell an agent from one wallet to another; the old owner's web session, tool token and sessions are dead; the old owner can still withdraw PersonalAccount funds; the buyer completes handover |
| P8-U4 | Agent economy for users | Real-time signal purchases available to users' agents, x402 mainnet configuration verified separately from testnet, external purchases tracked separately from internal ones | P5-U4, P8-U2 | One real user-initiated purchase settles; internal and external totals are separate |

**Checkpoint.** List and buy a skill, sell an agent from one wallet to another and confirm the old owner loses access, watch one agent buy from another (`PHASES.md > Phase 8`).

**What changed and why.** The escrow carries the exact check list from the Tokenbound research and becomes the only transfer path (`Answer 50`, `notes/tokenbound.md > 3.5`). The creator portal is placed here with the audit service already built in Phase 6 (`Answer 15`). Workflow listings are built-ins only (`Answer 16`).

### Phase 9: Hardening and mainnet

**Goal.** The platform is ready for real money (`PHASES.md > Phase 9`).

| Unit | Name | Components touched | Depends on | Acceptance tests |
|---|---|---|---|---|
| P9-U1 | Safety modes and emergency reserve | The agent lifecycle modes end to end (UNCONFIGURED, READY, RUNNING, RESTRICTED, REDUCE_ONLY, EXIT_PENDING, PAUSED, INCIDENT), a separately metered emergency reserve for gas and the Risk Sentinel, the rule that research stops first when credits run low | P4-U2 | Draining credits during an open position still allows the sentinel to act and the owner to exit; modes are shown separately from market exposure |
| P9-U2 | Monitoring, kill switch, runbooks and release fixtures | Metadata-only tracing (no prompt capture), Sentry, contract alerts, the admin console kill switch that pauses all Executors, per-venue pause, incident runbooks (signer compromise, malicious adapter, skill leakage, market shock, chain outage, billing exhaustion, accounting mismatch, manager handover), the minimum release fixtures from the revised build manual, p50, p95 and p99 execution stage latencies (MK-S7) | P8-U3, P7-U4 | Every fixture in `preview.html > Revised build manual > 13` passes; the kill switch pauses trading without touching any exit; restoring an old database cannot re-authorize executed work |
| P9-U3 | External reviews and legal gate | External review of the custody core, Executor, adapters, oracle adapter and escrow; the founders' legal review of pooled discretionary management; findings triaged | P9-U2 | No unresolved critical finding; the legal decision is recorded |
| P9-U4 | Mainnet deployment and dry run | Deployment manifests (chain, address, ABI digest, bytecode digest, block, admin, capabilities), the state-assertion script on mainnet, low caps, five platform-run agents with small real capital, a dry run with the founders' own funds, a capped mainnet canary through the real signer, Executor and venue (MK canary) | P9-U3 | The canary trades and exits on mainnet within caps; manifests match; `depositsEnabled` is false |
| P9-U5 | Public deposits enablement | `depositsEnabled` set true with the platform cap after P9-U3; the launch decision recorded | P9-U4 | A stranger can deposit into a public vault under the cap |
| P9-U6 | Submission deliverables | Public repository access for `metropolis@hackathon.monad.xyz`, technical demo video of the live product, pitch video, live link with access instructions, logo, the evidence bundle; simulated activity labeled | P9-U4, P5-U7 | Every item in `FINAL_PLAN.md > 2.2` exists and is linked from the repository README |

**Checkpoint.** A full dry run on mainnet with the founders' own small funds before opening to anyone else (`PHASES.md > Phase 9`).

**What changed and why.** The legal gate, external reviews, the state-assertion script, the mainnet canary and the submission deliverables are explicit units (`Answer 3`, `Answer 61`, `notes/managed-vaults.md > 4`, `notes/monad-agent-kit.md > 7` item 14). The emergency reserve is deferred to here as the register says.

### Solana track (after the Monad chain layer)

Same depth as Monad, on a separate branch, sharing the chain-agnostic core (`Register`). Starts after P2-U8 exists and is built out once the Monad vault and escrow schemas are stable.

| Unit | Name | Components touched | Depends on | Acceptance tests |
|---|---|---|---|---|
| S-U1 | Solana probes | Metaplex Core agent creation, PDA wallet, delegate grant and revoke, persistence across transfer, priority fees, account locks, transaction expiry, a Solana DEX depth measurement, a Solana price feed | P2-U8 | Each probe recorded as claim, method, observed output, remaining assumptions |
| S-U2 | Programs | Agent asset with the Agent Registry, custody core, typed-intent executor, vault, billing, escrow in Rust with Anchor | S-U1, P7-U3, P8-U1 | The same invariant families as Monad, including offline exit and epoch invalidation, expressed with Solana mechanisms |
| S-U3 | Identity and delegate restriction | Program-level restriction of the execution delegate so that it can reach only the executor; revoke on transfer; no assumed EVM parity | S-U2 | Transfer with prior approvals, authority changes and pending workflows all end old authority |
| S-U4 | Chain adapter, tool server variant, indexer and payer | `ChainAdapter` for Solana, chain tools variant, DAS indexer, x402 payer with Solana signatures, KMS Solana keys | S-U2 | The conformance suite from P2-U8 passes; capability flags list what differs |
| S-U5 | Conformance and launch approval | Independent launch approval for Solana; the same capital and risk gates | S-U4, P9-U3 | An EVM result satisfies no Solana gate |

---

## 4. Unit list in build order

| # | Unit | Name | One-line goal | Depends on |
|---|---|---|---|---|
| 1 | P0-U1 | Repo, tooling and tracking files | Working monorepo, CI, `plans/` | none |
| 2 | P0-U2 | Local environment | Fork, databases, one-command boot | P0-U1 |
| 3 | P0-U3 | Config, secrets and environment IDs | Safe configuration per environment | P0-U1 |
| 4 | P0-U5 | Shared domain and policy packages | Schemas and pure policy shared by everything | P0-U1 |
| 5 | P0-U4 | Dev console | Internal control page for every checkpoint | P0-U1 |
| 6 | P1-U1 | Hermes and E2B spike | Prove the wrapped runtime and egress injection | P0-U2 |
| 7 | P1-U2 | Wallet login | Privy login with ownership-bound sessions | P0-U1 |
| 8 | P1-U3 | AgentNFT and token-bound accounts | Mint with atomic account creation, epochs, escrow-only transfers | P0-U5, P0-U2 |
| 9 | P1-U4 | Indexer and API basics | Chain projections with watermarks | P1-U3 |
| 10 | P1-U5 | Agent provisioning | Config rendering, keys, sandbox lifecycle, export and restore | P1-U1, P1-U4 |
| 11 | P1-U6 | Credits | Billing, operating wallet, metering v1, budgets, pause at zero | P1-U5 |
| 12 | P1-U7 | Minimal tool servers and narrator | Identity-bound tool servers and the narrator | P1-U6 |
| 13 | P1-U8 | First task | A scheduled task that spends credits and produces a feed entry | P1-U7 |
| 14 | P1-U9 | My Agents page | Owner dashboard for status and spend | P1-U8 |
| 15 | P2-U0 | Venue and oracle spikes | Choose the venue, measure feeds, settle fork fidelity | P0-U2 |
| 16 | P2-U1 | Custody core and PersonalAccount | The capital contract in single-owner mode | P0-U5, P1-U3 |
| 17 | P2-U3 | Oracle adapter and circuit breaker | Fail-closed prices, deviation, modes | P2-U0, P2-U1 |
| 18 | P2-U2 | Executor, ProtocolRegistry and adapter | Typed intents with every hard limit | P2-U0, P2-U1, P2-U3 |
| 19 | P2-U4 | KMS signer, grants and execution ledger | Sign only Executor calls; reconcile everything | P2-U2 |
| 20 | P2-U5 | Chain tools server | Intents, never calldata; limits read from the Executor | P2-U4, P1-U7 |
| 21 | P2-U6 | Trade flow | Arming, automatic trades, settlement after receipt, reasons | P2-U5 |
| 22 | P2-U7 | Portfolio UI | Positions, history, deposit and withdraw, cards | P2-U6 |
| 23 | P2-U8 | Chain adapter interface and conformance suite | The seam the Solana branch implements | P2-U5 |
| 24 | P3-U1 | Goals form and goal translator | Structured input to template parameters | P2-U6 |
| 25 | P3-U2 | Data tools server | Metered, sanitized external reads | P1-U7 |
| 26 | P3-U3 | Strategy templates and tool registry | Templates with bounds; every tool ID live | P2-U5, P3-U2 |
| 27 | P3-U7 | Launch skills as built-in folders | Nine skills mounted and selectable | P3-U3, P1-U1 |
| 28 | P3-U4 | Discovery loop | Five stages as separate runs | P3-U3, P3-U7 |
| 29 | P3-U5 | Thesis Board | Research memory on the platform | P3-U4 |
| 30 | P3-U6 | Parameter proposals | Bounded parameter changes with approval | P3-U5 |
| 31 | P4-U1 | Workflow runner and portfolio coordinator | Declarative routines with reservations | P3-U6 |
| 32 | P4-U2 | Built-in workflows and Risk Sentinel | Rebalancer, Recurring Buys, parameter review, sentinel | P4-U1 |
| 33 | P4-U3 | CFO dashboard | Net worth, goal progress, approvals, emergency view | P4-U2 |
| 34 | P4-U4 | Reports | Narrator reports from ledger data | P4-U3 |
| 35 | P4-U5 | Tax lot ledger | Personal cost basis and export | P2-U6 |
| 36 | P4-U6 | Notifications | Alerts for the events that matter | P4-U3 |
| 37 | P5-U1 | Directory, build cards, IdentityBinder | Discoverable agents with ERC-8004 identity | P4-U2, P1-U3 |
| 38 | P5-U2 | Structured agent messages | Fixed message types, untrusted handling | P5-U1 |
| 39 | P5-U3 | Signal feed | Post-settlement publication, delayed free, real-time priced | P5-U2 |
| 40 | P5-U4 | x402 payer and first purchases | One real capped purchase cycle | P5-U3, P2-U4 |
| 41 | P5-U5 | Buyer agent | A skeptical evaluator with a budget | P5-U4 |
| 42 | P5-U6 | Trial and renewal | Net value after costs, renew or cancel | P5-U5 |
| 43 | P5-U7 | Value report | Pricing and product evidence, labeled simulated | P5-U6 |
| 44 | P6-U6 | 3D asset pipeline | Bodies, sockets, parts, thumbnails | P0-U1 |
| 45 | P6-U1 | SkillNFT, registries, BuildRegistry | Skill ownership, versions, active builds | P1-U3 |
| 46 | P6-U2 | Skill packaging, privacy and loader | Validate, hash, sign, encrypt, mount only the active build | P6-U1, P1-U5 |
| 47 | P6-U5 | Audit pipeline and creator upload service | Block what must be blocked | P6-U2 |
| 48 | P6-U3 | Launch skills as NFTs and premium data | Nine skills listed; pro data gated | P6-U5, P3-U7 |
| 49 | P6-U4 | Configure page | The 3D build experience wired to BuildRegistry | P6-U3, P6-U6 |
| 50 | P7-U1 | StrategyVault core | The public vault | P2-U1, P2-U3 |
| 51 | P7-U2 | Vault Executor integration and backstops | Trading for vault accounts with independent backstops | P7-U1, P2-U2 |
| 52 | P7-U3 | Vault invariant and spike suite | Offline exit and accounting proofs | P7-U2 |
| 53 | P7-U4 | VaultFactory, caps and vault UI | Deploy, cap, assert, show | P7-U3 |
| 54 | P7-U5 | Watchers and demand signals | Free follows with anti-gaming | P5-U1 |
| 55 | P7-U6 | Leaderboard | Honest ranking | P7-U5 |
| 56 | P8-U1 | AgentEscrow | The only transfer path, with the Tokenbound checks | P6-U1, P7-U1 |
| 57 | P8-U2 | Marketplace and creator portal | Listings, sales, creator flows | P8-U1, P6-U5 |
| 58 | P8-U3 | Agent sale flow end to end | Old owner loses everything but PersonalAccount funds | P8-U1 |
| 59 | P8-U4 | Agent economy for users | Signal purchases for users' agents on mainnet configuration | P5-U4, P8-U2 |
| 60 | P9-U1 | Safety modes and emergency reserve | Lifecycle modes and a funded emergency path | P4-U2 |
| 61 | P9-U2 | Monitoring, kill switch, runbooks, fixtures | Operate it safely | P8-U3, P7-U4 |
| 62 | P9-U3 | External reviews and legal gate | Independent eyes before real money | P9-U2 |
| 63 | P9-U4 | Mainnet deployment and dry run | Manifests, assertions, canary, founders' funds | P9-U3 |
| 64 | P9-U5 | Public deposits enablement | The recorded launch decision | P9-U4 |
| 65 | P9-U6 | Submission deliverables | Repo, videos, link, logo, evidence | P9-U4, P5-U7 |
| 66 | S-U1 | Solana probes | Metaplex, PDA, delegate, venue, feed facts | P2-U8 |
| 67 | S-U2 | Solana programs | Agent, custody, executor, vault, billing, escrow | S-U1, P7-U3, P8-U1 |
| 68 | S-U3 | Identity and delegate restriction | Program-restricted delegate | S-U2 |
| 69 | S-U4 | Chain adapter, tools, indexer, payer | The Solana implementation of the seam | S-U2 |
| 70 | S-U5 | Conformance and launch approval | Independent Solana gate | S-U4, P9-U3 |

---

## 5. Spike register

Every spike from the seven research runs, deduplicated. Source IDs are kept with a run prefix: H (Hermes), B (Bankr), TB (Tokenbound), ZR (Zodiac Roles, kept only where it applies to our Executor), MK (monad-agent-kit), MV (managed vaults: S and V rows), M (Morpho Vault). "Merged" lists spikes from other runs that test the same thing and are not listed separately. "Gates" names the unit that cannot close until the spike passes. Rows marked "mainnet" gate real money.

### 5.1 Runtime, sandbox and skills

| ID | Name | Proves | Pass criteria | Merged | Gates |
|---|---|---|---|---|---|
| H-01 | Environment and pinning | Pinned checkout at 085d9ee boots with an isolated home | `hermes doctor` clean; nothing unexpected in `HERMES_HOME` | | P1-U1 |
| H-02 | Gateway with a per-agent key | LiteLLM alias plus virtual key with budget works | Spend visible on the key with `x-agent-id` | | P1-U1 |
| H-03 | Mock platform server with structured output | Streamable HTTP server with bearer check | Missing header rejected; tool returns `structuredContent` | | P1-U1 |
| H-04 | One skill from our folder | Read-only external skill dir discovered | Skill listed in `GET /v1/skills` | | P1-U1 |
| H-05 | Rendered config resolves | Provider, MCP and toolsets as intended | `hermes tools --summary` shows only todo, skills, our servers | H-23 | P1-U1 |
| H-06 | Headless run with structured output | `/v1/runs` with idempotency, events, tool-call deliverable | Run completes; replay returns the same run with `Idempotency-Replayed` | | P1-U1 |
| H-07 | Hermes cron | Optional fallback only | Documented; not used | H-34 | none (fallback) |
| H-08 | Egress allowlist | Runs work with only gateway and tool hosts allowed | Every denied host listed and mapped to a switch | H-21, H-37, H-47 | P1-U1 |
| H-09 | No other vendor | All model traffic including forced compression reaches LiteLLM with the agent header | No request without `x-agent-id` | H-17, H-18, H-19 | P1-U1 |
| H-10 | Budget exhaustion | LiteLLM exhaustion ends a run as `billing`, not retried | Exact status and body recorded; 402 configured | H-20, H-41 | P1-U6 |
| H-11 | Skill read-only | Agent cannot modify a mounted skill | No change on disk; at most a staged proposal | H-16, B-02 step 6 | P1-U1, P3-U7 |
| H-12 | Tool allowlist | Removed toolsets are absent, not refused | Shell request yields "tool not available" | H-24, H-48 | P1-U1 |
| H-13 | Leak scan | Where a canary lands after runs and a forced 400 | Expected hits only (`state.db`, request dumps on tmpfs) | B-04, H-29, H-31, H-38 | P1-U1, P6-U2 |
| H-14 | Export and restore | Fresh home plus backup continues a session | Session continues in a new run | H-32 | P1-U5 |
| H-15 | Footprint | RSS after boot and after tool calls; home size | Numbers recorded | | P1-U5 |
| H-22 | Approval bridge on the API server | Flagged action waits or is denied under `unattended_mode: deny` | Orchestrator auto-deny path works within the timeout | | P1-U1 |
| H-25 | `readOnlyHint` and transport replay | Read tools replayed, write tools `outcome_uncertain` | Idempotency keys make retries safe | | P2-U5 |
| H-26 | Untrusted wrapper on trusted results | Model still obeys goals and limits wrapped as untrusted | Behavioral eval recorded; `SOUL.md` adjusted | | P3-U4 |
| H-27 | Tool search with many tools | Prompt-cache and context cost as the tool surface grows | Token cost measured | | P6-U3 |
| H-28 | Bundled skill seeding on the API path | Whether `sync_skills` runs under the gateway only | Contents of `skills/` after start recorded | | P1-U1 |
| H-30 | Skills index token size | Cost of the index with nine skills | Token count recorded | | P3-U7 |
| H-33 | Firecracker supervision | Gateway behavior without s6 as PID 1 | Subprocesses reaped; bootstrap supervises | | P1-U1 |
| H-35 | `response_format` on the main loop | Whether a JSON schema can be forced | Documented; tool-call pattern stands | | none |
| H-36 | Per-request toolsets | Whether stage narrowing per run exists | Documented | | P3-U4 |
| H-39 | Image lazy-install flag | Dockerfile sets `HERMES_DISABLE_LAZY_INSTALLS` | Grep confirmed | | P1-U1 |
| H-40 | Doc versus code drifts | The known drifts re-verified at the pin | Contract suite entries | H-46 | P1-U1 |
| H-42 | Overlapping requests to one session | `busy_input_mode` on the API server | Runner keeps one run per session | | P3-U4 |
| H-43 | `/goal` judge loop | Usefulness inside one Dive run | Evaluated | | P3-U4 |
| H-44 | Skill selection reliability | Correct skill loaded from 60-char descriptions with nine skills | At least 7 of 8 positive, 0 of 2 negative | B-02 | P3-U7 (launch gate) |
| H-45 | Upgrade contract test | Config keys and defaults hold after any re-pin | H-08 to H-16 pass on the new commit | | any future re-pin |
| B-01 | Convert and validate skills | Spec validator, generator, hash, signing; negatives rejected | Two converted packages pass F1 to F8; unmodified Bankr folder, unquoted colon and same-version-different-hash rejected | | P3-U7, P6-U2 |
| B-02 | Load into Hermes and confirm selection | Selection, `requires_tools` gating with MCP tools, loader edge cases (nested, lowercase, oversized, env-var skills), no writes | Gating works or loader gates; edge cases documented; no write to the mount | H-44, H-11 | P3-U7 |
| B-03 | Audit checklist on clean and risky skills | S and L rules, dynamic test, calibration set | Clean passes; synthetic risky skill blocked with every planted pattern caught including the paraphrased override; false-positive rate recorded | | P6-U5 |
| B-04 | Marker leak test through the private path | Where INDEX, BODY, reference and data markers appear | Never in tool arguments outside the platform, the owner feed, disk after teardown, memory or skill folders | H-13 | P6-U2 (launch gate) |
| B-05 | Version swap | Only the new version reaches the model; tamper and revoke refused | No old text in vendor requests; mid-session rule written; dependent workflow pauses | | P6-U2 |
| MK-S1a | Local header identity | Hermes lists only included tools and `whoami` returns the agent | Correct agent and tier | | P1-U1 |
| MK-S1b | E2B egress header injection | Token never in the sandbox; request outside the sandbox gets 401 | `env` and every config show no token; call still succeeds | H-08 | P1-U1 (launch gate; fallback: platform egress proxy) |
| MK-S4 | Tenant isolation | Agent B cannot read or act for agent A | `INTENT_NOT_FOUND`, 403 on session reuse, strict schemas reject extra fields; promoted to CI | MK-K01 | P1-U7, P2-U5 |
| MK-S6 | Premium tools hidden and metering ledger | Tier gating at the protocol level; one ledger row per paid call | Base token lacks the tool; list_changed or reconnect works; no row without an agent | | P3-U2, P6-U3 |
| MK-S7 | Latency and deadline budget | The 2-minute deadline is feasible end to end | p95 signing-to-inclusion well inside 120 s; server latency under 100 ms per call | | P9-U2 |

### 5.2 Token-bound accounts and escrow

| ID | Name | Proves | Pass criteria | Merged | Gates |
|---|---|---|---|---|---|
| TB-0 | Fork setup | Anvil forks Monad at a pinned block with the registry present | Registry has code on the fork | ZR-0, MV-V26, MK-S2 fork part | P0-U2, P2-U0 |
| TB-1 | Mint, create the account, match the SDK address | Registry formula, proxy slot, `owner()`, `token()`; SDK creation non-idempotent | Addresses match; second SDK create reverts | | P1-U3 |
| TB-2 | Skill in and read back | Equip works; `state()` unchanged; uninitialized proxy rejects ERC-1155 | Balance 1; transfer into uninitialized account reverts | | P1-U3 |
| TB-3 | Owner executes, non-owner rejected | Owner authority; sandboxed delegatecall cannot write account storage | `NotAuthorized` for others | | P1-U3 |
| TB-4 | Permission is all-or-nothing | A permissioned address can execute, create, sign, upgrade | Confirms the no-permissions rule | | P1-U3 (record only) |
| TB-5 | Transfer, old access, revival | Access switches in the same block; grants revive on return; our epoch blocks revival | Old session rejected by the mock Executor after return | ZR-Z01 | P1-U3 |
| TB-6A | Lock baseline | Lock semantics and limits | Locked calls revert; 366 days reverts | | P8-U1 |
| TB-6B | Override bypass | Pre-installed override drains while locked with `state()` unchanged | Skill moves via the override | | P8-U1 (escrow design gate) |
| TB-6C | Lock persists to the buyer | Seller's lock binds the buyer | Buyer `execute` reverts | | P8-U1 |
| TB-6D | Escrow custody neutralizes overrides and signatures | With the NFT in escrow the seller's override is dormant and signatures fail | Override moves nothing; seller signature invalid | | P8-U1 (escrow design gate) |
| TB-7 | ERC-1271 before and after transfer | Validity, lock independence, cross-account replay, short signature revert | Same signature valid on a second account of the owner; invalid after transfer | | P5-U1 (identity payload rule) |
| TB-7-USDC | USDC EIP-3009 while locked | Whether Monad USDC accepts an account signature during a lock | Documented; decides that USDC never sits in an account | | P5-U4 |
| TB-8 | Unsolicited tokens and cycles | Anything can be pushed in; self-transfer bricks | `OwnershipCycle` on safe transfer; guard in AgentNFT | | P1-U3 |
| TB-9a | Nested root owner | Whether canonical proxy accounts walk the tree | Documented; nesting forbidden regardless | | P1-U3 |
| TB-9b | Implementation readable by contracts | `extsload` works from a contract | Returns AccountV3Upgradable | | P8-U1 |
| TB-9c | Guardian state | Owner is the Tokenbound Safe; nothing trusted | Recorded | | P1-U4 (monitoring baseline) |
| TB-9d | Bytecode reproduction | Source at v0.3.1 reproduces the deployed init code | Hashes equal | TB-T03 | P1-U3 |
| TB-9e | ERC-4337 UserOp from an account | Whether a v0.6 UserOp executes and a bundler accepts it | Documented; the account is never a UserOp sender | | none (design confirms) |
| TB-9f | Prefund during lock | Gas taken from a locked account | Documented; the account never holds MON | TB-T05 | none |
| TB-T01 | Forwarder init code | Multicall3 forwarder equals the audited source | Hash reproduced | | P1-U3 |
| TB-T02 | SDK bundling | Whether the SDK bundles viem chains | Inspected; our viem module used instead | | P1-U3 |
| TB-T04 | Permit2 route dependency | Whether the chosen routes require Permit2 | Routes chosen that take direct approvals | ZR item 18 | P2-U0 |

### 5.3 Executor, oracle and venue

| ID | Name | Proves | Pass criteria | Merged | Gates |
|---|---|---|---|---|---|
| MK-K05 | Venue depth | Which of Uniswap v3, v4 and Kuru absorbs a 10%-of-typical-account trade inside 0.5% | Measured impact per venue; one chosen; `get_quote` shape confirmed | M-32, ZR-Z19 depth part | P2-U0 (launch gate) |
| M-33 | Chainlink heartbeat and deviation per feed | Feed behavior on Monad | Heartbeat and deviation recorded; staleness bounds set | MK-K04, ZR-Z19 feed part | P2-U0 (launch gate) |
| ZR-Z12 | Transient storage on Monad | Whether TSTORE and TLOAD work | Opcode executes or storage guard chosen | | P2-U0 |
| ZR-Z11 | Fund USDC in tests | `deal` on the USDC proxy or holder impersonation | Works | | P2-U0 |
| MK-S2 | Read tools on the fork | viem reads, structured output, Hermes consumption; anvil viability | Amounts exact to the base unit; `asOf` equals the fork block; fallback to direct RPC if anvil fails | | P2-U5 |
| ZR-3 | Allowed swap succeeds | Assets stay inside the account; allowance ends at zero; counters move | USDC down by `amountIn`, WMON up by at least `minOut`, allowance zero | MV-S6, M-04 | P2-U2 |
| ZR-4a to 4j | Structural rejections | No recipient, side door, disallowed token, fee tier, unlimited or foreign approval, delegatecall, value, unscoped selector or target can exist | Each case reverts or is impossible by construction | | P2-U2 |
| ZR-4n | Turnover cap | Crossing trade reverts | Reverts on the crossing swap | | P2-U2 |
| ZR-4o | Trade count | 21st trade in a rolling 24 hours reverts | Reverts | MV-S7 | P2-U2 |
| ZR-4p | Boundary burst (inverted) | A rolling window rejects the second batch until timestamps age out | Second 20 fail | MV-S7 | P2-U2 |
| ZR-4q | Non-member | Stranger, stale-epoch key and expired grant all revert | Reverts | | P2-U2 |
| ZR-4r | Zero min-out (inverted) | Too-low `minAmountOut` reverts against the oracle check | Reverts | | P2-U2 |
| ZR-5 | Same-block revoke | Revoke or epoch bump then a swap in the same block reverts | Reverts | | P2-U2 |
| ZR-Z02 | Front-running a revocation | A higher-fee trade ordered first succeeds; the damage is bounded | Documented on testnet with real block building | | P2-U2 |
| ZR-6A, ZR-6E, ZR-Z04 | Gas baseline, Executor overhead, testnet gas | Cost of the Executor path under Monad's gas model | Numbers recorded on fork and testnet | M-31 | P2-U2 |
| ZR-Z05 | No admin can change the recipient | Recipient derives from the account itself | Asserted structurally | | P2-U2 |
| ZR-Z06 | Deadline and slippage checks with a mock oracle | Stale deadline and low min-out reject | Rejects; cost measured | | P2-U2 |
| ZR-Z16 | Adversarial ports | ERC-1271-revert if contract signers ever exist; smuggling if batching ever exists | Each reverts | | P2-U2 |
| ZR-Z17 | Epoch paths | Mint, burn, transfer, safeTransfer, escrow all bump; stale and future epochs rejected | Fuzzed | TB-5, M-24 epoch part | P1-U3, P2-U2 |
| ZR-Z18 | Formal invariants | Exact balance deltas, allowance zero, no value on every path | Hold under fuzzing | | P2-U2 |
| MK-K03 | Signer restriction (adapted to KMS) | The signer refuses any call to another address or selector; gas payer identified | Refused | ZR-Z13 | P2-U4 |
| MK-S3 | `propose_swap` returns an intent ID | No calldata anywhere; idempotent; status history | No hex field except addresses and display hashes; schema lint passes | | P2-U5 |
| MK-S5 | Structured rejections | Every rejection code within one call; the Executor is the authority with pre-checks disabled | All cases; Hermes does not retry the identical intent | | P2-U5 |
| MK-K02 | Policy versus Executor invariants | Server accept never reverts on a limit; server reject would have reverted | Holds for a generated intent set | | P2-U5 |
| MV-S11 | Fail closed on reads | Oracle revert, zero, stale, negative, decimals mismatch, balance revert | Priced paths revert with a specific error; in-kind unaffected | M-25, M-26 | P2-U3, P7-U1 |
| M-27 | Oracle off band | 3% away from the pool blocks deposits and USDC exits | Reverts | | P2-U3 |
| M-29 | Pool manipulation | A flash swap moves the pool 20% but not NAV | NAV unchanged; deposit reverts on the band | | P2-U3 |
| M-30 | Executor sandwich | Oracle floor bounds sandwiching | 0.4% front-run passes; 0.6% reverts | | P2-U2 |
| M-35 | Circuit breaker peak basis | Which NAV and where, without false triggers | Chosen from replayed prices | | P2-U3 |
| MK canary | Capped mainnet canary | The real signer, Executor and venue trade and exit on mainnet within caps | Receipts, fills, costs, accounting, exit and guard results | | P9-U4 (mainnet) |

### 5.4 Vault

| ID | Name | Proves | Pass criteria | Merged | Gates |
|---|---|---|---|---|---|
| M-01, M-02 | Deposit share math; no-profit round trip | Directional NAV and virtual shares; no round trip creates value | Shares equal preview; round trip returns at most the deposit | MV-V16, MV-V17 | P7-U1 |
| M-03 | Inflation attack | First-depositor inflation fails with the seed and virtual shares | Victim keeps value; `depositsOpen` needs the seed | MV-V24 (offset chosen) | P7-U1 |
| M-05 | Executor limits and vault backstops | Every hard limit in the Executor; looser backstops in the vault | Direct calls with looser parameters revert on the vault | MV-S5, M-06 | P7-U2 |
| M-07 to M-11 | USDC path | USDC-first, proportional close, `alwaysProportional`, venue failure, thin-pool guard | Exact slices; clean revert; `UseInKind` above 2% of liquidity | MV-V21, MV-V25 | P7-U1 |
| M-12 | In-kind math | Pro-rata payout | Floor of each slice; others' claims never decrease | MV-V18 | P7-U1 |
| M-13 | Offline exit | `redeemInKind` succeeds with the Executor, key, feeds, pools, routers and AgentNFT all reverting and the guardian paused | Invariant over the handler run | MV-S2 | P7-U3 (launch gate, mainnet) |
| MV-S1 | In-kind survives a failing token | A reverting token becomes a claimable credit; others unaffected | Credit exact; never reverts because of the skipped token | | P7-U1 |
| MV-S3 | Share supply integrity | No path mints without assets or burns another's shares | Fuzzed over every role | MV-V22 | P7-U1 |
| MV-S4 | In-contract delays | Nothing executes early; emergency cannot add risk; delay never below the maximum lockup plus margin | Holds | M-21 (lockup governance) | P7-U1 |
| M-14 to M-17 | Leader stake | Floor on leader exits and diluting deposits; others never blocked; wind-down lifts it | Holds | MV-S9 | P7-U1 |
| M-18 to M-23 | Lockups | Both paths blocked until expiry; top-up semantics; no third-party relock; bounds; waivers; `max*` never revert | Holds | MV-S10 | P7-U1 |
| M-24 | Handover | Old owner powerless, new owner limited until acceptance, depositors free, also when the transfer bypasses the escrow | Holds | MV-S13 | P7-U2, P8-U1 |
| M-28 | Lag arbitrage | Stale-feed extraction bounded by the spread; measured to size `s` | Profit at most lag minus spread | | P7-U1 (sets the spread) |
| MV-S8 | Reference-price breaker | Deposits and USDC exits revert outside the band and resume without admin action; in-kind unaffected; honest operations blocked under historical volatility counted | Holds; parameters chosen | | P7-U1 |
| MV-S12 | Deposit hygiene | `minSharesOut`, caps, spread math, `depositsOpen` never blocks exits | Holds | | P7-U1 |
| MV-S14 | Operators cannot redirect proceeds | Third-party exits pay only the share owner | Reverts otherwise | | P7-U1 |
| MV-S15 | Post-deploy state assertion | Script compares every role, delay, oracle, route, fee and cap to intent | Fails on any mismatch | | P7-U4, P9-U4 (mainnet) |
| MV-V19 | Fee state monotonic | Per-user entry price and fee shares behave; no fee on loss | Holds (dormant rate) | | P7-U1 |
| MV-V20 | Permit front-running | A front-run permit does not block a permit deposit | Holds | | P7-U1 |
| M-34 | Ported invariants | Supply equals balances; previews equal results; no profitable round trip; timelock earliest time; abdication permanence; valuation never reverts; tracked balances match; per-trade loss bounded | Foundry invariants hold | MV-V16 to MV-V19 | P7-U3 (gate before external review) |
| M-31 | Exit gas | `redeemInKind` and proportional close cost under Monad's gas model | Recorded on testnet | | P7-U3 |

Dropped from the register as Zodiac-only: ZR-2, ZR-4l, ZR-6B to ZR-6D, ZR-Z03, ZR-Z07 to ZR-Z10, ZR-Z14, ZR-Z15; MK-S0 (hosted server probe); M-36 (Morpho factory bytecode, needed only for a later Morpho-native product).

---

## 6. What is deferred, and the trigger for adding it

| Feature | Left out because | Trigger for adding it | Source |
|---|---|---|---|
| WETH and a liquid staking token as tradable assets | Thin liquidity (about 5,700 USDC in the v3 USDC/WETH pool); no feed validation | Measured depth at the reference size inside 0.5% and a feed passing M-33; LST pricing by market feed versus redemption rate decided | `Register`, `notes/morpho-vault.md > 8` |
| Second venue | One venue keeps the adapter surface small | The first venue's full position lifecycle passes conformance and the depth spike shows the second venue is needed | `Register` |
| Lending, borrowing, leverage, LP positions, perps | No exit and valuation support at launch | Each venue's whole position lifecycle (enter, read, value, exit, worst case, residual obligations) passes conformance; lending exit probes pass | `Register`, `preview.html > Revised technical plan > 6` |
| CFO debt features: liability manager, debt guardian, debt refinancer | Depend on lending | Lending enabled and the guardian tests from the revised build manual pass | `Register` |
| Multi-goal buckets and the goal planner | One strategy per account at launch | A hard reservation model exists so a protected bucket cannot collateralize a strategy | `Answer 10`, `preview.html > Revised technical plan > 9` |
| Synergies and set bonuses | Nine skills give little to combine; needs a table and mounting logic | A second skill wave and a synergy table that composes only pre-approved capabilities | `Answer 11`, `preview.html > Revised build manual > 7` |
| Auto-copy trades | Recursive copy cycles and correlated exposure need controls | Signal service stable; cycle rejection, TTL, independent sizing and correlated-exposure caps built | `Answer 7` |
| Withdrawal queue (ERC-7540 style) | No queue at launch | Positions that cannot be split in kind, pro-rata sales routinely exceeding the slippage bound, or leverage | `Register`, `notes/managed-vaults.md > 3` |
| Async deposits settling at the next oracle round | Spread and lockup expected to suffice | M-28 shows extractable lag above the spread | `notes/morpho-vault.md > 7` |
| Performance fee activation | Fees deferred | Accounting tests pass on live data; the fee rate change goes through the risk timelock | `Answer 5` |
| Creator royalty share of performance fees | Deferred with fees | Fees active and fee-epoch rights specified | `Register` |
| Permissionless creator uploads | Invite-only bounds review load | Abuse handling, stake, dispute and revocation rules published | `Answer 15` |
| Third-party workflow listings and the workflow builder | Built-ins only | The workflow validator has rejected hostile specs in production and the creator flow exists | `Answer 16` |
| OpenSea and Blur agent sales | Seller-drain paths | A custom account implementation closes overrides and signature drains, and a marketplace that pins `state()` or a skill freeze during listing exists; the address migration is planned | `Register`, `Answer 49`, `notes/tokenbound.md > 4` |
| Share transfers in vaults | Lock griefing and cost basis | Rules that transfer only free shares and leave the receiver's lock untouched, behind the timelock | `Answer 25` |
| Share of other users' agents (agent-owns-agent) | Nested account walk is inert for canonical accounts | TB-9a result and a use case | `notes/tokenbound.md > 4` |
| ERC-8004 reputation and validation registries | Validation registry was "coming soon"; attestations are platform-signed | The registries are live on Monad and the claim classes are defined | `Answer 22` |
| Independent runtime attestation (TEE) | Trust boundary, not proof of trading quality | Creator demand for a trust model independent of the platform | `build-manual.md > 3.3`, `risk-review.md > R09` |
| Lit Protocol key release | Owner-controlled accounts would let owners decrypt | Same as above, plus Monad on Lit's supported chains | `build-manual.md > 3.2` |
| Seasons and leagues | Leaderboard first | Enough live history for comparable cohorts | `Answer 21` |
| Batched intents | Cumulative counting and smuggling risks | A need that one intent per transaction cannot meet, plus per-intent counting in the batch | `notes/zodiac-roles.md > 4` |
| Arbitrary code generation and bot evolution | Launch evolves through skills and template parameters | The evaluation ladder (fork integration, historical evaluation, stress, shadow, canary) and independent artifact approval exist | `Register`, `preview.html > Revised build manual > 8` |
| Historical backtests and simulation previews | Not a strategy evaluation system without point-in-time data | Frozen datasets with availability timestamps and a holdout outside the candidate's write authority | `Answer 13`, `risk-review.md > R05` |
| Hermes self-improvement revisit | Off at launch | Skills write approval plus an independent review step, and evidence that agent-written skills add value | `notes/hermes.md > 8` |
| Free-text goal translator | Structured input only | A separate untrusted proposal path that never reaches the brain as raw text | `risk-review.md > Contradictions` |
| Escrowed agent-to-agent jobs (ERC-8183 style) | x402 covers per-call purchases | A verified standard implementation with evaluator, acceptance, timeout and refund semantics | `technical-report.html > 12` |
| MEV and FastLane searcher skill | Not a launch strategy | A measured decision-to-inclusion path and a separately gated fast path | `build-manual.md > 4.7`, `risk-review.md > R11` |
| Enso routing, Blockaid screening, Tenderly simulation | Coverage on Monad unverified | Each proven on Monad by a probe with observed output | `build-manual.md > 15` |
| Offchain liabilities as read-only recommendations | Needs bank aggregation | A bank data aggregator decision | `technical-report.html > 13` |
| Management fee | Not in the product spec | Product decision; the per-second pattern is known | `notes/morpho-vault.md > 3.6` |
| Per-user deposit caps | Not needed under the platform cap | Abuse seen in practice | `notes/managed-vaults.md > 3` |
| Pull-oracle support in the Executor | Chainlink push feeds exist | A pull feed becomes the only reliable source for an asset | `notes/monad-agent-kit.md > 4` |
| Morpho-native USDC lending vault product | Separate product | Lending enabled and a decision to offer a Morpho V2 vault unmodified | `notes/morpho-vault.md > 1` |
| Custom workflow builder, tax lot automation, monthly CFO report as a workflow | Reports are narrator-generated at launch | Workflow marketplace exists | `technical-report.html > 14` |

---

## 7. Submission checklist and cut order

### 7.1 Deliverables mapped to units

| Deliverable | Produced by | Depends on |
|---|---|---|
| Public GitHub repository accessible to `metropolis@hackathon.monad.xyz` | P9-U6 | P0-U1 (the repository), every unit's evidence folder |
| Technical demo video of the live product | P9-U6 | P9-U4 (mainnet dry run), P6-U4, P7-U4, P8-U3 |
| Pitch video | P9-U6 | P5-U7 (value report, labeled simulated) |
| Live product link with access instructions | P9-U6 | P9-U4, P9-U5 if public deposits are open by then |
| Project logo | P6-U6 art track | none |
| Evidence bundle (addresses, transaction links, build hashes, test receipts, environment labels, known limitations) | P9-U6 | P9-U4, MV-S15, the spike register |

The demo must show one mint and configuration, one skill activation, one real research proposal, one rejected candidate, one policy-approved trade, one reconciled outcome, one blocked unsafe action, one safe interruption and recovery, and one real x402 purchase; five platform-run agents may illustrate different builds on the same proven path, labeled as platform-run (`preview.html > Revised build manual > 14`, `technical-report.html > 19`).

### 7.2 Cut order if a dependency fails

From `preview.html > Revised build manual > 15`, adopted as the rule for scope decisions: cut visual complexity, broad social sources, additional venues, open creator uploads, arbitrary live code, auto-copy, escrow jobs and the second chain before weakening custody, accounting, emergency handling or data provenance. Every cut feature stays tracked in section 6 with its failed gate and next proof. Never substitute unlimited permissions or optimistic accounting to preserve a demo claim.
