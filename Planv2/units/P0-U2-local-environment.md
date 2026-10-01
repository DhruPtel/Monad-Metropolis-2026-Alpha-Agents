UNIT: P0-U2 Local environment

GOAL
One command starts the full local development environment: a Monad mainnet fork, Postgres, and Redis, with health checks proving each works. Every later unit builds and tests against this.

READ FIRST
CLAUDE.md, LESSONS.md, Planv2/BUILD_PLAN.md (build rules, P0-U2, and any items in the "Lessons from Alpha Markets" section that apply to local environment or fork setup), and the parts of Planv2/FINAL_PLAN.md covering the local environment, chain IDs, and the fork.

DEPENDS ON
P0-U1.

IN SCOPE
1. Foundry project in chains/monad: foundry.toml, src/, test/, script/. Install forge-std using the method that does not leave nested git repositories in our repo (prefer Soldeer, Foundry's built-in package manager). Record the choice in DECISIONS_AND_OPEN_QUESTIONS.md. No other contract libraries yet.
2. Fork setup. The Monad RPC URL comes only from the MONAD_RPC_URL environment variable, loaded from the root .env file. Pick a recent Monad mainnet block, pin it in a committed config file (the block number is not secret), and start anvil forked at that block. Note: the RPC is not archive-capable, so use a recent block, and rely on Foundry's fork cache for repeat runs. Document how to re-pin to a newer block if the pinned one becomes unavailable.
3. Fork smoke test in chains/monad/test/fork/: confirm the fork reports chain ID 143, the block number equals the pinned block, and the canonical ERC-6551 registry at 0x000000006551c19487814612e58FE06813775758 has deployed code. Fork tests are skipped cleanly when MONAD_RPC_URL is not set.
4. Docker Compose file in infra/ for Postgres 16 and Redis 7: named volumes, health checks, ports bound to 127.0.0.1 only, and development-only credentials with safe defaults.
5. Root scripts:
   - pnpm doctor: checks Node, pnpm, forge, anvil, docker, and that Docker is reachable and MONAD_RPC_URL is set. Never print the URL or any secret value.
   - pnpm dev:up: starts Postgres, Redis, and the anvil fork.
   - pnpm dev:status: reports health for each (Postgres accepting connections, Redis responding, anvil chain ID and block number).
   - pnpm dev:down: stops everything.
   - pnpm dev:reset: stops everything and wipes local database volumes, after a confirmation prompt.
6. .env.example at the root listing only the variables this unit uses, with placeholder values. P0-U3 expands it later.
7. CI: add a Foundry job to .github/workflows/ci.yml using the same Foundry version as local, running forge build and non-fork tests. Fork tests do not run in CI.
8. README: add a "Local environment" section with the commands above and the prerequisites (Docker Desktop running, Foundry on PATH, MONAD_RPC_URL in .env).

OUT OF SCOPE
Any contracts beyond the smoke test, OpenZeppelin or other libraries, database schemas or migrations, the indexer, secrets management beyond MONAD_RPC_URL (P0-U3), shared domain packages (P0-U5), the dev console (P0-U4), and any mainnet transaction.

DELIVERABLES
Foundry project with the fork smoke test, pinned fork config, Docker Compose file, the five root scripts, .env.example, updated CI, updated README, and a DECISIONS entry for the dependency method.

ACCEPTANCE TESTS
- pnpm doctor passes and prints no secrets.
- pnpm dev:up starts all three services, and pnpm dev:status shows each healthy, with anvil reporting chain ID 143 at the pinned block.
- The fork smoke test passes locally against the running fork.
- pnpm dev:down stops everything; pnpm dev:reset wipes volumes after confirming.
- All P0-U1 checks still pass (lint, format:check, typecheck, test), and forge build passes.
- The CI workflow includes the Foundry job without requiring any secret.
- Postgres and Redis ports are bound to 127.0.0.1 only.
- git status is clean, .env is not committed, and no secret appears in any committed file or log output.
- Record the exact Foundry version and pinned fork block in the LOGS.md entry.

HOW THE OWNER TESTS IT
1. Open Docker Desktop.
2. Run pnpm doctor, then pnpm dev:up, then pnpm dev:status.
3. Run the fork smoke test with the command given in the README.
4. Run pnpm dev:down.
5. After pushing, confirm both CI jobs pass in the Actions tab.

COMMITS
Commit incrementally as each part works, for example:
- chore(contracts): add Foundry project and forge-std [P0-U2]
- test(contracts): add Monad fork smoke test [P0-U2]
- chore(infra): add Docker Compose for Postgres and Redis [P0-U2]
- chore(infra): add doctor and dev environment scripts [P0-U2]
- chore(infra): add Foundry job to CI [P0-U2]
- docs: add local environment setup to README [P0-U2]

WHEN DONE
Add a LOGS.md entry, and add a LESSONS.md entry for every bug fixed. Commit them. Then post the handoff message described in CLAUDE.md. Do not push.
