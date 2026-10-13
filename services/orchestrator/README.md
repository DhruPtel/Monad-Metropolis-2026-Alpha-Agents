# @alpha-agents/orchestrator

The agent orchestrator: it provisions agent runtimes and sandbox leases, hosts the tool servers and the model gate, runs research cycles, the trade flow, the reveal keeper and the Risk Sentinel, and serves an internal API on loopback for the dev console and the control API.

## What is here

- `src/main.ts`: the entry point. It loads config, migrates the database, wires the reveal keeper, the `SignerWorker`, credits, market data, the token registry and the attestor, starts the `Orchestrator`, and serves the API on 127.0.0.1.
- `src/orchestrator.ts`: the `Orchestrator`. Its `start()` runs the startup sweep, starts the tool servers (`src/tools/servers.ts`) and the job queue, and starts the background loops: reconcile, lease reaper, credits, requested scans, sentinel, research scheduler, watcher, intent expiry, value snapshots, trade flow, template runner, local feeds, token discovery and token screens. `main.ts` adds the registrar's pass every five minutes.
- HTTP routes: `src/api.ts` (`createApi`, the core routes) mounts `plan-routes.ts`, `token-routes.ts`, `cycle-routes.ts`, `research-routes.ts` and `sentinel-routes.ts`.
- `src/cycle/`: research cycle stages, plan rules, proposals, rationale, replay and the report. `src/research-*.ts` hold the research loop and discovery.
- `src/tokens/`: the token registry, screens, buyability and the onchain `Registrar`.
- `src/credits/`: funding addresses, ledger and refunds. `src/tools/`: tool server hosting, metering, identity and the registry check.
- `src/hermes/`: the agent runtime's layered config. `src/spike/` and `spike-skills/`: the Hermes spike driver and its test skill.
- Other modules: `gate.ts`, `leases.ts`, `provisioner.ts`, `sandbox.ts`, `keeper.ts`, `sentinel.ts`, `runner.ts`, `trade-flow.ts`, `attestor.ts`, `snapshots.ts`, `narrator.ts`.

## How it is used

- `pnpm dev:orchestrator` runs `src/main.ts`; the dev stacks in `scripts/` start it too.
- Live checks (they spend model credit): `pnpm test:orchestrator:live`, `pnpm test:activation:live`, `pnpm test:vault:live`, `pnpm test:skill:live`; also `pnpm test:anthropic:dry-run`, `pnpm test:skills:selection` and `pnpm registry:check`.
- Tests: `pnpm vitest run --project node services/orchestrator`; the fork tests run with `pnpm vitest run --project forks services/orchestrator`.
