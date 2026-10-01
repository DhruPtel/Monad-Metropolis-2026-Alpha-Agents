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
