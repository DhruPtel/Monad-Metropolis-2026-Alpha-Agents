# Brief excerpt given to every sub-agent (Parts 1 and 2, verbatim in substance)

## Part 1: Our product and what is already decided

We are building an onchain financial management platform on **Monad**. Anything specific to Hyperliquid (HyperCore, CoreWriter, precompiles) will not transfer directly. What we want is vault and permission design.

**Agents are NFTs.** Each agent is an NFT with an ERC-6551 token-bound account that holds only skills and identity. The agent's owner is the manager of any vault the agent runs.

**Three separate capital accounts:** PersonalAccount (owner's own money), StrategyVault (other users deposit, the agent manages), and an operating wallet (gas, AI credits, x402 payments, never funded from vault assets).

**Our Executor (decided after Zodiac Roles research).** We build our own Executor rather than using a generic permission module. A platform session key calls it with typed intents (for example, "swap X USDC for wrapped MON on Uniswap"). It enforces: max 10% of vault value per trade, max 40% in any non-USDC asset, at least 10% in USDC, max 0.5% slippage, exact approvals reset after each swap, a rolling limit of 20 trades per 24 hours, 2-minute deadlines, oracle freshness and deviation checks, a circuit breaker, and ownership and configuration epochs. We chose typed intents over arbitrary calldata because generic permission systems could not express percentage limits, oracle checks, or epochs.

**StrategyVault design (decided after Morpho Vault V2 research):**
- Our own vault borrowing Morpho's patterns, not a fork.
- Managers steer funds but never take them. Risky changes wait behind timelocks longer than the maximum lockup, and an emergency role can only reduce risk.
- Valuation computed once per transaction, with virtual shares and rounding in the vault's favor.
- Limits checked only on buys, never on exits.
- Normal withdrawals pay USDC while the vault stays above its 10% USDC floor; otherwise the withdrawer's share of each token is sold through allowlisted pools with an oracle-based minimum and a user minimum. If a pool or oracle fails, the call reverts.
- **Offline exit:** `redeemInKind` gives the user their share of every token with no oracle, DEX, Executor, or platform needed, and nothing can pause it. This is a non-negotiable rule.
- Oracle pricing risk mitigated with a buy/sell spread, freshness checks, the lockup, and in-kind exits.
- Launch assets likely USDC and wrapped MON only, because Monad liquidity is thin.

**Hyperliquid behavior we want to match:** leader keeps at least 5% of the vault, 10% performance fee, leader can trade but never withdraw depositor funds, 1-day default lockup the leader can extend, proportional position closing when free balance cannot cover a withdrawal, leader can close the vault to new deposits, and full public visibility of trades and the leader's share.

**Agent sales.** Agents are sold only through our marketplace escrow at launch. A vault whose agent is sold enters handover mode (reduce-only, depositors can exit) before the new owner can trade.

**Fees** are deferred for the first build phases, but the design must support a performance fee above a high-water mark.

## Part 2: Ground rules

1. **Read only.** Do not modify the repositories or deploy anything. (Foundry is not installed here, so do not attempt to run tests.)
2. **Cite everything.** Every behavioral claim must reference file paths and function names. Short code excerpts (under 20 lines) are fine for key mechanisms.
3. **Separate fact from inference.** Label statements **Verified** or **Inferred**.
4. **Record versions.** (Done in Phase 0; reference it.)
5. **Label portability.** For every mechanism, state whether it is **Portable** (works on any EVM chain, including Monad), **Adaptable** (the idea transfers but the implementation needs changes), or **Chain-specific**.
6. **Compare against our decisions.** Do not redesign from scratch. For each area, say whether these repositories confirm our design, improve on it, or reveal something we missed. Where they conflict with a non-negotiable rule (such as the offline exit), say so clearly.
7. **Be honest about gaps.** Anything the code cannot answer goes in open questions.
8. **Write plainly.** Clear prose and tables. Avoid em dashes.
