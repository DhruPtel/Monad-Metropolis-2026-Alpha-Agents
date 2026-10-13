# scripts

The root scripts behind the `pnpm` commands in the root `package.json`: dev stacks, deploys, checks and asset builds. Each one is run with `node scripts/<name>` through its `pnpm` script.

## What is here

- Stacks, dev: `dev.js` (`pnpm dev:up`, `dev:status`, `dev:down`, `dev:reset`), `anvil-runner.js` (the supervised fork), `dev-all.js`, `web.js`, `console.js`, `db.js`, `doctor.js`, `allowlist.js`, `allow-depositor.js`.
- Stacks, testnet: `testnet-stack.js` (`pnpm testnet:up`, `testnet:down`, `testnet:to-local`, `testnet:propose`), `testnet-depositors.js`, `testnet-gas.js`, `testnet-e2e.js`, `testnet-measure.js`, `rpc-probe.js`.
- Stacks, host: `host-tunnel.js` (`pnpm host:up`, `host:down`, `host:status`) and `host-vercel.js`.
- Stacks, base: `base-fork.js`, `base-deploy.js`, `base-stack.js` and `base-demo.js` (`pnpm base:*`).
- Deploys and verification: `deploy-agent-nft.js`, `deploy-account-factory.js`, `deploy-fund.js`, `deploy-executor-v3.js`, `deploy-attestor.js`, `deploy-testnet.js`, `deploy-testnet-v3.js`, `verify-testnet.js`, `verify-testnet-v3.js`; local fork tryouts `agent-nft-local.js`, `custody-local.js`, `custody-v3-demo.js`, `fund-demo.js`, `oracle-local.js`, `executor-local.js`, `signer-local.js`; and `write-local-feed.js`, `write-screen-tokens.js`.
- Canary: `deploy-canary.js`, `deploy-canary-v3.js`, `verify-canary.js`, `verify-canary-v3.js`, `canary-mainnet.js`, `canary-mainnet-v3.js`, `canary-local-only.js`, `test-canary-fork.js`.
- Assets: `assets/` (`build-bee-model.ts`, `build-images.ts`, `build-models.ts`, `check-models.ts` and their helpers), run by `pnpm assets:*`.
- Checks and gates: `test-fork.js`, `test-testnet-fork.js`, `testnet-local-only.js`, `assert-state.js`, `web-e2e.js` (Playwright in the pinned image), `check-web-build.js`, `commit-gate.js` (run by `.githooks/pre-commit`), `install-hooks.js`, `secrets-scan.js`, `env-example.js`, `spend-report.js`, `live-pending.js`.
- Spikes: `spikes/p2-u0/` (`pnpm spike:venues`) and `spikes/f-u2/` (`pnpm spike:feeds`).
- `lib/`: the shared library (config, paths, deploy helpers per contract set, canary run, state asserts, address book verification, Sourcify).

## How it is used

- Run each script through its `pnpm` command; see the root `package.json` for the full list.
- A script never imports another top-level script, only modules in `scripts/lib`: a top-level script runs its code (and may send transactions) on import.
- Tests: `pnpm vitest run --project node scripts`.
