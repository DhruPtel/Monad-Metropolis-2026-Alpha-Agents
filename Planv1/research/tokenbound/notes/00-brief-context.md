# Brief context for sub-agents (Parts 1 and 2 of the research brief, verbatim)

## Part 1: Our product (context you need for the mapping)

We are building an onchain financial management platform on Monad (Solana version later, not relevant here). Keep these facts in mind, because the final reports must connect Tokenbound to them.

**Agents are NFTs.** A user connects a wallet (MetaMask, OKX) and mints an agent NFT (our own ERC-721 contract, "AgentNFT") in one of three tiers. On mint, we create an ERC-6551 token-bound account (TBA) for the agent. Whoever holds the agent NFT controls the TBA. The canonical Tokenbound v3 stack is already deployed on Monad mainnet (chain 143) and testnet (chain 10143); the registry is at `0x000000006551c19487814612e58FE06813775758`.

**Skills are NFTs held by the TBA.** Skill NFTs (ERC-1155, one token ID per skill, capped supply) are equipped by transferring them into the agent's TBA. The number of equipped skills is limited by tier (skill slots). A separate BuildRegistry contract we write records the active build (exact skills and versions), because raw token transfers into the TBA must not be able to change a build on their own.

**Three separate capital accounts.** A risk review of our design required physically separate accounts:
1. **Personal account:** the owner's own money, managed by the agent. The TBA is a candidate for this role, but only if its permissions can be restricted exactly.
2. **Strategy vault:** a separate ERC-4626 vault contract that other users deposit into (Hyperliquid-style). The agent manages it but can never withdraw depositor funds. The TBA must never have unrestricted custody over vault assets.
3. **Operating wallet:** pays for gas, AI inference credits, and small paid services (x402 payments).

**The agent never holds the owner's key.** Trades are executed by a platform-managed session key (a Privy server wallet with policies) that is only allowed to call our Executor contract. The Executor enforces typed actions: fixed recipients, allowed assets and venues, exact-amount approvals, per-trade size limits, deadlines, and ownership and configuration epochs.

**Default hard limits at launch:** allowed assets USDC, MON, WETH, and one liquid staking token; one swap venue (Uniswap); max 10% of account value per trade; max 40% in any non-USDC asset; at least 10% kept in USDC; max 0.5% slippage; exact token approvals only; 2-minute transaction deadlines; circuit breaker at 10% and 20% drawdown. No leverage or lending at launch. Withdrawals must always work directly from the contract, even if the platform is down.

**Transfers are the hard part.** When an agent NFT is sold, the buyer must receive the agent, its equipped skills, and its history, but old permissions (session keys, approvals, pending actions) must stop working immediately. The seller must not be able to drain the agent right before the sale completes. Personal funds should be withdrawable by the seller before a sale.

**Other connections:**
- Each agent is also registered in the ERC-8004 identity registry, bound to the AgentNFT.
- Agents may need to sign payment authorizations (x402) and messages, so smart-account signature validation (ERC-1271) matters.
- Gas sponsorship and account abstraction (ERC-4337) may be used through Privy.

## Part 2: Ground rules

1. **Read only.** Do not modify the repositories or deploy anything. Read-only commands are fine. If running tests would materially answer a question, describe the test in the spike plan instead.
2. **Cite everything.** Every claim about behavior must reference file paths and function names. Short code excerpts (under 20 lines) are fine for key mechanisms.
3. **Separate fact from inference.** Label statements **Verified** (seen in code or in-repo docs) or **Inferred** (your reasoning). Never present an inference as fact.
4. **Record versions.** Note each repository's commit hash, version or tag, license, and last commit date at the top of each report.
5. **Be honest about gaps.** Anything the code cannot answer goes in the open questions list.
6. **Write plainly.** Clear prose and tables. Avoid em dashes.
7. **Three reports only.** Sub-agents write working notes to `research/tokenbound/notes/`, but the deliverables are the three files in Part 6.
