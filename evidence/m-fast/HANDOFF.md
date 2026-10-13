# M-FAST handoff: Base on a mainnet fork, for the Colosseum demo

Status: partial. Base is built end to end on a fork (config, address book, the fork, the deployment, the stack, discovery and research per chain, the chain tag in the UI, the demo script) and the agent researched Base's tokens on it; the sweep's plan step and a settled trade are pending (below). Arbitrum was skipped on the owner's instruction.

## Commits of this unit (oldest first)

- 0b27a85 feat(config): add the Base environment with its fork chain id, tokens, feeds, pools and external addresses [M-FAST]
- e5665b2 feat(infra): a Base mainnet fork with the trading set deployed on it, its own stack and demo scripts, and a Base fork test [M-FAST]
- 38d0a2b feat(agent): research, market data and the chain tools per chain, with Base behind the base environment [M-FAST]
- 8462b64 feat(web): tag every position tile and the agent terminal with its chain [M-FAST]
- the fifth commit: fix(agent): the Base stack starts and researches (the config loader, the v2-only assumptions, GeckoTerminal's id prefix, the chain's class F feeds, the playbooks) [M-FAST]
- the sixth commit: docs(plans): the M-FAST LOGS entry, L-251 to L-256, A-98 and this handoff [M-FAST]

The exact hashes of the last two are in the chat handoff.

## Test results

- pnpm typecheck, pnpm lint, pnpm format:check: clean on the final tree.
- Unit tests: config 122, devenv 70, signer 61, trading 76, policy 229, chain-tools 53, ui 621, domain 180, market 63, orchestrator (local-feeds, screen, registrar) 20, web wallet-mode 14, all passing.
- pnpm test:base-fork: 4 of 4 on a fork of Base mainnet at block 52,534,000 (every external address has code, the CREATE2 deployer's code hash, the tokens' decimals and symbols, the Chainlink feeds live at the pin, the core pools the factories' own, the v4 ETH/USDC pool with liquidity).
- Skipped as the session rules asked: the Playwright suites, the orchestrator's fork tests, the full vitest run.

## What the owner should check or try

The Base fork and the Base stack are still running from this session (fork on 8590, stack on 4110, 4210 and 3010), beside the testnet stack and the playtest fork, which were not touched.

Start from nothing:

```
pnpm base:fork:up          # anvil as a fork of Base mainnet at block 52,534,000 on 127.0.0.1:8590, chain 84538453
pnpm base:deploy           # finds the deployed set (idempotent); deploys it on a fresh fork
pnpm base:up               # indexer, control API (4110), orchestrator (4210), web (3010)
pnpm base:demo             # the headless run with the demo owner (anvil account 6): mint, credits, goal, account, grant, sweep, plan, trades
pnpm base:demo --owner 0x...   # also funds that wallet with 10 ETH and 5,000 USDC on the fork and mints it an agent
pnpm test:base-fork        # the Base fork forge test
pnpm base:down             # stops the stack; pnpm base:fork:down stops the fork (its state is saved in .dev/base-anvil-state.json)
```

For the web app with Privy login, stop the testnet web first and run `WEB_PORT=3000 pnpm base:up`; Privy allows only localhost:3000. Add the Base fork network to the wallet: chain id 84538453, RPC http://127.0.0.1:8590, currency ETH. The owner's three playtest wallets are on the deposit allowlist.

What to look at:

- evidence/m-fast/base-deployment.json: every address with its code size.
- evidence/m-fast/demo-run-*.json: each demo run's steps, the sweep's tool calls, the plan card, the intents.
- The orchestrator's token list on the fork: `curl http://127.0.0.1:4210/v1/tokens?limit=40` shows Base's universe (class F: WETH, USDC, cbBTC, AERO, VIRTUAL, DEGEN, USDT; the rest class A, unscreened).
- The chain tag on the window, vault, research and portfolio pages (`Base` next to every position and in the terminal header).

## Open issues (pending)

1. The trade flow requires the v2 chain reader (services/orchestrator/src/orchestrator.ts, `reader && options.trading`), which the Base fork does not have, so approved intents wait there. One change (TradeFlow taking the v3 reader alone where every agent is on v3) and the approved chain-check intent of agent 1 (1 USDC to WETH through the PancakeSwap v3 0.01% pool, route 0x72ab…) settles through the signer and Executor v3 on the fork.
2. The activation sweep's Scan step ran out of its 16 turns twice on Base: first on an empty universe (fixed: GeckoTerminal's id prefix, the chain's class F feeds), then with a refused brief and no turns to repair it. The market snapshot now names ETH as the native token with its own price range; a sweep has not run with that yet.
3. The orchestrator's cycle log lines did not reach .dev/base-stack.log in the later runs; the task record (`GET /v1/tasks/:id` on 4210) and the stage rows carry the reasons.
4. The sentinel's SIGNER_DOWN incident during restarts left the agent state INCIDENT; the resume path is unchecked.
5. Arbitrum (item 7) was not started.

## Model spend

Under 1 USD for the unit: three Base sweeps' Scan steps (about 0.26, 0 and 0.34 USD at the gate's cost) and the chain check; the day's window stood at 4.30 USD before the unit. Every run stayed under the gate's 10 USD task cap.

## Push

```
git push
```
