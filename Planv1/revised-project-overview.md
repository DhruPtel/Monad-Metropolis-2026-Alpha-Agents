# Revised project overview

Proposed revision 2 · 24 September 2026 · Companion to the risk review and technical/build documents.

## What the product is

A platform for owning and configuring onchain financial agents. An agent is represented by an NFT; skills are licensed capabilities represented by NFTs and visualized as mechanical parts. The agent researches opportunities, proposes changes to a deterministic strategy, and executes only within a defined capital mandate. Owners see positions, costs, risk, build history and what happened onchain.

The initial customer hypothesis is an experienced onchain user who wants a bounded allocation managed with transparent controls. It is not yet a validated customer segment. The initial product promise is controlled automation and a traceable decision-to-trade record. Profitability, self-improvement, secrecy against all observers and maximum-loss guarantees are not established.

The robotic creature and equipment concept remains the main configuration interface. Equipping a skill changes permitted capabilities and the proposed build. It does not immediately improve financial statistics. Those changes are measured through evaluation and later live results.

## The three capital compartments

| Compartment | Purpose | Who bears its results |
|---|---|---|
| Personal account | Owner's goal portfolios, lending positions and CFO workflows | Owner only |
| Strategy vault | One published strategy with defined assets, fees, risk mandate and exit rules | Vault shareholders |
| Operating escrow and commerce wallet | Research, hosting, gas and bounded paid services | Explicitly authorized payer; no automatic pool subsidy |

One agent can coordinate these accounts, but money, liabilities, approvals and accounting remain separate. An NFT transfer moves the agent's ownership and any disclosed transferable property; it never turns public depositors' capital into the buyer's freely withdrawable money. Personal assets can be withdrawn before sale. Existing mandates, fee entitlements and third-party shares require explicit handling.

## How an agent operates

The research worker gathers point-in-time data, maintains the Thesis Board, and proposes a strategy configuration or new bot artifact. External content and skills are untrusted input. The research worker never receives transaction signing authority.

An independent evaluator checks code safety, transaction behavior, historical performance where valid data exists, stress scenarios and live shadow results. Passing a test means meeting a recorded criterion, not proving future profit. An approved candidate becomes a canary with bounded capital before wider activation.

The deterministic runtime creates typed transaction intents. A shared portfolio coordinator reserves funds and arbitrates between trades, withdrawals and workflows. The signing service and onchain executor independently enforce their parts of the mandate. Settlement is recorded only after receipts and position reconciliation, not when an RPC returns a transaction hash.

A separate risk worker can stop new exposure, cancel orders and attempt bounded exits. If ordinary billing runs low, research stops first. Emergency monitoring and gas use their own reserve while obligations remain. If a venue is frozen or a chain is unavailable, the system shows unresolved exposure instead of saying the account is safe.

## Skills, privacy and ownership

Owning a skill permits activation of a specific immutable version. Inventory and active equipment are separate. Activating or removing skills creates a new build configuration with compatibility checks, slot limits and recorded fee terms. Removing a skill invalidates dependent active builds; software cannot prove that all derived knowledge has been erased.

Creators upload into an isolated review process. Approved packages are encrypted and released only to authorized runtimes. The platform and selected model/compute providers remain within the confidentiality trust boundary. The interface uses structured input and narrowly defined outputs to reduce leakage. These are protective controls, not cryptographic secrecy from the platform.

Creator compensation consists of disclosed sale revenue and, where enabled, a pre-agreed share of a capped performance fee. Equipped-agent performance is observational evidence; it does not prove that a particular skill caused a return. Creator stakes and review badges do not insure depositors.

## Product scope and release gates

These are proposed sequencing decisions. Deferred features remain requirements of the broader product.

| Capability | Hackathon evidence | Owner-capital release | Public-capital release |
|---|---|---|---|
| Agent NFT, skill ownership, mechanical configuration | Real mint/equip/build transitions | Transfer and revocation proven | Manager handover preserves depositor rights |
| Research and evolving bots | Real proposal, evaluation and rejected candidate; simulation labeled | Approved templates/DSL first; generated artifacts gated | Same controls with independent review and immutable mandates |
| Trading | Deterministic full round trip; real venue only after probes | One spot strategy and narrowly allowed assets | Only strategies with complete NAV and exit support |
| Vault deposits and fees | Demonstrate on testnet/fork; mainnet owner-only canary separately | Owner funds only until pooled gates pass | Open deposits after accounting, recovery and offering review |
| CFO workflows | Real workflow/approval states; unsupported protocols simulated visibly | Personal account rebalance/sweep; debt only after guardian tests | Personal and public policy remain separate |
| Marketplace and creator royalties | Curated private skills; testable fee allocation | Versioned licenses and reviewed artifacts | Permissionless listings only after abuse handling |
| x402 and signals | One actual capped purchase if supported; seeded activity labeled | Bounded commerce account and retry handling | External usage tracked separately from internal purchases |
| Leaderboard and social layer | Watchers and provenance-labeled metrics | Live history and costs | Comparable cohorts; no fabricated history |
| Solana | Shared specifications, separate validation track | Chain-specific custody and lifecycle tests | Independent launch approval; no assumed EVM parity |

## What people see

Configure shows skill inventory, active build, proposed build, evaluated scenarios and real permissions. Deploy means submitting a candidate for the next allowed release stage. If activation awaits evaluation, approval or reconciliation, the button and status say so.

Agent profiles distinguish chain-confirmed trades, platform-attested builds, simulated results and live performance. A return always has a period, capital basis, cost treatment and risk measure. Insufficient history remains blank or explicitly limited; 30-day sample figures never become live defaults.

The vault panel shows NAV and its freshness, withdrawable assets, queued exits, fees, owner stake, strategy capacity and manager-change rules. The personal CFO dashboard shows goals, liabilities, pending approvals, known/unknown cost basis and which account will pay for an action. The owner dashboard includes an emergency view with outstanding orders, positions, approvals and operating runway.

## What establishes success

For the demo: one reproducible end-to-end agent cycle, one blocked unsafe action, one safe interruption/recovery, and independently traceable transaction/accounting records. Five agent characters can share this proven machinery; their interactions are demo activity, not external traction.

For a trading product: reproducible net performance against a stated baseline, measured execution costs and capacity, resilient exits, and customers willing to pay for the service. More agents, more models and faster blocks do not establish those outcomes by themselves.

The platform keeps the original character-building and agent-economy idea. Its financial foundation becomes a precise statement of authority, accounting, execution and recovery that every new skill must respect.
