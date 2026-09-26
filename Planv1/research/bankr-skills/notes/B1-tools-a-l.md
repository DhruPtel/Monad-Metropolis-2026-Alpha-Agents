# B1: Tools, integrations and actions, skills 0-9 and A-L

Author: sub-agent B1. Repo: /home/dhrupatel/agent_tool/bnkr at HEAD d7b28f4. Read only. No scripts run, no URLs fetched.
Scope: 100 folders (0xwork through lonestaroracle-data). All paths are relative to the repo root.
Labels: **Verified** means it was seen in the cited file. **Inferred** means it is my reading or a guess. Unlabeled table cells are Verified from the cited paths.

Method: I read bankr/ (SKILL.md plus all 20 references) myself. The other folders were read in five parallel read-only passes, which each read SKILL.md, catalog.json, references/ and scripts/ as text. I spot-checked the load-bearing claims (BOTCOIN legacy endpoints, litcoin key forwarding, lienfi weakening settings, aero-stock-lp MAX_UINT256, bankr-shopify Bearer header, lonestar facilitator) with grep.

Legend for the table:
- "Connects to" categories: own scripts, external REST (host), MCP, Bankr (API or `bankr agent prompt`), onchain direct, CLI via npm/npx.
- "Bypass?" means whether the skill, used as written, would move value or sign outside our Executor.

---

## 1. Per-skill table

### 1a. Core, wallet and trading (value-moving)

| skill folder | connects to | chain actions | how chain actions are done | bypass our Executor? | own credentials | pure knowledge? | cite |
|---|---|---|---|---|---|---|---|
| bankr | Bankr REST `api.bankr.bot` (`/wallet/*`, `/agent/*`, launches, profiles, files, LLM credits); LLM gateway `llm.bankr.bot`; x402 Cloud `x402.bankr.bot`; CLI `@bankr/cli` (npm/bun) | writes: swap, transfer, sign, submit raw tx, deploy token, leverage, Polymarket bet, NFT buy, claim, automations, x402 pay | Bankr custodial wallet (Privy) via `/wallet/swap`, `/wallet/transfer`, `/wallet/sign`, `/wallet/submit`, or the async agent `/agent/prompt`; `BANKR_PRIVATE_KEY` for `fees claim-wallet` | yes. It is a complete alternative custody and execution stack | `BANKR_API_KEY` (`bk_...`), `BANKR_LLM_KEY`, `~/.bankr/config.json`; host-managed key via env or egress proxy is documented | no | bankr/SKILL.md:17-24,186-297,437-446,947-1035; references/* (see section 2) |
| aero-stock-lp | Own zero-dependency node scripts. They read public Base RPCs (`mainnet.base.org`, publicnode, drpc) via Multicall3, GeckoTerminal and Coinbase Exchange candles, and write state to `~/.aero-stock-lp/state.json`. Bankr `submit_raw_transaction` and Bankr automations | writes: approve (MAX_UINT256), swap USDC to equity token, mint Slipstream NFT, gauge stake/unstake, withdraw, collect, burn, sell AERO | Scripts emit unsigned `{to,data,value,chainId}`. The agent sends each one to Bankr raw submit and waits for the receipt | yes as written (Bankr). Structurally it is the best fit for us: the scripts never sign | none in scripts (Bankr session) | no (deterministic tool plus strategy) | aero-stock-lp/SKILL.md:14-30,52-137,139-309; scripts/entry.mjs:21,88; scripts/exit.mjs:152-224; scripts/lib/chain.mjs:60,172-200 |
| BOTCOIN | Bankr API (legacy `/agent/me`, `/agent/sign`, `/agent/submit`, plus `/agent/prompt`); coordinator REST `coordinator.agentmoney.net`; mining contract on Base | writes: swap, bridge, approve, stake 25M, unstake, submitReceipt, claim, personal_sign | Bankr prompt for swap and bridge. Coordinator-built calldata goes to Bankr `/agent/submit` unchanged ("no ABI encoding needed") | yes. It signs third-party calldata blind. It also uses endpoints the bankr skill says are removed (bankr/SKILL.md:284-293) | `BANKR_API_KEY` (write, Agent API on), `COORDINATOR_URL` | no | BOTCOIN/skill.md:56,122,135,179,498 |
| 0xwork | CLI `@0xwork/cli@latest` (npm -g); REST `api.0xwork.org`; Base RPC; TaskPoolV4 and AgentRegistryV3 contracts | writes: approve, stake AXOBOTL, claim, submit proof, post task (USDC escrow), approve/reject/cancel, buy product | The third-party CLI signs, using the Bankr remote signer or a local `PRIVATE_KEY`. The key wins when both are set | yes | `BANKR_API_KEY`, `PRIVATE_KEY`, `WALLET_ADDRESS`, `API_URL`, `RPC_URL`; `.env` found by walking parent directories; `0xwork init` writes a raw key to `.env` | no (it contains a good untrusted-content playbook) | 0xwork/SKILL.md:25-28,49-96,170-272,291-358 |
| 1claw | MCP `npx -y @1claw/mcp@0.32.2` (36 tools); REST `api.1claw.xyz`; Shroud TEE LLM proxy; CLI `@1claw/cli`; leases Bankr keys | writes: submit_transaction, sign tx/message/typed data, Safe proposals; secret CRUD | 1Claw vault-held keys via its Intents API, with server guardrails and Tenderly simulation | yes. It is a whole alternative custodian | `ONECLAW_AGENT_API_KEY` (`ocv_`), `ONECLAW_*`, operator `BANKR_PARTNER_KEY` | no | 1claw/SKILL.md:40-58,99-146,323-421,467-510; scripts/validate-setup.sh |
| aeon-distribute-tokens | Bankr `/wallet/me`, `/wallet/portfolio`, `/wallet/transfer`; `/agent/prompt` only to resolve @handles | writes: transfer (USDC or ETH, batch) | Bankr `/wallet/transfer` | yes | `BANKR_API_KEY` (wallet API, read-write) | no | aeon-distribute-tokens/SKILL.md:16-103 |
| agenticbets | Own `scripts/agenticbets.py`; REST `agenticbets.dev`; Bankr `/wallet/me`, `/wallet/submit`; optional MCP `npx agenticbets-mcp` | writes: bet (approve plus bet), claim | The script builds raw calldata and sends it to Bankr `/wallet/submit` on Base | yes | Bankr key from `~/.bankr/config.json` or `$BANKR_CONFIG` | no | agenticbets/SKILL.md:30-59,150-232; scripts/agenticbets.py:18-94,229-248 |
| autoboy | REST `thefirm.biz/api/public/v1` | writes by proxy. A third-party custodial smart wallet (Privy, signer delegated to The Firm) buys at launch. The user funds it with USDC; withdrawals via API | A third party signs with our funds | yes (custody leaves the platform) | Bearer `autoboy_...` | no | autoboy/SKILL.md:40-127; references/for-buyers.md |
| azzle | Own scripts (`v2-tasks.sh`, `v2-inspect.mjs`, `v2-lib.mjs`) doing Base RPC and `azzle.org` reads; Bankr for writes; npm `@azzle/agents@0.5.0` (install needs approval); XMTP | writes: post, claim, fund, deliver, release, dispute, approvals, fundWithUsdc/Eth | Bankr-prepared transactions. Each is decoded locally and checked against a pinned selector/ABI allowlist and code hashes before submit | yes as written. It has the strongest pre-sign gate in range | Bankr login; `BASE_RPC_URL`, `AZZLE_API_URL` | no | azzle/SKILL.md:29-55,141-235; references/signing-allowlist.json; references/sdk-pin.json; scripts/v2-lib.mjs |
| bankr-communities | REST `www.bankr.space`; Bankr `/agent/profile`, `/wallet/submit`; x402 Cloud; Base MCP `mcp.base.org` (`send_calls`); `bankr prompt`; npm `@0xwork/cli@latest` | writes: offchain posts by default. Downstream: QRCoin createBid, 0xWork escrow, POIDH bounty seed | Bankr prompt, `/wallet/submit`, or Base MCP from the fee-recipient wallet. Donor x402 is signed by a human in the browser | yes | `bk_...` key, `CRON_SECRET`, `PLATFORM_AGENT_WALLET`, and others | no | bankr-communities/SKILL.md:54-81,163-252; references/PLATFORM-AGENT-WORKER.md; references/SKILL-LINKED-FUNDRAISERS.md |
| bankr-shopify | Shopify Admin GraphQL; Bankr `/agent/prompt` (sent with `Authorization: Bearer`); mentions Bankr MCP tools | writes: transfer (USDC, loyalty token), x402 settle of a draft order; Shopify mutations | Natural-language Bankr prompt, including from an unattended `ORDERS_PAID` webhook | yes | `SHOPIFY_ACCESS_TOKEN`, `SHOPIFY_STORE_DOMAIN`, `BANKR_API_KEY`, `APP_SECRET` | no | bankr-shopify/SKILL.md:26-55,362-366,378-505 (Bearer at :405,:435) |
| based-mining | x402 on `x402.bankr.bot/0xcea5.../<name>`; polling `api.basedmining.xyz` | writes: pay (x402: `mine` $10, `megapot-ticket` $1, reads $0.01) | x402 `upto` with Permit2 through the Bankr facilitator (`api.bankr.bot/facilitator`). Signer not named (Inferred: Bankr wallet) | yes | none (the wallet is the identity) | no | based-mining/SKILL.md:50-143,166-198,590-660 |
| berry-juicer | REST `juicerapi.berryfi.org`; Bankr `/wallet/me`, `/wallet/sign`; dapp deep link | writes: sign (auth messages that spend inference USDC), vault deposit/withdraw | Bankr personal_sign. Deposits go through the dapp (human) or raw submit | yes for sign and raw submit. Its deposit checklist matches our model | `BANKR_API_KEY` | no | berry-juicer/SKILL.md:24-114,201-271; references/api.md:11-40 |
| blueagent | x402 on `x402.bankr.bot/0xf31f.../`; npm `@blueagent/cli`, `@blueagent/sdk`; installer `npx @blueagent/skill install --claude` | writes: pay (x402, $0.05 to $5.00) | SDK with `WALLET_PRIVATE_KEY`, or the Bankr prompt in the demos | yes | `WALLET_PRIVATE_KEY` | no | blueagent/SKILL.md:13-23,95-117; catalog.json |
| botchan | npm CLI `botchan`; Net Protocol contracts on Base | writes: onchain posts and comments | `BOTCHAN_PRIVATE_KEY` or `--private-key`; or `--encode-only` then a Bankr "submit transaction" prompt | yes (key path). The encode-only path maps to a proposed tx | `BOTCHAN_PRIVATE_KEY`, `BOTCHAN_CHAIN_ID` | no | botchan/SKILL.md:20-98,167-193 |
| capacitr | REST `app.capacitr.xyz`; own `scripts/analyze.sh`, `discovery.sh` (curl/jq) | writes: pay (x402 in USDC or $CAPACITR) | Signed by the agent platform: EIP-3009 (USDC), Permit2 plus an EIP-2612 permit for MaxUint256 ($CAPACITR), or ERC-7710 delegation; pre-signed `X_PAYMENT` env | yes | `CAPACITR_BASE_URL`, `X_PAYMENT` | no | capacitr/SKILL.md:15-265; references/x402-flow.md:10-140; scripts/analyze.sh:16 |
| cattown | REST `api.cat.town`; direct contract calls on Base; Bankr CLI | writes: stake, claim, restake, unlock, unstake, approve, gacha (ETH for VRF), setApprovalForAll plus sell | Raw calldata via Bankr prompt or CLI | yes (the call specs are precise enough for typed intents) | Bankr read-write key | no (reads are "almost") | cattown/SKILL.md:1-140,520-575; references/gacha/contract.md; references/sell-items/contract.md |
| clanker | npm `clanker-sdk`, `viem`; RPCs; Clanker v4 contracts | writes: deploy token plus pool, dev buy, airdrop, claim vault, claim rewards, update metadata | Own `PRIVATE_KEY` in `.env`, viem walletClient | yes | `PRIVATE_KEY`, `RPC_URL_*` | no | clanker/SKILL.md:16-70; references/deployment.md; references/rewards.md:112-138 |
| coffer | Robinhood Chain (4663) CofferVault; RPC reads; connected or Bankr wallet | writes: depositETH, withdraw | The wallet sends after required `eth_call` simulation, a selector check and explicit authorization | yes as written. It is the cleanest typed-intent candidate | none (Bankr wallet) | no | coffer/SKILL.md:19-59,112-188; references/abi-and-calls.md |
| coinhero | REST `my.coinhero.fun/api/agent/deals*`; ConsignmentManager on Base | writes: proposeDeal, approve, deposit, setDailyLimit, addManager, withdraw | The API returns unsigned txs. The bot validates `to`, function and args (no infinite approvals), then signs via the Bankr wallet | yes | `COINHERO_API_KEY` (`chk_`) | no | coinhero/SKILL.md:18-116,184-328 |
| darksol-random-oracle | REST `acp.darksol.net/oracle/*`; oracle contract on Base | writes: pay (x402 $0.05 or $0.25); holder path uses a personal_sign header | "any x402-compatible client"; `x-darksol-signature` for holders | yes | none | no | darksol-random-oracle/SKILL.md:21-77,189-198 |
| delu-oracle | x402 `x402.bankr.bot/0xed2c.../delu-oracle/analyze/{ca}`; optional checkr | writes: pay (x402 `upto`, DELU via Permit2; +$0.45 USDC social add-on) | Runtime x402 client; standalone recipes use a `PRIVATE_KEY` env | yes | `PRIVATE_KEY` (standalone only) | no | delu-oracle/SKILL.md:22-89; references/external-clients.md:83-94; references/social-enrichment.md:167-203 |
| endaoment | Own `search.sh` (REST `api.endaoment.org`), `donate.sh` (RPC eth_call); Bankr CLI | writes: approve plus donate or deployOrgAndDonate (USDC) | `bankr agent "Submit this transaction: {...}"` with calldata built in bash | yes | Bankr login | no | endaoment/SKILL.md:33-79; scripts/donate.sh:39-129 |
| ens-primary-name | Own scripts; public RPCs, ENS subgraph, optional thirdweb; viem (npm -g); Bankr CLI | writes: setName, setText avatar | Bankr "Submit this transaction" prompt with viem-encoded calldata | yes | Bankr login, `THIRDWEB_SECRET_KEY` | no | ens-primary-name/SKILL.md:16-61; scripts/set-primary.sh; scripts/set-avatar.sh |
| erc-8004 | Own scripts; Pinata; RPCs; IPFS; `get-agent.sh` fetches an arbitrary URI; Bankr CLI; optional `agent0-sdk` | writes: bridge ETH, register, update profile | Bankr prompts ("Bridge...", "Submit this transaction..."); SDK path uses `PRIVATE_KEY` | yes | `PINATA_JWT`, Bankr login, `PRIVATE_KEY`, `ETH_RPC_URL` | no | erc-8004/SKILL.md:21-156; scripts/register.sh; scripts/get-agent.sh:60,73 |
| gem-miner | Bankr prompts only; GEM and GemStaking on Base | writes: approve, stake, requestUnstake, withdraw, earlyWithdraw, getReward | Natural-language `bankr "call stake(uint256) on 0x..."` | yes | Bankr | no (a thin prompt catalog, easy to turn into intents) | gem-miner/SKILL.md:10-79 |
| github-vesting | REST `api.proofofdev.xyz/api/agent/*`; Bankr `/wallet/submit`, `/wallet/sign`; GitHub commit | writes: approve plus lock / lockAllowance on GitEscrow, personal_sign | Third-party API prepares txs. They are validated locally against `known-escrow.json` (selectors, spender, no infinite approve), then sent to Bankr `/wallet/submit` | yes (with strong local validation) | Bankr write key; GitHub App | no | github-vesting/SKILL.md:12-189; references/TX-VALIDATION.md; references/TRUST-ONCHAIN.md |
| gitlawb | CLI `gl` (npm, brew, or `curl ... install.sh \| sh`); REST `node.gitlawb.com`; local MCP `gl mcp serve`; Bankr CLI | writes: bounty escrow create/claim/approve, name registry, Ed25519 signing, UCAN | Own keys: `~/.gitlawb/identity.pem`, and `ETH_PRIVATE_KEY` passed as a CLI argument | yes | `ETH_PRIVATE_KEY`, `GITLAWB_KEY`, `GITLAWB_NODE`; edits `~/.claude.json` | no | gitlawb/SKILL.md:32-48,158-321,414-424; scripts/setup.sh |
| gmfarcaster | Own `scripts/query.py` to `api.gmfarcaster.com/v1/query`; alternative npm MCP | writes: pay (x402 exact, about $0.005 per query) | Own key: `x402ClientSync` plus `ExactEvmScheme(EthAccountSigner)`, with a local pin policy | yes | `GMFARCASTER_PRIVATE_KEY(_FILE)`, pin overrides | no (paid data) | gmfarcaster/SKILL.md:13-105; scripts/query.py:32-149 |
| grantr | Hosted MCP `mcp.grantr.id/mcp` (OAuth); browser handoff | read-only plus prepares unsigned Morpho deposit/withdraw txs | Never signs. It hands off to Bankr or another wallet after explicit confirmation, and forbids free-form Bankr prompt execution | no as written (the Bankr handoff would bypass if wired that way) | OAuth session, passkey; never asks for keys | no | grantr/SKILL.md:10-99; references/workflows.md |
| harness | REST `tryharness.ai/api/external-agent/owner/*`; Bankr wallet | writes: sign (pairing), transfer (deposits), pay credits in $HARNESS | Bankr `/wallet/sign`; Bankr transfer; x402-shaped `direct-transfer` | yes | management token `hmt_...` | no | harness/SKILL.md:21-92; references/management-api.md:83-113 |
| harness-capu | REST `gw.capminal.ai`; CAPU/CAP/sCAP contracts; Bankr | writes: swap, approve, stake, unstake, mint/burn, transfer, SIWE | Host signer, after it demands an unsigned tx to inspect (stops otherwise) | yes (strict preview gates) | `OPENCAP_API_KEY`, `OPENCAP_ACCOUNT_TOKEN` | no | harness-capu/SKILL.md:36-180; references/transaction-safety.md |
| harness-collaboration | REST `tryharness.ai/.../verify`, `/callbacks/bankr`; Bankr wallet tools | writes: any "financial_onchain" class, after authorization | Bankr wallet, only after a one-use Harness authorization | yes as transport. The design is close to our intent model | Bearer in the Harness prompt | no | harness-collaboration/SKILL.md:43-248; references/protocol-reference.md |
| harness-venice | REST `api.venice.ai/api/v1`; DIEM and sVVV contracts | writes: swap, approve, stake, unstake, transfer, personal_sign | Agent wallet direct calls; curl to mint the key | yes | `VENICE_API_KEY` (minted, shown once) | no | harness-venice/SKILL.md:25-178 |
| helixa | Own scripts (curl `api.helixa.xyz`, `mint-agent.js`, `cast`); `@x402/fetch` | reads; writes: mint NFT ($1 x402), SIWA sign | Own `PRIVATE_KEY` / `AGENT_PRIVATE_KEY` with cast or ethers; facilitator Dexter | yes | `AGENT_PRIVATE_KEY`, `PRIVATE_KEY`, `HELIXA_BASE_URL` | no (reads are almost pure) | helixa/SKILL.md:25-311; scripts/helixa-post.sh:19 |
| hoodmarkets | REST `api.hood.markets`; Bankr `/wallet/submit` on chain 4663; Uniswap deep links | writes: deploy token and claim fees (server-side), buy/sell (Pro) | Pro: API calldata, then TX-VALIDATION, then Bankr `/wallet/submit`. Deploy and claim are broadcast by the hood server. Simple swaps use a deep link for a human | yes | Bankr write key; captcha JWT | no | hoodmarkets/SKILL.md:23-321; references/TX-VALIDATION.md |
| hydrex | Bankr prompts; REST `api.hydrex.fi`, `incentives-api.hydrex.fi`; veHYDX, Voter and vault contracts | writes: approve, lock, vote, vault deposit/withdraw, claim, exercise | Bankr natural-language prompts and arbitrary-tx JSON | yes | Bankr | no | hydrex/SKILL.md:1-208; references/locking.md:53-75; references/rewards.md |
| lienfi | MCP over HTTP `api.lienfi.com/api/v1/mcp`; REST; Bankr `/wallet/me`, `/wallet/sign`, `/wallet/submit` | reads; writes: typed-data signs, approve USDC, buyNFT, setApprovalForAll | Bankr sign and submit with server-returned calldata | yes. It also tells operators to weaken Bankr settings (see red flags) | `BANKR_API_KEY`, `LIENFI_BEARER` | no (research part almost pure) | lienfi/SKILL.md:29-92,110-365 |
| litcoin | pip `litcoin` SDK; coordinator `api.litcoin.app`; Bankr LLM gateway; `curl -O .../litcoin_miner.py` | writes: claim, stake, vault, mint, repay, guild, delegate, escrow, faucet | Coordinator builds calldata; "Bankr signs and submits". The Bankr key is sent in request bodies to the coordinator | yes, and it leaks the key to a third party | `BANKR_API_KEY`, optional OpenRouter key | no | litcoin/SKILL.md:12-352; references/protocol.md:47-58,363-365,401-420 |

### 1b. Paid data and oracles (x402), read-only APIs

| skill folder | connects to | chain actions | how | bypass? | credentials | pure knowledge? | cite |
|---|---|---|---|---|---|---|---|
| alchemy | REST/RPC `*.g.alchemy.com`, Notify API; gateways `x402.alchemy.com`, `mpp.alchemy.com`; npx `@alchemy/x402`; npm `@x402/fetch`, `mppx` | read-only data; `eth_sendRawTransaction` documented; writes: pay (x402 EIP-3009, MPP Tempo or Stripe) | Own key in `wallet-key.txt` or `PRIVATE_KEY`/`EVM_PRIVATE_KEY`; catalog says to prefer Bankr `/agent/sign` (a removed endpoint) | yes | `ALCHEMY_API_KEY`, `ALCHEMY_NOTIFY_AUTH_TOKEN`, `PRIVATE_KEY`, `STRIPE_SECRET_KEY` | no (a provider our data tools could absorb) | alchemy/SKILL.md:15-110,219-260; references/x402/*; references/mpp/payment.md:16-125 |
| ai2human-task-router | REST `ai2human.io` (x402 or API key); own `scripts/smoke.mjs` | writes: pay (0.01 USDT0 on X Layer, eip155:196) | An x402 client in the agent runtime; the challenge is pinned to payee, asset and amount; literal `confirm create task` required | yes | `AI2HUMAN_API_KEY` | no | ai2human-task-router/SKILL.md:89-261; references/payment-policy.md |
| agent-wormhole | npx `@builtbyecho/agent-wormhole@0.1.2`; REST `storage.builtbyecho.xyz`; x402 Cloud endpoint; Bankr CLI `x402 call` | writes: pay (x402); holder route uses an EIP-191 signature | `bankr --config $BANKR_PAYER_CONFIG x402 call --max-payment 0.01 -y` | yes (auto-confirmed with `-y`) | `BANKR_OWNER_CONFIG`, `BANKR_PAYER_CONFIG` | no | agent-wormhole/SKILL.md:15-113 |
| checkr | x402 REST `api.checkr.social`; `pip install x402`, `npm install x402-axios` | writes: pay ($0.02 to $0.50) | Generic x402 interceptor with the user's wallet client | yes | none | no (the signal-reading guidance is knowledge) | checkr/SKILL.md:16-107; references/endpoints.md:78 |
| cortx | REST `usecortx.dev/api/v1/reliability/{id}` (no auth) | none | n.a. It never pays or authorizes | n.a. | none | almost | cortx/SKILL.md:12-122 |
| lonestaroracle-data | x402 REST on 49 `*.lonestaroracle.xyz` hosts; optional MCP `mcp.lonestaroracle.xyz` | writes: pay (x402 USDC $0.02 to $2.00) | Agent x402 wallet; Coinbase CDP facilitator | yes | none (a funded wallet) | almost (data, but every call is paid) | lonestaroracle-data/SKILL.md:15-95; references/catalog.md |
| b20-console | Own `scripts/inspect-b20.js` to `b20.charon.codes/api/inspect` | read-only | n.a. | n.a. | none | almost | b20-console/SKILL.md:23-89; scripts/inspect-b20.js |
| defi-native | Own `scripts/pulse.py` (DefiLlama, vaults.fyi); recipes for Morpho, Merkl, CoinGecko, GeckoTerminal, Hyperliquid, RPCs; optional MCP | read-only. Directive 8 says never construct, sign, submit or approve | n.a. | no | optional `VAULTSFYI_API_KEY` (metered, about $0.30/call, user yes each time), `DUNE_API_KEY`, `COINGECKO_API_KEY`, others | almost | defi-native/SKILL.md:24-49; scripts/pulse.py; api-routes.json |
| juicebox-v6 | Knowledge bundle (50+ modules, ABIs, manifest); mentions Bendystraw GraphQL, Relayr, Etherscan, RPCs; maintainer build scripts | read-only by default; writes possible (pay, cash out, deploy, loans) | "Bankr's wallet/signing flow or the user's approved signer" after a review, simulate, prove pipeline | yes for writes; defaults to an unsigned tx plan | optional `BENDYSTRAW_API_KEY`, `ETHERSCAN_API_KEY` | almost | juicebox-v6/SKILL.md:10-53; references/modules/jb-tx-safety.md |
| bankr-token-scam-analysis | Bankr agent built-in tools (token_search, read_contract, market_intelligence, browse_url, and others); `execute_cli` with viem@2.21.55; RPCs | read-only | n.a. | n.a. (it does run npm at runtime) | optional `*_RPC_URL` | almost (tool names need remapping) | bankr-token-scam-analysis/SKILL.md:48-106 |

### 1c. Aeon suite (24)

| skill folder | connects to | chain actions | bypass? | credentials | pure knowledge? | cite |
|---|---|---|---|---|---|---|
| aeon-autoresearch | local files; rewrites a target SKILL.md; git branch | none | n.a. | none | yes (meta, self-modifying) | aeon-autoresearch/SKILL.md:16-59 |
| aeon-deal-flow | web (Crunchbase, TechCrunch, SEC Form D, X, LinkedIn) | none | n.a. | none | almost | aeon-deal-flow/SKILL.md:24-58 |
| aeon-deep-research | web search, docs, prediction markets | none | n.a. | "LLM + search provider keys" (catalog) | almost | aeon-deep-research/SKILL.md:13-35 |
| aeon-defi-monitor | DefiLlama, RPC (Bankr/QuickNode/Alchemy) | read-only; emits text "Submit:" payloads for the operator | no as written | optional `BANKR_API_KEY` | almost | aeon-defi-monitor/SKILL.md:16-68 |
| aeon-defi-overview | DefiLlama, GeckoTerminal, funding aggregators | none | n.a. | none | almost | aeon-defi-overview/SKILL.md:15-43 |
| aeon-distribute-tokens | see table 1a | writes: transfer | yes | `BANKR_API_KEY` | no | see 1a |
| aeon-hacker-news-digest | HN Algolia, Firebase | none | n.a. | none | almost | aeon-hacker-news-digest/SKILL.md:23-54 |
| aeon-huggingface-trending | huggingface.co/api | none | n.a. | none | almost | aeon-huggingface-trending/SKILL.md:15-43 |
| aeon-last30 | Reddit, X, HN, Polymarket, web | none | n.a. | optional Reddit and X credentials | almost | aeon-last30/SKILL.md:23-54 |
| aeon-monitor-kalshi | `trading-api.kalshi.com` (Bearer) | none; suggests executing via Bankr Submit or AgenticBets | no as written | Kalshi token under three different names (`KALSHI_API_TOKEN`, `KALSHI_TOKEN`, `KALSHI_API_KEY`) | no (new data source) | aeon-monitor-kalshi/SKILL.md:16-75 |
| aeon-monitor-polymarket | gamma-api and clob.polymarket.com; RPC | read-only; emits Submit payloads | no as written | `BANKR_API_KEY` (only for payloads) | almost | aeon-monitor-polymarket/SKILL.md:16-70 |
| aeon-monitor-runners | GeckoTerminal | none | n.a. | none | almost | aeon-monitor-runners/SKILL.md:23-58 |
| aeon-narrative-tracker | xAI x_search, web, memory of previous runs | none | n.a. | optional `XAI_API_KEY` | almost | aeon-narrative-tracker/SKILL.md:15-53 |
| aeon-on-chain-monitor | RPC eth_getLogs, CoinGecko, DefiLlama | read-only | n.a. | RPC endpoint | almost | aeon-on-chain-monitor/SKILL.md:16-58 |
| aeon-paper-pick | huggingface.co/papers | none | n.a. | none | almost | aeon-paper-pick/SKILL.md:16-64 |
| aeon-reg-monitor | Federal Register, CFTC, SEC, FinCEN, EU, ESMA, CourtListener | none | n.a. | none | almost | aeon-reg-monitor/SKILL.md:16-48 |
| aeon-rss-digest | user-configured feed URLs (arbitrary egress) | none | n.a. | none | almost | aeon-rss-digest/SKILL.md:15-52 |
| aeon-skill-evals | local outputs, `evals-state.json` | none | n.a. | none | yes (meta) | aeon-skill-evals/SKILL.md:14-67 |
| aeon-skill-repair | local skill files; WebFetch of URLs the skill references; git branch; auto-applies LOW/MED fixes | none | n.a. | none | yes (meta, self-modifying) | aeon-skill-repair/SKILL.md:17-69 |
| aeon-skill-security-scan | local skills dir, baseline and trust files | none | n.a. | none | yes (meta) | aeon-skill-security-scan/SKILL.md:17-66 |
| aeon-token-movers | CoinGecko | none | n.a. | none | almost | aeon-token-movers/SKILL.md:23-57 |
| aeon-token-pick | output of other aeon skills; web | none (suggests Bankr Submit or AgenticBets) | no | none | yes (rubric) | aeon-token-pick/SKILL.md:14-57 |
| aeon-unlock-monitor | Tokenomist, DefiLlama, CryptoRank, DropsTab, CoinGecko | none | n.a. | none | almost | aeon-unlock-monitor/SKILL.md:14-53 |
| aeon-vuln-scanner | local semgrep, trufflehog, osv-scanner, slither; `gh api` (creates advisories, forks, PRs) | none onchain; GitHub writes | n.a. onchain | `GH_TOKEN` vs `GITHUB_TOKEN` (catalog), repo plus advisory write scope | no | aeon-vuln-scanner/SKILL.md:20-87 |

### 1d. Social, identity, infra, stubs

| skill folder | connects to | chain actions | bypass? | credentials | pure knowledge? | cite |
|---|---|---|---|---|---|---|
| bankr-twitter-agent | X API v2 via `execute_cli` with npm `twitter-api-v2@1.17.2`; Bankr files; Bankr cron automations with Telegram approvals | none directly. It gates @bankrbot tags, which can trigger onchain actions | n.a. (X posting is an external write) | `X_API_KEY`, `X_API_KEY_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` | no (its guardrail logic is a reusable playbook) | bankr-twitter-agent/SKILL.md:30-37,96-101,191-360 |
| codegrid | local macOS app: MCP, Unix socket `~/.codegrid/socket`, `codegrid://` links | none | n.a. | none | no (irrelevant in our sandbox) | codegrid/SKILL.md:52-98 |
| hermesone | npm `hermesone@0.2.0`, installs native apps from GitHub releases | none | n.a. | env flags `HERMESONE_ALLOW_UNVERIFIED`, `HERMESONE_AUTO_INSTALL` | no (an installer) | hermesone/SKILL.md:13-151 |
| base | placeholder (4 lines) | n.a. | n.a. | n.a. | n.a. | base/SKILL.md |
| base-account, base-deploy, base-minikit, base-network, base-node | External, content not in repo. install.command for all five is `npx skills add base/base-skills`. Setup notes: base-account `npm install @base-org/account...`; base-deploy `curl -L https://foundry.paradigm.xyz \| bash` plus a BaseScan key; base-minikit `npm install @farcaster/miniapp-sdk` | unknown (base-deploy Inferred: deploy with own key) | unknown | per setup notes | Inferred: mostly dev knowledge | each `base-*/catalog.json` |
| ethskills-* (16: addresses, audit, building-blocks, frontend-playbook, frontend-ux, gas, indexing, l2s, orchestration, qa, security, standards, testing, tools, wallets, why) | External, content not in repo. Each catalog install.command is `curl -s https://ethskills.com/<name>/SKILL.md` | unknown; descriptions are knowledge (orchestration and wallets mention x402 and approval thresholds) | unknown | unknown | Inferred: yes | each `ethskills-*/catalog.json` |
| hunch | External, content not in repo. install.command: `install the hunch skill from https://github.com/rajkaria/hunch-skills/tree/cabe950.../hunch` | per description: bet USDC on Base via x402, $1 minimum | Inferred: yes | unknown | n.a. | hunch/SKILL.md; hunch/catalog.json:18-22 |
| hunch-bazaar | External, content not in repo. install.command pins `rajkaria/hunch-skills@78803b0.../hunch-bazaar` | per stub: bet ($0.50 min), create/resolve markets, "standing bets", wallet-proof signatures; funds go to a Hunch-controlled settlement account, not escrow | Inferred: yes | unknown | n.a. | hunch-bazaar/SKILL.md:25-53; catalog.json:20-24 |

### 1e. Counts (from the tables above)

- **Value-moving skills (writes, including x402 pay):** about 55 of 100. Every one of them would bypass our Executor as written. Most go through Bankr custody, and a minority (0xwork, alchemy, blueagent, botchan, clanker, gitlawb, gmfarcaster, helixa, erc-8004 SDK path, delu standalone) use their own private key. (Verified per row.)
- **Main execution channels:**
  1. Free-form Bankr natural-language prompts (BOTCOIN, bankr-shopify, endaoment, ens-primary-name, erc-8004, gem-miner, hydrex, cattown, botchan).
  2. Bankr `/wallet/submit` with calldata built by the skill or by a third-party API (agenticbets, github-vesting, hoodmarkets, lienfi, coinhero, BOTCOIN, aero-stock-lp, litcoin).
  3. Own-key signing in the sandbox.
  4. Third-party custody (autoboy, 1claw, hunch-bazaar).
- **Unsigned-tx producers** (easiest to reroute to our Executor): aero-stock-lp scripts, grantr, coinhero API, github-vesting API, hoodmarkets prepare-*, lienfi confirm, azzle, botchan `--encode-only`, bankr `/launch-v3/*/build*`, juicebox (plan mode), coffer. (Verified per row.)

---

## 2. Deep dive: bankr/SKILL.md and bankr/references/*

bankr/ is the core reference. SKILL.md has 1600 lines, and there are 20 reference files totalling about 5,400 lines (Verified).

### 2.1 Integration surfaces (Verified, bankr/SKILL.md:17-24, 56-501)
- **Bankr CLI** `@bankr/cli` (install with `bun`/`npm -g`, frontmatter requires the `bankr` binary). It has namespaces `wallet`, `agent`, `tokens`, `project`, `files`, `club`, `llm`, `x402`, `launch`, `fees`. The CLI also launches Claude Code and OpenCode through the gateway (`bankr claude`).
- **REST `https://api.bankr.bot`.** The authoritative spec is OpenAPI 3.0 at `docs.bankr.bot/openapi/api.yaml`. The skill tells agents to "fetch the spec rather than guessing" (SKILL.md:172-184); we did not fetch it.
- **LLM gateway** at `https://llm.bankr.bot`, OpenAI and Anthropic compatible.
- **x402 Cloud** at `https://x402.bankr.bot`.
- **Auth.** Every call sends the header `X-API-Key: bk_...` (SKILL.md:186-195). The key is created by headless email OTP (`bankr login email`), at the web terminal, or through SIWE login (`bankr login siwe --private-key`). Headless login accepts the Terms of Service on the user's behalf, and the skill tells the agent to get explicit consent first (SKILL.md:42,85). MFA accounts need a browser passkey step-up.
- **Key storage.** `~/.bankr/config.json`, `BANKR_API_KEY`, `BANKR_LLM_KEY`, `BANKR_API_URL`, `BANKR_LLM_URL`, `BANKR_NOT_INTERACTIVE` (SKILL.md:423-481).
- **Host-managed credentials** (safety.md "Host-Managed Credentials"). The host can supply the key as an env surrogate or attach it in an egress proxy. The agent is told not to run `bankr login` or ask for a key when the env var is empty, and not to send an empty `X-API-Key` header. This is Verified and directly relevant: it is the pattern our platform tool servers would use if we ever proxied Bankr.

### 2.2 Endpoint catalogue (Verified, SKILL.md:241-297, 1438-1477, 1569-1582; references)

| layer | endpoints | notes |
|---|---|---|
| Wallet API (sync) | `GET /wallet/me`, `GET /wallet/portfolio` (`?include=pnl,nfts`, `?chains=`), `POST /wallet/swap-quote` (read), `POST /wallet/swap`, `POST /wallet/transfer`, `POST /wallet/sign`, `POST /wallet/submit` | Writes need `walletApiEnabled` and a non-read-only key. Swap takes `slippageBps` (10-2000, default 500), `quoteId`, `idempotencyKey`. Execution slippage is clamped to 2% on the aggregator path (SKILL.md:1407-1420) |
| Agent API (async) | `POST /agent/prompt` (max 10,000 chars, optional `threadId`), `GET /agent/job/{id}`, `POST /agent/job/{id}/cancel` | Job states: pending, processing, completed, failed, cancelled. Returns `response`, `richData`, `statusUpdates` (api-workflow.md:41-192) |
| Removed legacy | `/agent/me`, `/agent/balances`, `/agent/sign`, `/agent/submit` | Still used by BOTCOIN (skill.md:56,135,179), by alchemy/catalog.json, and by safety.md's own read-only table (inconsistent) |
| Public, no auth | `/addresses/resolve`, `/users/search`, `/token-launches`, `/token-launches/quote-tokens`, `/launch-v3/quotes`, `/launch-v3/:token/recipient` | |
| Unsigned-tx builders, no auth | `POST /launch-v3/:token/{recipient/build, operator/build, holders/build-claim, holders/build-stake, holders/build-unstake, fees/build-claim}`, `POST /token-launches/{token}/vesting/build-claim` | These return unsigned transactions "sign and broadcast yourself" (token-deployment.md:313-332). They are a good fit for our Executor |
| Token launch | `POST /token-launches/deploy` (`simulateOnly`), `POST /token-launches/:token/fees/claim`, vesting reads | Limits in SKILL.md:823-844 |
| Profiles | `/agent/profile` CRUD, `/agent/profile/update`, `/agent-profiles/:id/*` | projects.md |
| Files | `/user/files/*` | files.md |
| LLM gateway | `/v1/chat/completions`, `/v1/messages`, `/v1/images/generations`, `/v1/models`, `/v1/credits`, `/v1/usage`; account side `/llm/credits/state`, `/llm/credits/transfer`, `/llm/usage`, `/llm/daily-budget` | llm-gateway.md |
| Automation | none on the API-key surface. Created through `/agent/prompt` in natural language. `/user/automation/*` are session-only | automation.md:117-139 |

### 2.3 Agent prompt API: what it does (Verified)
- One natural-language channel covers trading, cross-chain, limit/stop/DCA/TWAP, Polymarket, Hyperliquid and Avantis leverage, NFT buys, Merkl claims, token launches, x402 calls and deploys, web browsing, file storage, arbitrary transactions, and LLM credit top-ups and transfers (SKILL.md:690-922).
- The default model is "Gemini 3.8 Flash". "Max Mode" swaps in any gateway model billed from LLM credits (SKILL.md:621-635).
- Skills can be installed into the Bankr agent by pasting a GitHub link. Reinstalling replaces the skill. Limits are 1 MB for SKILL.md and 100 KB per reference file (SKILL.md:902-912). Inferred: this is how the repo's third-party skills reach Bankr users.
- Implication for us (Inferred): any skill that says `bankr agent prompt "..."` is delegating both planning and signing to another LLM agent that we do not control. That is incompatible with "agent never signs, typed intents only".

### 2.4 How Bankr gates signing: two independent layers (Verified, SKILL.md:947-1035; safety.md)
A transaction must pass **both** layers to broadcast.

**Wallet-level Security** is set only in the web UI with Privy authentication. An API key can read it (`/user/security`) but cannot change it. It is enforced "at the transaction broadcast chokepoint" (safety.md:9):

| control | default | notes |
|---|---|---|
| Pause all transactions | off | Also halts in-flight broadcasts (safety.md incident response) |
| Daily spending limit | $500 rolling 24h | Enforced on every path, including x402, raw submit and direct signer callers (safety.md "Defaults Are Enforced") |
| Per-transaction limit | $500 | |
| Price impact limit | on, 15% | Checked on the fee-exclusive `swapImpactBps` |
| Permitted recipients | off | New entries wait out a cooldown (default 24h, 0 to 168h). Own addresses are always allowed |
| Arbitrary contract calls | off (blocked) | Blocks `write_contract`, raw `/wallet/submit`, and arbitrary tx tools. Named ops (swap) still work |
| Response channels | all on | X, Farcaster, Telegram |

Behaviour of these controls:
- **Fail-closed pricing.** If USD pricing fails and a limit is on, the tx is rejected (`PRICING_UNAVAILABLE`).
- **Timed windows.** A control can be turned off for 10, 30, 60 or 1440 minutes. The deadline always resolves toward the safer state, is evaluated at read time, and is computed by the server.
- **Raw submit.** `/wallet/submit` prices only the native `value`. Calldata with value 0 counts as $0 and is not recipient-checked. That gap is exactly why the arbitrary-calls switch exists (sign-submit-api.md:159-186).
- **Error codes.** `PER_TX_LIMIT_EXCEEDED`, `DAILY_LIMIT_EXCEEDED`, `RECIPIENT_NOT_PERMITTED`, `RECIPIENT_COOLDOWN`, `PRICING_UNAVAILABLE`. Pause and arbitrary-calls-off return a 403 with no code.
- **Spend log.** Idempotent on tx hash.

**API-key level** (bankr.bot/api-keys):
- Capability flags `walletApiEnabled`, `agentApiEnabled`, `tokenLaunchApiEnabled`, `llmGatewayEnabled`, `readOnly`.
- `readOnly` filters write tools out of agent sessions and returns 403 on `/wallet/swap|sign|submit|transfer`.
- `allowedIps` (CIDR).
- `allowedRecipients` (EVM and Solana). A non-empty list blocks all raw submits, and also refuses Polymarket, NFT buys/mints/listings and airdrops, because those counterparties cannot be checked (SKILL.md:1010; sign-submit-api.md:186).

**Other built-in guards:**
- Protected-token swap guard (staked positions).
- Impostor-token screening, which drops dust that uses canonical tickers.
- Selling your own creator-fee token is blocked; Glidepath is the exit path.
- A security scanner verdict `untrusted_address`. It is cited by hoodmarkets, github-vesting and bankr-communities, which all say "never route around it".
- Location gating for tokenized stocks.
- Launch rate limits (3 per rolling 24h, 1 per minute, name and IP caps).
- Idempotency keys on swaps. Never blind-retry a 504 or LaunchLab 502, because the tx may already be onchain.
- Automations are not idempotent: list them before re-creating (automation.md:135).
- A 2% balance cap in the first 5 minutes after launch.

**Human confirmation:**
- Raw `/wallet/submit` "executes immediately with no confirmation prompt" (sign-submit-api.md:347).
- The agent "may ask for confirmation on large or unusual operations" (safety.md transaction safety).
- For x402 the agent "will always confirm the payment amount and token" (x402-cloud.md:200). The CLI `-y` and `--ni` flags skip that confirmation.
- Bankr has no simulation step exposed to callers, apart from launch `--simulate` (Verified by absence in the files read; Inferred for the server side).

**Inconsistencies found inside bankr/ (Verified):**
- **Key defaults disagree.** SKILL.md:129-137 says new keys default to Agent API on and read-write. safety.md's capability table says `agentApiEnabled` defaults to false and `readOnly` to true. SKILL.md:139 says `bankr login siwe` keys start read-only.
- **Price-impact failure mode disagrees.** SKILL.md:971 and 1372 describe fail-closed when impact cannot be estimated. safety.md "Price Impact Limit" says "when impact can't be estimated it fails open", with LaunchLab as the fail-closed exception.
- **Stale endpoint names.** safety.md read-only table still names `/agent/sign` and `/agent/submit`. sign-submit-api.md error rows say "Agent API access not enabled" for wallet endpoints.
- **Chain list mismatch.** arbitrary-transaction.md lists only chains 1, 137, 8453 and 130. sign-submit-api.md:143 lists 9 chains, including Robinhood 4663 and Arc 5042.

### 2.5 x402 Cloud, from bankr's side (Verified, references/x402-cloud.md)
- **Seller side.** Deploy a `Request -> Response` handler with `bankr x402 deploy`. It is priced in USD per request (USDC or any supported ERC-20 on Base), configured in `bankr.x402.json`.
  - Fees: Free plan (0%, up to 1,000 requests a month), Pro 5%, Enterprise 3%.
  - Limits: 5 MB bundle, 30 s execution, 20 deploys an hour.
  - Listings are public in a marketplace, and the same catalogue backs agent discovery.
- **Buyer side.** Use the agent tool or `bankr x402 call <url> --max-payment <usd>` (default 1, ceiling 10). The cap is what gets sent: an advertised price above the cap fails closed. Other options are `x402-fetch` with a viem private key, or v1 and v2 x402. ERC-1271 and 6492 smart wallets can pay.
- **Settlement.** Payments settle only if the handler returns a status below 400. A Bankr facilitator verifies and settles, using short-lived tokens bound to the endpoint. The payout goes to the endpoint's record, not to anything in the request. The facilitator URL in a 402 is informational only. The payer's address reaches the handler as `x-402-payer`.

### 2.6 LLM gateway (Verified, SKILL.md:568-688; llm-gateway.md)
- Multi-provider access with separate USD credits (not the trading wallet). New accounts start at $0, and calling without credit returns a 402.
- **Privacy tiers.** `standard`, `zdr` and `private` (TEE). They can be set per request, per base path (`/zdr`, `/private`), per model suffix, or account-wide. They fail closed with `422 zdr_unavailable`, and the `X-Privacy-Tier` response header reports the tier actually used.
- **Spend control.** A daily spend budget (rolling 24h) returns 402 `daily_budget_exceeded`. Credit transfers between users are capped at $500 a day, with a 10% burn fee on granted credit. Deprecation is signalled by headers, and a hard-deprecated model returns 410.
- Relevance to us (Inferred): the privacy tier and fail-closed design is a useful reference for our "skill text reaches model vendor" concern.

### 2.7 Automation (Verified, references/automation.md)
- Order types: limit, stop loss, DCA (hourly, daily, weekly, monthly), TWAP, and scheduled commands (any prompt on a cron-like schedule).
- Automations are managed only in natural language. They bind to the wallet behind the key at creation time.
- Bankr Club allows up to 20 concurrent recurring automations.
- To modify one you cancel it and recreate it.
- Solana uses Jupiter Trigger and DCA.
- There are no structured parameters, guardrails or approval modes beyond the wallet limits. The trigger condition is whatever the prompt says.

---

## 3. How payment skills work (x402 and MPP)

### 3.1 Generic x402 flow as described across the range (Verified: bankr/references/x402-cloud.md:260-272; capacitr/references/x402-flow.md; alchemy/references/x402/*; delu-oracle/references/external-clients.md:83-94)
1. The client calls the endpoint and gets HTTP 402.
   - v1: the body carries `{x402Version, accepts:[{scheme, network, maxAmountRequired, asset, payTo, extra}]}`.
   - v2: a base64 `PAYMENT-REQUIRED` header (alchemy).
2. The client picks one `accepts` entry and **signs a payment authorization offchain**:
   - **`exact` + EIP-3009** `transferWithAuthorization`. This is EIP-712 typed data over (from, to, value, validAfter, validBefore, nonce), with the USDC domain "USD Coin" v2. It is gasless for the payer (capacitr x402-flow.md; gmfarcaster; alchemy payment.md:141-149).
   - **`upto` + Permit2**: the payer signs a ceiling and the server settles the actual amount (delu-oracle 250k DELU ceiling; based-mining with `extra.permit2Spender`). Permit2 signatures are single-use, so calls must be sequential (delu-oracle SKILL.md:35-39).
   - **Permit2 + EIP-2612 gas sponsoring**: capacitr signs a MaxUint256 permit to Permit2 once.
   - **ERC-7710 delegation**: capacitr, with MetaMask smart accounts.
   - **`direct-transfer`**: harness. This is not a signature. The agent sends a real ERC-20 transfer, then POSTs the tx hash (harness/references/management-api.md:83-113).
3. The client retries with an `X-PAYMENT`, `Payment-Signature` or `X-Payment` header.
4. The server's **facilitator** verifies the signature and submits it onchain. The payer never pays gas. Facilitators named in range:
   - Bankr (`api.bankr.bot/facilitator`, based-mining; x402-cloud.md:270)
   - Coinbase CDP (lonestaroracle-data SKILL.md:25; capacitr for USDC)
   - Dexter `x402.dexter.cash` (helixa)
   - Alchemy's own gateway facilitator
5. The response includes `PAYMENT-RESPONSE` or `X-PAYMENT-RESPONSE` with the settlement tx hash.

**Who pays and who signs.** In every case in range the payer is the agent's wallet. The signer is one of three things:
- (a) the Bankr custodial wallet through the Bankr agent or `bankr x402 call`: agent-wormhole, bankr-shopify, based-mining (Inferred), delu (runtime);
- (b) a local private key in the sandbox: gmfarcaster, alchemy, helixa, blueagent SDK, checkr client libraries, delu standalone recipes;
- (c) an unnamed "x402-capable wallet": lonestaroracle-data, darksol, ai2human, capacitr, checkr.

**Prices seen** (Verified):

| skill | price |
|---|---|
| gmfarcaster | about $0.005 per query |
| lonestaroracle-data | $0.02 to $2.00 |
| checkr | $0.02 to $0.50 |
| darksol | $0.05 / $0.25 |
| blueagent | $0.05 to $5.00 |
| capacitr | $0.05 / $0.10 |
| based-mining | $0.01 reads, $1 ticket, $10 mine |
| helixa | $1 mint |
| ai2human | 0.01 USDT0 on X Layer |
| delu | DELU tiered, +$0.45 USDC |
| defi-native vaults.fyi | about $0.30 |
| Bankr buyer cap | $10 per request |

**MPP** appears only in alchemy (references/mpp/*):
- The server answers with `WWW-Authenticate`, and the client replies `Authorization: Payment <credential>` via `mppx`.
- Tempo method: `tempo.charge` with a viem `privateKeyToAccount`, signing a TIP-20 transfer.
- Stripe method: a card via a Shared Payment Token created server-side with `STRIPE_SECRET_KEY`.

### 3.2 Guardrail patterns worth adopting (Verified in the cited files)
- **Challenge pinning before signing.** Verify network, asset, payTo, host, path, and amount at or below a cap; refuse on mismatch or redirect.
  - gmfarcaster enforces this in code (scripts/query.py:68-82, `NoMatchingRequirementsError`).
  - Also: lonestaroracle-data SKILL.md:20-60 (catalog ceilings), based-mining (exact price equality and facilitator pin), ai2human (references/payment-policy.md, "402 is only a quote").
- **Cap is what gets sent.** An advertised price never raises the cap (bankr x402-cloud.md:213).
- **Confirmation mode.** One explicit confirmation per paid call (lonestar), or a standing autopay policy with a per-endpoint cap (based-mining SKILL.md:116-120).
- **No blind retries on paid POSTs.** Paid calls are not idempotent. A 202 pending means don't pay again (darksol, lonestar, based-mining, gmfarcaster).
- **Pre-payment reliability check** (cortx). Seven failure stages. Stages 5 to 7 fail after the money has moved, so resource binding plus a freshness under 60 minutes is required (cortx/SKILL.md:49-120).
- **Privacy.** Confirm before sending a wallet address or holdings to a paid endpoint (lonestar).

### 3.3 Mapping to our model (Inferred)
Our x402 path should be a **platform tool** (`pay_x402(url, max_usd)` or a metered data tool) run by our tool server:
- The agent never holds a key.
- The platform wallet or the agent TBA signs the EIP-3009 or Permit2 authorization after policy checks: pinning, caps, per-skill budget.
- Skills contribute only the endpoint catalogue (host, path, schema, expected payTo/asset/price) as data.

Ported skills must have these removed or disabled: `-y` auto-confirm, own-key variables, and MaxUint Permit2 permits. The pin lists in gmfarcaster, lonestaroracle-data and based-mining can be turned into our endpoint allowlist format.

---

## 4. Pure knowledge and "almost pure" skills (easiest to port)

**Pure knowledge / playbook, no external calls** (Verified):
- aeon-token-pick (a rubric over other outputs).
- aeon-skill-evals and aeon-skill-security-scan (meta; local files only; would need adapting to our read-only skills folder).
- aeon-autoresearch and aeon-skill-repair are pure but **self-modifying**. Do not port them as runtime skills. At most, use them as offline tooling for our audit pipeline.
- Knowledge-heavy but not pure:
  - juicebox-v6: protocol knowledge with an unsigned-plan default.
  - bankr-token-scam-analysis: a research method once its tool names are remapped.
  - defi-native: playbook plus keyless data.
- Stubs whose content is external (ethskills-* x16, base-* x5, hunch, hunch-bazaar) are described as knowledge. We cannot assess them; they would need to be fetched and audited.

**Almost pure** (need only baseline web search, X data, Dune or chain reads, or a single keyless public API):
- aeon-deal-flow, aeon-deep-research, aeon-defi-overview, aeon-defi-monitor (read part), aeon-hacker-news-digest, aeon-huggingface-trending, aeon-last30, aeon-monitor-polymarket (read part), aeon-monitor-runners, aeon-narrative-tracker, aeon-on-chain-monitor, aeon-paper-pick, aeon-reg-monitor, aeon-rss-digest (arbitrary feed egress), aeon-token-movers, aeon-unlock-monitor.
- defi-native (DefiLlama and vaults.fyi via pulse.py; metered calls need consent), bankr-token-scam-analysis, juicebox-v6 (indexer and RPC reads), cortx (one keyless API), b20-console (one keyless API).
- The read-only parts of cattown, coffer, lienfi and helixa.
- Each of these needs its specific public hosts added to our data tool servers: DefiLlama, GeckoTerminal, CoinGecko, HN, HuggingFace, Polymarket gamma/clob, regulator sites, cortx, b20.charon.codes (Inferred).

**Not portable as written** (need custody, own keys, native installs or a desktop): codegrid, hermesone, gitlawb, clanker, 0xwork, 1claw, autoboy, litcoin, bankr-twitter-agent (X write keys), aeon-vuln-scanner (binaries plus GitHub write access).

---

## 5. Multistep flow skills: skill, workflow, or both

| flow | trigger | state | steps | guardrails | approval | recommendation |
|---|---|---|---|---|---|---|
| aeon-distribute-tokens (aeon-distribute-tokens/SKILL.md:16-103) | on demand or weekly payout | JSON ledger keyed `list\|recipient\|utc_date` with status and txHash, saved after every row | RESOLVE: key-scope check, balance at least 1.05x total, resolve @handles via the Bankr agent, build the plan. EXECUTE: `/wallet/transfer` per READY row | per-row idempotency, 5% headroom, abort on 403, back off on 429, split lists over 50, skip unresolvable handles; dry-run means RESOLVE only | none mandatory (dry-run preview only) | **Both.** Skill: plan and idempotency method. Workflow: schedule, then plan, then owner approval (or a pre-approved recipient allowlist), then batched `propose_transfer` intents. Handle resolution must be a platform tool |
| aeon monitors (defi-monitor, on-chain-monitor, monitor-polymarket, monitor-kalshi, unlock-monitor, narrative-tracker, digests) | catalog schedule (daily, weekly, 2-hourly) | watchlist YAML; dedup state (e.g. `state/unlock-monitor-seen.json`, aeon-unlock-monitor/SKILL.md:47); memory diff | fetch, compare with thresholds, alert on change | stay silent when unchanged, flag stale data, treat third-party text as untrusted | none (read-only). "Submit:" payloads are text suggestions | **Both.** Skill: analysis method. Workflow: schedule, watchlist as parameters, thresholds, alert, then optionally a `propose_*` intent with approval |
| aero-stock-lp (aero-stock-lp/SKILL.md:52-309) | user request, Bankr automation every 2h, price triggers 0.5-1% inside the band edges | `~/.aero-stock-lp/state.json` (only `entryUsd` and `enteredAt` are unrecoverable from chain), trend-brake history, compound consent | gas preflight, entry plan (gates), one confirmation, swap, size, mint, settle, stake. Manage: hold, or exit begin/finish and re-enter; refresh triggers | quote no older than 900s; pool within 3% of quote; TVL at least $20k; pool age at least 48h; size at most 25% of TVL; volatility brake; minOut 1.5% / 2%; cost hurdle 2x; 1.3x hysteresis; never recenter while in range. All enforced as failing script exit codes | one confirmation per sequence, then a recorded "autonomy grant" means zero further check-ins | **Both.** Strategy template (scripts plus gates, tunable width and thresholds) as a skill. Workflow holds schedule, price triggers and approval mode (replacing the "autonomy grant"). Unsigned tx lists become intents. Replace MAX_UINT256 approvals with exact ones |
| bankr automation (bankr/references/automation.md) | price condition or schedule, expressed in natural language | Bankr server-side | limit, stop, DCA, TWAP, scheduled prompt | wallet limits only; not idempotent | implicit at creation | **Workflow.** These are our workflow primitives (trigger, conditions, steps). Rebuild them natively with typed parameters. Do not delegate to Bankr |
| BOTCOIN mining (BOTCOIN/skill.md) | user request; claim polling every few hours | coordinator auth token, epochs | balance check, buy, stake (2 txs), auth, loop of challenge, LLM solve, submit receipt, claim | coordinator text treated as data | none | **Workflow** (loop plus staking) using a skill (solve method). Third-party calldata needs Executor simulation and a target allowlist |
| 0xwork session (0xwork/SKILL.md:170-358) | work session | `memory/0xwork-tasks.json` | discover, screen, claim, deliver, submit | 1 active task, at most 5 claims a day, injection screen, skip safetyFlags | none | **Both** (selection playbook as a skill; claim and submit loop as a workflow). Custody is a blocker |
| harness-collaboration (harness-collaboration/SKILL.md:55-248) | "HARNESS COLLABORATION PROTOCOL" header | ledger keyed by authorizationId, limitsHash, sessionId | verify session, research, POST proposal (side-effect classes, maximumGrossUsd, pinned expectedEffects, expiry up to 30 min), decision (authorize, deny, park), validate one-use authorization, ledger, execute once, verify receipts, `done` block | local limit enforcement, pinned host, stop after 3 no-progress exchanges | server-side or parked for the user | **Both.** It maps almost 1:1 onto our workflow plus `propose_*` model and is the best design reference in range |
| lienfi purchase (lienfi/SKILL.md:136-309) | user wants a lien | operator bearer, 10-minute reservation, 300-second price signature | research, human browser authorization, key proof and consents, register, quote, reserve, acknowledgment, confirm (approve, buyNFT, setApprovalForAll), sequential submit, verify | one purchase in flight, exact approvals, a timeout is not a revert | operator caps (only the per-lien cap is enforced) | **Both.** The 3 txs become typed intents |
| github-vesting lock (github-vesting/SKILL.md:121-189) | user message or tweet | pinned intent, `known-escrow.json` | lock API, validate txs (1-2 txs, chain 8453, value 0, selector allowlist, spender equals escrow, no infinite approve), approve, lock, confirm-lock | stop on `untrusted_address`, URL allowlist | implicit; explicit only for repo-claim commit | **Both.** The validation checklist becomes Executor policy |
| grantr savings (grantr/SKILL.md:56-99) | user ask | MCP session | resolve, opportunities, balances, prepare unsigned, validate, preview, stop | never signs; MCP content untrusted | explicit final summary | **Skill** with intents. Its prepare-then-validate-then-preview pattern already matches ours |
| based-mining multi-block (based-mining/SKILL.md:597-640) | user buys hashpower | quote with `expires_at`, receipts, `order_id`s | ask blocks, state risk, quote, confirm total, N paid calls (each 402 validated), reconcile, poll `status_url` | spend cap, no auto-retry, host allowlist | explicit, or standing autopay with cap | **Both** |
| azzle task lifecycle | open tasks or claims | onchain state machine (POSTED to RESOLVED) | worker: claim, deliver; poster: fund, release | pins, code hashes, selector allowlist, receipt plus event check | per step | **Both** (protocol skill plus worker and poster workflows) |
| coinhero consignment | user | API deal state | authorize, propose, approve, deposit, setDailyLimit, activate, monitor, withdraw | tx validation, no infinite approvals, per-step confirmation | per step | **Both** |
| cattown staking / gacha | weekly revenue deposits (Mon/Wed); user | chain and API | unlock, wait 14 days, unstake; claim and restake; gacha pay then poll VRF | 100/day gacha cap | user | **Skill**, plus an optional weekly claim workflow |
| gem-miner, harness-capu, harness-venice unstake | cooldowns (7 days, about 1 day) | chain | request, wait, finalize | fresh confirmation per batch | user | **Skill plus a delayed-step workflow** |
| hydrex voting (hydrex/SKILL.md:140-208) | weekly epoch (Thu 00:00 UTC) | API strategies | rank by projectedFee/liveVotingWeight, vote, claim oHYDX with Merkle proofs | none beyond Bankr | none | **Both** (strategy template plus weekly workflow) |
| bankr-communities platform worker | cron `*/15 * * * *` | platform-spaces queue | post milestones; when a goal is met, run QRCoin or 0xWork via Base MCP | 1 post per campaign per day; separate confirmation before skill execution | explicit | **Workflow** composed of several skills |
| bankr-shopify Bridge 3 | Shopify ORDERS_PAID webhook | order id | HMAC verify, read handle, Bankr prompt "send 100 LOYALTY", poll | order-id idempotency | none (unattended) | **Workflow** with spend cap and approval mode. The skill stays knowledge only |
| bankr-twitter-agent crons | UTC cron x5 | personality and storyline files, approval queue | scan, filter, rank, draft, guardrail, post or queue | never tag @bankrbot, VIP and >50k-follower gating | Telegram "approve <id>" | **Workflow** (non-financial). Its approval queue is a good model |
| litcoin flywheel | loop (`mine(rounds=None)`) | coordinator | mine, claim, stake, vault, mint, escrow | 24h delegation window | none | Not portable as written. Would need a full rebuild as a **workflow** |

Rule of thumb from this range (Inferred): if a flow has a schedule, a watchlist, a waiting period or a loop, that part is a **workflow**. Protocol knowledge, endpoint catalogues, validation checklists and scoring rubrics are **skills**. Most value-moving protocol skills need **both**.

---

## 6. Cross-cutting red flags (Verified unless marked)

**Remote code and installs:**
- gitlawb `curl ... install.sh | sh` (SKILL.md:48, scripts/setup.sh:12) and edits `~/.claude.json`.
- litcoin `curl -O litcoin_miner.py` and pip.
- base-deploy `curl -L foundry.paradigm.xyz | bash`.
- ethskills-* fetched from ethskills.com at install time.
- Unpinned `@0xwork/cli@latest`.
- blueagent MCP installer `--claude`.
- hermesone native app installs.
- BOTCOIN and bankr-communities tell the agent to install skills from other repos, and bankr-communities has a "re-install from GitHub main" self-update (SKILL.md:81).

**Key leakage or weakening Bankr's own safety:**
- litcoin sends `bankrKey` to `api.litcoin.app` (references/protocol.md:363-365).
- lienfi tells operators to leave `allowedRecipients` empty and arbitrary contract calls ON, and to raise the daily limit (lienfi/SKILL.md:41-53).
- gitlawb passes `--private-key` on the command line.
- 0xwork writes a raw key to `.env` and discovers `.env` in parent directories.
- harness-venice prints an API key into chat.

**Unlimited approvals:** aero-stock-lp MAX_UINT256 (scripts/entry.mjs:21,88); capacitr MaxUint Permit2 permit.

**Blind third-party calldata:** BOTCOIN coordinator; hydrex Merkle proofs; hoodmarkets server-side deploy and claim. The validating counter-examples are github-vesting, azzle, coinhero and hoodmarkets TX-VALIDATION.

**Confirmation overrides:**
- aero-stock-lp "ZERO further check-ins" after the autonomy grant (SKILL.md:52-66).
- agent-wormhole `-y`.
- bankr-shopify unattended transfers.
- hunch-bazaar "standing bets".
- delu-oracle "do not halt or surface the error" on checkr fallback.

**Behaviour-steering text:**
- bankr-communities forces `use_skill("bankr-communities")` before swaps and deploys, and has forbidden-reply lists.
- alchemy says "Do NOT mention the API key" and bans other data sources, which conflicts with our baseline tools.
- hoodmarkets says to post `*ReplyHint` fields verbatim.

**Self-modifying skills:** aeon-autoresearch and aeon-skill-repair. These conflict with our read-only skills folder and with self-improvement being off.

**Doc inconsistencies:**
- bankr key defaults and price-impact failure mode (section 2.4).
- Kalshi and GitHub token names.
- checkr price for `/v1/bankr` ($0.02 vs $0.05).
- capacitr default asset and method.
- berry-juicer v1 vs v2 auth signature.
- helixa "updates free" vs $1.
- endaoment EIN hyphen handling (SKILL.md:77-79 vs scripts/donate.sh:39-40).
- 1claw MCP pin (SKILL 0.32.2 vs catalog 0.31.1).

**Positive patterns to copy into our audit rules and Executor policy:**
- gmfarcaster and lonestar x402 pinning.
- cortx reliability stages.
- harness-collaboration proposal and one-use authorization ledger.
- azzle and github-vesting selector and code-hash allowlists.
- coffer simulate-then-send.
- juicebox jb-tx-safety pipeline.
- 0xwork untrusted-content section.
- bankr-twitter-agent approval queue.
- Bankr's own fail-closed pricing, timed windows that restore safety, and allowlist-disables-unverifiable-counterparties rule.

---

## Open questions

1. **Bankr OpenAPI spec.** The skill says `docs.bankr.bot/openapi/api.yaml` is authoritative and moves ahead of the skill. We did not fetch it (rule). Endpoint shapes and the key defaults conflict (SKILL.md vs safety.md) cannot be settled from the repo.
2. **Bankr server-side simulation.** Does Bankr simulate transactions before broadcast? The files mention only launch `simulateOnly` and pricing. The skills that ask for simulation do it themselves.
3. **Which wallet signs x402 in skills that don't say.** Several skills say only "x402-capable wallet" (lonestaroracle-data, darksol, ai2human, capacitr). Inferred: the Bankr agent's built-in x402 tool when run inside Bankr.
4. **Facilitator for gmfarcaster, checkr, darksol, blueagent.** Not named in the files.
5. **External stub content.** The ethskills-* (16), base-* (5), hunch and hunch-bazaar content is not in the repo. Their tools, keys and actions cannot be assessed without fetching the pinned sources, which is out of scope here.
6. **Legacy endpoints.** Whether `/agent/sign` and `/agent/submit` still work (BOTCOIN, alchemy catalog) or fail: the bankr skill says removed.
7. **Chain coverage.** Whether any in-range protocols deploy on Monad. None mention Monad in the rows above (Inferred from the absence of Monad in the hosts and chain ids reported); porting them means redeploys or chain-agnostic knowledge only.
8. **Human confirmation in the Bankr agent.** How reliably does the Bankr agent's "may ask for confirmation" behaviour fire? No policy thresholds are documented.
9. **bankr-shopify auth header.** It sends `Authorization: Bearer ${BANKR_API_KEY}` to `/agent/prompt`, while bankr documents `X-API-Key`. Unknown whether both are accepted.
10. **Content verified second-hand.** Per-row details for non-bankr folders came from the parallel read passes. I spot-checked six claims; the rest have not been re-read line by line by me.
