# chains/base

The pin for the local Base mainnet fork. This folder holds no contracts of its own: the Base fork runs the same contracts as Monad, built and tested from `chains/monad`.

## What is here

- `fork.json`: the fork pin, `chainId` 8453 (Base mainnet) and the `blockNumber` the fork starts from.

## How it is used

- `scripts/lib/paths.js` names this file as `BASE_FORK_CONFIG_PATH`, and `scripts/lib/config.js` reads it.
- `pnpm base:fork:up` starts anvil as a fork of Base at this block (answering its own local chain id, not 8453), and `pnpm base:fork:down` stops it.
- `pnpm base:deploy`, `pnpm base:up`, `pnpm base:down` and `pnpm base:demo` deploy the contracts to that fork and run the Base stack on it.
- The Base fork's foundry profile is `[profile.base]` in `chains/monad/foundry.toml`. `pnpm test:base-fork` runs the forge tests in `chains/monad/test/base` under that profile.
