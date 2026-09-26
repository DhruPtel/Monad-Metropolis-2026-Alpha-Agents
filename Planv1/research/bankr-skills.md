# Discovery report — BankrBot/skills

**Read-only survey.** No files in the target repo were modified.

**Path note.** The task said `./bankr-skills`. There is no such directory. The
clone of `github.com/BankrBot/skills` **is** the primary working directory:
`/home/dhrupatstudio/BNKR_play/repo_research/skills` (`git remote -v` →
`https://github.com/BankrBot/skills.git`, branch `main`, HEAD `8a007c2`). All
file paths below are relative to that directory. This report is written to
`repo_research/research/bankr-skills.md` — a sibling of the clone, so the clone
stays clean.

**Flagged inferences** are marked `[INFERRED]`. Everything else is read from the
cited line.

---

## 1. ORIENTATION

### What this repo is

A **marketplace catalog of agent skills**, not an application. It is a flat
collection of directories, one per skill, each containing agent-facing Markdown
instructions and (sometimes) helper scripts. `README.md:8` gives the whole
distribution mechanism:

```
> install the [skill-name] skill from https://github.com/BankrBot/skills/tree/main/[skill-name]
```

There is no build, no test runner at the root, no CI config beyond
`.github/CODEOWNERS`, and no root `package.json`. Skills are consumed by an LLM
agent (Bankr's, or Claude Code) that reads `SKILL.md` into context and then
either follows prose or shells out to the bundled scripts.

### Directory map

```
/                              144 top-level skill directories
├── README.md                  36 KB catalog table + "Adding a Skill" contract
├── featured.json              7 featured slugs (schemaVersion 1)
├── onchainkit.skill           one stray packed-skill artifact
├── .claude/settings.json      repo-wide Claude Code permissions
├── .github/CODEOWNERS
└── <slug>/
    ├── SKILL.md               REQUIRED — frontmatter + agent instructions
    ├── catalog.json           REQUIRED — marketplace metadata, slug == folder
    ├── logo.svg               recommended
    ├── references/            optional deep docs (59 skills have one)
    └── scripts/               optional helpers (29 skills have one)
```

The structure is specified, not just conventional — `README.md:92-130` states
the required layout, the `catalog.json` schema, and that "a folder without a
valid `catalog.json` is skipped".

Counts (measured):

| Thing | Count |
|---|---|
| Top-level skill directories | 144 |
| `SKILL.md` files (incl. nested sub-skills) | 148 |
| `.md` files total | 610 |
| `.json` files | 208 |
| `.sh` / `.mjs` / `.py` / `.js` / `.ts` | 87 / 32 / 14 / 8 / 3 |

Two "suites" dominate the long tail: `ethskills-*` (16 stubs) and `aeon-*` (24
prose-only agent skills). Five `uniswap-*`, five `base-*` and all 16
`ethskills-*` are 11-line pointer stubs that install from elsewhere — e.g.
`ethskills-audit/SKILL.md:11`: "Provided by EthSkills. Installs outside this
repo — see `catalog.json` `install.command`."

### Governance

`.github/CODEOWNERS` puts `/bankr/`, `/README.md` and `/.claude/` behind
maintainer review. `.claude/settings.json` denies reads of `**/config.json`,
`**/.env*`, `**/*.pem`, `**/*.key` for anyone who opens the repo in Claude Code.

---

## 2. AGENT ARCHITECTURE — the distribution

### Code vs prose

**30 of 144 skills (21%) ship executable code. 114 (79%) are prose only.**

And "ships code" overstates it. Ranking the 30 by lines of shipped code:

| Tier | Skills | Code LOC | What the code is |
|---|---|---|---|
| **Substantial engines** (>800 LOC) | `voidly-pay` (8553), `quotient` (3497), `aero-stock-lp` (1897), `defi-native` (1290), `rhagent` (1109), `onchainkit` (1099), `juicebox-v6` (929), `opensea` (923), `pmfi-parbitrage` (894) | 9 skills | real logic |
| **Mid** (200–800) | `azzle`, `erc-8004`, `neynar`, `veil`, `ens-primary-name`, `productclank`, `agenticbets`, `b20-console`, `symbiosis`, `helixa`, `onair-shoutout`, `endaoment` | 12 skills | curl wrappers + some encoding |
| **Token** (<200) | `gmfarcaster`, `rider-battle`, `1claw`, `ai2human-task-router`, `capacitr`, `signals`, `hunch`, `gitlawb`, `bankr-communities` | 9 skills | 5–150 LOC helpers |

The bottom of that list is nearly nothing: `bankr-communities/scripts/get-community-link.sh`
is **5 lines**; `hunch/scripts/walkthrough.sh` is a 58-line demo that deliberately
stops at the 402 challenge (`hunch/scripts/walkthrough.sh:8`); `gitlawb/scripts/setup.sh`
is a 43-line installer.

Of the 9 "substantial" ones, several are not agent logic at all:
`opensea`'s 923 LOC is **29 near-identical curl wrappers** (many 11–15 lines);
`onchainkit`'s 1099 LOC is Python **scaffolding generators**;
`defi-native`'s is a **static-site builder** (`build_site.py`, `site.js`);
`juicebox-v6`'s is a **docs-manifest verifier**;
`voidly-pay`'s 8553 LOC is ~60% tests (`voidly-pay/tests/`, 8 test files).

**So: roughly 4 skills in the repo contain non-trivial agent-serving runtime
logic** — `aero-stock-lp`, `quotient`, `voidly-pay`, `pmfi-parbitrage`.

### What the code actually does

Grouped by function:

1. **Raw JSON-RPC chain reads** — `aero-stock-lp/scripts/lib/chain.mjs`,
   `azzle/scripts/v2-lib.mjs:114`, `voidly-pay/scripts/verify-settlement.mjs:489`,
   `pmfi-parbitrage/scripts/pmfi_parbitrage.mjs:49`, `endaoment/scripts/donate.sh:48`,
   `erc-8004/scripts/get-agent.sh:33`, `ens-primary-name/scripts/verify-primary.sh:63`.
2. **Unsigned calldata construction** — `aero-stock-lp/scripts/lib/chain.mjs:210`
   (`tx()` returns `{label, to, data, value, chainId}` and never signs).
3. **HTTP wrappers with retry** — `opensea/opensea-api/scripts/opensea-get.sh`,
   `helixa/scripts/helixa-get.sh`, `neynar/scripts/neynar.sh`.
4. **x402 payment policy** — `quotient/scripts/payments.sh` (625 LOC, the single
   best guardrail artifact in the repo).
5. **Signing with a raw private key** — only 6 skills:
   `signals/scripts/publish-signal.sh:34`, `productclank/scripts/create-campaign.mjs:101`,
   `helixa/scripts/mint-agent.js:28`, `gmfarcaster/scripts/query.py:105`,
   `onair-shoutout/scripts/request.py:115`, `opensea/opensea-swaps/scripts/opensea-swap.sh:43`.
6. **Scaffolding / doc tooling** — `onchainkit`, `defi-native`, `juicebox-v6`.

### What a well-formed skill looks like

Frontmatter key frequency across all 147 `SKILL.md` files with frontmatter:

```
147 name:        (universal, required)
147 description: (universal, required)
 80 metadata:
 24 tags:        19 visibility:   17 version:   13 license:
  9 homepage:     9 emoji:         7 compatibility:
  5 env:          5 dependencies:  3 credentials:
  1 recommended-models:   (aero-stock-lp only)
```

Only `name` + `description` are load-bearing — `README.md:132` calls them "the
single source for those fields". Everything else is optional convention.

The best-structured skill in the repo is **`aero-stock-lp`** (1 SKILL.md, 382
lines of prose; 8 scripts, 1897 LOC), and its shape is worth copying wholesale:

- `SKILL.md` opens with a **"Division of labor"** paragraph
  (`aero-stock-lp/SKILL.md:14-22`) that states exactly what is code and what is
  model.
- A **calldata hygiene** section before anything else
  (`aero-stock-lp/SKILL.md:68-95`), written because models corrupted calldata in
  production.
- A **command table** (`aero-stock-lp/SKILL.md:123-132`) — every script prints
  exactly one JSON object `{ok, …, txs[], report, next}` and `next` names the
  following command, so the agent is walked through a state machine.
- Reference tables (`aero-stock-lp/SKILL.md:342-353`) that explicitly defer to
  code: "`scripts/lib/markets.mjs` is canonical", "the SKILL.md table is human
  reference" (`markets.mjs:2`).

The best-structured *prose-only* skills are the `aeon-*` family: each is a
60-line output contract. `aeon-deep-research/SKILL.md:22-29` specifies a 5-part
output structure with per-claim source-class tags
(`[primary]/[expert]/[secondary]/[market]`) and confidence tags
(`[established]/[likely]/[contested]`), plus a mandatory adversarial section.
`aeon-token-pick/SKILL.md:14-22` requires falsifiable thesis, entry, kill
criterion, sizing, horizon — and defines `NO_PICK` as a first-class output:
"empirically the highest-EV output on flat days is no pick"
(`aeon-token-pick/SKILL.md:7-8`).

---

## 3. LLM vs DETERMINISTIC BOUNDARY

Most skills draw no boundary at all — 114 are pure prose, so the model does
everything including the arithmetic. The handful that do draw one draw it
sharply, and always the same way: **the model chooses, the code computes.**

### Where the boundary is stated explicitly

`aero-stock-lp/SKILL.md:14-22` is the canonical statement:

> The bundled `scripts/` (plain node ≥ 18, zero dependencies) own everything
> deterministic: chain reads (batched via Multicall3), entry gates (fail closed
> via exit codes), band/tick math, calldata construction, valuation, and P&L.
> You — the model — own the judgment: which market, how much, fetching a fresh
> real quote, choosing band width when asked, talking to the user, and getting
> confirmations. Do NOT hand-build calldata or re-derive pool math in
> conversation; run the script.

`hunch/references/discovery.md:21-25`:

> **The LLM is advisory only.** In `post` mode it proposes *facets* (assets,
> entities, search terms) that become a query string; the deterministic ranker
> over known market ids makes every final pick. The LLM can never select a
> market id or size a bet.

`hunch/references/resolved.md:102`: "The model never picks anything here — it's a
read over…"

`wake-token-spotter-analysis/SKILL.md:13`: "Built on a strict separation between
deterministic data analysis and interpretive judgment — operators see both."

`aero-stock-lp/SKILL.md:206-208`, on the staked-vs-unstaked route decision:
"The scripts do this math; you explain it."

### Is arithmetic, ranking or thresholding done by the LLM?

**In the code-bearing skills: no.** All of it is in code:

- **Arithmetic** — `aero-stock-lp/scripts/lib/math.mjs` holds every price/tick
  conversion, the band construction, the vol estimator
  (`wFromIV(iv) = iv * Math.sqrt(5/252)`, `math.mjs:72-74`), and the
  concentrated-liquidity share formula (`stockShare`, `math.mjs:63-69`). The
  file's own header says the token0/token1 price inversion "lives HERE, once,
  and nowhere else" (`math.mjs:3-4`).
- **Thresholding** — `aero-stock-lp/scripts/entry.mjs:144-182` is a literal array
  of ten gate objects, each `{name, pass, value, limit}`; the first failure exits
  non-zero (`entry.mjs:183-184`). The thresholds are numeric constants in code:
  quote age ≤ 900s, pool within 3% of the real quote, TVL ≥ $20k, pool age ≥ 48h,
  size ≤ 25% of TVL, `|24h move| < 7%` for equities / 15% for crypto.
- **Ranking** — `hunch`'s ranker is server-side; the LLM only supplies facets.
- **Payment caps** — `quotient/scripts/payments.sh:96-114` is a hardcoded
  per-route price table; float math is delegated to `awk` because bash has none
  (`payments.sh:70-73`).

### Where the LLM is trusted with numbers — and the guard

The one place a model-sourced number enters the money path in `aero-stock-lp` is
the **equity quote**: the agent fetches it from web search or market data and
passes `--quote` / `--quote-age-s` / `--iv`. The skill closes the loop by
refusing to guess: `entry.mjs:100-102` fails the `nav` gate outright if those
flags are absent, and `math.mjs:55` throws `"no honest vol input -> no band -> no
entry"`. `SKILL.md:146-147` says it in words: "No honest vol input → the script
refuses — never guess one to get past it."

Then the gate at `entry.mjs:146-151` **cross-checks the model's quote against the
pool's own price** — reject if they differ by more than 3%. That is the pattern:
let the model source an external number, then have code validate it against an
independent onchain source.

---

## 4. STATE AND PERSISTENCE

There is **no shared persistence layer**. Each skill invents its own. Formats are
JSON or JSONL on local disk; nothing uses a database.

| Skill | Location | Format | Contents |
|---|---|---|---|
| `aero-stock-lp` | `~/.aero-stock-lp/state.json` (`SKILL.md:283`) | JSON | position basis + trend-brake history |
| `quotient` | `$XDG_STATE_HOME/quotient-skill/spend-ledger.json`, `pending-approval.json` (`payments.sh:48-53`) | JSON | spend ledger keyed by run id |
| `quotient` (policy) | `$XDG_CONFIG_HOME/quotient-skill/autopay.json` (`payments.sh:50`) | JSON | user-created autopay policy |
| `aeon-distribute-tokens` | unspecified path (`SKILL.md:64-77`) | JSON | `(list, recipient, utc_date)` → status + txHash |
| `aeon-skill-security-scan` | `scan-state.json` (`SKILL.md:42`) | JSON | `sha256(file+line+pattern)` fingerprints for NEW/RESOLVED/PERSISTENT delta |
| `harness-collaboration` | `ledger/authorizations.jsonl` (`references/protocol-reference.md:74-75`) | JSONL append-only | one-use authorization consumption |
| `agenticbets`, `symbiosis` | `~/.bankr/config.json` (`agenticbets/SKILL.md:41`, `symbiosis/SKILL.md:65`) | JSON | Bankr API key (read only) |
| `nookplot` | `~/.nookplot/credentials.json`, `0600` (`references/integrations-mesh.md:181`) | JSON | credentials |

### The two persistence philosophies worth noting

**"The chain is the memory; the file is a cache."** — `aero-stock-lp/SKILL.md:289`.
Only two fields are unrecoverable from chain (`entryUsd`, `enteredAt`); everything
else is re-derived on every manage pass (`SKILL.md:283-289`). If state is lost,
`manage.mjs` still discovers positions from chain and flags `basisEstimated: true`.
There is also a **pointer, not a store**, convention: one line in the runtime's
user-memory file naming where the real state lives (`SKILL.md:291-300`).

**Write-after-every-row idempotency** — `aeon-distribute-tokens/SKILL.md:19`:
"Persist state to disk **after every line**, not at the end." Keyed on
`(list, recipient, utc_date)` so a same-day re-run is a no-op for completed rows
(`SKILL.md:14`).

`quotient` writes atomically via temp-file-then-rename (`payments.sh:75-82`), and
notes the reason its ledger exists at all: paid calls run inside `$(…)` command
substitutions, so shell variables never reach the parent (`payments.sh:55-57`).

---

## 5. EXTERNAL I/O

### Chains touched

| Chain | id | Skills |
|---|---|---|
| Base | 8453 | the large majority |
| Robinhood Chain | **4663** | `hoodmarkets`, `rhagent`, `urizen`, `pantheon-staking`, `quotient`, `bankr`, `skopos` |
| Ethereum mainnet | 1 | `erc-8004`, `ens-primary-name` |
| Arbitrum | 42161 | `nexus-trading-labs` |
| Sepolia | 11155111 | `erc-8004` (testnet flag) |
| Solana, TRON, Bitcoin, TON, 54+ others | — | `symbiosis`, `suwappu-dex` (prose only) |

### Robinhood Chain / 4663 / USDG / tokenized stocks — full inventory

This is the section you asked for, so it is exhaustive.

**`urizen`** — prose only, no scripts. Describes itself as "an AI equity-research
desk + **the first autonomous fund on Robinhood Chain (4663)**"
(`urizen/SKILL.md:4`). This is the closest prior art to what you are building.

- API base `https://urizenfund.com/api`, "public, key-less, CORS-open" GET
  endpoints (`urizen/SKILL.md:21,24`).
- Research surface (`urizen/SKILL.md:29-39`): `/api/quant/ohlc`, `/fundamentals`
  (SEC EDGAR), `/filings` (Form 4), `/ratings`, `/news`, `/macro`, `/market`,
  `/predictions` (Polymarket), and — directly relevant —
  `GET /api/quant/onchain?symbol=URI` described as "**On-chain price + liquidity
  (chain 4663)**" (`urizen/SKILL.md:38`).
- Fund surface (`urizen/SKILL.md:43-50`): `/api/fund/strategies` (mandates +
  cadence), `/book` (positions + NAV), `/mirror` (target weights for copy-trade),
  `/trades` (execution tape), `/signals`, `/stats`.
- Cash leg is **USDG**; `$URI` is `0x970078468807853bc316432e745165eb34398ba3`,
  WETH-paired, 18 decimals (`urizen/SKILL.md:22,100-101`).
- Explorer: `https://robinhoodchain.blockscout.com` (`urizen/SKILL.md:72`).
- The one write path is a ready-to-sign `$URI` buy, and it is guarded by a
  five-clause validation (`urizen/SKILL.md:73-79`): chain exactly 4663, token
  exactly `$URI`, `tx.to` exactly the **Doppler swap router
  `0xe492912F37C2A4eCa45D42DC67548F4C6Cd7ce2B`**, calldata selector exactly
  `0x4d819a2a`, `tx.value` within a user-approved bound.
- Copy-trade weights are explicitly **guidance, not an order**, and require
  per-rebalance confirmation of every token contract, weight, amount, route,
  slippage, chain and total exposure (`urizen/SKILL.md:84-86`).

**`hoodmarkets`** — prose only (14 `.md`, 0 scripts), but it carries the pinned
contract set for chain 4663 in `hoodmarkets/known-contracts.json`:

```json
"hoodmarketsV3Factory": "0x9BDdC8ddf28f5629C989A36Eb5bb6C73cBA60Df5",
"weth": "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
"uniswapV3SwapRouter02": "0xCaf681a66D020601342297493863E78C959E5cb2",
"swapHelper": "0x6373285f77ad0a3f5a441439b3d23d16b79aa585"
```

plus vault, LP locker, fraction deployer, platform fee recipient, and five legacy
factory versions. `hoodmarkets/references/CHAIN-4663.md:7` makes chain support a
hard precondition: "Confirm Bankr wallet / provider **explicitly supports chain
4663**", and `CHAIN-4663.md:23`: "If Bankr returns an error that chain 4663 is
unsupported → **stop**. Do not suggest alternate execution venues."
`hoodmarkets/references/TX-VALIDATION.md:7` requires `chainId === 4663` on every
tx.

**`rhagent`** — 1109 LOC of scripts, all Bankr-API and rhagent.bot HTTP; no direct
4663 RPC. `rhagent/references/CHAIN-SWAPS.md:12-21` is the operational fact table:

| Fact | Value |
|---|---|
| Chain ID | `4663` / Bankr name `robinhood` |
| Native gas | ETH |
| Wrapped | WETH |
| Dollar stable | **USDG** |
| **Not** on this chain | **USDC**, USDT |

`rhagent/references/ONCHAIN-TRADES.md:3` notes public rhagent.bot activity is
"mirrored on Robinhood Chain mainnet (chain ID `4663`) as a permanent public
reference. The platform pays gas."

**`pantheon-staking`** — prose only, but the most rigorous contract reference in
the repo for 4663. `pantheon-staking/SKILL.md:25-28` pins the vault per chain
(Base `0xBf52Aaf8b6C82FaD0220B5378022eA4fC0a98fDb`, RH 4663
`0x541E0a67558bAd0FFb5CD61C7BA2ebB392F33edB`).
`references/staking-contract-rh.md:3-7` records the implementation behind the
proxy (`0xb43e88d96c1c99c7949a32b4996b84181126176d`), `VERSION() == 7`, and the
**exact blocks the facts were read at** (45,334,150 and 45,414,502), on
2026-08-25. `staking-contract-rh.md:20-22` proves shared lineage by bytecode:
"byte-identical (ex-metadata) to the Base V7 implementation … 22,159 bytes on
both, same solc metadata trailer (`64736f6c634300081c` → 0.8.28)". ABI fragments
and selectors are listed at `staking-contract-rh.md:35-55`.

**`quotient`** — the only place a **USDG token address on 4663** appears in code:

```bash
# quotient/scripts/payments.sh:31-32
QP_USDC_ASSET="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"   # Base USDC, eip155:8453
QP_USDG_ASSET="0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"   # Robinhood Chain USDG, eip155:4663
```

It is used as an accepted x402 settlement asset — the 402-challenge validator
accepts either `eip155:8453`+USDC or `eip155:4663`+USDG (`payments.sh:160-162`).

**`bankr`** (the official skill) — `bankr/SKILL.md:900` and
`bankr/references/tokenized-stocks.md` are the authoritative prose. Key facts:
200 Robinhood-issued tokenized stocks/ETFs; USDG is the cash leg; Robinhood
stocks are **18-decimal**, Base B20 equities are **8-decimal**
(`tokenized-stocks.md:67`); tokenized-stock trades require **location
verification** with 30-day expiry, and are unavailable in the US and UK
(`tokenized-stocks.md:73-79`); over the Wallet API a gated swap without a passed
check returns `403` (`tokenized-stocks.md:79`).

**`skopos`** — prose only; claims limit/stop/TP/TWAP orders on Robinhood Chain
including tokenized stocks, returned as a sign-in link rather than calldata
(`skopos/SKILL.md:42-45`).

### Non-Base Uniswap pools

Two hits, both on Robinhood Chain:
- `hoodmarkets/known-contracts.json` → `uniswapV3SwapRouter02`
  `0xCaf681a66D020601342297493863E78C959E5cb2` on 4663, and
  `hoodmarkets/README.md:3` says Simple (V3) tokens "trade on
  Uniswap/DexScreener".
- `urizen/SKILL.md:76` → the **Doppler** swap router
  `0xe492912F37C2A4eCa45D42DC67548F4C6Cd7ce2B` on 4663 (Doppler, not Uniswap
  proper; `bankr/SKILL.md:900` confirms Bankr launches on RH Chain use Doppler).

No skill references Uniswap pools on any other non-Base chain in executable code.

### RPC endpoints hardcoded in code

| File:line | Endpoints |
|---|---|
| `aero-stock-lp/scripts/lib/markets.mjs:7-11` | `mainnet.base.org`, `base-rpc.publicnode.com`, `base.drpc.org` |
| `voidly-pay/scripts/lib/pins.mjs:87-95` | 7-host **reviewed allowlist** (Tenderly, Blast, Nodies, Base, dRPC, MeowRPC, Allnodes) |
| `pmfi-parbitrage/scripts/pmfi_parbitrage.mjs:10-13` | `mainnet.base.org`, overridable only under `PMFI_UNSAFE_DEV_MODE=1` |
| `azzle/scripts/v2-lib.mjs:15` | `BASE_RPC_URL` env or `base-rpc.publicnode.com` |
| `erc-8004/scripts/get-agent.sh:14,19` | `eth-sepolia.g.alchemy.com/v2/demo`, `eth.llamarpc.com` |

**No skill hardcodes a Robinhood Chain RPC URL.** `[INFERRED]` — every RH-chain
action in this repo goes through an HTTP API (Bankr, api.hood.markets,
rhagent.bot, urizenfund.com) rather than direct RPC.

### Non-RPC data sources

`geckoterminal.com` (`aero-stock-lp/scripts/lib/chain.mjs:179`),
`api.exchange.coinbase.com` ticker + candles (`chain.mjs:191,200`),
SEC EDGAR via urizenfund (`urizen/SKILL.md:32-33`), Polymarket
(`urizen/SKILL.md:39`), DexScreener / GoPlus / Etherscan V2
(`wake-token-spotter-analysis/SKILL.md:445-449`), CoinGecko (`aeon-token-movers`),
`robinhoodchain.blockscout.com` (`urizen/SKILL.md:72`),
`api.hood.markets` (`hoodmarkets/references/API-HOST.md:10`).

### Auth methods and secret handling

Four patterns, in descending order of how much they are trusted:

1. **Bankr API key, wallet stays custodied** — the dominant pattern.
   `X-API-Key` header (`aeon-distribute-tokens/SKILL.md:60`), key read from
   `~/.bankr/config.json` (`agenticbets/SKILL.md:41`). Scripts never see a
   private key.
2. **Unsigned calldata handed back to the agent** — `aero-stock-lp`'s `tx()`
   (`chain.mjs:210-219`) and `urizen`'s `/api/fund/quote`. Nothing in the skill
   can sign.
3. **Wallet-signature auth (SIWA/SIWE)** — `helixa/scripts/mint-agent.js:18-25`
   builds `Bearer <address>:<timestamp>:<signature>`.
4. **Raw `PRIVATE_KEY` in env** — 6 skills (list in §2). `gmfarcaster` and
   `onair-shoutout` are the most careful: they prefer a
   `*_PRIVATE_KEY_FILE` path over an inline env var
   (`gmfarcaster/scripts/query.py:98-105`).

Repo-level hygiene: `.claude/settings.json` denies reading `**/.env*`, `**/*.key`,
`**/*.pem`, `**/config.json`. `rhagent/scripts/generate_rh_keypair.py:9` instructs
"Store the private key only in `RH_PRIVATE_KEY_BASE64` on the gateway — never
[locally]". `nookplot` writes credentials `0600`
(`references/integrations-mesh.md:181`). There is a whole skill,
`aeon-skill-security-scan`, dedicated to auditing other installed skills for
"shell injection, secret exfiltration, traversal, prompt-override payloads,
obfuscation" (`README.md:88`).

Counter-example worth flagging: `rhagent/SKILL.md:681` and `:942` print a literal
shared secret value (`RH_GATEWAY_SECRET=uniqueissomethingimtesting`) into the
agent instructions.

---

## 6. MONEY PATHS

### Every path that can spend or sign

| # | Path | Where | Signer |
|---|---|---|---|
| 1 | Bankr Wallet API `POST /wallet/transfer` | `aeon-distribute-tokens/SKILL.md:56-62` | Bankr (custodied) |
| 2 | Bankr arbitrary-tx `/wallet/submit` | `aero-stock-lp/SKILL.md:68-95`, `hoodmarkets/references/BANKR-SUBMIT.md`, `rhagent/references/CHAIN-SWAPS.md:51-76` | Bankr |
| 3 | Bankr CLI x402 payer `bankr x402 call --max-payment` | `quotient/scripts/payments.sh:527` | Bankr |
| 4 | Local private key → x402 / direct tx | `productclank/scripts/create-campaign.mjs:101`, `helixa/scripts/mint-agent.js:28`, `signals/scripts/publish-signal.sh:34`, `gmfarcaster/scripts/query.py`, `onair-shoutout/scripts/request.py`, `opensea/opensea-swaps/scripts/opensea-swap.sh:43` | the script |
| 5 | Ready-to-sign tx returned by a third-party API | `urizen/SKILL.md:55-56` (`/api/fund/quote`) | the human |
| 6 | Sign-in link (no calldata ever reaches the agent) | `skopos/SKILL.md:3` | the human, in-app |

Note the shape: **the repo's norm is that the skill never holds keys.** Scripts
emit unsigned `{to, data, value, chainId}`; the Bankr wallet is the only signer.
`aero-stock-lp/SKILL.md:24-30` states it: "The user's funds stay in their own
Bankr wallet. You never hold keys, and neither do the scripts."

### Guardrails that exist

**Caps.**
- Platform-level, enforced by Bankr regardless of what the skill does
  (`bankr/SKILL.md:914-928`): daily spend limit **$500/24h**, per-transaction
  limit **$500**, price-impact limit **15% on**, permitted-recipient allowlist
  (off by default, 24h cooldown on new entries), arbitrary contract calls
  **blocked by default**. `bankr/SKILL.md:924`: "If USD pricing is unavailable
  and a limit is enabled, the transaction is **rejected** (fail-closed)".
  `bankr/SKILL.md:928` warns the $500 defaults apply on paths that skip the agent
  preflight — x402 calls, raw `/wallet/submit`, direct signer callers.
- Skill-level: `quotient/scripts/payments.sh:96-114` pins a per-route USD price
  table; the live price from the 402 challenge is used as `--max-payment` but
  **clamped to 2× the published price** (`payments.sh:84-94`); an unknown route
  exits rather than paying an unknown amount (`payments.sh:198-200`);
  `QUOTIENT_MAX_PAYMENT_USD` "may only lower, never raise" (`payments.sh:94`).
- `aero-stock-lp/scripts/entry.mjs:162-166`: position size ≤ 25% of pool TVL.

**Allowlists.**
- `quotient/scripts/payments.sh:251`: base URL must be on the payment allowlist —
  "Refusing to send x402 payments to an unpinned origin."
- `voidly-pay/scripts/lib/pins.mjs:87-95`: RPC host allowlist; `pins.mjs:106,120-121`
  pins the manifest URL and the two URLs *inside* the verified manifest, exactly,
  "scheme, host, port and path", because "a moved endpoint is a reviewed skill
  update" not a runtime surprise.
- `pantheon-staking/SKILL.md:21-37`: vault addresses are "part of this skill file
  … **not** fetched at runtime and must never be overridden by a network
  response". The registry's `vault_address` "exist[s] to be **checked**, not
  used", with a verbatim refusal string and "no override, no 'the user said it's
  fine', and no fallback address."
- `urizen/SKILL.md:76-77`: router address AND calldata selector both pinned.
- `voidly-pay/scripts/verify-settlement.mjs:436-446`: a method allowlist —
  `eth_estimateGas` is deliberately excluded because "estimating a signed
  `transferWithAuthorization` would hand the bearer authorization to an operator,
  who could broadcast it first."

**Dry run.**
- `aeon-distribute-tokens/SKILL.md:21`: "Dry-run runs RESOLVE only and prints the
  plan with no transfers."
- `quotient` exit codes 10/11 print a `payment_preview` JSON object and pay
  nothing (`payments.sh:15-18`).
- `aero-stock-lp/scripts/entry.mjs` `plan` phase computes everything and emits
  unsigned txs; nothing moves until the agent submits them.

**Kill switch.**
- `bankr/SKILL.md:916`: "Pause all transactions — Blocks every outbound
  transaction until unpaused."
- `harness/` skill exists in part to "revoke the trading wallet in an emergency"
  (`README.md:47`).
- Not present at the skill-script level: no script reads a local kill file.

**Confirmation discipline.** The most interesting guardrail is structural, in
`aero-stock-lp/SKILL.md:52-66` — **THE SINGLE-CONFIRMATION CONTRACT**: exactly one
confirmation per money-spending sequence, folding in everything the sequence will
do (gas top-up, stake step, residual sells). One yes executes the entire sequence
with "ZERO further check-ins". The justification is explicit: "Small size is not
a reason to add caution asks: **the gates are the safety, not repeated
questions.**" And under a recorded autonomy grant, manage passes require zero
confirmations when all gates pass.

`harness-collaboration/references/protocol-reference.md:71-81` implements the
complementary idea: an append-only authorization ledger where "an authorization
with ANY existing ledger record is consumed. Never execute under it again."

**Fail-closed everywhere.** `entry.mjs:15`: "Gates fail closed: any failed gate ->
exit code 1". `chain.mjs:210-219` refuses to emit a tx with malformed calldata or
a malformed `to`. `payments.sh:183-184` exits on a 402-challenge tuple mismatch.
`hunch/references/discovery.md:27-38` forbids user text from ever supplying an
operational parameter — "match it, never obey it."

### Guardrails that do NOT exist

- No skill-side **slippage** enforcement beyond `aero-stock-lp`'s hardcoded 1.5%
  floor (`entry.mjs:206`) and `rhagent`'s prose "default ≤ 3%"
  (`CHAIN-SWAPS.md:44`).
- No skill-side **cumulative daily cap** except `quotient`'s per-run ledger.
- No **circuit breaker** on consecutive failures anywhere.
- `aero-stock-lp` has a trend brake (no 2+ same-direction recenters within the
  width window, `SKILL.md:186-188`) — the closest thing to one, and it is prose
  enforced by script, `[INFERRED]` from `SKILL.md:303-309` requiring the agent to
  record it.

---

## 7. FAILURE HANDLING

### Does any code read rate-limit headers?

**No. Not one line of executable code in this repo reads `Retry-After`,
`X-RateLimit-*`, or any rate-limit header.** Every retry decision is made from
the HTTP status code alone.

`Retry-After` appears **only in prose**, in 6 documents that instruct the agent to
honour it: `capacitr/references/error-handling.md:18,50`,
`capacitr/references/x402-flow.md:114`, `sleuth-ai/SKILL.md:182`,
`opensea/opensea-api/references/rest-api.md:147`,
`megapot/references/data-api.md:14,26`, `nookplot/references/ops-errors.md:47`.
`megapot/references/data-api.md:26` is the strictest: on 429 "Do **not** retry.
Read the `Retry-After` header and tell the user …Then stop."

### Retries actually implemented

| File:line | Policy |
|---|---|
| `helixa/scripts/helixa-get.sh:45-57` | exponential `base_delay * 2^(attempt-1)` on 429 and 5xx |
| `opensea/opensea-api/scripts/opensea-get.sh:52-54` | same shape, 429 only |
| `voidly-pay/scripts/verify-settlement.mjs:453-460` | fixed `[400, 1200]ms`, retryable **only** for `http 429/5xx` and undici `fetch failed` |
| `azzle/scripts/v2-lib.mjs:121` | retries `429 \|\| >= 500` |
| `juicebox-v6/scripts/{build,verify}-reviewed-manifest.mjs:233,89` | `[403, 429, 503]`, max 5 attempts |
| `aeon-distribute-tokens/SKILL.md:86-87` (prose) | 429 → sleep 60s, retry once, then abort; 5xx → retry once after 10s |
| `quotient/scripts/payments.sh:535` | retry once, and **says the quiet part**: "if the failure happened after payment this may double-charge; check the spend ledger" |

`voidly-pay/scripts/verify-settlement.mjs:447-452` has the best reasoning in the
repo on *why* to retry: "A public operator answers HTTP 429/503 to a burst it
would have answered a second later; that is a rate limit, not a verdict… a
timeout, a body over the cap, a non-JSON body and a JSON-RPC error are all final
on the first read… retrying cannot manufacture a proof, only recover a dropped
read."

### Timeouts

Only **8 files** set any timeout: `helixa/scripts/helixa-{get,post}.sh`,
`opensea/opensea-api/scripts/opensea-{get,post,auth-request-key}.sh`,
`ens-primary-name/scripts/verify-primary.sh`, `quotient/scripts/pm.sh` (all
`curl --connect-timeout 10 --max-time 30`-style), and
`voidly-pay/scripts/verify-settlement.mjs:483` (`AbortController`, 20s).

**`aero-stock-lp` — the best script in the repo — sets no timeout at all.**
`chain.mjs:60-64` and `chain.mjs:172` use bare `fetch` with no `AbortSignal`.
A hung RPC hangs the entry sequence indefinitely.

### Malformed output

- `aero-stock-lp/scripts/lib/chain.mjs:210-219`: `tx()` regex-validates calldata
  and address, throws rather than emitting.
- `quotient/scripts/payments.sh:169-170`: 402 challenge `amount` must match
  `^[0-9]+$` or the tuple is a mismatch.
- `voidly-pay/scripts/verify-settlement.mjs:488-500`: `accept-encoding: identity`
  and a streamed body with a size cap, because "a 4 MiB gzip body decompressed to
  ~4 GiB in RAM before `text.length` was ever compared"; plus
  `redirect: "error"` — "a redirect is a second URL nobody reviewed".
- `aero-stock-lp/scripts/lib/positions.mjs:195-205`: `collect` simulation can
  revert on zero-fee positions; caught, fees stay 0.
- `aero-stock-lp/scripts/lib/chain.mjs:89-109`: Multicall chunked at 50 with
  concurrency 4 "public RPCs reject oversized payloads (HTTP 413)".

### Failover

`aero-stock-lp/scripts/lib/chain.mjs:53-75` rotates through three RPCs and sticks
with whichever answered (`rpcIndex` at `:68`), throwing only when all fail.
`voidly-pay` does the opposite — it requires a **quorum of independent
operators** and refuses on divergence (`pins.mjs:45-49`, `:83-85`): "A
non-archive operator fails the run CLOSED … it can cost you a proof, never fake
one."

---

## 8. CONFIG AND TYPES

### Where tunable values live

There is no config convention. Four patterns:

1. **A canonical code module** — best practice, one instance.
   `aero-stock-lp/scripts/lib/markets.mjs` holds chain id, RPC list, Multicall3,
   token/pool/gauge addresses, tick spacings, fees, all function selectors, and
   `GAS_MIN_ETH = 0.0015` (`:134`). Header at `:2`: "This file is the source of
   truth; the SKILL.md table is human reference."
2. **A pinned JSON file** — `hoodmarkets/known-contracts.json`,
   `hunch/x402-registry.json`, `featured.json`, and each skill's `catalog.json`.
3. **Constants embedded in a shell library** — `quotient/scripts/payments.sh:26-53`
   (host, payee, asset addresses, timeout bound, mode, file paths) plus the price
   table at `:96-114`.
4. **Prose tables in `SKILL.md`** — the overwhelming majority.
   `pantheon-staking/SKILL.md:25-28` is the honest version of this: the prose
   table is explicitly the trust anchor, and is stated to be non-overridable at
   runtime.

Thresholds are almost never externalised. `aero-stock-lp`'s ten gate limits are
inline literals in `entry.mjs:144-182`; the width factors are a frozen map in
`math.mjs:50`. `[INFERRED]` — this appears deliberate: a threshold in a config
file is a threshold an agent or a network response could move.

### Is there a shared types module?

**Not present.** There is no `types.ts`, no `.d.ts`, no shared schema module
anywhere in the repo. Only 3 TypeScript files exist at all
(`rider-battle/scripts/{prepareTx,depositCreate,readMatch}.ts`), and they define
no exported types. There is no cross-skill code sharing of any kind — each skill
is a hermetic directory, which is a deliberate consequence of the
install-one-folder distribution model (`README.md:8`).

The closest thing to a contract is a **documented JSON shape**:
`aero-stock-lp/SKILL.md:118-121` — "Every script prints ONE JSON object to
stdout: `{ok, …, txs[], report, next}`. `ok: false` + non-zero exit means a gate
failed". That single convention is what makes the 8 scripts composable.

---

## 9. DEPENDENCIES

Only **4 `package.json` files** exist in the whole repo.

| Skill | Dependencies | Why it matters |
|---|---|---|
| `aero-stock-lp` | **none** — "plain node ≥ 18, zero dependencies" (`SKILL.md:14-15`) | hand-rolls ABI encoding, Multicall3 tuple encoding, and selector constants (`chain.mjs:111-146`, `markets.mjs:90-124`) to avoid a supply chain. This is why it is the most portable skill here. |
| `voidly-pay` | `@voidly/session@1.0.0`, `ethers@6.17.0`, `tweetnacl@1.0.3`, `tweetnacl-util@0.15.1` — all **exact-pinned** | `package.json` description: "Run `npm ci --ignore-scripts` here (exact versions, integrity-checked, **no install-time code**)". `voidly-pay/tests/prose.test.mjs:113` asserts the docs put `verify-settlement.mjs` *before* `npm ci` — i.e. the verifier must be runnable with no install at all. |
| `pmfi-parbitrage` | `ethers@^6.15.0` | caret range, not pinned |
| `onchainkit` (template) | `@coinbase/onchainkit`, `viem`, `wagmi`, `next`, `react` | scaffolding output, not runtime |

Everything else depends only on the host environment: **`bash` + `curl` + `jq`**
(22 shell scripts use `jq`), `node`, or `python3`. `viem` is imported ad-hoc
without a manifest in `signals/scripts/publish-signal.sh:33`,
`ens-primary-name/scripts/{set-primary,set-avatar,verify-primary}.sh`, and
`productclank/scripts/create-campaign.mjs:21-23` — i.e. those scripts assume a
`viem` install that nothing declares. `helixa/scripts/mint-agent.js:6` documents
`npm install ethers @x402/fetch @x402/evm viem` in a comment only.

**What matters for you:** the zero-dependency approach in `aero-stock-lp` is
viable. Raw `eth_call` + hand-built selectors + Multicall3 covers every read you
need for a fund, in ~225 lines (`chain.mjs`), with no ABI files and no viem.

---

## 10. VERDICT

### Patterns worth stealing

1. **The stated division of labor, at the top of the file.**
   `aero-stock-lp/SKILL.md:14-22`. Name what the code owns (chain reads, gates,
   math, calldata, valuation, P&L) and what the model owns (which market, how
   much, fetching a quote, talking to the user). Judges will read this paragraph
   and immediately understand your architecture. Your analyst→aggregator→risk→
   treasurer split is exactly this pattern with four actors instead of two.

2. **Gates as a data structure, failing closed with numbers.**
   `aero-stock-lp/scripts/entry.mjs:144-184`. An array of
   `{name, pass, value, limit}`; first failure exits non-zero with
   `{ok:false, gate, detail, gates}`. Then `SKILL.md:36-37`: "gates run silently;
   mention only a FAILURE, in one line, with the number". This is precisely the
   shape your **risk agent's veto** should take — except make it deterministic
   code, not an agent, and you get a better demo: a veto with a number is
   auditable, a veto with a paragraph is not.

3. **Validate the model's number against an independent source.**
   `aero-stock-lp/scripts/entry.mjs:146-151` — the `nav` gate rejects the entry
   if the LLM-fetched equity quote and the onchain pool price differ by >3%, and
   the `unseeded` gate (`:152-157`) rejects a ratio outside (0.5, 2) as a
   "fictitious price". Pair with `math.mjs:55`, which throws rather than letting
   a guessed volatility through: `"no honest vol input -> no band -> no entry"`.

4. **One confirmation per money-spending sequence, folding in everything.**
   `aero-stock-lp/SKILL.md:52-66`. The line that makes it work: "the gates are
   the safety, not repeated questions." For your treasurer: one approval on the
   ordered trade list, then execute it all — with each tx submitted, mined, and
   receipt-verified before the next (`SKILL.md:26-30`: "The sequence IS your
   atomicity").

5. **Pinned trust anchors that a network response can never override.**
   `pantheon-staking/SKILL.md:21-37` — the registry returns `vault_address` "to
   be **checked**, not used", with a verbatim refusal string and explicitly "no
   override, no 'the user said it's fine', and no fallback address."
   `urizen/SKILL.md:73-79` does the same for a router address *and* a calldata
   selector. `voidly-pay/scripts/lib/pins.mjs:97-121` extends it to URLs inside a
   signed manifest.

6. **"The chain is the memory; the file is a cache."**
   `aero-stock-lp/SKILL.md:281-289`. Only `entryUsd` and `enteredAt` are
   unrecoverable; everything else re-derives every pass, and a lost file produces
   a loud `basisEstimated: true` rather than a quiet lie. For a fixture-driven
   offline demo this is the right invariant to design toward: your fixtures
   replace the chain, and your state file stays a cache.

### Things that look fragile

1. **`aero-stock-lp` has no request timeouts.** `chain.mjs:60-64` and `:172` use
   bare `fetch`. The RPC failover loop (`:55-75`) only advances on *rejection* —
   a hung connection never rejects, so the entry sequence hangs indefinitely
   mid-money-path. Contrast `voidly-pay/scripts/verify-settlement.mjs:483`, which
   aborts at 20s.

2. **Nothing reads rate-limit headers.** All retry logic is status-code-only
   (§7). Six documents tell the *agent* to honour `Retry-After` and zero lines of
   code do. `quotient/scripts/payments.sh:535` admits its retry "may
   double-charge".

3. **`Number()` on financial BigInts.** `aero-stock-lp/scripts/lib/chain.mjs:224`
   (`Number(BigInt(out)) / 1e18`) and `positions.mjs:222,226` convert wei-scale
   BigInts through float64. Fine at the magnitudes involved here, silently wrong
   above 2^53. `math.mjs:6` also computes `Q96 = 2 ** 96` as a float and divides
   `Number(sqrtPriceX96) / Q96` (`:10`) — precision loss in the price that then
   feeds the 3% NAV gate.

4. **Undeclared dependencies.** `signals/scripts/publish-signal.sh:33`,
   `ens-primary-name/scripts/*.sh`, and `productclank/scripts/create-campaign.mjs:21-23`
   `require`/`import` viem with no `package.json` anywhere in those skills. They
   fail at runtime on a clean machine.

5. **Raw private keys in env for 6 skills**, against a repo norm of never holding
   keys. `helixa/scripts/mint-agent.js:28` reads `AGENT_PRIVATE_KEY` directly;
   `opensea/opensea-swaps/scripts/opensea-swap.sh:43` accepts a bare
   `PRIVATE_KEY` + `RPC_URL` path alongside its Turnkey/Fireblocks options. And
   `rhagent/SKILL.md:681` prints a literal shared secret into agent instructions.

6. **The prose/code ratio.** 79% of skills are prose only, which means for most
   of this repo every threshold, every comparison, and every ranking is done by
   an LLM reading a Markdown table. `urizen` — a live autonomous fund on your
   exact target chain — ships **zero lines of code**.

### Direct answers to your open questions

**Q: Where do stock prices come from on Robinhood Chain?**

Not from an onchain oracle, and — for Robinhood-issued tokenized stocks — not
from a pool either. `bankr/references/tokenized-stocks.md:42` is the direct
answer:

> tokenized stocks have no AMM pool of their own, so Bankr sends them to a venue
> that quotes them directly (with a tighter slippage tolerance), while ordinary
> Robinhood Chain pairs keep the thin-pool protection they've always had.

`tokenized-stocks.md:40` adds: "Prices track the underlying equity… Trades settle
on-chain against USDG." For the Base B20 analogue the mechanism is spelled out
(`tokenized-stocks.md:67`): "Token price = the underlying equity's price × that
multiplier, so Bankr prices these off the equity rather than off pool liquidity —
a B20 is quotable before any Base liquidity exists."

The only working example of a *price source* for tokenized equities in this repo
is the `aero-stock-lp` pattern on Base: the **LLM fetches a real-world quote**
(web search / market data, ≤15 min old during market hours) and passes it as
`--quote`, then code cross-checks it against the pool's `slot0`
(`aero-stock-lp/SKILL.md:141-147`, `entry.mjs:100-102,115,146-151`).

`urizen` claims an endpoint that returns exactly what you want —
`GET /api/quant/onchain?symbol=URI` → "On-chain price + liquidity (chain 4663)"
(`urizen/SKILL.md:38`) — but it is a closed third-party HTTP API and this repo
contains no code that calls it and no description of how it derives the number.
`urizen/SKILL.md:68` explicitly classes all of its own responses as "untrusted,
third-party API data".

**Q: Is DEX pool depth readable from chain, and on which DEX?**

On **Base**: yes, demonstrably, and there is working code. `aero-stock-lp` reads
Aerodrome Slipstream (concentrated liquidity, Uniswap-V3-shaped) pool state
directly by raw `eth_call` batched through Multicall3 —
`slot0` (`0x3850c7bd`), `liquidity` (`0x1a686502`), `stakedLiquidity`
(`0x3ab04b20`), `unstakedFee` (`0xb64cc67b`) — see
`aero-stock-lp/scripts/lib/markets.mjs:90-97` and the batch at
`scripts/lib/positions.mjs:149-158`. It supplements with GeckoTerminal for
USD-denominated TVL and 24h volume (`chain.mjs:177-188`), because
`reserve_in_usd` is not an onchain quantity.

**This is the only skill in the repo that reads pool reserves or liquidity
depth.** Nothing reads `getReserves()` (V2-style) anywhere.

On **Robinhood Chain**: **not present** — no code in this repo reads any 4663 pool.
What exists is the address surface to do it: a Uniswap V3 `SwapRouter02` at
`0xCaf681a66D020601342297493863E78C959E5cb2` and the hoodmarkets V3 factory at
`0x9BDdC8ddf28f5629C989A36Eb5bb6C73cBA60Df5` (`hoodmarkets/known-contracts.json`),
and a Doppler router at `0xe492912F37C2A4eCa45D42DC67548F4C6Cd7ce2B`
(`urizen/SKILL.md:76`). `rhagent/references/CHAIN-SWAPS.md:42` tells the agent to
check liquidity via "DexScreener or GeckoTerminal shows a RH Chain pool with
non-trivial USD liquidity" — i.e. HTTP, not chain.

`[INFERRED]` — those V3 pools are for **memecoins and hood.markets launches**, not
for Robinhood's tokenized stocks, which `tokenized-stocks.md:42` says have no pool
at all. So pool depth on 4663 is readable in principle for the memecoin side and
is likely the wrong question for the stock side.

**Q: What does a server-side x402 handler look like?**

Fully answered, and it is simpler than you'd expect. `bankr/references/x402-cloud.md`
documents **Bankr x402 Cloud** at `https://x402.bankr.bot`. A handler is a bare
`Request → Response` function, no framework (`x402-cloud.md:61-68`):

```typescript
// x402/<service-name>/index.ts
export default async function handler(req: Request): Promise<Response> {
  return Response.json({ message: "Hello from x402!" });
}
```

Price, methods, and an agent-discovery schema live in `bankr.x402.json`
(`x402-cloud.md:143-159`), deployed with `bankr x402 deploy`
(`x402-cloud.md:44-56`). You never write the 402 challenge, the `X-PAYMENT`
verification, or the settlement — the platform does. `tokenAddress` optionally
prices the endpoint in a non-USDC ERC-20 (`x402-cloud.md:163`). Handlers can call
the LLM gateway at `https://llm.bankr.bot/v1/chat/completions` with the Bankr API
key (`x402-cloud.md:120-137`) — which is how your decision-record endpoint and
your per-analyst LLM-cost accounting can share one billing surface.

For the **client** side, `quotient/scripts/payments.sh` is the reference
implementation: a free `curl -D -` preflight reads the `payment-required:` header,
base64-decodes it, and validates the complete tuple — `x402Version == 2`, scheme
`exact`, network `eip155:8453`+USDC or `eip155:4663`+USDG, `payTo` equal to the
pinned payee, `maxTimeoutSeconds` under bound, `amount` an integer
(`payments.sh:147-173`) — before any payer is invoked. It is honest about the
residual gap (`payments.sh:134-136`): "this read and the payer's own challenge
fetch are two requests — a server could show different terms to each; the cap and
host allowlist still bound that residual risk."

### Targeted questions

**1. The EARN skill (yield layer on Robinhood Chain).**

**Not present.** No directory matching `*earn*`, no `SKILL.md` with `name:`
containing "earn", no "yield layer" string anywhere in the repo.

The nearest thing is **`pantheon-staking`** — staking vaults for creator coins on
Base *and* Robinhood Chain, 6-month mandatory term, monthly rewards
(`pantheon-staking/SKILL.md:15`). It is prose only. It calls the StakingVault
proxy at `0x541E0a67558bAd0FFb5CD61C7BA2ebB392F33edB` on 4663 via Bankr's
arbitrary-transaction flow (`references/staking-contract-rh.md:3`,
`SKILL.md:107`), using `stake` `0x946debd5`, `accruedReward` `0x814b57b3`,
`claimReward` `0x4953c782`, `pools` `0xa4063dbc`, `stakes` `0xa4e47b66`
(`staking-contract-rh.md:52-53`). `ERC-20 approve` must name the RH vault, not
Base's (`staking-contract-rh.md:57-59`). Unstaking and early exits are
deliberately web-app-only (`README.md:64`).

Other yield skills exist but none on 4663: `berry-juicer` (Base), `zyfai` (Base/
Arbitrum/Plasma), `stakr` (ERC-4626), `hydrex` (Base), `gem-miner` (Base),
`pmfi-parbitrage` (Base).

**2. The two LayerZero OFT skills (`oft-launch`, `oft-bridge`).**

**Not present.** No `oft-launch`, no `oft-bridge`, no directory matching
`*oft*` or `*bridge*`. Searching `\bOFT\b|LayerZero|lzReceive|endpointId` across
the repo returns only prose mentions, no ABIs and no contract bindings:

- `bankr-token-scam-analysis/SKILL.md:42` describes the OFT pattern for forensics
  and names the **LZ V2 endpoint on Base `0x1a44076050125825900e736c501f859c50fE728c`**,
  the source import `@layerzerolabs/oft-evm/contracts/OFT.sol`, and the admin
  surface `peers(uint32)`, `setPeer`, `send`, `setEnforcedOptions`.
- `bankr-token-scam-analysis/SKILL.md:58` lists the read calls and the endpoint
  ids to check them against: `owner()`, `peers(uint32)`, `endpoint()`,
  `msgInspector()`, `preCrime()`; eids Ethereum=30101, BSC=30102, Arbitrum=30110,
  Base=30184, Polygon=30109, Optimism=30111.
- `nexus-trading-labs/references/deposit-withdraw.md:32,52` mentions a LayerZero
  fee (~0.00001 ETH) on an Arbitrum deposit.
- `defi-native/references/concepts.md:21` mentions LayerZero as a bridge risk
  class.

No ABI file, no contract address for an OFT deployment, and **nothing touching
Robinhood Chain via LayerZero** anywhere in the repo. If those two skills exist,
they are not in this repo at this commit (`8a007c2`).

**3. Skills that read onchain state directly (viem/ethers/raw RPC).**

Nine, plus tests. Full list:

| Skill | File:line | Mechanism | What it reads |
|---|---|---|---|
| `aero-stock-lp` | `scripts/lib/chain.mjs:55-147`, `positions.mjs:149-205` | raw `eth_call` + Multicall3, hand-rolled encoding, zero deps | pool `slot0`, `liquidity`, `stakedLiquidity`, `unstakedFee`; NPM `positions`/`ownerOf`; gauge `earned`/`rewardRate`; gaugeFactory `minStakeTimes`; ERC-20 `balanceOf`/`allowance`; `eth_getBalance`; `eth_getTransactionReceipt`; plus **owner-spoofed `eth_call` simulations** of `decreaseLiquidity` and `collect` to value principal and fees (`positions.mjs:174-205`) |
| `voidly-pay` | `scripts/verify-settlement.mjs:461-500`, `lib/pins.mjs:87-95` | raw `fetch` JSON-RPC, host allowlist, method allowlist, quorum | `eth_chainId`, `eth_getTransactionReceipt`, `eth_getBlockByNumber`, `eth_blockNumber`, `eth_gasPrice` |
| `pmfi-parbitrage` | `scripts/pmfi_parbitrage.mjs:5,19-30,49` | `ethers.JsonRpcProvider` + ABI strings | ERC-7540-style vault: `getVaultState()` (PPS, supply, idle, backing, HWM, pending/claimable, paused, shutdown), `getUserDepositRequests`, `getDepositRequest`, request counts |
| `azzle` | `scripts/v2-lib.mjs:114-212` | raw `eth_call`, retries 429/5xx | EIP-1967 / ZOS implementation slots (`:8-9`), proxy `implementation()`, task-registry state |
| `erc-8004` | `scripts/get-agent.sh:33` | `curl` JSON-RPC to `eth.llamarpc.com` / Alchemy demo | `tokenURI(uint256)` on the identity registry |
| `endaoment` | `scripts/donate.sh:48,62` | `curl` JSON-RPC | factory `0x9fb8578d<orgId>` → entity address; `eth_getCode` to confirm deployment |
| `ens-primary-name` | `scripts/verify-primary.sh:63-95`, `set-primary.sh:81`, `set-avatar.sh:48` | `curl` JSON-RPC **and** `viem` `createPublicClient` | reverse resolution; `namehash`, `keccak256` helpers |
| `juicebox-v6` | `scripts/{build,verify}-reviewed-manifest.mjs:226,82`; `references/shared/wallet-utils.js:213,386` | raw JSON-RPC; `viem` `createPublicClient` in the shared browser helper | manifest address verification |
| `b20-console` | `scripts/inspect-b20.js` | via `https://b20.charon.codes/api/inspect`, not direct RPC | B20 factory recognition, supply cap, permit/EIP-712 state — surfaced as `RPC_TIMEOUT` / `RPC_RATE_LIMITED` / `READ_FAILED` codes (`:26-30`) |

Everything else in the repo reaches chain through Bankr's API or a vendor HTTP
API. **None of these read Robinhood Chain.**

**4. DEX pool reserves / liquidity depth, and non-HTTP price sources.**

**Pool depth: exactly one skill.** `aero-stock-lp` — see the table above and the
Base answer under "open questions". The read batch
(`aero-stock-lp/scripts/lib/positions.mjs:149-158`):

```js
const batch = await multicall([
  { to: M.pool,  data: SEL.slot0 },
  { to: M.npm,   data: SEL.positions + idW },
  { to: M.npm,   data: SEL.ownerOf + idW },
  { to: M.gauge, data: SEL.earned + addrWord(wallet) + idW },
  { to: M.pool,  data: SEL.liquidity },
  { to: M.pool,  data: SEL.stakedLiquidity },
  { to: M.pool,  data: SEL.unstakedFee },
  { to: M.gauge, data: SEL.rewardRate },
]);
```

No skill reads `getReserves()`. No skill reads pool depth on any chain but Base.

**Price from a non-HTTP source: yes, one — and only one.** `aero-stock-lp` derives
price from the pool's own `sqrtPriceX96`, read over RPC, in
`aero-stock-lp/scripts/lib/math.mjs:9-12`:

```js
// human USD price of 1 token1, from sqrtPriceX96 (token dec = 8 or 18)
export function priceFromSqrtX96(sqrtPriceX96, decimals) {
  const r = Number(sqrtPriceX96) / Q96;
  return 10 ** (decimals - 6) / (r * r);
}
```

called at `entry.mjs:115` (`const poolPrice = priceFromSqrtX96(toBigInt(wordAt(slot0Res.data, 0)), M.decimals)`),
`entry.mjs:274`, `exit.mjs:150`, `positions.mjs:207`, and `manage.mjs:252-258`.
The file header (`math.mjs:2-4`) explains the one subtlety:

> USDC is token0 in every pool, so tick and human price move in OPPOSITE
> directions: the band's LOW price maps to the UPPER tick and vice versa.
> That inversion lives HERE, once, and nowhere else.

Every other price in the repo is an HTTP fetch: Coinbase spot/candles
(`chain.mjs:190-202`), GeckoTerminal (`chain.mjs:177-188`), DexScreener, CoinGecko,
or a vendor API. No Chainlink, Pyth, or any oracle contract read appears in
executable code anywhere. (`megapot` mentions Pyth-seeded randomness in prose,
`README.md:59`.)

**5. Skill composition — does one skill invoke another, or an agent call a second agent?**

**No mechanism exists.** There is no manifest field, no import, no cross-skill
`require`, and no runtime call from one skill's script into another's. Skills are
hermetic directories by design (`README.md:92-104`), and the only composition
primitive in the repo is a **natural-language install instruction pasted into
prose**:

```
install the qrcoin skill from https://github.com/BankrBot/skills/tree/main/qrcoin
```
— `bankr-communities/SKILL-LINKED-FUNDRAISERS.md:57`, and again for `0xwork` at
`:118`.

The other three expressions of composition, all weaker:

- **Prose pairing hints.** `aeon-token-pick/SKILL.md:57`: "Pairs naturally with
  `aeon-narrative-tracker` (narrative fit), `aeon-monitor-runners` (momentum
  candidates), `aeon-unlock-monitor` (supply-side risk), and Bankr Submit /
  AgenticBets for execution." `aeon-autoresearch/SKILL.md:59` similarly. These
  are suggestions to the human, not calls.
- **Meta-skills that operate on other skills as files.** `aeon-skill-evals`,
  `aeon-skill-repair`, `aeon-skill-security-scan`, `aeon-autoresearch` read and
  rewrite other installed skills' `SKILL.md` on disk
  (`aeon-skill-security-scan/SKILL.md:42` fingerprints findings into
  `scan-state.json`). That is file manipulation, not invocation.
- **Multi-agent orchestration described but not implemented here.**
  `ethskills-audit/SKILL.md:3` advertises "Runs parallel specialist agents,
  synthesizes findings, and files GitHub issues" — but the entire skill is **11
  lines** and installs from outside this repo (`:11`). `codegrid/SKILL.md:9`
  describes spawning and messaging sibling agents over a local agent bus with
  `session_id` addressing and a `read → message → read` protocol, with patterns
  named "delegate, review, pipeline, parallel fan-out, monitor, debate"
  (`README.md:35`) — but ships 0 lines of code. `nookplot/references/collab-guilds.md:95-114`
  describes guilds "collectively spawn[ing] a new agent from a knowledge bundle"
  recorded onchain via an `AgentFactory` contract — also prose only.

**For your build:** there is no prior art here for the analyst-swarm fan-out. The
closest thing in spirit is the `aeon-*` family — N independent, single-purpose,
read-only skills with tightly specified structured output contracts
(`aeon-deep-research/SKILL.md:22-29`, `aeon-token-pick/SKILL.md:14-22`) — which is
exactly your analyst layer, minus any orchestrator. You will be writing the
aggregator, the parallel fan-out, and the agent-to-agent plumbing from scratch.
Nothing in this repo composes.
