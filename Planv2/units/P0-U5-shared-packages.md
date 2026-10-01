UNIT: P0-U5 Shared domain and policy packages

GOAL
Create the shared packages every later service imports: core domain types, the canonical mode model, the address book per environment, typed intents, the tool registry IDs, and the hard limits as pure, tested policy functions. This gives every service one definition of each rule instead of several.

READ FIRST
CLAUDE.md, LESSONS.md, Planv2/BUILD_PLAN.md (build rules, P0-U5, and applicable "Lessons from Alpha Markets"), and in Planv2/FINAL_PLAN.md: the canonical mode model and mapping table, the canonical tool registry table, the hard limits and trust model, the Executor intent design, and anything describing the address book. If BUILD_PLAN's P0-U5 adds requirements not listed here, include them and list them in the handoff.

DEPENDS ON
P0-U1, P0-U2, P0-U3.

IN SCOPE
1. packages/domain:
   - Core types: agent ID, tier (base, medium, pro with 3, 5, and 8 slots), account kinds (PersonalAccount, StrategyVault, funding address), asset IDs, and the environment label from packages/config. Every record type carries the environment label.
   - The canonical mode model and its mapping table, exactly as defined in FINAL_PLAN.md.
   - The canonical tool registry IDs across the chain, data, and platform servers, exactly as in FINAL_PLAN.md.
   - Typed intent schemas with zod, starting with the swap intent and the rebalance intent. Intents never contain calldata.
2. Address book in packages/domain, one entry per environment, for every contract and token the plan references (ERC-6551 registry and Tokenbound account implementation, USDC, wrapped MON, Uniswap contracts, Chainlink feeds, and any others named in the plan). Rules:
   - Use only addresses that appear in Planv2 or its research. Never guess or recall an address from memory.
   - Each entry records its source document and a status: verified or unverified.
   - Verify each mainnet address against the local fork by confirming it has deployed code. Mark it verified only if that check passes.
   - Any address that cannot be found or verified stays unverified with the related open question ID (for example Q-03 for USDC). Unverified addresses must be impossible to use for signing, enforced by the type system or a runtime check.
3. packages/policy: the launch hard limits as typed constants and pure functions that check a proposed intent against an account state. Cover: max 10% of account value per trade, max 40% in any non-USDC asset, at least 10% in USDC, max 0.5% slippage, rolling 20 trades per 24 hours, rolling 24-hour turnover cap of 100% of NAV, 2-minute deadlines, oracle price under 5 minutes old and within 2% of pool price, circuit breaker thresholds (10% reduce-only, 20% pause), and the reduce-only exemption for trades whose output is USDC. Every rejection returns a structured reason code, which later feeds "why the agent did not trade". Document that the Executor is the final authority and these checks are offchain pre-checks.
4. Tests for both packages: valid and invalid intents, every limit at, just under, and just over its threshold, the reduce-only exemption, rolling window edges, mode mappings, and the unverified-address signing block.
5. Root typecheck: switch to checking every workspace package (pnpm -r typecheck or project references), so new packages are actually type checked.
6. Pin every GitHub Action in ci.yml to a full commit SHA, with the version tag in a comment.
7. Doc drift: update Planv2/BUILD_PLAN.md and Planv2/DECISIONS_AND_OPEN_QUESTIONS.md to reflect three environments (local, testnet, beta) as built in P0-U3, with public mainnet added in Phase 9. Record it as an owner decision.

OUT OF SCOPE
Contracts, the Executor itself, database schemas, services, the dev console (P0-U4), any network calls beyond read-only checks against the local fork, and any address not found in Planv2 or its research.

DELIVERABLES
packages/domain and packages/policy with tests, the address book with sources and verification status, the root typecheck fix, SHA-pinned CI actions, updated plan docs, and a short README section describing the shared packages.

ACCEPTANCE TESTS
- All domain and policy tests pass, including every threshold edge case.
- Every rejection path returns a reason code.
- Every address book entry has a source and status. Every mainnet entry marked verified has code on the fork.
- Attempting to use an unverified address for signing fails.
- pnpm -r typecheck covers the new packages, and a deliberate type error in one of them fails the root typecheck.
- CI actions are pinned to SHAs, and CI passes.
- All existing checks still pass: lint, format:check, vitest, forge build, non-fork forge tests, secrets:scan, doctor, dev:status, test:fork.
- git status is clean.

HOW THE OWNER TESTS IT
1. Run pnpm test and pnpm typecheck.
2. Open the address book file and review which addresses are verified and which are unverified.
3. Read the policy reason codes list and check they would make sense as "why the agent did not trade" messages.
4. After pushing, confirm all CI jobs pass.

COMMITS
Commit incrementally as each part works, for example:
- feat(infra): add domain package with core types and mode model [P0-U5]
- feat(infra): add tool registry IDs and typed intent schemas [P0-U5]
- feat(infra): add address book with fork verification [P0-U5]
- feat(infra): add policy package with launch hard limits [P0-U5]
- chore(infra): typecheck all workspace packages [P0-U5]
- chore(infra): pin CI actions to commit SHAs [P0-U5]
- docs(plans): record three-environment decision [P0-U5]

WHEN DONE
Add a LOGS.md entry, and add a LESSONS.md entry for every bug fixed. Commit them. Then post the handoff message described in CLAUDE.md. Do not push.
