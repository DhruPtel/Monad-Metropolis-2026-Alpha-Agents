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
pnpm dev:status   # health of each service, and anvil's chain ID, network and block
pnpm test:fork    # fork smoke tests against the running fork
pnpm dev:down     # stop everything; database volumes are kept
pnpm dev:reset    # stop everything and delete the database volumes (asks first)
```

Use `pnpm run doctor`, not `pnpm doctor`: `doctor` is a built-in pnpm command and runs pnpm's own checks instead.

| Service  | Address                                                             |
| -------- | ------------------------------------------------------------------- |
| anvil    | `http://127.0.0.1:8545`, chain ID 143, network monad                |
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

## Environments and configuration

Every service runs in one of three environments, chosen by `APP_ENV` (default `local`):

| `APP_ENV` | Label          | Chain                | Chain RPC                      |
| --------- | -------------- | -------------------- | ------------------------------ |
| `local`   | `fork`         | anvil fork of 143    | `http://127.0.0.1:8545`, fixed |
| `testnet` | `testnet`      | Monad testnet, 10143 | `MONAD_TESTNET_RPC_URL`        |
| `beta`    | `mainnet-beta` | Monad mainnet, 143   | `MONAD_RPC_URL`                |

Configuration is loaded by `@alpha-agents/config` (`packages/config`). A service calls `loadConfig({ name, signs, requires })` at startup. The loader:

- validates every variable of the selected environment, and reads no other variable, so a local or testnet process never loads a mainnet key reference;
- fails at once with a `ConfigError` that names each missing or invalid variable and never contains a value;
- treats an empty value, or one left as its `.env.example` placeholder, as not set, which is an error for a required variable;
- wraps every secret in `Secret`, which prints as `[redacted]`; `summarizeConfig(config)` is safe to log.

**Mainnet guard.** With `APP_ENV=beta`, a service that signs transactions refuses to start unless `BETA_SIGNING_ENABLED=true` is set exactly. The flag is rejected in any other environment. Local signing always targets the loopback fork, and a testnet RPC equal to the mainnet URL is rejected. Services also call `assertChainId` with the chain ID their RPC reports before signing.

**`.env.example`** lists every variable the full build needs, grouped by service, with whether it is secret, which environments read it, and the unit that first uses it. It is generated from the registry in `packages/config/src/variables.ts`: edit the registry, then run `pnpm run env:example`. A test fails if the two drift. Copy it to `.env` and fill in only what the units you run need.

## Shared packages

Every service imports its rules from one place under `packages/`:

| Package                    | What it defines                                                                                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@alpha-agents/config`     | Environments, the config loader and the mainnet signing guard                                                                                                                      |
| `@alpha-agents/domain`     | Amounts (bigints with the scale in the type), IDs, tiers, accounts, assets, the canonical mode model, the tool registry, typed intents, reason codes, records and the address book |
| `@alpha-agents/policy`     | The launch hard limits and the offchain pre-checks; the Executor contract stays the final authority                                                                                |
| `@alpha-agents/skills`     | The skill.json manifest schema and its validator against the tool registry                                                                                                         |
| `@alpha-agents/workflows`  | The workflow spec schema and validator                                                                                                                                             |
| `@alpha-agents/accounting` | Journal, valuation and credits types                                                                                                                                               |

The address book (`packages/domain/src/address-book.ts`) lists every external contract the plan names, per environment, with its source, a status and any open question. An entry is `verified` only if it had code on the local fork at the pinned block; `pnpm test:fork` re-checks every verified entry, and `signingAddress` refuses anything unverified. The policy reason codes and their messages are in `packages/domain/src/reasons.ts`, and the limits table is in `packages/policy/README.md`.

## Web app and design system

`apps/web` is the Next.js app (App Router, React 19, Tailwind CSS 4, shadcn/ui on Radix). Every page is built only from the design system, and `/design` shows all of it.

```sh
pnpm dev:web          # http://localhost:3000, design system at /design
pnpm test:web:e2e     # build, then screenshot, accessibility and navigation tests in Docker
pnpm test:web:e2e -- --update   # rewrite the screenshot baselines after an intended change
```

- **Tokens.** Raw values (colors, type scale, spacing unit, radii, borders, shadows) live only in `apps/web/src/app/globals.css`: a palette, then semantic dark-theme tokens under `[data-theme]` (a light theme is one more block), mapped into Tailwind. Tailwind's default palette, fonts, radii, shadows and sizes are removed, so only tokens compile, and a test fails on any raw color, size or font in a component or page. Lime is for primary actions, active states and positive values only; muted red for losses and errors only; brass for detail.
- **Fonts.** Geist Sans for the interface and Geist Mono for every number, amount and address, self-hosted through next/font.
- **Components.** Base components in `src/components/ui` (Button, Card, Input and Field, Select, Slider, Tabs, Dialog, Tooltip, Toast, Skeleton, Table, EmptyState, Badge) and product components in `src/components`: StatusPill and ReasonMessage render straight from `packages/domain`, AmountDisplay and AddressDisplay use its `formatAmount` and `shortenAddress`, plus StatBar, RiskBadge, DemandCounter and BetaBanner. The app shell shows the beta banner on every page.
- **States.** Components style hover and focus through the `is-hover` and `is-focus` variants, which also match `data-force="hover"` or `"focus"`, so `/design` can show every state without a pointer.
- **Tests.** Component tests run in Vitest under jsdom (`pnpm test`). Screenshot tests of `/design` at 1440px and 380px and an axe scan run in the Playwright 1.63.0 image pinned by digest, locally and in CI, and compare pixels exactly. A new component is added to the design system and to `/design` before any page uses it.

## Secret scanning

```sh
pnpm run secrets:scan   # run before every push
```

This runs gitleaks (pinned by image digest, in Docker) over the full history of every branch and over uncommitted and staged changes. Output is redacted, and gitignored files such as `.env` are never read. CI runs the same scan. Rules are the gitleaks defaults (`.gitleaks.toml`); a verified false positive is added to `.gitleaksignore` by fingerprint, with its reason. If a real secret is ever found, rotate it first: removing it from history does not make it safe.
