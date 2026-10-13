# @alpha-agents/signer

The transaction signer. Every platform transaction (an Executor swap, or a USDC refund or credit settlement from an agent's funding address) moves through a Postgres outbox with fenced per-key nonces, is checked against a strict allowlist and the chain pin before a key signs it, and is reconciled into the ledger once confirmed.

## What is here

- `signer.ts`: the `Signer` (outbox, nonces, broadcast, unknown-outcome resolution) and `withKeyLock`.
- `policy.ts`: what the signer will sign, the per-environment `CHAIN_PINS` and the gas caps.
- `keys.ts`: the key interface with `LocalKeyProvider` and `CanaryKeyProvider`; no method ever returns key material.
- `kms.ts`: `KmsKeyProvider` for AWS KMS secp256k1 keys, tested against a mock that signs like KMS.
- `chain.ts`: `ViemChainClient`, reads and sends with a primary and a secondary RPC provider.
- `reconcile.ts`: `reconcileSwap` and `reconcileSwapV3`, which settle a swap only when the Executor's event and the account's balance changes agree.
- `abi.ts`: the Executor (v2 and v3) and ERC-20 surfaces the signer touches.
- `dev.ts` (also `@alpha-agents/signer/dev`): `buildTestSwap` and limit-breaking variants for the local fork.
- `fake-chain.ts` (exported as `@alpha-agents/signer/testing`): `FakeChain`, a test chain that can time out, refuse, lose or delay a broadcast.

## How it is used

- Imported by `services/orchestrator`, `apps/console` and the canary scripts (`scripts/lib/canary-run.js`, `pnpm canary:mainnet`).
- `pnpm signer:local` runs the signer's flow step by step on a fork of its own.
- Tests: `pnpm vitest run --project node packages/signer`; the fork test runs with `pnpm vitest run --project forks packages/signer`.
