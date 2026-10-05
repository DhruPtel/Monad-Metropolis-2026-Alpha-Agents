# P1-U3 AgentNFT gas report

Measured on 2026-10-04 on the local fork of Monad mainnet (pinned block 109670000), with forge 1.8.3 using the Monad EVM (`network = "monad"`) and the real ERC-6551 registry, Tokenbound v3 account and Pyth Entropy.

Sources:
- `forge test --match-path test/fork/AgentNFTFork.t.sol --gas-report` (gas inside the call, without the 21,000 transaction base or calldata).
- `pnpm agent-nft:local mint` and `reveal` (whole-transaction `gasUsed` from the anvil receipt).

| Action | Gas | Notes |
|---|---|---|
| `mintWithClaim` (transaction) | 334,091 | Claim check, ownership, the account created by the registry and initialized, one mint per wallet record |
| `mint` (open mode, in the call) | 221,834 to 294,597 (median 294,597) | The low end is a mint whose account was already created and initialized by someone else |
| `requestReveal` (in the call) | 170,419 to 177,753 | Constant whatever the batch size; also pays the Entropy fee of 1.4 MON |
| `_entropyCallback` (in the call) | 53,853 | Stores the number only; the provider's default callback gas limit is 1,000,000 |
| `reveal`, 1 agent (transaction) | 58,733 | |
| `reveal`, 49 agents (in the call) | 1,002,020 | About 20,000 per agent after the first |
| Deployment size | 38,634 bytes of init code, 32,759 bytes of runtime code | Above Ethereum's 24,576-byte limit, within Monad's 128 KB limit |

What the numbers mean for the reveal: one Entropy request covers a whole batch, so the per-agent reveal cost is the deck draw and one storage write. A platform keeper revealing in chunks of 100 spends about 2,000,000 gas per chunk.

Monad bills the gas limit of a transaction, not the gas used, so the platform's reveal keeper and the mint page should set limits close to these numbers rather than a large fixed margin.
