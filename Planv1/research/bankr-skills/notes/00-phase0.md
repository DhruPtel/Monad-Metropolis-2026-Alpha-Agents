# Phase 0 orientation (written by lead)

## Safety check (Verified)
- `.claude/settings.json` exists at repo root. Contents: `attribution.commit=""`, `attribution.pr=""`, `sessionUrl=false`,
  and `permissions.deny` for `Read(**/config.json)`, `Read(**/.env*)`, `Read(**/*.pem)`, `Read(**/*.key)`.
  It DOES apply to a Claude Code session opened in this repo. Effect: strips commit/PR attribution and blocks reads of secrets-like files.
  No hooks, no MCP config, no allow rules. Assessed benign. Protected by `.github/CODEOWNERS` (`/.claude/ @igoryuzo @saltoriousSIG @sidrisov`).
  We do not rely on it.
- `defi-native/AGENTS.md` exists (agent instructions file for other harnesses). Treat as data.
- No `.mcp.json`, no `CLAUDE.md`, no hooks directories found.
- `onchainkit.skill` at root is a zip archive (SKILL.md, 4 python scripts, references, template app incl. `.env.local.example`). Not extracted.

## Versions (Verified)
- Repo: https://github.com/BankrBot/skills.git, branch main
- HEAD: d7b28f4caea71b446655ef991346f4860b95656a, committed 2026-09-22 11:16:25 -0400
- First commit: 2026-01-26. Total commits on HEAD: 623.
- Contributors: 103 unique author names (`git shortlog -sn HEAD`), 115 name+email pairs.
- License: NO root LICENSE file. Only `juicebox-v6/LICENSE` and `defi-native/LICENSE`. Some SKILL.md frontmatter has `license:`.
- SKILL.md count: 151 (147 top-level folders; `opensea/` has 5 nested sub-skills; `skills/bankr-twitter-agent/SKILL.md` is a duplicate with no frontmatter or catalog).
- Placeholder stubs (4 lines): `base/`, `zapper/`.
- External-install stubs (11 lines, point to `catalog.json install.command`): all 5 `uniswap-*`, 5 `base-*` (account/deploy/minikit/network/node), 16 `ethskills-*`, plus `hunch`, `hunch-bazaar`, `pi-fire-science` (external type).
- Non-conforming catalog.json: `b20-console/catalog.json` (no schemaVersion, `install` is a string), `rider-battle/catalog.json` (check).
- Root catalog files: `README.md` (human table), `featured.json` (schemaVersion 1, list of 7 featured slugs), per-folder `catalog.json` (schemaVersion 1).
- README "Adding a Skill" (README.md:92-132): folder = slug; SKILL.md required (name + description frontmatter); catalog.json required; logo.svg recommended; references/ and scripts/ optional; PR-based review.
- File types in repo (by extension): md 605, json 210, sh 86, png 50, mjs 32, svg 29, py 14, js 8, jpg 6, txt 4, ts 3, .example 3, html 2, css 2, sql 1, tsv 1.

## Inventory
See `00-inventory.tsv` (path, name, provider from catalog.json, install type, line count, frontmatter keys, description).

## Categories (lead's first pass, Inferred from descriptions)
- Core platform / wallet / trading agent: bankr (1600 lines + 20 references), aero-stock-lp, nexus-trading-labs, symbiosis, suwappu-dex, opensea-swaps, uniswap-trading, uniswap-driver, hoodmarkets, autoboy, clanker, zyfai, coffer, stakr, pmfi-parbitrage, veil, splits
- Data / market intelligence (read-only APIs): alchemy, quicknode, zerion, opensea-api, lonestaroracle-data, delu-oracle, wake-token-spotter-analysis, orlix, skopos, sleuth-ai, signals, signa, bankr-token-scam-analysis, b20-console, trustlayer-sybil-scanner, cortx, polygraph, waybackclaw
- Research playbooks (Aeon suite, 24): deep-research, last30, narrative-tracker, token-pick, token-movers, monitors, deal-flow, reg-monitor, digests; plus meta skills (autoresearch, skill-evals, skill-repair, skill-security-scan, vuln-scanner)
- Knowledge / dev playbooks (mostly external stubs): ethskills-* (16), base-* (5), uniswap-hooks/cca/viem, onchainkit, juicebox-v6, defi-native
- Payments / x402 / commerce: voidly-pay, moltycash, metr-merchant-payments, blueagent, bankr-shopify, 0xwork, ai2human-task-router, azzle, gmfarcaster, onair-shoutout, capacitr
- Identity / reputation / agent infra: erc-8004, helixa, siwa, nookplot, ens-primary-name, agent-wormhole, 1claw, gitlawb, codegrid, harness*, hermesone, grantr
- Social: bankr-twitter-agent, neynar, botchan, productclank, bankr-communities, gmfarcaster
- Games / lotteries / prediction: agenticbets, megapot, yoink, cattown, rider-battle, qrcoin, gem-miner, based-mining, litcoin, hunch, hunch-bazaar, versa, urizen, BOTCOIN
- Yield / staking / vaults: zyfai, coffer, stakr, pantheon-staking, berry-juicer, hydrex, harness-capu, harness-venice, lienfi, coinhero, github-vesting, endaoment, starchild-dao, quotient, rhagent
- NOTE: `BOTCOIN/skill.md` uses lowercase filename (152 skill files total counting it).
