# chains/monad

Monad contracts, Foundry project, deployment scripts and the Monad chain adapter.

- `foundry.toml`: Foundry config. `network = "monad"` makes forge use the Monad EVM; without it, forking chain 143 fails. Dependencies install with Soldeer into `dependencies/` (gitignored); `soldeer.lock` pins them.
- `fork.json`: the pinned Monad mainnet fork block used by the local anvil fork and the fork tests.
- `src/AgentNFT.sol`: the agent NFT (P1-U3), on OpenZeppelin 5.7.0 from Soldeer. `src/interfaces/IExternal.sol` holds the minimal interfaces to the ERC-6551 registry, Tokenbound accounts and Pyth Entropy.
- `script/DeployAgentNFT.s.sol`: deterministic CREATE2 deployment with a state assertion; run it through `pnpm deploy:agent-nft` from the repository root, never directly.
- `test/`: unit, fuzz, invariant and reveal attack tests on mocks (`test/mocks/`); `test/fork/AgentNFTFork.t.sol` runs against the real registry, Tokenbound account and Entropy.
- `test/fork/`: tests that run against the local anvil fork. Run them with `pnpm test:fork` from the repository root after `pnpm dev:up`. Forge does not read the root `.env`, so a bare `forge test` skips them; they never run in CI.

```sh
forge soldeer install   # restore dependencies from soldeer.lock
forge build
forge test --no-match-path 'test/fork/**'   # non-fork tests, as CI runs them
```
