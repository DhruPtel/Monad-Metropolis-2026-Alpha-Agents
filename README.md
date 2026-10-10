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

`pnpm dev:all` runs every service in one terminal, each output line labeled with its service (indexer, api, orchestrator, web, console) and also written to `.dev/dev-all.log`. It refuses to start while a heavy suite (Playwright, a production build) is running or when less than 2 GiB of memory is available; `--force` overrides both. Ctrl-C stops the services and leaves the stack running; `pnpm dev:down`, from any terminal, stops the services by PID, then anvil and the containers, LiteLLM included (D-211). anvil saves the fork's state to `.dev/anvil-state.json` every minute and when it stops, and the next `pnpm dev:up` loads it (D-364), so `pnpm dev:down`, a hang or a reboot keeps the fork's deployments, mints and balances; what a restore does not keep is the history older than the last save (L-63). For a fresh fork on purpose, delete that file between `pnpm dev:down` and `pnpm dev:up`, or run `pnpm dev:reset`, which deletes it with the volumes; then redeploy with `pnpm deploy:agent-nft` and the other deploy commands.

Use `pnpm run doctor`, not `pnpm doctor`: `doctor` is a built-in pnpm command and runs pnpm's own checks instead.

| Service  | Address                                                             |
| -------- | ------------------------------------------------------------------- |
| anvil    | `http://127.0.0.1:8545`, chain ID 143143, network monad             |
| Postgres | `postgres://alpha:alpha_local_dev_only@127.0.0.1:5432/alpha_agents` |
| Redis    | `redis://127.0.0.1:6380`                                            |

Ports bind to 127.0.0.1 only. The Postgres credentials are for local development only. Postgres and Redis ports can be changed with `POSTGRES_PORT` and `REDIS_PORT` in `.env`; Redis defaults to 6380 because a system Redis often holds 6379. anvil writes its log, with the RPC URL redacted, to `.dev/anvil.log`.

Tests that reset a chain or need a fresh deck (`pnpm test:fork`, the fork controls test, the indexer's and keeper's fork tests, `pnpm test:web:live` and `pnpm test:orchestrator:live`) start their own anvil fork on another port (8546; 8548 for the indexer test, 8549 for the keeper test, 8550 for the orchestrator live check, 8572 for the stuck-transaction tools, 8574 for the fork-reset recovery test) and stop it afterwards, so the playtest fork on 8545 is never reset (D-200). Their logs, with the RPC URL redacted, go to `.dev/test-fork-<port>.log`.

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

## Custody: PersonalAccount and AccountFactory (P2-U1)

`chains/monad/src/custody/` holds owners' trading money. `CustodyCore.sol` is the small, non-upgradeable core: the owner's withdrawal is always on and needs only the token (a token whose transfer reverts, such as USDC under a Circle pause or blacklist, is credited for a later `claim` while the rest withdraws); the only other way out is `executeSwap` for the Executor the factory names, which starts unset and changes only after a 9-day timelock, with the core's own post-trade backstops. `PersonalAccount.sol` is the core for one agent and one owner, holding USDC and WMON only. `AccountFactory.sol` deploys one clone per agent and owner, and holds the beta allowlist and caps (100 USDC per account, 2,000 USDC across the platform): tightening is instant, loosening waits the timelock, and the factory has no path to account funds. The owner, the guardian and the sentinel key can set reduce-only, pause or close deposits; only the owner undoes them. Slither's findings and the gas report are in `evidence/p2-u1/`.

```sh
pnpm deploy:account-factory                 # deploy to the local fork (deploys AgentNFT first if needed; deterministic)
pnpm custody:local demo                     # anvil account 6: mint an agent if it has none, create its account, deposit 25 test USDC, withdraw it
pnpm custody:local create                   # create (or show) the owner's PersonalAccount
pnpm custody:local deposit 25               # test USDC into the account, up to the 100 USDC cap
pnpm custody:local withdraw 10              # some USDC back to the owner; with no amount, every held asset
pnpm custody:local show                     # balances, principal, mode, caps and the platform total
pnpm custody:local deposit 10 --owner 7     # any of the local test owners, anvil accounts 6 to 9
```

Locally, AgentNFT's admin (anvil account 0) is the factory admin, account 4 the guardian and account 5 the sentinel key; anvil accounts 6 to 9 start on the deposit allowlist. The admin adds or removes a wallet at once (D-231); raising either cap waits the 9-day timelock. The commands act only on the fork that `LOCAL_FORK_PORT` names (the playtest fork by default) and refuse anything that is not the local anvil fork.

### The custody core v3 (F-U3)

`chains/monad/src/fund/CustodyCoreV3.sol`, `PersonalAccountV3.sol` and `AccountFactoryV3.sol` are the fund agent's account: a portfolio of up to 16 tokens the TokenRegistry knows, each with its own feed or attested price and an onchain cost-basis record (the USDC paid for what is held, moved pro rata on sells and withdrawals). The class A caps, 15% per position and 50% in all, hold by cost basis with no price; class F keeps the 45% value cap. The owner opts in to screened-lane tokens onchain and out again at once. Every v2 guarantee stays: the owner withdraws any held token without a price, the Executor or the platform; withdrawals cannot be paused; a token whose transfer reverts is credited while the rest comes out; the sentinel can only tighten; loosening waits the 9-day timelock. The factory takes the registry, the oracle and the Executor at deployment; F-U3 deploys it with the Executor unset, and F-U4 deploys it again with Executor v3.

```sh
pnpm deploy:custody-v3                      # deploy to the local fork beside v1, v2 and the v3 set (needs pnpm deploy:fund first; deterministic)
pnpm custody:v3:demo                        # a fork of its own (port 8586): open an account, deposit four tokens, show the cost basis, opt in, withdraw everything
```

### Executor v3 (F-U4)

`chains/monad/src/fund/ExecutorV3.sol` is the fund agent's Executor: the only contract that can trade a PersonalAccountV3, from the session key the agent's owner registered, for any pair of tokens the TokenRegistry lists, through routes of up to three registered pools on the RouteAdapter. It checks every hard limit across the whole portfolio in a fixed order and refuses with `Rejected(reason)` (the codes in packages/domain): 10% of value per trade; 40% at most in any one token after a buy, or the registry's own cap when lower; 10% at least in USDC; the class A cost-basis caps, 15% per position and 50% in all; a floor of 0.5% slippage against the feeds or 1% against an attested price, and after the fill a value loss of at most that slippage plus the route's pool fees; 20 trades and 100% turnover per rolling 24 hours; deadlines at most two minutes ahead; fresh feeds and pools within 2% of them; the account's mode and an unpoked drawdown. Screened tokens trade only for accounts whose owner opted in, sell-only tokens only sell, frozen tokens neither. A class A side carries its attestation in the intent, checked through the registry's verifier; until F-U12's attestor exists every class A trade is refused as `ATTESTOR_UNAVAILABLE`. Inside the account's `executeSwap` the Executor pulls exactly the input, the adapter pays the account directly, what actually arrived is checked against the intent's minimum, and nothing stays behind. `packages/policy`'s `executorV3.verdict` gives the same answer offchain, held to the contract by `packages/policy/fixtures/executor-v3-parity.json` (236 cases, replayed by `ExecutorV3Parity.t.sol`), and `executorV3.blockers` lists every rule a trade breaks for the chain tools. Slither and gas are in `evidence/f-u4/`.

The Executor binds once, after deployment, to the AccountFactoryV3 deployed with it and to a ProtocolRegistryV3 that lists its RouteAdapter as active from construction (D-361, D-363). `pnpm deploy:executor-v3` deploys the Executor, then the adapter and the registry from one `ExecutorSetDeployer` (so no timelock stands between deployment and the first trade), an OracleAdapterV3 over that registry, AccountFactoryV3 again with the Executor and the oracle given, and the binding. Every address follows from the arguments, so running it again finds the same contracts; `pnpm test:fork` deploys the same set on its test fork and trades through one, two and three real pools.

```sh
pnpm deploy:executor-v3                     # deploy to the local fork beside the earlier sets (needs pnpm deploy:fund first; deterministic)
```

### The Executor (P2-U2)

`chains/monad/src/executor/Executor.sol` is the only contract that can trade an account's funds. It takes typed swap intents from the session key the agent's owner registered (`registerSession`; a sale of the agent, a configuration change or expiry ends the grant, and an old grant never revives), and checks every launch hard limit in a fixed order: 10% of value per trade, 40% at most in WMON and 10% at least in USDC after a buy, the oracle floor of 0.5% slippage, 20 trades and 100% turnover per rolling 24 hours, deadlines at most 2 minutes ahead, a fresh oracle within 2% of the pool, and the account's mode and unpoked drawdown. A refusal reverts with `Rejected(reason)`, the reason codes in packages/domain. Inside the account's own `executeSwap` it pulls exactly the input, the venue adapter pays the account directly, and nothing stays behind. `ProtocolRegistry.sol` lists the adapters with their code pinned: the Uniswap v4 MON/USDC 0.05% adapter (`src/venues/`, which unwraps and rewraps WMON) is active, the v3 USDC/WMON 0.3% fallback is registered but paused. Loosening a limit, activating a venue or unpausing waits the 9-day timelock; tightening and pausing are instant for the admin or the guardian. `packages/policy`'s `executorVerdict` gives the same answer offchain, held to the contract by a shared fixture. Slither and gas are in `evidence/p2-u2/`.

```sh
pnpm executor:local demo                    # a fork of its own on 8548: an account, real swaps on the v4 pool, then one intent per limit and its reason
pnpm executor:local demo --keep             # the same, leaving the fork on 8548 until Ctrl-C
```

### Oracle adapter and circuit breaker (P2-U3)

`chains/monad/src/oracle/OracleAdapter.sol` prices WMON from Chainlink MON/USD (refused at 300 seconds old or older, or for a zero, negative, incomplete, future or changed-decimals answer), treats USDC as exactly 1, refuses a trade when the Uniswap v4 MON/USDC pool is more than 2% from the oracle, and stops deposits when USDC/USD is stale (7,200 seconds, two hourly heartbeats, D-317) or more than 1% off its peg. Every refusal carries a reason code. The custody core values an account once per transaction through it, and its circuit breaker tracks the 7-day peak of the account's value per internal unit, so deposits and withdrawals never trip it: 10% down sets REDUCE_ONLY, 20% PAUSED, anyone may `poke()`, and only the owner unpauses. Withdrawals never read the oracle. `packages/policy` mirrors the rules offchain, and `pnpm policy:parity` rewrites the fixture that holds the two together (vitest and forge each check it). Slither and gas are in `evidence/p2-u3/`.

A fork copies the feeds as they were at the pinned block and nothing updates them there, so as the fork's clock moves on every priced action would be refused. On the local fork only, `LocalFeed` (D-237) keeps them fresh: under `pnpm dev:all` the orchestrator re-dates both feeds every minute (no transactions, no blocks), and the scripts below re-date them before anything priced. Nothing like it can run on testnet or mainnet: devenv refuses any RPC but the local anvil fork.

```sh
pnpm oracle:local prices                    # a fork of its own on 8548: MON/USD, the pool and USDC/USD through the adapter
pnpm oracle:local demo                      # same fork: a test account valued, MON falls 15/25/40%, the breaker trips
pnpm oracle:local demo --drops 9,10,20 --keep   # your own drops; --keep leaves the fork on 8548 until Ctrl-C
pnpm custody:local prices                   # the adapter on the playtest fork
pnpm custody:local refresh-feeds            # re-date the playtest fork's feeds now (dev:all does it every minute)
```

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

### Wallet on the local fork (MetaMask or OKX)

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

**OKX Wallet** works the same way (D-224): choose it in the login window. With MetaMask and OKX both installed, the app uses the wallet you chose, whichever one holds `window.ethereum`, and the wallet button names it. OKX may refuse to add a network with an http RPC from a site; the app then shows the steps above to add it by hand (OKX: Settings, Networks, Add network). Switching accounts in the wallet while logged in ends the session with a notice; connect again to use the new account.

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

## My Agents (P1-U9)

`/agents` in the web app shows every agent the connected wallet owns (D-218): its art (3D stays on /configure), tier, species and what it is doing (waiting for reveal, setting up, ready, running, or paused with no credits, when research stops and safety checks keep running); "Fund your agent" with the funding address, a copy button, a QR code of the address, the credits balance, any USDC held above the 50 USDC beta cap, and a Trading placeholder until Phase 2; 24-hour spend and recent charges; and the narrator's activity entries. "Run Scan now" and "Refund credits" each ask for confirmation first: the Scan shows its estimated cost (about 0.15 to 0.30 USDC, Assumption A-31), and the refund shows the ownership epoch it is tied to.

The page asks the control API for an owner session per agent and reads `GET /v1/agents/:id/summary`, which only the owner can read; `POST /v1/agents/:id/scan` records an owner's Scan, which the orchestrator queues within two seconds (D-219). `pnpm test:web:live:agents` runs the whole owner path on a stack of its own with the orchestrator: mint, fund by a plain USDC transfer, a Scan from the page, its entry, a refund paid on chain, and another wallet seeing none of it.

To try it: `pnpm dev:all`, open http://localhost:3000/agents, log in with the wallet that owns an agent (mint one first if needed), send test USDC to the funding address shown (or press "Fund 5 USDC" in the dev console), then run a Scan and read its entry.

Forks reach the upstream through a retrying proxy (`packages/devenv`, L-91): a node that answers the pinned block as missing, or "not found", is asked again with backoff, alternating with `MONAD_RPC_URL_SECONDARY` when it is set (D-220). Fork starts also check the pinned block first and retry up to six times.

### The Bee on the local fork (D-221)

On the local fork the reveal keeper plays Pyth Entropy, so it can choose the number it delivers. `LOCAL_FIRST_REVEAL_SPECIES` (default `bee`, or `random`) makes agent #1 on a fresh fork reveal as that species, and the dev console's "Reveal next as" card steers one reveal, once: a wallet's next reveal (its lowest unrevealed agent, or the next agent it mints) or one pending agent by ID. Steers are kept in Postgres, so restarts keep them, and the card says exactly which agent each pending steer will apply to. Both exist only with `APP_ENV=local`: any other environment refuses to start with a species set, and testnet and mainnet reveals always take Pyth Entropy's number.

Stuck transactions after a fork reset: a wallet keeps numbering its transactions from the old fork's history, so after `pnpm dev:down` and a fresh fork it can send a nonce the fork does not expect yet, and anvil queues that transaction forever. The mint page names this ("Your wallet has transactions the local fork will never mine") with both nonces, and a mint that hits it stops with the same explanation instead of waiting. The fix is in the wallet: in MetaMask select the Monad (local fork) network, then Settings, Advanced, Clear activity tab data (newer versions: Clear activity and nonce data); in OKX Wallet clear the pending transactions for that network. The dev console's Fork page has a "Stuck transactions" card that shows an account's fork nonce and queued transactions and can drop them or align the account's nonce to the one the wallet sends next.

To get the Bee on a fresh fork: `pnpm dev:down`, delete `.dev/anvil-state.json` (the saved fork), `pnpm dev:all`, `pnpm deploy:agent-nft`, then mint at http://localhost:3000/mint; agent #1 reveals as the Bee within about 15 seconds. On a fork that already has agents, choose "Bee" for your wallet in the console's "Reveal next as" before the next mint.

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
