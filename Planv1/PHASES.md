# Build Phases

*Agent side of the platform. Revision 2, September 25, 2026.*

This document breaks the agent build into phases. Each phase builds one feature end to end, then stops at a checkpoint where you can use it, play with it, and tune how it looks and behaves before moving on. The NFT design and UI work you are doing in parallel plugs in at the phases where it is needed.

The phases are ordered by dependency. Each one produces something you can actually touch.

---

## How every phase works

Each phase runs through the same four steps.

**1. Build.** The phase is split into small units. Each unit is one Claude Code task with a clear goal and a clear definition of done. A planning model (me or another instance) writes the prompt for each unit from this document and the plan docs. Claude Code executes it.

**2. Stabilize.** Claude Code runs the unit's tests, documents any bugs it finds, fixes them, and records what changed. A phase is not finished until every unit's acceptance tests pass together, not just individually.

**3. Playtest checkpoint.** You use the feature as a real user would. The checkpoint section of each phase lists what you should be able to do and what to look at. You write down anything that feels wrong, looks off, or behaves unexpectedly.

**4. Tune.** A short round of adjustments based on your notes: wording, layout, timing, formatting, how the agent reacts, what it shows. These are small, fast changes, not new features. Once you are happy, the phase is locked and the next one starts.

---

## Files that track the work

Keep these in the `plans/` directory so every Claude Code session can read the current state.

- `plans/PHASES.md`: this document.
- `plans/STATUS.md`: which units are done, in progress, or blocked, updated by Claude Code at the end of every unit.
- `plans/BUGS.md`: every bug found, with how to reproduce it, the cause, the fix, and the status.
- `plans/DECISIONS.md`: every decision made during the build, with the reason, so later sessions do not undo it.
- `plans/PLAYTEST.md`: your notes from each checkpoint, and the tuning changes made from them.
- `plans/units/`: one file per unit prompt, named like `P1-U3-credits.md`.
- `research/`: the codebase research reports.

---

## Unit prompt template

Every unit prompt given to Claude Code follows this shape, so any model can write them consistently.

```
UNIT: P[phase]-U[number] [short name]

GOAL
One or two sentences on what this unit delivers.

READ FIRST
The plan docs, research reports, and code folders relevant to this unit.

DEPENDS ON
Units that must be complete before this one.

IN SCOPE
Exactly what to build.

OUT OF SCOPE
What not to touch or add, even if it seems helpful.

DELIVERABLES
Files, contracts, services, endpoints, or UI screens produced.

ACCEPTANCE TESTS
Specific checks that must pass, automated where possible.

HOW THE OWNER TESTS IT
Plain steps for a person to verify it works.

WHEN DONE
Update plans/STATUS.md, log any bugs in plans/BUGS.md, log any decisions
in plans/DECISIONS.md, and summarize what was built and anything left open.
```

## Rules for every Claude Code session

1. Read `STATUS.md`, `DECISIONS.md`, and the unit prompt before writing code.
2. Stay inside the unit's scope. Anything extra goes into `STATUS.md` as a suggestion.
3. Work on a branch per unit and keep commits small.
4. Write tests with the code, not after it.
5. When something breaks, reproduce it, log it in `BUGS.md`, fix it, and note the fix.
6. Never put real private keys or real funds anywhere during the build phases. Testnet and forks only.
7. End every session by updating the tracking files.

---

## Phase 0: Foundations

Short setup phase so every later unit starts from a working base.

**Build units**
- **P0-U1 Repo and tooling:** monorepo layout from the build manual, package manager, linting, formatting, and a basic CI run.
- **P0-U2 Local environment:** Foundry installed, a Monad mainnet fork script, local Postgres and Redis, and a single command that starts everything.
- **P0-U3 Config and secrets:** environment templates for local, testnet, and fork setups, with secrets kept out of the repo.
- **P0-U4 Dev console:** a simple internal admin page to see every agent, reset one, add test funds, and trigger tasks manually. This makes every later checkpoint much faster to test.

**Checkpoint:** one command boots the stack locally, the fork runs, and the dev console loads.

---

## Phase 1: The agent comes alive

**Feature:** connect a wallet, mint an agent, fund it with credits, and watch it use them.

**Build units**
- **P1-U1 Hermes spike:** run the spike plan from the Hermes research. Confirm Hermes runs headless in a sandbox, uses our gateway with a per-agent key, connects to one MCP server, loads one skill from our folder, and returns structured output. Include the marker-string leak test.
- **P1-U2 Wallet login:** Privy login with MetaMask and OKX in the web app.
- **P1-U3 AgentNFT on testnet:** mint an agent with a tier, create its token-bound account through the canonical registry, and emit the mint event.
- **P1-U4 Indexer and API basics:** the indexer picks up mints, and the API returns a user's agents.
- **P1-U5 Agent provisioning:** the orchestrator generates the agent's Hermes config from a base template plus its tier, creates its gateway key, and can start and stop its sandbox.
- **P1-U6 Credits:** the owner deposits test USDC into the agent's operating balance, the gateway meters usage per agent, the balance is debited, and the agent pauses cleanly at zero.
- **P1-U7 First task:** the agent runs a simple scheduled task using baseline tools (for example, a short market scan with web search), and the narrator writes an activity feed entry.
- **P1-U8 My Agents page:** shows each agent's status, credit balance, recent spend, and activity feed.

**Playtest checkpoint**
You should be able to: connect your wallet, mint an agent, add credits, trigger or wait for a task, see the credit balance drop, read the activity entry, and see the agent pause when credits run out.

Things to look at: how minting feels, how credits are shown (dollars, credits, or both), how clear the spend breakdown is, how the activity entries read, and how long each step takes.

**Tuning ideas:** onboarding copy, agent naming, credit display, feed wording and tone, task timing.

---

## Phase 2: First trades

**Feature:** the agent makes its first real trades on test funds, safely.

**Build units**
- **P2-U1 PersonalAccount contract:** holds the owner's USDC, with deposit and direct owner withdrawal that works even if our platform is down.
- **P2-U2 Executor, core limits:** typed swap intents, allowed assets, one venue, recipient bound to the account, exact approvals reset after each swap, deadlines, trade size caps, rolling trade count, and ownership and config epochs.
- **P2-U3 Oracle checks:** price feeds for the allowed assets, freshness and deviation checks, and the circuit breaker. Any asset without a reliable feed is removed from the allowlist.
- **P2-U4 Session key and signing:** a Privy session wallet whose policy only allows calling the Executor, plus simulation of every transaction before signing.
- **P2-U5 Chain tools:** MCP tools for the agent to read balances and prices, get quotes, and propose a swap intent.
- **P2-U6 Trade flow:** the agent proposes a trade, the owner approves the first one, then small trades within limits can run automatically. Settlement is recorded only after the receipt and balances are confirmed.
- **P2-U7 Portfolio UI:** positions, trade history, deposit and withdraw, and the approval card.

Trades run on a Monad mainnet fork (real Uniswap contracts, fake money) and on testnet where liquidity allows.

**Playtest checkpoint**
You should be able to: deposit test USDC, see the agent propose a trade, approve it, watch it settle, see the position update, try a trade that breaks a limit and see it blocked, and withdraw your funds directly.

Things to look at: whether the approval card clearly explains what will happen, how positions and profit or loss are shown, how blocked trades are explained, and how fast the whole cycle feels.

**Tuning ideas:** approval card wording, position layout, trade explanations, confirmation messages.

**Solana:** the Solana branch starts here, since this is where chain-specific code begins. The shared core stays in one place; only the account, execution, and tool pieces differ.

---

## Phase 3: Planning and research

**Feature:** the agent understands the owner's goals, researches, and proposes a portfolio.

**Build units**
- **P3-U1 Goals form:** structured goal input (amount, horizon, priority, risk level) saved to the agent's config.
- **P3-U2 Data tools:** MCP tools for DefiLlama, CoinGecko, Dune, X, web search, and document reading, all metered through credits.
- **P3-U3 Discovery loop:** the orchestrator schedules Scan, Dive, Challenge, Test, and Zoom out, with a budget per stage.
- **P3-U4 Thesis Board:** storage for research ideas with status, confidence, and expiry, plus a UI showing statuses and outcomes.
- **P3-U5 Allocation proposals:** the agent turns goals and research into a target portfolio, the evaluator checks it against limits, and the owner approves it before rebalancing trades run.
- **P3-U6 Strategy templates:** approved allocation templates whose parameters the agent tunes, with each accepted version recorded.

**Playtest checkpoint**
You should be able to: set goals, watch the agent research over a few cycles, see thesis cards appear and change status, receive an allocation proposal, approve it, and see the portfolio rebalance.

Things to look at: whether the research feels thoughtful or shallow, how much it costs per cycle, how the proposal explains its reasoning without revealing private skills, and whether the cadence feels right.

**Tuning ideas:** research depth versus cost, proposal format, thesis card layout, cycle timing, system prompt adjustments.

---

## Phase 4: Financial management and reports

**Feature:** the agent manages money over time and reports on it clearly.

**Build units**
- **P4-U1 Workflow runner:** runs declarative workflows with triggers, steps, guardrails, and approval modes.
- **P4-U2 Built-in workflows:** rebalancer, recurring buys, and risk sentinel. Lending-based workflows wait until lending is enabled.
- **P4-U3 CFO dashboard:** net worth, goal buckets and progress, pending approvals.
- **P4-U4 Reports:** daily, weekly, and monthly reports generated by the narrator from real account data, with a few format templates to compare.
- **P4-U5 Tax lot ledger:** simple per-purchase records, gains and losses per position, and a CSV export.
- **P4-U6 Notifications:** alerts for approvals, big moves, circuit breaker events, and low credits.

**Playtest checkpoint**
You should be able to: let the agent run for a period (with a way to fast-forward time on the fork), then read its reports, check the dashboard, respond to approvals, and trigger the risk sentinel with a simulated price drop.

Things to look at: this is the most "artistic" checkpoint. Look at report structure, length, tone, which numbers and charts appear, how goal progress is shown, and how often notifications arrive.

**Tuning ideas:** report templates and formatting, chart choices, dashboard layout, notification frequency and wording.

---

## Phase 5: Agent interaction and value test

**Feature:** two or more agents interact in the same market, and a buyer agent honestly judges whether what our platform offers is worth paying for.

This phase answers the most important product question: if someone gives an agent a plain directive like "make money with this, keep the downside small," would that agent actually choose to pay for our signals, reports, or other agents' outputs? If an agent with a budget and no loyalty to us would not pay, a person probably would not either.

**Build units**
- **P5-U1 Agent directory:** agents can discover each other through build cards (tier, goals, verified stats, trade history) served by the API.
- **P5-U2 Structured agent messages:** agents interact through fixed message types only, such as "offer signal," "request quote," "share research note," and "accept" or "decline." No free-form chat, so private skills cannot leak between agents. Every incoming message is treated as untrusted input, the same as a web page.
- **P5-U3 Signal feed:** each agent publishes its trades after they settle. Delayed access is free; real-time access has a price.
- **P5-U4 First paid purchases:** one agent pays another for real-time signals through x402 on testnet, capped per day and paid from the operating balance.
- **P5-U5 Buyer agent:** a separate evaluator agent with a directive, a budget, and no stake in our platform. It is shown offers (signal feeds, research reports, skills, other agents' services) and must decide whether to buy, what the most it would pay is, and why. It runs on a different model from the sellers to reduce the chance of models favoring their own output.
- **P5-U6 Trial and renewal:** after buying, the buyer agent tracks whether the purchase actually improved its results after costs over a trial period, then decides to renew or cancel, with reasons.
- **P5-U7 Value report:** a summary of every offer, the buy or decline decision, the price the buyer would accept, renewal outcomes, and net value delivered. This feeds pricing and product decisions.

**Playtest checkpoint**
You should be able to: run two agents in the same market, watch them discover each other, see one offer a signal and the other accept or decline it, see a paid purchase settle, and read the buyer agent's verdicts on each offer.

Things to look at: whether the buyer's reasons sound like a real, skeptical customer; which offers get declined and why; what price it would actually pay compared to what you planned to charge; and whether anything it bought delivered value after costs.

**Tuning ideas:** what agents offer, pricing, how offers are described, what data a buyer needs before deciding, and which products to drop because no agent wants them.

**One caution:** an agent's willingness to pay is a strong signal for design and pricing, but it is not real demand. Label these results as simulated in anything shown to judges or users, and keep real user purchases tracked separately.

---

## Phase 6: Skills and customization

**Feature:** skill NFTs change what an agent can do, and equipping them feels like building a character.

**Build units**
- **P6-U1 SkillNFT and registries:** skill tokens, the skill registry, and the build registry with slot limits per tier.
- **P6-U2 Skill packaging and privacy:** upload, encrypt, and release decrypted skills only into the owning agent's sandbox after an ownership check.
- **P6-U3 Capability skills:** a first set of skills that add tools or data (for example, premium curated data for pro tiers) so the effect is visible.
- **P6-U4 Configure page:** connects your NFT and 3D work to real equip and unequip actions, slots, and the active build.
- **P6-U5 Basic audit pipeline:** automated checks on uploaded skills before listing.

**Playtest checkpoint**
You should be able to: equip a skill, see the agent's build change, see the new capability used in its next research cycle, unequip it, and confirm the capability is gone.

**Tuning ideas:** equip animation and feedback, slot layout, how capabilities are described, build history display.

---

## Phase 7: Vaults and social

**Feature:** other users can deposit into an agent's vault and follow agents.

**Build units:** StrategyVault contract with ERC-4626 accounting and direct withdrawals, deposits from other wallets, watchers, and the leaderboard.

**Playtest checkpoint:** deposit into another wallet's agent vault, watch it trade, withdraw, and follow agents.

**Tuning ideas:** vault panel clarity, leaderboard layout, how demand counters feel.

---

## Phase 8: Marketplace and agent economy

**Feature:** skills and agents are bought and sold, and agents pay each other.

**Build units:** skill marketplace, workflow listings, agent sales through our escrow with ownership epochs and settlement checks, creator portal, and agent-to-agent purchases.

**Playtest checkpoint:** list and buy a skill, sell an agent from one wallet to another and confirm the old owner loses access, and watch one agent buy from another.

---

## Phase 9: Hardening and mainnet

**Feature:** the platform is ready for real money.

**Build units:** emergency reserve and safety modes, platform-wide deposit caps, full monitoring and kill switch, external reviews of the custody contracts, mainnet deployment with low caps, and the Solana launch track.

**Checkpoint:** a full dry run on mainnet with your own small funds before opening to anyone else.

---

## What you can test at each stop

| After phase | You can |
|---|---|
| 0 | Boot everything locally |
| 1 | Mint an agent, fund credits, watch it work and spend |
| 2 | Deposit, approve trades, see limits block bad trades, withdraw |
| 3 | Set goals, watch research, approve a portfolio |
| 4 | Read reports, use the CFO dashboard, respond to alerts |
| 5 | Watch agents interact, and see whether a buyer agent would pay for what we offer |
| 6 | Equip skills and see new abilities |
| 7 | Run a public vault and follow agents |
| 8 | Trade skills and agents at scale |
| 9 | Run on mainnet with real funds |
