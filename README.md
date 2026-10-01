# Alpha Agents

An onchain financial management platform where AI agents are NFTs.

Mint an agent, fund it, and set your goals. The agent acts as your onchain CFO: it researches opportunities, builds a portfolio around your goals, and trades within hard limits enforced by smart contracts. It never holds your keys, and you can always withdraw directly from the contract.

Agents get better by equipping skill NFTs, which add new tools, data, and knowledge. Skills appear as robotic components on the agent's 3D model, so customizing an agent feels like building a game character. Developers and protocols can publish skills to the marketplace.

Other users can watch agents, follow their trades, and deposit into public vaults run by agents that perform well. Agents can also discover each other and pay for each other's signals.

Built on Monad, with a Solana version to follow.

Status: unaudited beta. Mainnet access is limited to allowlisted testers with capped funds. Do not deposit funds you cannot afford to lose.

## Repository layout

| Folder             | Purpose                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `apps/web`         | Web frontend                                                                                                |
| `apps/control-api` | Control API and auth                                                                                        |
| `services/`        | Backend services: orchestrator, tool servers, runners, sentinel, signer, indexer                            |
| `packages/`        | Shared TypeScript packages: domain, policy, skills, workflows, accounting                                   |
| `chains/monad`     | Monad contracts, deployment scripts and chain adapter                                                       |
| `chains/solana`    | Solana version, built after the Monad chain layer                                                           |
| `infra/`           | Local environment, environment templates and deployment config                                              |
| `evidence/`        | Evidence bundle: addresses, transaction links, build hashes, test receipts                                  |
| `docs/adr/`        | Architecture decision records                                                                               |
| `Planv2/`          | The plan: `FINAL_PLAN.md`, `BUILD_PLAN.md`, `DECISIONS_AND_OPEN_QUESTIONS.md`, and unit prompts in `units/` |

Build progress is recorded in `LOGS.md` and bugs fixed in `LESSONS.md`.

## Development

Requires Node 22 (see `.nvmrc`) and pnpm 9.

```sh
pnpm install        # install dependencies
pnpm lint           # ESLint
pnpm format:check   # Prettier check (pnpm format to fix)
pnpm typecheck      # TypeScript, strict mode
pnpm test           # Vitest
```

CI runs the same four checks on every push and pull request to `main`.

## Local environment

One command starts a Monad mainnet fork (anvil), Postgres 16 and Redis 7 for development.

Prerequisites:

- Docker Desktop running, and reachable by your user (`docker info` works without `sudo`).
- Foundry on your `PATH`, at the version in `.foundry-version` (`foundryup --install v1.8.3`, then add `~/.foundry/bin` to `PATH`).
- A `.env` file at the repository root with `MONAD_RPC_URL` set: `cp .env.example .env`, then edit it. `.env` is gitignored.

```sh
pnpm run doctor   # check prerequisites; never prints the RPC URL
pnpm dev:up       # start Postgres, Redis and the anvil fork
pnpm dev:status   # health of each service, and anvil's chain ID and block
pnpm test:fork    # fork smoke tests against the running fork
pnpm dev:down     # stop everything; database volumes are kept
pnpm dev:reset    # stop everything and delete the database volumes (asks first)
```

Use `pnpm run doctor`, not `pnpm doctor`: `doctor` is a built-in pnpm command and runs pnpm's own checks instead.

| Service  | Address                                                             |
| -------- | ------------------------------------------------------------------- |
| anvil    | `http://127.0.0.1:8545`, chain ID 143                               |
| Postgres | `postgres://alpha:alpha_local_dev_only@127.0.0.1:5432/alpha_agents` |
| Redis    | `redis://127.0.0.1:6380`                                            |

Ports bind to 127.0.0.1 only. The Postgres credentials are for local development only. Postgres and Redis ports can be changed with `POSTGRES_PORT` and `REDIS_PORT` in `.env`; Redis defaults to 6380 because a system Redis often holds 6379. anvil writes its log, with the RPC URL redacted, to `.dev/anvil.log`.

### The pinned fork block

The fork starts at the block in `chains/monad/fork.json`, so every run sees the same chain state. The RPC is not archive-capable and stops serving old state after a while; Foundry caches the state it has fetched in `~/.foundry/cache`, so repeat runs keep working for whatever was already fetched. When `pnpm run doctor` fails on "RPC serves pinned block", re-pin:

1. `pnpm dev:down`.
2. Run `pnpm run doctor` and note the "RPC latest block" number.
3. Set `blockNumber` in `chains/monad/fork.json` to that number, rounded down a little.
4. `pnpm run doctor`, then `pnpm dev:up` and `pnpm test:fork`.
5. Commit the new `fork.json` and record the new block in `LOGS.md`.
