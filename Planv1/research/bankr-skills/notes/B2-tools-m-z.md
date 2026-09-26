# B2: Tools, integrations, and actions (skills M through Z)

Sub-agent B2. Scope: skill folders `megapot` through `zyfai` (plus `opensea/*` nested sub-skills and `skills/bankr-twitter-agent`). Repo HEAD d7b28f4. Method: read every in-scope SKILL.md in full or near full, read references/ and scripts/ as text (grep plus targeted reads for hosts, env vars, signing, approvals). No script was executed, no URL was fetched, nothing was installed.

Labels: **V** = Verified (seen in files, path cited). **I** = Inferred (my reading, not stated in files).

Terminology used below:
- "Bankr prompt" = natural-language request to Bankr's agent (`bankr agent prompt`, `POST /agent/prompt`, or "@bankrbot" on X). Bankr's model decides and signs.
- "Bankr wallet API" = direct `POST /agent/submit`, `/wallet/submit`, `/agent/sign`, `/wallet/sign`, or `bankr wallet submit`, `bankr x402 call`. Bankr's custodial wallet signs exactly what the caller built.
- "Own key" = a raw private key or signer key held in the agent's env or on disk.
- "Bypass Executor" = if the skill ran as written inside our sandbox (assuming egress allowed), the chain action would be signed somewhere other than our Executor contract path. In our model every such action must be re-expressed as a typed intent.

---

## 1. Per-skill table

Columns: connects to | chain actions | how chain actions are done | bypass our Executor? | credentials | pure knowledge? | cites.

| Skill folder | Connects to | Chain actions | How done | Bypass Executor as written? | Own credentials | Pure knowledge? | Cites |
|---|---|---|---|---|---|---|---|
| megapot | Onchain Base contracts (Jackpot etc.); REST `api.megapot.io` (wins lookup only); runtime fetch of task recipes from `llms.megapot.io` | writes: approve, bet (buy tickets), subscribe (recurring), LP deposit/withdraw, claim | Bankr wallet tools; confirm each write with user (V) | yes (Bankr wallet signs) | none (anonymous Data API) | no | megapot/SKILL.md:17,39-45,68-80; references/buy-random.md:7-11; references/data-api.md:3,16 |
| metr-merchant-payments | REST `api.metr.app/v1` | merchant side: start/end sessions; ending a session releases escrow onchain (done by Metr) | Metr server settles; withdrawals are human-only in dashboard (V) | partially: money-moving API call outside Executor, no agent signing | `METR_MERCHANT_API_KEY`, `METR_AGENT_KEY` via Bankr "Env Vars" UI (V) | no | metr-merchant-payments/SKILL.md (Authentication, Core Operations, Claim & Withdraw) |
| moltycash | x402 JSON-RPC `api.molty.cash/a2a` via `bankr x402 call`; funding transfer to returned campaign wallet | writes: pay (x402 fees), transfer (campaign funding) | Bankr wallet API (`bankr x402 call --max-payment`), Bankr transfer (V) | yes | none required (optional `MOLTY_IDENTITY_TOKEN`) | no | moltycash/SKILL.md (Security model, One transport, Fees) |
| nexus-trading-labs | REST `og.nexustradinglabs.com` (proxy over Orderly on Arbitrum); `api-evm.orderly.org`; rss2json news | writes: perp trades, SL/TP, deposit, withdraw, onchain thesis register, deploy a server-side autonomous trading bot | Bankr `sign_message` tool (static message as bearer token) plus the user's Bankr API key posted to Nexus's server, which calls Bankr `/wallet/submit` and `eth_signTypedData_v4` (V) | yes, strongly (third party holds Bankr key during call; bot trades server-side) | user's Bankr API key in request body; `walletSig` | no | nexus-trading-labs/SKILL.md:19-29 (sign flow), Quick Reference table; references/deposit-withdraw.md:23,32,87,92 |
| neynar | REST `api.neynar.com` via own `scripts/neynar.sh` | none (social writes: cast, like, recast, follow) | n.a. | n.a. | `apiKey` + `signerUuid` in `~/.clawdbot/skills/neynar/config.json` (V) | no | neynar/SKILL.md:15-28,136-145; scripts/neynar.sh:8,13 |
| nookplot | REST+WS `gateway.nookplot.com`; x402 `api.nookplot.com`; MCP `npx @nookplot/mcp` (410 tools); CLI `npx @nookplot/cli`; runtime SDK; gateway also offers egress proxy, sandbox exec, BYOK inference | writes: sign EIP-712 ForwardRequests (meta-tx, relayer pays gas) for posts, votes, bounties, escrow, guild treasury, forge deploy; USDC credit purchase; NOOK staking | own key `NOOKPLOT_AGENT_PRIVATE_KEY` signs locally, gateway relays (V) | yes | `NOOKPLOT_API_KEY`, `NOOKPLOT_AGENT_PRIVATE_KEY`, `ANTHROPIC_API_KEY` for runtime (V) | no | nookplot/SKILL.md:5-6,16-20,24-33,40-75,160-172; references/economy-overview.md:41,90-98,128-164 |
| onair-shoutout | x402 REST `gateway.gmfarcaster.com/v1/shoutout` via own Python script (x402 lib) | writes: pay $5 USDC (EIP-3009) | own key `GMFARCASTER_PRIVATE_KEY` or `_FILE`; local pins (payee, asset, network, max price) plus `--confirm` flag (V) | yes | `GMFARCASTER_PRIVATE_KEY` | no | onair-shoutout/SKILL.md (setup, Configuration table, Notes:135); scripts/request.py:74-97,108-118,180-197; scripts/requirements.txt |
| onchainkit | npm (`npm create onchain@latest`), CDP portal key for the built app | none by agent (builds dapps that transact) | n.a. | n.a. | `NEXT_PUBLIC_CDP_API_KEY` for the generated app | almost: dev knowledge; scripts are dev tooling | onchainkit/SKILL.md:1-60; scripts/create-onchain-app.py:18,30 (`shell=True`) |
| opensea (router) | none | none | n.a. | n.a. | none | yes (pure router) | opensea/SKILL.md:11-31 |
| opensea/opensea-api | REST `api.opensea.io` (scripts), CLI `@opensea/cli`, MCP `mcp.opensea.io/mcp` | read-only, except `get_mint_action` / `deploy_seadrop_contract` / drop-mint script return unsigned tx data | returns tx data only (V) | n.a. for reads; mint/deploy would need an intent | `OPENSEA_API_KEY` (can be self-issued via unauthenticated `POST /api/v2/auth/keys`) (V) | no | opensea-api/SKILL.md:49-53,245-360; scripts/opensea-get.sh; scripts/opensea-auth-request-key.sh; scripts/opensea-drop-mint.sh |
| opensea/opensea-marketplace | REST fulfillment endpoints (scripts), CLI | writes: buy/sell NFT, create listings/offers, cross-chain buys, sweeps, approvals | wallet adapter from opensea-wallet (Privy, Turnkey, Fireblocks, Bankr, raw key) (V) | yes | `OPENSEA_API_KEY` + provider creds | no | opensea-marketplace/SKILL.md (Buying, Cross-chain, Signing transactions) |
| opensea/opensea-swaps | CLI `opensea swaps execute`; MCP `get_token_swap_quote` via `mcporter` | writes: swap (ERC20, cross-chain) | wallet adapter (V) | yes | same | no | opensea-swaps/SKILL.md; scripts/opensea-swap.sh (provider autodetect) |
| opensea/opensea-tool-sdk | `npx @opensea/tool-sdk`; Base ToolRegistry `0x7291...4856`; x402 facilitators (PayAI, Coinbase CDP) | writes: register tool onchain, pay x402 (`paidFetch`), SIWE auth signatures | own `PRIVATE_KEY` env or wallet adapter (V) | yes | `PRIVATE_KEY`, `RPC_URL` | no | opensea-tool-sdk/SKILL.md:7-12,56-62,156-185,219-252; references/x402.md |
| opensea/opensea-wallet | Privy / Turnkey / Fireblocks / Bankr APIs; `opensea wallet info` | none itself; it is the signer config for the other OpenSea skills | external signing provider or raw key (V) | yes (it is a signer) | Privy, Turnkey, Fireblocks, Bankr env sets, or `PRIVATE_KEY` (V) | mostly a security playbook | opensea-wallet/SKILL.md:42-80,125-206; references/wallet-setup.md; references/wallet-policies.md; references/wallet-funding.md; opensea/docs/policy-administration.md |
| orlix | REST `orlixai.xyz` (`/api/analyze`, `/api/chat` to 19 LLMs, `/api/b20-skill`); Bankr prompts | writes: deploy B20 token (prepare returns unsigned EIP-1559 tx) | Bankr prompt / Bankr signs prepared tx; mandatory confirm summary (V) | yes | none (unauthenticated API) | no | orlix/SKILL.md (Security Boundaries, B20 Actions); references/bankr-integration.md:14-40 |
| pantheon-staking | REST registry `launch.pantheonvaults.com/api/skill/registry`; pinned vault contracts on Base (8453) and Robinhood Chain (4663) | writes: approve (exact amount only), stake, claim; no unstake | "contract call from the user's own wallet"; signing tool not named (V); in Bankr runtime, Bankr wallet (I) | yes | none | no | pantheon-staking/SKILL.md:21-45 (pins), 69-90 (G1-G8 gates), 95-130 (registry), 144-150 (admin Safes) |
| pi-fire-science | external install; SKILL.md in repo is 140 lines of brand/tokenomics knowledge with Bankr buy prompts | writes: buy via Bankr prompt | Bankr prompt (V) | yes | none | mostly knowledge | pi-fire-science/SKILL.md:72-100; catalog.json install.command = "install the pi-fire-science skill from https://github.com/patternintegrity/pifirescience/tree/main/pi-fire-science" |
| pmfi-parbitrage | own Node script (ethers) to Bankr API; Base RPC | writes: approve (exact, only if needed), deposit USDC, redeem pARB | Bankr wallet API `/wallet/submit`; hard-coded vault, USDC, chain, endpoint; `--dry-run` then `--confirm-risk` (V) | yes | `BANKR_API_KEY` or `~/.bankr/config.json` | no | pmfi-parbitrage/SKILL.md (guardrails, Agent behavior); scripts/pmfi_parbitrage.mjs:7-12,82-97,187,580-581 |
| polygraph | CLI `npx polygraphso`, MCP (`verify_attestation`), EAS reads on Base; harness `@polygraphso/litmus` runs target MCP servers in Docker | read-only (grade lookup, attestation read) | n.a. | n.a. | none (Bankr key only appears in an example MCP config) | no; meta-security tool | polygraph/SKILL.md (grades, Verify before you trust); references/bankr-integration.md:29-122,138 |
| productclank | REST `api.productclank.com`; x402 credit top-up | writes: pay (credit bundles $2 to $500) | own `AGENT_PRIVATE_KEY` via `@x402/fetch`, or direct USDC transfer then tx hash (V) | yes | `PRODUCTCLANK_API_KEY`, `AGENT_PRIVATE_KEY` | no | productclank/SKILL.md:12,45-52,204-212,433-470; references/FUNDING.md:12-17,41-62,118; scripts/create-campaign.mjs:14,28-41 |
| qrcoin | public RPC `mainnet.base.org` eth_call; Bankr prompts | writes: approve, createBid (~11.11 USDC), contributeToBid (~1 USDC) | Bankr prompt "Send transaction to ... calling createBid(...)" (V) | yes | none | no | qrcoin/SKILL.md (Contracts, Transactions via Bankr) |
| quicknode | JSON-RPC via API-key URL or `x402.quicknode.com`; `@quicknode/x402`, `@quicknode/sdk` | read-only chain data; payment for credits | `@quicknode/x402` with `evmPrivateKey` (own key), SIWE/SIWX auth, auto-pays on 402 (V) | yes for payment | `QUICKNODE_RPC_URL` / API key, or `PRIVATE_KEY` | no | quicknode/SKILL.md:15-44,158-162; references/x402-reference.md:3-45,87-127,246-259 |
| quotient | x402 REST `quotient-api-gateway.onrender.com`; keyless Polymarket and Hyperliquid reads (`pm.sh`); Bankr `/agent/prompt` for trades | writes: pay (x402), bet (Polymarket via Bankr prompt) | `bankr x402 call` with pre-flight pinned tuple and capped `--max-payment`; trades via Bankr prompt after hashed-plan confirm (V) | yes | `BANKR_API_KEY` (execute only), `QP_APPROVE_TOKEN` | no | quotient/SKILL.md:24-29 (credentials), Access Model, Paid Calls 1-6, Execution via Bankr, Endpoint Catalog; references/bankr-x402-flow.md; scripts/payments.sh:527; scripts/signal-strategy.mjs:45,759 |
| rhagent | `rhagent.bot` social API; third-party Railway gateway `rhwallet-rhagent-production.up.railway.app` (Robinhood Crypto API proxy and Agentic MCP proxy); Bankr (Chain swaps, prompt that adds an MCP server); Telegram/Discord | writes: Robinhood equities/options orders, Robinhood crypto orders, Robinhood Chain swaps; mandatory trade-post of every fill | Robinhood keys sent as request headers to the gateway; `place_equity_order` via MCP; Bankr prompts for Chain (V) | yes (and offchain brokerage outside any chain policy) | `RH_API_KEY`, `RH_PRIVATE_KEY_BASE64`, `RH_GATEWAY_SECRET` (hardcoded public value), `AGENTIC_TOKEN`, `RHAGENTS_AGENT_KEY` (V) | no | rhagent/SKILL.md:1-26,55-230,581-615,642-715,819-935,1429-1446; references/CREDENTIAL-BOUNDARY.md:25; connect/lib/bankr.js:8,56; scripts/agentic-mcp.sh:21 |
| rider-battle | Supabase REST (untrusted lobby index, publishable key in file); escrow contract on Base; Bankr runtime `bankr.tx.prepare`, `bankr.chain.readContract` | writes: RIDER transfer to escrow, createMatch, joinMatch, settle, cancelUnaccepted, refundStalled (wager) | Bankr "tx prepare" button (human taps to sign) behind a selector allowlist (V) | I: human signs via button, still outside Executor | none (Supabase publishable key committed) | no | rider-battle/SKILL.md (Trust model, Constants, Funding model); scripts/prepareTx.ts:1-49; scripts/depositCreate.ts:34-85; catalog.json (install is a string, non-conforming) |
| signa | REST `signaagent.xyz` (brain, resolve, capabilities, public inbox, DM) | sign: EIP-191 `personal_sign` DM envelope only; no tx | agent wallet `personal_sign` (V); Bankr wallet in practice (I) | yes (message signature) | none | no | signa/SKILL.md:27,40,67-85 |
| signals | REST `bankrsignals.com/api`; Bankr `/agent/sign` or own key | sign: EIP-191 register/publish/close messages (no tx); consumers "copy top performers" by other means | Bankr `/agent/sign` personal_sign, or `PRIVATE_KEY` via viem in script (V) | yes (signature) | Bankr key in `~/.clawdbot/skills/bankr/config.json`; `PRIVATE_KEY` for script | no | signals/SKILL.md:28-100; HEARTBEAT.md:1-60,155; scripts/publish-signal.sh:25-38 |
| siwa | npm `@buildersgarden/siwa`; Bankr Agent API signer; `/agent/submit` for ERC-8004 registration | sign: SIWA auth messages; write: ERC-8004 register tx | Bankr `/agent/sign` and `/agent/submit` via SDK signer (V) | yes | `BANKR_API_KEY`; `RECEIPT_SECRET` (server side) | mostly SDK/dev knowledge | siwa/SKILL.md; references/bankr-signer.md (Create Signer, Register) |
| skills/bankr-twitter-agent | X API (credentials in env), Bankr automations (cron prompts), Telegram as approval channel | none; hard rule never tag @bankrbot autonomously because that triggers onchain actions | n.a. | n.a. | `X_API_KEY`, `X_API_KEY_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` (+ per-agent overrides) (V) | playbook + automation recipes | skills/bankr-twitter-agent/SKILL.md:25-49,166-215,285-400 |
| skopos | REST `tryskopos.xyz` free chat; x402 paid endpoints; MCP `npx skopos-mcp@0.1.0` | pay (x402 $0.01 to $0.25); trades only via deep-link into Skopos app where the human signs | x402 by agent wallet with pinned `payTo`; human deep link for swaps/orders (V) | payments yes; trades no (human signs in Skopos app, still outside our policy) | none | no | skopos/SKILL.md (Option 1, Option 2 table and pin table, How to respond) |
| sleuth-ai | x402 via Bankr gateway `x402.bankr.bot`; manifest `app.sleuthagent.ai/x402/openai-bnkr.json` | pay (x402 USDC `exact` or SLEUTH `upto`, max $1/call); read-only investigations | Bankr CLI x402 with `--max-payment` or SDK; strict pins (V) | yes (payment) | none | no | sleuth-ai/SKILL.md (Security invariants, Payments) |
| splits | CLI `@splits/splits-cli@0.2.9` (also ships an MCP server); Splits API; Bankr wallet API for module path; `cast` for calldata | writes: transfers, arbitrary custom calls, signer and threshold changes, swaps, fee-locker claims, module enable/execute | agent-owned local EOA (generated by CLI, stored `~/.splits/config.json`) as a multisig signer, threshold 2 default; or Bankr wallet as Safe-style module via `/wallet/submit` (V) | yes | `SPLITS_API_KEY` (human creates in web), local signer key (V) | no | splits/SKILL.md:37-103,119-170; references/agent-access.md; references/bankr-agent-signer.md:133-306; references/treasury-workflows.md; references/swap-and-sweep.md |
| stakr | onchain StakrVault/Factory; Bankr prompt or `bankr wallet submit` | writes: create vault, deposit, lock, addRewardToken, modifyRewardToken | Bankr prompt or Bankr wallet API raw calldata (V) | yes | none | largely protocol knowledge | stakr/SKILL.md (Executing Transactions via Bankr, streaming rewards); references/vault-api.md |
| starchild-dao | REST `token.starchild.software`; `balanceOf` read | sign: EIP-712 votes and proposals (gasless, offchain governance) | agent wallet signTypedData (V); Bankr wallet in practice (I) | yes (signature) | none | no | starchild-dao/SKILL.md (Safety, 3 Vote, 4 Propose) |
| suwappu-dex | MCP `api.suwappu.bot/mcp` (streamable HTTP) | read-only by default; `execute_swap` gated | Suwappu executes server-side; keys in Suwappu's Turnkey enclaves; `SUWAPPU_API_KEY` is the spend authority (V for Turnkey claim, I for "API key = authority") | yes if `execute_swap` enabled | `SUWAPPU_API_KEY` (self-registered via unauthenticated POST) | no | suwappu-dex/SKILL.md:23-42,46-63,71-83 |
| symbiosis | own Python scripts to `api-v2.symbiosis.finance`; Bankr `/agent/submit` | writes: bridge/swap; unlimited ERC20 approve | Bankr wallet API submits API-returned calldata unchanged; no confirmation step in script (V) | yes | Bankr key in `~/.bankr/config.json` | no | symbiosis/SKILL.md:57-67,142-149; scripts/symbiosis-swap.py:15-19,54-80,146-170 |
| trails | REST `trails-api.sequence.app`; Bankr `submit()` from `@bankr/cli`; widget URL for human funding | writes: swap/bridge deposit tx, approve + vault deposit | Bankr wallet API; widget deep link for human funding (V) | yes | `TRAILS_API` (Sequence access key), `BANKR_API_KEY` | no | trails/SKILL.md (env, Task Guide); references/trails.md:5,61,112,149,184-211 |
| trustlayer-sybil-scanner | REST `api.thetrustlayer.xyz` | read-only; x402 $0.001 on paid endpoints | x402 client not specified (V) | payments yes | none | no (single-GET, almost pure) | trustlayer-sybil-scanner/SKILL.md (API Base, Sybil Scan) |
| uniswap-cca, uniswap-driver, uniswap-hooks, uniswap-trading, uniswap-viem | external, content not in repo (11-line stubs) | per descriptions: driver = plan swaps/LP then deep links for human; trading = API/Universal Router integration; others dev knowledge | external, content not in repo | n.a. (unknown) | unknown | unknown | each `*/catalog.json` install.command = `npx skills add Uniswap/uniswap-ai` |
| urizen | REST `urizenfund.com/api` (keyless, CORS open) | writes: buy $URI via ready-to-sign quote tx (human signs), or "@bankrbot buy $URI" | ready-to-sign tx from API with validation checklist; or Bankr on X (V) | yes if agent signs; deep-link style if human | none | no | urizen/SKILL.md (Research, The fund, Trade, Safety) |
| veil | npm `@veil-cash/sdk` CLI; Bankr `/agent/prompt`; Base RPC; Veil relayer | writes: register, deposit ETH/USDC (via Bankr), withdraw/transfer/merge (ZK proofs signed with local `VEIL_KEY`, relayed) | deposits: Bankr prompt "Submit this transaction (do not change any fields)" with JSON; private actions: own key `VEIL_KEY` (V) | yes | `VEIL_KEY`, `DEPOSIT_KEY`, `RPC_URL` in `~/.clawdbot/skills/veil/.env*`; Bankr apiKey in `~/.clawdbot/skills/bankr/config.json` | no | veil/SKILL.md; scripts/_common.sh; scripts/veil-bankr-prompt.sh; scripts/veil-bankr-submit-tx.sh; scripts/veil-deposit-via-bankr.sh; templates/env.veil.example; references/sdk-reference.md:94-118,279-312,340-351 |
| versa | onchain AgentRegistry (payable register), REST `versa-production.up.railway.app` | writes: register vault with ETH, fundAgent (non-withdrawable), withdraw after 5 days; EIP-191 signed profile updates | agent wallet (unspecified) (V) | yes | none; posts the vault "secret phrase" to the backend (V) | no | versa/SKILL.md (Critical Rules, Quick Start); references/deploy.md:20-49; references/manage.md:40,71 |
| voidly-pay | REST `api.voidly.ai` (discovery, registry), pinned manifest at `intelligence.voidly.ai:8443`; two public Base RPCs; `@voidly/session` SDK; Bankr `/wallet/sign` and `/wallet/submit` documented only | skill itself: none (prepare and verify); payment (EIP-3009 receive/transfer authorization) is left to Bankr + human | local Ed25519 identity signs envelopes (moves no money); payment via Bankr `/wallet/sign` typed data, human-confirmed (V) | payment path yes; shipped scripts no | none (local identity file 0600) | no | voidly-pay/SKILL.md:1-20,40-100,184-256,288-376,377-517,650; scripts/lib/pins.mjs:19,107,120-121; scripts/verify-settlement.mjs:130 |
| wake-token-spotter-analysis | REST `wakeonbase.com/api/spotter/{address}` (free) | read-only | n.a. | n.a. | none | almost pure (one GET) | wake-token-spotter-analysis/SKILL.md:26-57 |
| waybackclaw | REST `waybackclaw.space`; payment by WBC token transfer then tx hash in `X-PAYMENT` header | writes: offchain memory logs (free); pay WBC transfer for reads (1 WBC default) | agent wallet ERC-20 transfer (unspecified) (V) | yes | `WAYBACKCLAW_AGENT_TOKEN` (shown once) | no | waybackclaw/SKILL.md (Setup, Capabilities); references/x402-payments.md:7-9,22-70,88-126 |
| yoink | public RPC eth_call; Bankr arbitrary transaction | writes: `yoink()` game tx | Bankr wallet arbitrary tx JSON (V) | yes | none | no | yoink/SKILL.md (Contract Interface, Yoinking) |
| zapper | placeholder (4 lines) | none | n.a. | n.a. | none | empty stub | zapper/SKILL.md; zapper/catalog.json |
| zerion | REST `api.zerion.io` (API key or x402 $0.01); `zerion-cli`; MCP `zerion-mcp-server`; webhooks; Bankr prompts for execution | read-only data; x402 payments; execution handed to Bankr (stop-loss, DCA, copy trades) | x402 via `@zerion/x402` with `PRIVATE_KEY` or CLI `--x402`; trades by Bankr prompt (V) | yes for payment and trades | `ZERION_API_KEY` or `PRIVATE_KEY` | no | zerion/SKILL.md:19-37,403-420,435-491,522-538; references/x402-reference.md; references/bankr-integration.md:54-171,82,132 |
| zyfai | npm `@zyfai/sdk`; `sdk.zyf.ai` API; MCP `mcp.zyf.ai`; onchain Safe subaccount | writes: deploy Safe, create session key (delegates rebalancing to Zyfai), deposit, withdraw, ERC-8004 register, change strategy | viem WalletClient from `PRIVATE_KEY` / KMS / WaaS, or injected browser wallet (V) | yes (plus ongoing Zyfai session-key execution outside any Executor) | `ZYFAI_API_KEY` (agent can self-create via unauthenticated POST with wallet + email), `PRIVATE_KEY` (V) | no | zyfai/SKILL.md:10-37,49-79,93-172,197-270,448-560,658-729,769 |

Summary (I, from the table): the table has 49 rows (the five uniswap stubs share one row). Read-only or social-only: neynar, polygraph, quicknode (reads), trustlayer, wake, opensea-api (reads), skills/bankr-twitter-agent, onchainkit. Stubs or routers: opensea router, zapper, uniswap group. Every other skill performs or enables a chain write or a wallet signature, and every such path would bypass our Executor as written. None uses a typed-intent path like ours; the closest are pmfi-parbitrage and rider-battle (hard-coded target and selector allowlists) and pantheon-staking (pinned addresses and gates).

---

## 2. Close looks

For each: the action path as written, then the split for our model. "Platform tool" = read-only data tool on our tool servers. "Typed intent" = chain write through policy, simulation, Executor.

### 2.1 opensea-wallet (signing providers, private-key handling)

Action path (V):
- The OpenSea CLI/SDK auto-detects a `WalletAdapter` from env vars in the order Privy, Fireblocks, Turnkey, Bankr, Private Key (opensea-wallet/SKILL.md:135; scripts/opensea-swap.sh provider detection).
- Privy: `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_WALLET_ID`, plus `PRIVY_AUTH_SIGNING_KEY` (an additional-signer P-256 key, never the owner key). Policies evaluated in Privy's TEE (references/wallet-setup.md:46-80).
- Turnkey: non-root API user scoped to sign-only activities; `TURNKEY_RPC_URL` needed because Turnkey only signs and the adapter broadcasts (wallet-setup.md:118-154).
- Fireblocks: API user with `Signer` role only; async MPC signing with polling (wallet-setup.md:181-209).
- Bankr: `BANKR_API_KEY` with dashboard-only scope flags (`readOnly`, `allowedRecipients`, `allowedIps`, daily message limit, `walletApiEnabled`, `agentApiEnabled`) (wallet-setup.md:236-247).
- Raw private key: "local dev only"; the adapter actually uses `eth_sendTransaction` on a dev node and does not sign with `PRIVATE_KEY` (wallet-setup.md:289-312).

Security design worth copying (V):
- Split signing credentials from administrative credentials. The agent must never modify its own policy, rotate its own keys, or export the key (SKILL.md:152-161).
- Policy mutation recipes are deliberately placed in `opensea/docs/policy-administration.md`, outside every skill folder, so a loader that mounts one skill directory never shows them to the agent (SKILL.md:197-199). This is a real example of "keep admin instructions out of agent context".
- Aggregate caps: all four providers only do stateless per-tx checks; the answer is "wallet float" (hot wallet funded for one budget period) (references/wallet-funding.md). Our Executor can enforce stateful caps natively, which is a platform advantage over every provider listed here (I).

Our model:
- This skill has no place as-is. The agent never holds signing credentials, so no provider config should ever reach the sandbox (I).
- Keep as reference for our own Executor policy schema: per-tx value cap, destination allowlist, chain allowlist, method (selector) filter, deny-by-default (references/wallet-policies.md:23-120).
- Audit rule: reject any skill whose frontmatter declares signer env vars (`PRIVATE_KEY`, `PRIVY_*`, `TURNKEY_*`, `FIREBLOCKS_*`, `BANKR_API_KEY`) (I).

### 2.2 suwappu-dex (read-only-by-default MCP with gated execute)

Action path (V): one hosted MCP server. Setup registers it with `--exclude execute_swap` so the default tool list is read-only (`get_quote`, `get_prices`, `get_portfolio`, `list_chains`, `list_tokens`, `get_tempo_tokens`, `browse_mpp_directory`, `predict_markets`, `predict_market_detail`). Enabling `execute_swap <quote_id>` means re-adding the server without the exclude, "on a dedicated trading agent only", with user confirmation and the `quote_id` preserved for audit (suwappu-dex/SKILL.md:32-42,55-63,71-76). Execution happens server-side: "Keys live in Turnkey TEE enclaves; Suwappu enforces 2FA + per-swap/hourly/daily spending limits + tx simulation server-side" (SKILL.md:77-78). The API key comes from an unauthenticated `POST /v1/agent/register` (SKILL.md:25-31).

Good pattern for us (I):
- Tool-surface split at registration time (exclude the one write tool) is exactly our platform-tool vs typed-intent split, applied per build.
- Quote then execute-by-id: the write only references a server-issued quote, so the model cannot alter parameters between approval and execution. Our `propose_swap` should work the same way: quote tool returns a `quote_id` bound to exact parameters, intent references the id, policy and simulation run on the bound parameters.

Caution (I): because Suwappu holds the keys, `execute_swap` would move funds from a Suwappu-custodied wallet, not from the agent's token-bound account. In our model that is custody outside our platform; we should only take the read tools.

Our model:
- Platform tools: `quote`, `prices`, `portfolio`, `list_chains`, `list_tokens`, trending, prediction market reads (proxied through our data tool server with our key).
- Typed intent: `propose_swap(quote_ref)` executed by our Executor against our own router allowlist, not Suwappu's `execute_swap`.

### 2.3 zerion

Action path (V): pure read API (portfolio, positions, PnL, transactions, NFTs, gas, swap offers, webhooks). Access by API key or x402 at $0.01 USDC on Base per request (zerion/SKILL.md:19-22,399-420). The x402 client needs "Private key access for signing" (references/x402-reference.md:147-151; `createZerionX402Client({ privateKey: process.env.PRIVATE_KEY })` at :110-115). Execution is always a Bankr prompt ("Research then Execute" pattern, SKILL.md:24-37). Integration examples auto-execute from data: a webhook handler that buys whenever a whale buys more than $1000, and a loop setting stop-losses, with no confirmation step (SKILL.md:437-491; references/bankr-integration.md:82,132,144).

Note (V): the x402 header in SKILL.md is `X-402-Payment` with a JSON body (SKILL.md:411; x402-reference.md:78), which differs from the `X-PAYMENT` / `PAYMENT-SIGNATURE` headers other skills use. Either Zerion uses a nonstandard variant or the doc is inaccurate (open question).

Our model:
- Platform tools (high value, read): `wallet_portfolio`, `wallet_positions` (with DeFi grouping), `wallet_pnl`, `wallet_transactions` (interpreted), `nft_positions`, `fungible_lookup`, `gas_prices`, `swap_offers` (quote only). Our data server pays Zerion (key or x402) and meters the agent.
- Typed intents: none originate here. Stop-loss, DCA, copy-trade become workflows that call `propose_swap` with approval.
- Webhooks: only via a platform event source feeding workflow triggers, never an agent-hosted HTTP server (I).

### 2.4 quicknode

Action path (V): JSON-RPC read access (balances, `eth_call`, receipts, gas, Solana accounts, DAS, marketplace add-ons including Metis/Jupiter swap API). Two access modes: API key embedded in the endpoint URL, or x402: SIWE/SIWX sign-in to get a JWT, then buy credits in USDC; `@quicknode/x402` "handles this automatically by triggering a new USDC payment" on 402 (quicknode/SKILL.md:15-44,158-162; references/x402-reference.md:18-20,38-45). Mainnet credits: 1,000,000 for $10 USDC; testnet 100 for $0.01. The example passes `evmPrivateKey: process.env.PRIVATE_KEY` (SKILL.md:22-27).

Our model:
- Platform tools: this is "chain tools" infrastructure. It belongs behind our chain tool server as a provider, not as a skill (I). Metis swap endpoints (`quoteGet`, `swapPost`) must not be exposed to agents; swaps go through `propose_swap`.
- Payment: auto top-up of $10 per 402 must be a platform billing concern, never an agent decision (I).

### 2.5 uniswap-driver (deep links for human execution)

External, content not in repo (V: uniswap-driver/SKILL.md is an 11-line stub; catalog.json install.command `npx skills add Uniswap/uniswap-ai`). The description says it plans swaps and LP positions, verifies tokens onchain, researches market conditions, and "generate[s] pre-filled Uniswap interface URLs" for execution (uniswap-driver/SKILL.md:3).

Pattern (I from description; same pattern V in skopos and urizen and trails widget): the agent never signs; it produces a URL the human opens and signs in their own wallet. In our model the owner has no chat channel and the agent never signs, so deep links do not fit the agent path. They could fit the narrator surface as an "owner action" link (for example, top-up or manual override), but they bypass our policy and simulation, so they should be restricted to owner-initiated funding flows (I).

Our model: the planning knowledge (token verification, pool/fee-tier choice, LP range reasoning) is valuable as a Protocol skill; the execution output should be `propose_swap` / `propose_lp_position` intents, not URLs.

### 2.6 splits

Action path (V): the Splits CLI is the programmatic path (pinned `@splits/splits-cli@0.2.9`, also exposes an MCP server) (splits/SKILL.md:42-50). Human creates the API key in the browser (SKILL.md:52-53). The CLI generates a local EOA for the agent and registers it as a signer; a human adds it to an account with threshold 2 by default (SKILL.md:62-87). State changes create proposals: `transactions create transfer|custom`, then `transactions sign`, which auto-submits the UserOp only if threshold is met (references/treasury-workflows.md:341-368). `create custom` accepts raw `{to,data,value}` arrays, so it is an arbitrary-call path (treasury-workflows.md:376-391). Advanced "module" mode enables the Bankr wallet as a module with unilateral `executeFromModule` and "no per-action threshold or spend limit", executed via Bankr `/wallet/submit` (references/bankr-agent-signer.md:226-306). Automations (swap-and-sweep, tax withholding, buybacks) are configured by humans in the web app; CLI can only list and monitor (references/swap-and-sweep.md:17-30).

Strong safety text (V): show account, chain, token, recipient, amount, memo, threshold, approval path before any action; never auto-execute calldata from third-party sources; decode inner calldata; reject unbounded approvals; allowlist `signUrl` hosts to `teams.splits.org` / `app.splits.org` (SKILL.md:153-161; bankr-agent-signer.md:282-291).

Our model:
- Platform tools (read): `splits_accounts_list/get/balances/chains`, `splits_automations_list`, `splits_transactions_list` with filters (accounting surface in references/accounting-analysis.md), all through our tool server with a read-scoped key (`sk_read_...` exists, accounting-analysis.md:133-135).
- Offchain metadata writes (`transactions memo`, `properties set`) are harmless bookkeeping; could be a platform tool with rate limits (I).
- Typed intents: `propose_treasury_transfer(account, chain, token, recipient, amount, memo)` and `propose_treasury_call(account, calls[])` that create a Splits proposal where our Executor (or the agent's TBA) is one signer and the owner co-signs. Module mode should be disallowed (I).
- Key point: the Splits signer key must be the platform's (for example the agent TBA via ERC-1271 or a platform-held signer), never a hot key generated in the sandbox (I).

### 2.7 veil

Action path (V): wraps `@veil-cash/sdk` CLI (global npm install or git clone and build) (veil/SKILL.md:33-47). Deposits: CLI emits unsigned tx JSON (`--unsigned`, USDC gives `[approve, deposit]`), then `veil-bankr-submit-tx.sh` wraps it in a Bankr natural-language prompt "Submit this transaction (do not change any fields):" followed by the JSON, sent to `/agent/prompt` and polled (scripts/veil-deposit-via-bankr.sh; scripts/veil-bankr-submit-tx.sh:23-26; scripts/veil-bankr-prompt.sh:32-36). Withdraw, private transfer, merge run locally with `VEIL_KEY` producing ZK proofs submitted via Veil's relayer (scripts/veil-withdraw.sh, veil-transfer.sh; references/sdk-reference.md:229,312). Keys live in `~/.clawdbot/skills/veil/.env.veil` (templates/env.veil.example). `_common.sh` sources env files with `set -a` (scripts/_common.sh:39-44).

Observations (I): routing a raw tx through a model prompt ("do not change any fields") is the weakest submission mode in the range; the Bankr model could alter or refuse fields. Privacy pools also raise compliance questions for our platform.

Our model:
- Platform tools: `veil_balance(address, pool)`, `veil_status` (read).
- Typed intents: `propose_privacy_deposit(asset, amount)`; withdraw/transfer require a Veil keypair; that key would have to be platform-held and the relayer call made by our tool server. Likely out of scope at launch (I).

### 2.8 voidly-pay

Action path (V): explicitly "PREPARE and VERIFY, not an end-to-end hire". Scripts discover a pinned provider (DID pin, manifest URL pin, worker/accept URL pins, payee pin, price band 0.05 to 5 USDC, canonical Base USDC), seal a brief client-side to the provider's key, and verify settlement against two public Base RPCs (voidly-pay/SKILL.md:40-100,184-256; scripts/lib/pins.mjs:19,107,120-121). Payment (Leg 2) is an EIP-712 signature over USDC `receiveWithAuthorization` (Lane A, provider relays) or `transferWithAuthorization` (Lane B, caller submits), with the nonce bound to the grant hash; signing is Bankr `/wallet/sign` and submission Bankr `/wallet/submit`, documented but not executed by the skill (SKILL.md:288-376). A mandatory pre-signature preview checks payee, amount (atomic and decimal), payer, EIP-712 domain, struct, nonce binding, validity window (SKILL.md:377-517). Installation and identity registration require the human's go-ahead (SKILL.md:130-160,212-230). The skill states that a third-party Bankr round trip has never happened (SKILL.md:248-251).

Our model:
- Platform tools: `verify_settlement(grant_hash, tx)` style verification is pure read and useful (settlement proof against public RPC quorum).
- Typed intent: `propose_x402_payment` generalized to `propose_eip3009_authorization(domain, struct)` with our policy checking payee pin, amount band, and nonce binding. The preview checklist in SKILL.md:476-517 is a ready-made spec for our payment policy check (I).
- The encrypted-hire flow needs a local Ed25519 identity with files at 0600; in our sandbox that key would need to be platform-managed (I).

### 2.9 symbiosis

Action path (V): `symbiosis-swap.py` resolves the Bankr wallet, calls `POST https://api-v2.symbiosis.finance/crosschain/v1/swap` with `partnerId: "bankr"`, then, if `approveTo` is set, submits `approve(approveTo, MAX_UINT256)` via Bankr `/agent/submit`, then submits the API-returned `tx.to` / `tx.data` / `tx.value` unchanged (scripts/symbiosis-swap.py:15-19,104-170). No confirmation prompt, no simulation, no allowlist on `approveTo` or `tx.to` (V by reading the script; SKILL.md has no confirmation instruction).

Risk (I): the approval spender and the call target both come from a third-party API response, with an unlimited approval. This is the pattern our audit pipeline should flag hardest: "API-supplied calldata submitted verbatim" plus "unbounded approve".

Our model:
- Platform tools: `bridge_quote(src_chain, src_token, amount, dst_chain, dst_token)` via our data server.
- Typed intent: `propose_bridge(quote_ref)` with policy: router address must be on our allowlist, exact-amount approval, simulation of the source-chain leg, destination recipient forced to the agent's own address. Chains beyond our supported set are rejected (I).

### 2.10 zyfai

Action path (V): SDK `ZyfaiSDK` connects with an injected wallet, a viem WalletClient (from `PRIVATE_KEY`, KMS, or Turnkey/Privy), or a raw private key string (zyfai/SKILL.md:93-172). Flow: `deploySafe(user, chain, "conservative"|"aggressive")`, `createSessionKey` (lets Zyfai rebalance automatically; "cannot withdraw to arbitrary addresses"), `depositFunds`, `withdrawFunds` (SKILL.md:30-37,197-270). The agent can create its own API key via unauthenticated `POST /api/sdk-api-keys/create` with wallet address and email (SKILL.md:49-79). Data methods: positions, protocols, APY per strategy, earnings (SKILL.md:374-656). `updateUserProfile` changes strategy, protocols, splitting, cross-chain (SKILL.md:448-560). MCP at `mcp.zyf.ai` (SKILL.md:769).

Our model (I):
- Platform tools: `zyfai_apy_by_strategy`, `zyfai_protocols`, `zyfai_positions(user)`, `zyfai_earnings(user)`.
- Typed intents: `propose_vault_deposit` / `propose_vault_withdraw` against the Zyfai Safe. The session key is a standing delegation to an off-platform executor that would rebalance outside our Executor forever after; it must be treated as a separate owner-approved "delegate authority" intent, or not supported. Strategy choice ("conservative"/"aggressive") maps nicely to our "tune parameters of approved strategy templates".

### 2.11 nexus-trading-labs

Action path (V):
- First step of every session: the agent calls Bankr's `sign_message("nexus-trading-key-v1")` and reuses that signature as `walletSig`, a bearer credential for every authenticated endpoint. The skill tells the agent "DO NOT ask the user for a signature. You have sign_message, use it yourself." (SKILL.md:19-29).
- Trades, SL/TP, cancel, leverage, positions go to `og.nexustradinglabs.com` with `walletSig` (Quick Reference table).
- Deposits and withdrawals: the agent asks the user for their Bankr API key and posts it in the JSON body to Nexus's `/proxy/bankr-deposit` and `/proxy/bankr-withdraw`; Nexus's server then submits approve and deposit via Bankr `/wallet/submit`, or signs the Orderly EIP-712 Withdraw via Bankr `eth_signTypedData_v4` (references/deposit-withdraw.md:19-33,84-95). If `allowedRecipients` is set on the Bankr key, deposit returns 403 (deposit-withdraw.md:34).
- Autonomous agent runs server-side on Nexus: modes PAPER / ASSISTED / AUTONOMOUS, `confirm: "GO LIVE"` required for live, an "order-only" key derived from `walletSig` that "cannot withdraw", hard daily-loss cap, max trades/day, kill switch (SKILL.md "Autonomous Agent", "Live activation gate").

Risks (I): (1) a static-message signature used as a reusable bearer credential means anyone who sees it can trade the account; (2) sending the user's Bankr API key to a third-party server gives that server full signing power within the key's scope for as long as it keeps it; (3) the skill steers users away from `allowedRecipients`, the one Bankr control that would limit this.

Good parts (V): strong untrusted-content rules (feed, thesis, webhook payloads are data), PAPER default, explicit GO LIVE disclosure text, "claimed by API" language for unverified leaderboard proofs.

Our model:
- Platform tools: `perp_markets`, `mark_price`, `funding_rate`, `open_interest`, `24h_stats` (Orderly public data), `nexus_leaderboard` (labelled as claims).
- Typed intents: `propose_perp_order(market, side, notional, leverage, sl, tp)`, `propose_perp_deposit`, `propose_perp_withdraw` executed by our Executor with an Orderly-registered key held by the platform.
- The "autonomous agent" and its presets map to a Strategy skill (config template: signalMode, thresholds, caps) plus a Workflow (trigger on funding/OI signals, PAPER vs live approval). The bot itself must run on our side, not Nexus's.

---

## 3. Payment skills in range

| Skill | Protocol | Who pays | 402 challenge handling | What signs | Price (V) | Guardrails (V) |
|---|---|---|---|---|---|---|
| zerion | x402, USDC Base | agent (data consumer) | client or `zerion-cli --x402`; 402 body with `x402.payment{chain,token,amount,recipient,validBefore,nonce}` | ERC-3009 `TransferWithAuthorization` signed by `PRIVATE_KEY` (viem) | $0.01 per call; failed calls not charged | none beyond doc (zerion/references/x402-reference.md) |
| quicknode | x402 + SIWE/SIWX sessions | agent | `@quicknode/x402` auto-pays when credits run out | SIWE/SIWX message + EIP-712 USDC payment from `evmPrivateKey` | $10 USDC per 1,000,000 credits (mainnet); 1 credit per successful call | `preAuth` only; auto top-up (quicknode/SKILL.md:39-44,161; references/x402-reference.md:38-45) |
| moltycash | x402, USDC Base | campaign owner (agent) | `bankr x402 call --max-payment`; verify network, asset, amount vs flat fee; no blind retries | Bankr wallet (EIP-3009, signed inside Bankr) | create $1 (+3% commission on payouts); status/review/close $0.01 | endpoint pin, asset pin, preview before each paid call (moltycash/SKILL.md) |
| onair-shoutout | x402, USDC Base (server also accepts MPP, USDC on Tempo) | sponsor (agent operator wallet) | Python `x402_requests` session; policy hook drops any challenge not matching pins before signing | EIP-3009 via `EthAccountSigner` with `GMFARCASTER_PRIVATE_KEY` | $5 per submission; refunded if declined | payee, asset, network, max price pins; `--confirm` required; custom endpoint opt-in (onair-shoutout/SKILL.md; scripts/request.py:74-97) |
| skopos | x402, USDC Base | agent | pin table: network, scheme `exact`, asset, `payTo 0x76e8...96dd`, timeout <= 300, amount <= published | agent wallet (Bankr) | $0.01 to $0.25 per endpoint (sniper-check $0.25) | per-session cap, idempotent, no blind retry (skopos/SKILL.md Option 2) |
| sleuth-ai | x402 via Bankr's x402 gateway | agent | manifest pin, invoke URL parse pin, single-entry `accepts`, payee pin (Bankr settlement wallet), chain pin, token+scheme pairing, raw price tracking, auto-pay allowlist of 8 endpoints | Bankr CLI (`--max-payment`) or SDK | typically ~$0.10, hard max $1 per call; USDC `exact` or SLEUTH `upto` | the strictest pin set in the range (sleuth-ai/SKILL.md) |
| quotient | x402, USDC Base or USDG Robinhood Chain | agent (Bankr wallet) | scripts pre-flight the 402 (free read), validate network/asset/payee/expiry, clamp `--max-payment` to 2x published price, then `bankr x402 call --yes --raw` | Bankr wallet signs internally (no typed-data inspection possible on this path, stated) | $0.0025 to $0.05 per route | preview + one batched approval per request; approval token 15 min; autopay policy file with per-call $0.05, per-run $0.25, per-day $1.00 defaults; spend ledger; exit codes 10/11/12 (quotient/SKILL.md Paid Calls; references/bankr-x402-flow.md; scripts/payments.sh:527) |
| trustlayer-sybil-scanner | x402 | agent | not specified | not specified | $0.001 per query | none stated |
| productclank | x402 v2 (EIP-3009) or direct USDC transfer + tx hash | agent or owner | `wrapFetchWithPayment(fetch, walletClient)` | `AGENT_PRIVATE_KEY` | credit bundles $2 (40 cr) to $500 (14,000 cr); boost 200 to 300 cr; discover 10 cr + 12 cr/post | cost confirmation before campaign (productclank/SKILL.md:112; references/FUNDING.md:12-17,41-62,118) |
| opensea-tool-sdk | x402 (client and server); facilitators PayAI or Coinbase CDP | tool caller | `paidFetch` parses 402, checks `maxAmount`, `allowedRecipients`, `allowedAssets`, signs, retries with `X-Payment` | EIP-3009 via wallet adapter or `PRIVATE_KEY` | set by tool provider (example $0.01) | client-side max amount and recipient allowlist (references/x402.md) |
| voidly-pay | EIP-3009 receive/transfer authorization bound to a sealed grant (x402-like, not HTTP 402) | hirer | skill does not execute; documents Bankr `/wallet/sign` + `/wallet/submit` lanes | Bankr wallet typed-data signature | pinned band 0.05 to 5 USDC | pinned payee, band, domain, nonce binding, mandatory preview, human confirms every payment (voidly-pay/SKILL.md:288-517) |
| waybackclaw | "x402"-styled but not EIP-3009: pay by ERC-20 WBC transfer, then send tx hash in `X-PAYMENT` | agent | read `accepts[0]`, preview, confirm, send WBC transfer(s) (may be split to another agent's wallet), retry with base64 `{network, txHash}` | agent wallet ERC-20 transfer | 1 WBC default per read; premium 2x; webhooks ~$0.50 in WBC | server checks tx status, recipient, amount, replay (waybackclaw/references/x402-payments.md:25-70,88-126) |
| nookplot | x402 on `api.nookplot.com`; credits via CreditPurchase contract (USDC) | agent | not detailed in SKILL.md | own key | credits packages (economy-overview.md:90-106) | tier caps |
| metr-merchant-payments | not x402; session-based escrow checkout; merchant receives | customer pays; merchant agent ends session to release escrow | n.a. | Metr settles onchain | set per session | withdrawals only in dashboard (metr SKILL.md) |
| signals | free (no payment); EIP-191 signatures for provider identity | n.a. | n.a. | Bankr `/agent/sign` or own key | free | n.a. (signals/SKILL.md) |
| nexus-trading-labs | mentions x402 endpoints that sell Nexus signals priced in $NEXUS (seller side only) | others | n.a. | n.a. | not stated | n.a. (SKILL.md "Proof" section) |

MPP (V): only onair-shoutout mentions that its endpoint also accepts MPP (USDC on Tempo) and that the skill is x402-only (onair-shoutout/SKILL.md:135); suwappu-dex exposes a `browse_mpp_directory` read tool (suwappu-dex/SKILL.md:52). No skill in this range implements an MPP client.

Cross-cutting (I):
- Three signing modes exist for x402: own private key in env (zerion, quicknode, onair-shoutout, productclank, opensea-tool-sdk), Bankr signs internally via `bankr x402 call` (moltycash, quotient, sleuth-ai), and Bankr typed-data sign endpoint (voidly-pay, quotient vanilla lane). The Bankr-internal mode cannot be inspected before signing; quotient says so explicitly.
- For our platform, x402 payment should be one typed intent (`propose_x402_payment(challenge)`) evaluated by policy: network, asset, payee allowlist per skill, amount ceiling per skill and per day, validity window. Better still, metered data calls should be paid by our tool servers (the brief already says tool servers meter paid calls), so the agent never sees a 402 at all.
- The best guardrail designs to copy: quotient (preview, batched approval, standing autopay with caps, ledger), sleuth-ai (full pin set, single `accepts` entry, raw price tracking), onair-shoutout (pins enforced in code before signing), voidly-pay (preview checklist, nonce binding).

---

## 4. Pure knowledge and "almost pure" skills

Pure knowledge / playbook, no external calls of their own (V unless marked):
- `opensea/SKILL.md`: pure router text.
- `zapper`: empty placeholder (description "Placeholder for Zapper skill.").
- `uniswap-cca`, `uniswap-hooks`, `uniswap-viem`: external, content not in repo; descriptions are dev knowledge (auction configuration math, hook security checklist, viem/wagmi). Likely pure knowledge once fetched (I).
- `opensea/opensea-wallet`: a security and configuration playbook; the only calls are provider setup commands a human runs. Knowledge value: the credential-separation model and policy templates.
- `skills/bankr-twitter-agent`: a playbook (persona files, storyline ledger, guardrails, rollout checklist, cron recipes). Uses only X read/write and file edits, which map to baseline X data tools plus a posting tool (I).
- `pi-fire-science`: brand, tokenomics, treasury address, and Bankr prompts; the only action is a buy prompt. Mostly knowledge.
- `stakr`: protocol explanation of ERC-4626 multi-reward vaults with function semantics; execution is just Bankr prompts. Knowledge plus intents.
- `onchainkit`: React component and config knowledge; scripts are dev scaffolding (npm), irrelevant for a trading agent.
- `siwa`: SDK usage knowledge for SIWA auth.

"Almost pure", relying only on baseline tools (chain reads, web, X, Dune) plus at most one simple call:
- `qrcoin`, `yoink`, `megapot` (reads): all state via `eth_call` on known contracts, which our chain tools already cover; writes become intents. Megapot's winnings lookup needs one REST call; its runtime doc fetch should be removed.
- `pantheon-staking`: one registry GET plus chain reads; the rest is gating logic.
- `starchild-dao`: `balanceOf` read plus one GET; the write is an EIP-712 signature.
- `wake-token-spotter-analysis`, `trustlayer-sybil-scanner`: a single REST GET each; trivially wrapped as a data tool.
- `urizen`: keyless GETs; could be a data tool.
- `polygraph`: grade lookup is one call; its value for us is in our audit pipeline, not in agent builds.

---

## 5. Multistep flow skills: skill, workflow, or both

| Skill | Trigger | State | Steps | Guardrails / approval (V) | Recommendation (I) |
|---|---|---|---|---|---|
| rhagent | user message; "Auto onboarding, run on install and first message" (SKILL.md:642); heartbeat every 30 min (SKILL.md:1429-1446; HEARTBEAT.md) | env credentials, `lastRhagentCheck`, `heartbeatMode` state file, registration tokens | connect Robinhood; register on rhagent.bot; trade (Chain via Bankr, App via gateway/MCP); after every fill post to rhagent.bot before replying (Rule 0); browse/comment; copy-trade | ask before placing equity orders (SKILL.md:581-615); confirm copy-trades (Part 5 Step 2); privacy rules on X | Split. Research reads (ticker rooms, leaderboard) could be a Research skill; the mandatory fill posting is a workflow side effect that exports trading data to a third party and should not be allowed by default. Brokerage (Robinhood App) is out of scope for an onchain Executor. |
| signals | heartbeat every 15 to 30 min (signals/HEARTBEAT.md:3) | provider registration, open signals | publish every trade with tx hash; close positions with exit tx and PnL; consume top providers | signatures prove provider identity | Both: a Research skill for reading and filtering providers; an "after each fill" workflow step for publishing, using a platform message-sign intent. Copy trading from signals must be a Strategy workflow with approval. |
| skills/bankr-twitter-agent | cron (5 recipes, UTC) and manual | personality.md, storyline.md, pending approval queue, per-agent bundle | scan mentions, filter, rank, draft, guardrail check, post or queue for approval, update storyline | never reply unprompted; never tag @bankrbot; route addresses and "send X" to approval; follower-weighted approval; manual-first rollout checklist; rollback triggers (SKILL.md:166-215,285-340) | Both. Knowledge (persona method, guardrails) is a skill; the cron recipes are workflows. Its guardrails are a good template for our workflow approval modes. Its @bankrbot rule is the key lesson: social output must never be able to trigger a chain action. |
| nexus-trading-labs (autonomous agent) | server-side signal loop (funding + OI confluence), optional TradingView webhook | agent config on Nexus server, mode, positions | activate PAPER, tune, GO LIVE, monitor, kill | PAPER default; GO LIVE disclosure and confirm; daily loss cap; max trades/day; order-only key; webhook signals PAPER by default | Strategy skill (parameter template: signalMode, thresholds, TP/SL, caps) plus Workflow (trigger on market condition, approval mode "paper" or "live"). Execution on our Executor, not Nexus's bot. |
| zyfai | user request, then Zyfai rebalances continuously via session key | Safe address, session key, strategy | deploy Safe, create session key, deposit, (Zyfai rebalances), withdraw | session key cannot withdraw elsewhere (claim) | Skill for data and deposit/withdraw intents. The continuous rebalancing is an external workflow we cannot supervise; treat delegation as unsupported or as an explicit owner-approved exception. |
| splits treasury ops | user request; human-configured automations fire on receipt | Splits accounts, signer sets, pending proposals, memos/properties | inventory; propose transfer/custom; sign; human co-signs; monitor sweeps; reconcile books | threshold 2 default; show all fields; decode calldata; signUrl host allowlist; module mode opt-in only | Both. Skill: treasury knowledge + read tools. Workflows: payroll run (monthly trigger, fixed recipients, approval required), revenue monitor (event trigger, read-only report), consolidation sweep. |
| quotient | user request; `signal-strategy.mjs` run; `converge-monitor.sh` | autopay policy file, spend ledger, hashed trade plans | read signals, filter by conviction/capacity/upside, equal-weight sizing, Bankr prompts | dry-run default; `--execute` writes a hashed plan (exit 12); `--execute --confirm <hash>` within 10 min; liquidity report before buys | Both. Research skill (forecast reads, monitor vocabulary). Workflow: daily equal-weight signal strategy with the hashed-plan approval pattern mapped to our approval mode. |
| zerion (integration examples) | webhook from Zerion; script loops | none | PnL guardian sets stop-losses; whale copy buys $100 on any whale buy > $1000 | none in the examples | Workflow only, with approval and caps; the examples as written auto-execute from external events and must not be copied. Skill part is pure data tools. |
| megapot subscriptions | onchain `JackpotAutoSubscription` (keeper) | subscription contract | subscribe once, keeper buys daily | confirm writes; mix locked at creation | The subscription is a standing onchain authority; treat creation as an owner-approved intent. Our own recurring buy would be a workflow instead. |
| stakr streaming rewards | "script/cron" top-ups (stakr/SKILL.md streaming section) | vault reward schedule | addRewardToken once, modifyRewardToken repeatedly | none | Workflow (schedule + budget cap) using a skill's intent templates. |
| trails / symbiosis / veil deposit | user request | intent id, tx hashes | quote, commit, submit deposit tx, execute, wait for receipt (trails); quote, approve, swap (symbiosis); unsigned JSON then Bankr prompt (veil) | trails none stated; symbiosis none; veil validates JSON | Skill only: these are single-intent multi-tx recipes. The Executor should handle approve + action atomically or as a bundled intent. |
| moltycash campaign lifecycle | user request | campaign_id | create (pay), fund wallet, status, review, close | preview each paid call; verify returned wallet address; confirm funding | Skill (single-request actions). A "review submissions daily" routine would be a workflow. |
| rider-battle | tweet / user request | matchId, Supabase row, onchain match | read state, transfer, wait confirm, create/join, settle or refund | pinned constants; allowlisted preparer; mandatory confirmation; recovery path | Skill only; the two-step "transfer then call" should become one typed intent with built-in recovery. |
| nookplot runtime | WebSocket events, LLM event loop (`AutonomousAgent`) | gateway state, credits | listen, decide via LLM, prepare, sign, relay | daily relay caps | Not compatible: it embeds its own autonomous agent loop and its own key. At most, a read-only skill for the network's data. |

General rule proposed for the skill vs workflow line (I):
1. **Skill** = what the agent knows and can do in response to a single request: knowledge, read tools, and intent templates (parameter schemas plus safety gates) for bounded actions. A skill has no trigger other than the agent deciding to use it, holds no state between runs beyond the audit log, and grants no standing authority.
2. **Workflow** = anything that acts without a fresh user or owner request: time, event, webhook, or market-condition triggers; loops over runs; persistent state (ledgers, storylines, positions to manage); standing budgets or spend caps over time; and any delegation of future authority (session keys, modules, subscriptions, autopay policies).
3. **Both** when a playbook contains knowledge and also a routine (twitter-agent, splits, quotient, signals, nexus). Ship the knowledge and intent templates as a skill; ship the schedule, state, caps, and approval mode as a workflow that requires that skill.
4. A useful mechanical test for the audit pipeline: if a SKILL.md contains cron expressions, "heartbeat", "every N minutes", "after every trade", webhooks, "autopay", "session key", or "module", split it or reject it as a skill.

---

## 6. Findings for the audit pipeline (red flags and good patterns)

Red flags (V, with cites):
- Third party receives the user's wallet API key: nexus-trading-labs posts `bankrApiKey` to `og.nexustradinglabs.com` (references/deposit-withdraw.md:23,87,92).
- Static signature as bearer credential, self-signed without user: nexus `sign_message("nexus-trading-key-v1")`, "DO NOT ask the user for a signature" (SKILL.md:19-29).
- Brokerage private keys sent to a third-party gateway: rhagent puts `RH_PRIVATE_KEY_BASE64` in `X-RH-Private-Key-Base64` headers to the Railway gateway (rhagent/SKILL.md:884-889; references/CREDENTIAL-BOUNDARY.md:25 admits the gateway "sees Robinhood keys").
- Remote code execution instructions: `curl -fsSL https://rhagent.bot/scripts/generate_rh_keypair.py | python3` (rhagent/SKILL.md:674,907) and download-then-run of `rh-chain-fill-post.sh` (rhagent/SKILL.md:216).
- Skill changes agent tooling via Bankr: rhagent connect code queues a Bankr prompt to add an MCP server (connect/lib/bankr.js:56; references/BANKR.md:601).
- Mandatory data export: rhagent Rule 0, every fill must be posted to rhagent.bot before replying (SKILL.md:55-170).
- Runtime-loaded instructions: megapot fetches task recipes from `llms.megapot.io` at task time ("source of truth", SKILL.md:17); nookplot, signals, rhagent, siwa, voidly point to live `skill.md` / `heartbeat.md` URLs (nookplot/SKILL.md:45; signals/SKILL.md header links; rhagent/SKILL.md:18-19; siwa/references/bankr-signer.md:3).
- Hard-coded monetization: megapot sets `_referrers` to the Megapot operator wallet on every purchase (SKILL.md:74-80).
- Unbounded approval + API calldata submitted verbatim: symbiosis (scripts/symbiosis-swap.py:19,148,164-169).
- Shell injection risk in dev scripts: onchainkit `subprocess.run(cmd, shell=True)` with `f"npm create onchain@latest {project_name}"` (scripts/create-onchain-app.py:18,30).
- Self-provisioned third-party accounts from inside the agent: OpenSea free key via unauthenticated POST (opensea-api/SKILL.md:50), Suwappu (SKILL.md:25-31), Zyfai with email (SKILL.md:49-79), Nookplot (SKILL.md:156-160), WaybackClaw (SKILL.md Setup).
- Secret sent to third party by design: versa posts the vault `secretPhrase` to its backend (versa/SKILL.md Quick Start).
- General egress/compute proxies inside a skill's network: nookplot gateway offers egress proxy, sandbox exec, MCP bridge, BYOK inference that forwards model API keys (nookplot/references/economy-overview.md:41,72,128-160).
- Auto-execution from external events with no confirmation: zerion webhook copy-trade and stop-loss loops (zerion/SKILL.md:437-491).
- Committed credentials: rider-battle Supabase publishable key (SKILL.md Constants; references/supabase.md) and rhagent hard-coded `RH_GATEWAY_SECRET` value (SKILL.md:880).

Good patterns to reuse (V):
- Pinned addresses that registry responses can only fail, never override, plus ordered gates G1 to G8 (pantheon-staking/SKILL.md:21-90).
- Selector and target allowlist in the transaction preparer (rider-battle/scripts/prepareTx.ts:1-49).
- Dry-run then explicit confirm flag, hard-coded endpoint and targets, exact approvals (pmfi-parbitrage).
- Payment previews, batched approval, standing autopay caps, spend ledger, hashed-plan confirmation (quotient).
- Payment pins enforced in code before signing (onair-shoutout/scripts/request.py:74-97; sleuth-ai invariants).
- Read-only by default with the single write tool excluded at registration, quote-id binding (suwappu-dex).
- Signing vs admin credential separation, admin docs kept out of the mounted skill folder (opensea-wallet).
- Human-in-the-loop thresholds and approval URL host allowlist (splits).
- MCP server trust grading with tool-surface fingerprint binding (polygraph). Worth considering inside our own audit pipeline for any tool server we add (I).

---

## Open questions

1. uniswap-cca, uniswap-driver, uniswap-hooks, uniswap-trading, uniswap-viem: content is external (`npx skills add Uniswap/uniswap-ai`); what driver actually outputs (deep links only, or also calldata) cannot be verified from this repo.
2. pi-fire-science is typed external in catalog.json but the repo copy has 140 lines of real content; is the repo copy authoritative or a snapshot?
3. Pantheon, starchild-dao, signa, versa, waybackclaw, yoink do not name the signing tool explicitly; in the Bankr runtime it is presumably the Bankr wallet, but files do not say.
4. Zerion x402 header (`X-402-Payment` with JSON) differs from the standard x402 `X-PAYMENT` / `PAYMENT-SIGNATURE`; files cannot tell which is correct.
5. Suwappu: is `SUWAPPU_API_KEY` alone sufficient to execute a swap from the Suwappu-held wallet, or is there a separate 2FA step per swap? SKILL.md:77 mentions 2FA without detail.
6. Nexus: how long does the Nexus server retain the Bankr API key sent to `/proxy/bankr-*`? Not stated.
7. rhagent Railway gateway: is it operated by the same party as rhagent.bot? CREDENTIAL-BOUNDARY.md calls it "third-party" but the skill author links its GitHub repo.
8. Trustlayer x402: which endpoints are paid and how the challenge is shaped is not documented in the skill.
9. Voidly-pay: the skill states a third-party Bankr round trip has never been exercised; whether Bankr's `/wallet/sign` accepts that EIP-712 shape is unverified.
10. Megapot's runtime-fetched recipes (`llms.megapot.io/tasks/*`) determine actual calldata for bulk buys, subscriptions, and LP actions; their content is outside the repo and could change after audit.
11. Which of these protocols deploy on Monad at all (our launch chain)? Almost every skill here is Base, Arbitrum, or Robinhood Chain only; zerion lists `monad` among supported chains (zerion/SKILL.md:514), trustlayer lists `monad` (SKILL.md Sybil Scan). Others are silent.
12. Rider-battle `bankr.tx.prepare` "button": is this a human-signed confirmation UI or does the Bankr runtime auto-submit in some contexts? Inferred human-tap, not stated.
