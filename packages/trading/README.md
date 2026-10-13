# @alpha-agents/trading

The trade flow's shared rules and records: arming and how it ends, intent approval and its states, goals, plans, proposals, snapshots, the portfolio and vault views, and why an agent did not trade. The control API and the orchestrator both read and write through it, so the rules exist once.

## What is here

- `arming.ts`, `actions.ts`: session grant arming rules and the owner's wallet calls (register, revoke, confirm arming).
- `store.ts`: `TradeStore`, the arming rows and the intents' moves through approval, submission, confirmation and reconciliation.
- `goals.ts`, `plans.ts`, `proposals.ts`, `decisions.ts`: `GoalStore`, the plan store, `ProposalStore` and the template runner's `DecisionStore`.
- `activation.ts`: the checks and steps of the activation sweep when the owner turns on automatic trading.
- `portfolio.ts`, `portfolio-v3.ts`, `holdings.ts`, `vault-v3.ts`: chain readers and JSON views of the owner's account, holdings and StrategyVaultV3.
- `snapshots.ts`, `window.ts`: `SnapshotStore` (value snapshots over time) and the portfolio window's performance rules.
- `chain.ts`: fresh RPC reads that arming depends on (owner, epochs, grant).
- `sealed.ts`, `owner-keys.ts`: `sealSecret` and `openSecret` (AES-256-GCM at rest) and `OwnerKeyStore` for an owner's own data source keys.
- `json.ts`: JSON shapes for intents and arming.

## How it is used

- Imported by `apps/control-api` and `services/orchestrator`.
- Tests: `pnpm vitest run --project node packages/trading` (store tests need the local Postgres from `pnpm dev:up` and skip without it).
