# Phase 0: Orientation (written by lead)

## Versions and maintenance (Verified)

| Item | Value | Source |
|---|---|---|
| Upstream | https://github.com/stakeme-team/monad-agent-kit | `git remote -v` |
| Local HEAD | `b0f0a09120e09026a08e146ee7366c98073fb7b6` ("Update README.md") | `git log -1` |
| Last commit date | 2026-04-28 15:27:56 UTC | git log and GitHub API `pushed_at` |
| First commit | 2026-04-28 ("Initial release: Monad Agent Kit", `1c08cc6`) | git log |
| Total commits | 8, all on 2026-04-28 | git log |
| Contributors | 1 (`dracovis0x7`) | git log, GitHub API `/contributors` |
| package.json version | `0.1.0` | `package.json` |
| Tags / releases | 0 / 0 | GitHub API |
| Stars / forks / open issues (ever) | 0 / 0 / 0 (no issues ever filed) | GitHub API, checked 2026-09-25 |
| License | README says "MIT", but there is **no LICENSE file** in the repo and GitHub reports `license: null` | `README.md` last section, `ls LICENSE*`, GitHub API |
| Org pattern | `stakeme-team` publishes near-identical kits for Arc, Sei, Celestia, ZetaChain, Somnia, Pharos, 0G. Several of those were pushed as recently as 2026-09. The Monad kit has had no activity for about five months. | GitHub API `/orgs/stakeme-team/repos` |

## The most important structural finding (Verified)

**This repository does not contain an MCP server.** It is a client-side kit. All chain tools (`prepare_*`, `get_balance`, `broadcast_signed_raw_transaction`, etc.) live on a hosted, closed-source server at `https://api.monad.exploreme.pro/mcp` run by STAKEME (the "exploreme" explorer). Evidence:
- `.mcp.json`: `{"type":"http","url":"https://api.monad.exploreme.pro/mcp"}`
- `.cursor/mcp.json`: same URL; `.codex/config.toml`: `npx mcp-remote <url>` (stdio bridge)
- `src/mcp-client.ts`: `createMCPClient({ transport: { type: "sse", url } })` from `@ai-sdk/mcp` (note: SSE here, HTTP in `.mcp.json`)
- No file in the repo registers an MCP tool. No dependency on `@modelcontextprotocol/sdk`.
- The tool list is known only from `README.md` ("MCP Tools" table) and `CLAUDE.md`, which list slightly different sets (CLAUDE.md adds `get_evm_compiler_versions`, `get_erc721_token_by_address`).

**Network note (Verified, 2026-09-25):** from this machine, `https://api.monad.exploreme.pro/mcp` fails the TLS handshake and plain HTTP is redirected by a network safe-browsing filter to `https://www.safebrowse.io/warn.html?...`. The Claude Code `monad` MCP connection also failed (EPROTO). We therefore **cannot list the server's tool schemas live**. Do not attempt to bypass the filter. Treat anything about server internals as Inferred unless the client code proves it.

## Language, dependencies, entry points (Verified from `package.json` and `package-lock.json`)

- TypeScript, ESM, Node >= 20, run via `tsx` (no build step used).
- `viem` 2.47.18 (the only chain library; no ethers)
- `@ai-sdk/mcp` 1.0.36 (Vercel AI SDK MCP client; not the official MCP TS SDK)
- `ai` 4.3.19, `@ai-sdk/anthropic` 1.2.12, `@ai-sdk/openai` 1.3.24, `dotenv`
- `node_modules` is not installed locally.
- Entry points: `examples/01-send-tokens.ts`, `examples/02-deploy-and-verify.ts` (AI SDK demos); `scripts/*.ts` CLIs; `src/index.ts` re-exports the library. Started via `make <target>` or `npm run <script>`.

## Repository map

| Path | Purpose |
|---|---|
| `src/` | AI SDK library: MCP client factory, agent loop, signing bridge that auto-signs `prepare_*` results, wallet address helper, env utils (about 360 lines total) |
| `scripts/` | Local CLIs: wallet generate/import, `sign-tx.ts` (stdin unsigned JSON to stdout signed hex), `signer-daemon.ts` (Unix socket signer, auto or manual approval), `keystore-utils.ts` (V3 keystore), `guard.sh` (Claude Code PreToolUse hook blocking key reads), `security-test.ts` |
| `examples/` | Two AI SDK demos: send native tokens, deploy and verify a contract |
| `.claude/` | Claude Code hook config (`settings.json` runs `guard.sh`) and three skills: `/wallet`, `/send`, `/deploy` |
| `.cursor/`, `.codex/`, `.mcp.json` | MCP client configs for Cursor, Codex, Claude Code, all pointing at the hosted server |
| `contracts/` | `SimpleStorage.sol` and its compiled artifact for the deploy demo |
| `docs/` | Architecture notes, per-IDE setup guides, example prompts |
| `Dockerfile`, `docker-compose.yml`, `Makefile`, `bin/dev` | Optional Docker isolation (signer container has `network_mode: none`), make shortcuts |

## Scope adjustments for sub-agents

Because there is no server code, sub-agent scopes shift:
- **A (MCP structure):** analyse the *client* side and everything inferable about the hosted server's transport, auth, tool registration, schemas, and errors from how the client consumes it. Answer "how would we build this" questions from MCP spec and SDK knowledge, labeled Inferred.
- **B (tools and transactions):** the transaction path is fully visible on the client side (`src/signing-bridge.ts`, `scripts/sign-tx.ts`, `scripts/signer-daemon.ts`, skills, examples). Tool list comes from docs. Swaps, staking, lending: check whether any exist.
- **C (data, reliability, security):** external services, secret handling, `guard.sh` robustness, signer-daemon approval model, injection risk from remote tool outputs.

## Rules for all sub-agents

- Read only. Do not install, run scripts, or change the repo. Only write your notes file under `research/monad-agent-kit/notes/`.
- **Never read `.env` or anything in `.keystore/`, never print environment variables, never read `PRIVATE_KEY`.** (Project CLAUDE.md rule.) Reading `.env.example` is fine.
- Cite file paths and function names for every claim. Label **Verified** or **Inferred**. Short excerpts only (under 20 lines).
- Write plainly, tables welcome, avoid em dashes.
