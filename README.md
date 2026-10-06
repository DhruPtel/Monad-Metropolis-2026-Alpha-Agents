# Alpha Agents

An onchain financial management platform where AI agents are NFTs.

Mint an agent, fund it, and set your goals. The agent acts as your onchain CFO: it researches opportunities, builds a portfolio around your goals, and trades within hard limits enforced by smart contracts. It never holds your keys, and you can always withdraw directly from the contract.

Agents get better by equipping skill NFTs, which add new tools, data, and knowledge. Skills appear as robotic components on the agent's 3D model, so customizing an agent feels like building a game character. Developers and protocols can publish skills to the marketplace.

Other users can watch agents, follow their trades, and deposit into public vaults run by agents that perform well. Agents can also discover each other and pay for each other's signals.

Built on Monad, with a Solana version to follow.

Status: unaudited beta. Mainnet access is limited to allowlisted testers with capped funds. Do not deposit funds you cannot afford to lose.

## Repository layout

| Folder             | Purpose                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`         | Web frontend                                                                                                                                      |
| `apps/control-api` | Control API and auth                                                                                                                              |
| `services/`        | Backend services: orchestrator, tool servers, runners, sentinel, signer, indexer                                                                  |
| `packages/`        | Shared TypeScript packages: domain, policy, skills, workflows, accounting                                                                         |
| `chains/monad`     | Monad contracts, deployment scripts and chain adapter                                                                                             |
| `chains/solana`    | Solana version, built after the Monad chain layer                                                                                                 |
| `infra/`           | Local environment, environment templates and deployment config                                                                                    |
| `evidence/`        | Evidence bundle: addresses, transaction links, build hashes, test receipts                                                                        |
| `docs/adr/`        | Architecture decision records                                                                                                                     |
| `Planv2/`          | The plan: `FINAL_PLAN.md`, `BUILD_PLAN.md`, `DECISIONS_AND_OPEN_QUESTIONS.md`; prompts of units before P0-U4 in `units/` (later units: `LOGS.md`) |

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
pnpm dev:all      # everything: the stack, LiteLLM, indexer, API, orchestrator, web and console
pnpm dev:up       # start Postgres, Redis and the anvil fork only
pnpm dev:status   # health of each service, and anvil's chain ID, network and block
pnpm test:fork    # fork tests and the address book check, on a fork of their own on 8546
pnpm dev:down     # stop everything dev:all started, anvil and every container; volumes are kept
pnpm dev:reset    # stop everything and delete the database volumes (asks first)
```

`pnpm dev:all` runs every service in one terminal, each output line labeled with its service (indexer, api, orchestrator, web, console) and also written to `.dev/dev-all.log`. It refuses to start while a heavy suite (Playwright, a production build) is running or when less than 2 GiB of memory is available; `--force` overrides both. Ctrl-C stops the services and leaves the stack running; `pnpm dev:down`, from any terminal, stops the services by PID, then anvil and the containers, LiteLLM included (D-211). anvil keeps its state in memory only, so `pnpm dev:down` loses everything on the fork: deployments, mints and balances. Redeploy with `pnpm deploy:agent-nft` after the next `pnpm dev:up`.

Use `pnpm run doctor`, not `pnpm doctor`: `doctor` is a built-in pnpm command and runs pnpm's own checks instead.

| Service  | Address                                                             |
| -------- | ------------------------------------------------------------------- |
| anvil    | `http://127.0.0.1:8545`, chain ID 143143, network monad             |
| Postgres | `postgres://alpha:alpha_local_dev_only@127.0.0.1:5432/alpha_agents` |
| Redis    | `redis://127.0.0.1:6380`                                            |

Ports bind to 127.0.0.1 only. The Postgres credentials are for local development only. Postgres and Redis ports can be changed with `POSTGRES_PORT` and `REDIS_PORT` in `.env`; Redis defaults to 6380 because a system Redis often holds 6379. anvil writes its log, with the RPC URL redacted, to `.dev/anvil.log`.

Tests that reset a chain or need a fresh deck (`pnpm test:fork`, the fork controls test, the indexer's and keeper's fork tests, `pnpm test:web:live` and `pnpm test:orchestrator:live`) start their own anvil fork on another port (8546; 8548 for the indexer test, 8549 for the keeper test, 8550 for the orchestrator live check) and stop it afterwards, so the playtest fork on 8545 is never reset (D-200). Their logs, with the RPC URL redacted, go to `.dev/test-fork-<port>.log`.

### The pinned fork block

The fork starts at the block in `chains/monad/fork.json`, so every run sees the same chain state. The RPC is not archive-capable and stops serving old state after a while; Foundry caches the state it has fetched in `~/.foundry/cache`, so repeat runs keep working for whatever was already fetched. When `pnpm run doctor` fails on "RPC serves pinned block", re-pin:

1. `pnpm dev:down`.
2. Run `pnpm run doctor` and note the "RPC latest block" number.
3. Set `blockNumber` in `chains/monad/fork.json` to that number, rounded down a little.
4. `pnpm run doctor`, then `pnpm dev:up` and `pnpm test:fork`.
5. Commit the new `fork.json` and record the new block in `LOGS.md`.

## Environments and configuration

Every service runs in one of three environments, chosen by `APP_ENV` (default `local`):

| `APP_ENV` | Label          | Chain                        | Chain RPC                      |
| --------- | -------------- | ---------------------------- | ------------------------------ |
| `local`   | `fork`         | anvil fork of 143, as 143143 | `http://127.0.0.1:8545`, fixed |
| `testnet` | `testnet`      | Monad testnet, 10143         | `MONAD_TESTNET_RPC_URL`        |
| `beta`    | `mainnet-beta` | Monad mainnet, 143           | `MONAD_RPC_URL`                |

The local fork copies Monad mainnet's state at the pinned block and runs Monad's EVM (`--network monad`, hardfork MonadTen), but answers its own chain ID, **143143**, so no wallet can mistake Monad mainnet for it (D-195, L-53). `chains/monad/fork.json`'s `chainId` is the chain it copies, 143.

Configuration is loaded by `@alpha-agents/config` (`packages/config`). A service calls `loadConfig({ name, signs, requires })` at startup. The loader:

- validates every variable of the selected environment, and reads no other variable, so a local or testnet process never loads a mainnet key reference;
- fails at once with a `ConfigError` that names each missing or invalid variable and never contains a value;
- treats an empty value, or one left as its `.env.example` placeholder, as not set, which is an error for a required variable;
- wraps every secret in `Secret`, which prints as `[redacted]`; `summarizeConfig(config)` is safe to log.

**Mainnet guard.** With `APP_ENV=beta`, a service that signs transactions refuses to start unless `BETA_SIGNING_ENABLED=true` is set exactly. The flag is rejected in any other environment. Local signing always targets the loopback fork, and a testnet RPC equal to the mainnet URL is rejected. Services also call `assertChainId` with the chain ID their RPC reports before signing.

**`.env.example`** lists every variable the full build needs, grouped by service, with whether it is secret, which environments read it, and the unit that first uses it. It is generated from the registry in `packages/config/src/variables.ts`: edit the registry, then run `pnpm run env:example`. A test fails if the two drift. Copy it to `.env` and fill in only what the units you run need.

## Shared packages

Every service imports its rules from one place under `packages/`:

| Package                     | What it defines                                                                                                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@alpha-agents/config`      | Environments, the config loader and the mainnet signing guard                                                                                                                                                              |
| `@alpha-agents/domain`      | Amounts (bigints with the scale in the type), IDs, tiers, species, accounts, assets, the canonical mode model, the tool registry, typed intents, reason codes, records, token-bound account addresses and the address book |
| `@alpha-agents/policy`      | The launch hard limits and the offchain pre-checks; the Executor contract stays the final authority                                                                                                                        |
| `@alpha-agents/skills`      | The skill.json manifest schema and its validator against the tool registry                                                                                                                                                 |
| `@alpha-agents/workflows`   | The workflow spec schema and validator                                                                                                                                                                                     |
| `@alpha-agents/accounting`  | Journal, valuation and credits types                                                                                                                                                                                       |
| `@alpha-agents/tool-server` | The tool servers' shared conventions: identity from the injected token, typed errors, the identity field lint                                                                                                              |

The address book (`packages/domain/src/address-book.ts`) lists every external contract the plan names, and every contract we deploy, per environment, with its source, a status and any open question. An external entry is `verified` only if it had code on the local fork at the pinned block. Our own contracts are verified only for `local`, at their deterministic fork address: `pnpm test:fork` starts a fork of its own on port 8546, deploys them there and checks them. `signingAddress` refuses anything unverified. The policy reason codes and their messages are in `packages/domain/src/reasons.ts`, and the limits table is in `packages/policy/README.md`.

## AgentNFT (P1-U3)

`chains/monad/src/AgentNFT.sol` is the agent NFT: 1,000 agents across 25 species, a free two-step mint (mint, then a reveal from Pyth Entropy), one mint per wallet behind a signed claim, a Tokenbound account per agent, ownership epochs, escrow-only transfers, onchain metadata and 5% royalties. The randomness research is `evidence/p1-u3/RANDOMNESS.md` and the gas report `evidence/p1-u3/GAS.md`.

```sh
pnpm deploy:agent-nft           # deploy to the local fork (deterministic; a second run finds it)
pnpm deploy:agent-nft testnet   # Monad testnet, with MONAD_TESTNET_RPC_URL and TESTNET_DEPLOYER_PRIVATE_KEY in .env
pnpm agent-nft:local mint       # mint with a claim signed by the local signer, from a fresh wallet
pnpm agent-nft:local reveal     # request a reveal, deliver a number as Entropy, apply it
pnpm agent-nft:local show 1     # print agent 1 and its decoded tokenURI
```

Locally, anvil account 0 is the admin, account 1 the claim signer and account 2 the treasury. Entropy's keeper does not serve the fork, so the helper delivers the random number by impersonating the Entropy contract; the request itself goes to the real Entropy contract.

## Web app and design system

`apps/web` is the Next.js app (App Router, React 19, Tailwind CSS 4, shadcn/ui on Radix). Every page is built only from the design system, and `/design` shows all of it.

```sh
pnpm dev:web          # http://localhost:3000, design system at /design
pnpm test:web:e2e     # build, then screenshot, accessibility and navigation tests in Docker
pnpm test:web:e2e -- --update   # rewrite the screenshot baselines after an intended change
```

- **Tokens.** Raw values (colors, type scale, spacing unit, radii, borders, shadows) live only in `packages/ui/src/styles.css`: a palette, then semantic dark-theme tokens under `[data-theme]` (a light theme is one more block), mapped into Tailwind. Tailwind's default palette, fonts, radii, shadows and sizes are removed, so only tokens compile, and a test fails on any raw color, size or font in a component or page. Lime is for primary actions, active states and positive values only; muted red for losses and errors only; brass for detail.
- **Fonts.** Geist Sans for the interface and Geist Mono for every number, amount and address, self-hosted through next/font.
- **Components.** Base components in `packages/ui/src/components/ui` (Button, Card, Input and Field, Select, Slider, Tabs, Dialog, Tooltip, Toast, Skeleton, Table, EmptyState, Badge) and product components in `packages/ui/src/components`: StatusPill and ReasonMessage render straight from `packages/domain`, AmountDisplay and AddressDisplay use its `formatAmount` and `shortenAddress`, plus StatBar, RiskBadge, DemandCounter and BetaBanner. The app shell shows the beta banner on every page.
- **States.** Components style hover and focus through the `is-hover` and `is-focus` variants, which also match `data-force="hover"` or `"focus"`, so `/design` can show every state without a pointer.
- **Tests.** Component tests run in Vitest under jsdom (`pnpm test`). Screenshot tests of `/design` at 1440px and 380px and an axe scan run in the Playwright 1.63.0 image pinned by digest, locally and in CI, and compare pixels exactly. A new component is added to the design system and to `/design` before any page uses it.

### Wallet on the local fork (MetaMask)

Use http://localhost:3000 (not 127.0.0.1; Privy is allowed on localhost only), and give MetaMask a network of its own for the fork:

| Field              | Value                   |
| ------------------ | ----------------------- |
| Network name       | `Monad (local fork)`    |
| Default RPC URL    | `http://127.0.0.1:8545` |
| Chain ID           | `143143`                |
| Currency symbol    | `MON`                   |
| Block explorer URL | leave empty             |

1. `pnpm dev:up`, then `pnpm deploy:agent-nft` (it prints `AgentNFT on the local fork: 0x60cacA6dE327331b321E140Ae19AcbCc4188Be6E`). A fork started before D-195 answers 143: `pnpm run doctor` says so, and `pnpm dev:down` then `pnpm dev:up` restarts it.
2. In MetaMask, add the network above by hand (Settings, Networks, Add network, Add a network manually), and select it.
3. Fund your address on the fork: `cast rpc anvil_setBalance <your address> 0x56BC75E2D63100000 --rpc-url http://127.0.0.1:8545` (100 MON, fork only).
4. Start the indexer and the control API (see "Indexer and control API" below), and put your address on the mint allowlist: `pnpm allowlist add <your address>`.
5. `pnpm dev:web`, open http://localhost:3000/mint, connect, and mint, then follow the link to your agent on /configure. With `pnpm dev:orchestrator` running, the reveal keeper reveals it within about 15 seconds. A wallet off the allowlist is told so before it can click. Before a claim is requested, the app checks through MetaMask the wallet's chain ID, the pinned block's hash and AgentNFT's code, and stops with the failed check named if one differs.

Do not point MetaMask's Monad (chain 143) network at `http://127.0.0.1:8545`: keep it on Monad's official RPC. On chain 143, a mint went to Monad mainnet through MetaMask's gasless relay, which MetaMask offered because the account had no MON there; the relay runs on MetaMask's servers for chain 143, not through the RPC set in the wallet (L-53).

## Indexer and control API (P1-U4)

The indexer (`services/indexer`) polls the chain's logs into Postgres: every AgentNFT event, the agents projection, and USDC transfers into and out of agents' token-bound accounts, each with its block number and hash, behind a watermark that also holds the last block's hash. A reorg or a rewound fork is detected, rolled back to the newest block the chain still has, and recorded in `indexer.incidents` (D-197). The control API (`apps/control-api`, Hono) serves agents and supply from that index, owner sessions bound to the wallet and ownership epoch, mint eligibility, and the mint claim, signed with `CLAIM_SIGNER_PRIVATE_KEY` for a linked wallet on the allowlist that has not minted (D-198).

```sh
pnpm db:migrate                 # apply migrations (the indexer and API also do this at start)
pnpm dev:indexer                # index the local fork; --once to catch up and exit
pnpm dev:api                    # the control API on http://127.0.0.1:4100
pnpm allowlist add <address> [note]   # put a wallet on the mint allowlist
pnpm allowlist remove <address>
pnpm allowlist list
pnpm db:reset                   # local only: drop and re-create the indexer and platform schemas
```

The API needs `CLAIM_SIGNER_PRIVATE_KEY` in `.env` to sign claims: on the local fork it is anvil account 1, AgentNFT's local claim signer (it was named `LOCAL_CLAIM_SIGNER_PRIVATE_KEY` before P1-U4; rename the line). It moves to a KMS signer before the beta. With `PRIVY_APP_ID` and `PRIVY_APP_SECRET` set, the API verifies Privy logins; `API_SESSION_SECRET` has a local default and must be set to a random value anywhere else.

| Route                                 | What it answers                                                    |
| ------------------------------------- | ------------------------------------------------------------------ |
| `GET /health`                         | environment, AgentNFT and the index watermark                      |
| `GET /v1/supply`                      | minted count and remaining slots per species, from the index       |
| `GET /v1/agents?owner=` or `?minter=` | agents from the index                                              |
| `GET /v1/agents/:id`                  | one agent                                                          |
| `GET /v1/session`                     | the Privy user and their linked wallets                            |
| `POST /v1/agents/:id/session`         | an owner session for the agent's current owner and ownership epoch |
| `GET /v1/agents/:id/owner`            | the owner-only view, rechecked against the chain on every call     |
| `GET /v1/mint/eligibility?wallet=`    | eligible, or why not: not allowlisted, already minted, sold out    |
| `POST /v1/mint/claim`                 | the signed EIP-712 mint claim, or the reason it is refused         |

`pnpm test:web:live` starts its own stack: a fork on 8546, a throwaway database, the indexer and the API on 4101, and the web test build pointed at them.

## Orchestrator and reveal keeper (P1-U5)

The orchestrator (`services/orchestrator`) sets up every revealed agent to run and runs the AgentNFT reveal keeper. It reconciles the indexer's agents with its own records every second: a revealed agent is provisioned (its Hermes config rendered from the base template, its tier's overlay and its own overrides, then a LiteLLM virtual key with a starting budget, all recorded in `platform.agent_runtimes`), and an agent a reorg removed is deprovisioned (its key deleted). Work goes through a Redis queue with deterministic job IDs, and each agent's provisioning runs under a Postgres lock, so a repeated event never provisions twice (D-202). The keeper waits 10 seconds after it first sees an unrevealed agent (60 seconds on testnet and beta) so mints share one Entropy request, then reveals them; on the local fork it delivers the random number as Entropy itself (D-201).

```sh
pnpm dev:litellm                # the LiteLLM gateway (compose profile agent), once
pnpm dev:orchestrator           # provisioning, the keeper, leases and the internal API on 127.0.0.1:4200
pnpm test:orchestrator:live     # live end to end on its own stack (E2B, LiteLLM, a real model; a few cents)
```

It needs `LITELLM_MASTER_KEY`, and for sandboxes `E2B_API_KEY` and cloudflared in `~/.local/bin`. `REVEAL_KEEPER_PRIVATE_KEY` is the keeper's wallet (anvil account 3 on the local fork; any funded account elsewhere, KMS before the beta); without it the keeper is off. `ORCHESTRATOR_SECRET` encrypts the agents' virtual keys at rest and has a local default.

- **Sandbox leases.** At most one active sandbox per agent, enforced by Postgres, with a 10-minute lease that is also the sandbox's own E2B timeout. E2B's egress rule injects only the lease's gate token; the gate, inside the orchestrator, attaches the agent's own LiteLLM key, so the key never reaches E2B or the sandbox (D-203). A Cloudflare quick tunnel carries the sandbox's requests to the local gate.
- **Startup sweep.** Every start removes what a killed earlier run left in its namespace: the tunnel (by its PID file in `.dev/`), tagged sandboxes, active leases and their gate tokens, tasks left running, and LiteLLM keys no live agent owns (L-19).
- **Internal API.** `GET /v1/runtimes`, `GET /v1/tasks/:id` and `GET /v1/keeper`; on the local fork only, `POST /v1/agents/:id/tasks/noop` and `POST /v1/agents/:id/reset` (D-205).
- `--namespace=<name>` keeps a test run's queue, tags and key aliases apart from the development one (default: the `APP_ENV` value); `--no-keeper` turns the keeper off.

## Credits (P1-U6)

Each agent has a funding address: an account the orchestrator derives from `FUNDING_ADDRESS_SEED` (a random seed in `.env`, one per environment; KMS keys replace it before the beta, D-207). USDC sent to it is the agent's credits, with no other step: the indexer sees the transfer and the orchestrator credits it in the double-entry ledger in Postgres (D-208). Model calls are metered from LiteLLM's spend log at provider cost plus 25% (Assumption A-27), and each agent's LiteLLM budget is kept equal to what its remaining credits buy. Spendable credits are capped at 50 USDC per agent for the beta (Assumption A-28): the part of a deposit above the cap is held, flagged, never spent, and returned by a refund.

At zero credits the agent is RESTRICTED (D-129, D-209): the gate answers its model calls with HTTP 402 `insufficient_quota`, which Hermes treats as billing and does not retry, and LLM tasks are refused. Everything deterministic keeps running: the reveal keeper, provisioning, deposits, metering and refunds.

The current owner can ask for the remaining credits back, with an owner session, at `POST /v1/agents/:id/credits/refund`. The orchestrator checks the owner and ownership epoch on chain again, then sends the credits and any held USDC from the funding address to that owner. A request made before a sale is refused, so credits stay with the agent (D-210). `GET /v1/agents/:id/credits` shows the funding address and balances. In the dev console, "Fund 5 USDC" sends test USDC to an agent's funding address and "Refund" pays its owner.

`pnpm test:orchestrator:live` checks all of it on a fork of its own: a deposit credited, a task's charge metered, a refund paid on chain, a run that runs out of credits ending as billing, and the ledger matching the funding address on chain.

## Tool servers, the Scan and the narrator (P1-U7)

Agents do research through two MCP tool servers that run inside the orchestrator, behind the gate, so a sandbox still reaches one host (D-213):

- **Data tools** (`services/data-tools`): `web_search` and `read_url`, both through Tavily (`TAVILY_API_KEY`, D-214). Every call is charged to the agent before it runs, from the price table (Assumption A-29: 0.01 USDC per search, 0.002 USDC per page), and refused at zero credits; a call Tavily does not answer is reversed. `read_url` refuses private, loopback, link-local, internal and cloud metadata addresses before any request. Results are marked as untrusted web content, never instructions.
- **Platform tools** (`services/platform-tools`): `complete_stage`, once per stage per run, and `write_thesis`, which stores the run's research notes (private: never served to owners).

Neither server takes an agent in any input: each finds the agent from the lease's gate token, the one value E2B injects at egress (`packages/tool-server`).

The orchestrator schedules a Scan for every provisioned agent with at least 0.05 USDC of credits, every `SCAN_INTERVAL_MINUTES` (360 by default, D-216). A Scan is one Hermes run: the agent searches, reads pages, saves notes and ends with `complete_stage`; the stored stage record is the result. Afterwards the narrator, a separate model on its own LiteLLM key, writes a short activity entry from the platform's own records, and the entry is kept only if every number in it appears in those records; otherwise a fixed template writes it (D-217). `GET /v1/agents/:id/activity` on the control API serves the entries.

To try it: run `pnpm dev:all`, open the console's Agents page, press "Fund 5 USDC" on a provisioned agent, wait for its credits to show, then "Run Scan". The result card shows the stage record, tool calls and spend; the agent's activity entry and tool call history appear below the table once the Scan ends (about a minute). After changing `infra/litellm/config.yaml`, restart LiteLLM so it knows the `narrator` alias.

## Dev console

`apps/console` is an internal, local-only console for the development environment. It is a separate app, so its code is never part of the product deployment, and it is built only from `packages/ui`.

```sh
pnpm dev:all             # every service, the console at http://127.0.0.1:3001 among them
pnpm dev:console         # the console alone (the stack must already be up)
pnpm test:console:e2e    # screenshot and accessibility tests of every page, in Docker
pnpm test:console:live   # the owner's flows against the running stack, on the host's Chromium
pnpm dev:down            # stop everything when done
```

`test:console:live` runs Playwright on the host rather than in the pinned image, because Docker Desktop on WSL2 does not share the distro's 127.0.0.1 with `--network=host`; it takes no screenshots, so the host browser is enough. Install it once with `pnpm --filter @alpha-agents/console exec playwright install chromium` The headless browser needs no extra system packages on the development machine; `pnpm --filter @alpha-agents/console exec playwright install-deps --dry-run chromium` lists the optional ones (GPU and Xvfb, for headed runs), which need sudo to install.

- **Local only.** It refuses to start or build unless `APP_ENV` is `local` (or unset), always binds to 127.0.0.1, and answers only requests addressed to 127.0.0.1 or localhost. Every action that changes chain state first checks that the target is the anvil fork on 127.0.0.1 (host 127.0.0.1, an `anvil/` client, chain 143) and refuses otherwise; a remote RPC is never contacted. Secrets never appear: configuration is shown only through `summarizeConfig`.
- **Environment.** Postgres, Redis and anvil health (chain ID, network, current and pinned block) from `packages/devenv`, the same checks `pnpm dev:status` prints, and the redacted configuration.
- **Fork controls.** Snapshot, revert, mine blocks, advance time, and reset to the pinned block; revert and reset ask first.
- **Test funds.** Set any address's MON balance, and give it USDC minted through the real USDC contract on the fork by a fork-only test minter; balances are read back from the chain.
- **Address book.** Every entry per environment with its status, source and open question.
- **Policy sandbox.** Build a swap and an account, run `packages/policy`, and read the result as "why the agent did not trade" messages. Presets break each launch limit.
- **Agents.** Every agent from the control API's index with its runtime from the orchestrator. "Run no-op task" starts the agent's sandbox, runs one trivial Hermes task through the gate and LiteLLM, shows the structured result and stops the sandbox; "Reset" deletes the agent's key and provisions it again. The kill switch placeholder waits for PB-U1.

## Secret scanning

```sh
pnpm run secrets:scan   # run before every push
```

This runs gitleaks (pinned by image digest, in Docker) over the full history of every branch and over uncommitted and staged changes. Output is redacted, and gitignored files such as `.env` are never read. CI runs the same scan. Rules are the gitleaks defaults (`.gitleaks.toml`); a verified false positive is added to `.gitleaksignore` by fingerprint, with its reason. If a real secret is ever found, rotate it first: removing it from history does not make it safe.
