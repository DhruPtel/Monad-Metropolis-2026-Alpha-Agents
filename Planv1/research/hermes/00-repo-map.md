# 00. Hermes Agent: Repository Map

| Field | Value |
|---|---|
| Repository | `NousResearch/hermes-agent` (origin `https://github.com/NousResearch/hermes-agent.git`), cloned at `hermes-agent/` |
| Commit analyzed | `085d9ee608893bb0611c2fc339c19d8848af9f2b` |
| Commit date | 2026-09-25T01:09:23-05:00 ("fix(desktop): pass --disable-gpu on 0xC0000409 relaunch ...") |
| Latest release tag | `v2026.9.24` (2026-09-24). Latest tag overall: `rc.8-v0.21.5`. HEAD is 2,142 commits past `v2026.9.24` per `git rev-list`. |
| Package version | `pyproject.toml` declares `version = "0.0.0"`; the real version is derived at build time (see `hermes_cli/build_info.py`, which defers to `version_info`). Treat the calendar tag `v2026.9.24` as the release version. |
| License | MIT, "Copyright (c) 2025 Nous Research" (`LICENSE`) |
| Working tree | Clean (no local modifications) |

## Languages, packaging, entry points (Verified)

- **Python** is the core (`requires-python = ">=3.11,<3.15"`, `.python-version`). Dependencies are exact-pinned in `pyproject.toml` with `uv.lock`; provider-specific packages live in extras and are installed on demand by an internal package manager (`pm/`).
- **TypeScript/Node** for the TUI (`ui-tui/`), web dashboard (`web/`), Electron desktop (`apps/desktop/`), docs site (`website/`, Docusaurus). `package.json`, `package-lock.json`, `.nvmrc`.
- Nix (`flake.nix`, `nix/`) and Docker (`Dockerfile`, `docker-compose.yml`, `docker/`) packaging.
- Console scripts (`pyproject.toml [project.scripts]`):
  - `hermes = hermes_cli.main:main` (primary CLI: chat, `gateway`, `cron`, `config`, `tools`, `mcp`, `skills`, `profile`, etc.)
  - `hermes-agent = agent.legacy_cli:main`
  - `hermes-acp = acp_adapter.entry:main` (Agent Client Protocol server for editors)
- Other runnable modules at repo root: `run_agent.py` (AIAgent class), `cli.py` (interactive CLI), `batch_runner.py`, `mcp_serve.py` (Hermes exposed as an MCP server), `mini_swe_runner.py`, `trajectory_compressor.py`.

## Top-level map

Line counts are Python lines only (`find -name '*.py' | xargs cat | wc -l`), approximate.

| Path | Purpose | Size |
|---|---|---|
| `run_agent.py` | `AIAgent` class, the core agent object used by every surface | 91 KB |
| `agent/` | Agent core: turn loop (`conversation_loop.py`, `turn_*.py`), prompt assembly (`prompt_builder.py`, `system_prompt.py`), context compression, provider adapters (Anthropic, Bedrock, Gemini, Vertex, Codex), auxiliary models, memory manager, curator (skill self-improvement), usage/pricing, redaction, retries | 309 files, ~127k py lines |
| `model_tools.py`, `toolsets.py`, `toolset_distributions.py` | Tool schema assembly for the model; named toolsets; toolset distributions | ~80 KB |
| `tools/` | Built-in tool implementations: terminal, file ops, browser, code execution, delegation (subagents), MCP client (`mcp_tool*.py`), memory, skills manager/hub/guard, cronjob tools, approval system, web, send_message, kanban | 344 files, ~118k py lines |
| `providers/` | Provider base class and README for the model provider abstraction | 3 files, ~1k lines |
| `plugins/` | In-tree plugins: memory backends, model-providers, context_engine, web, browser, image/video gen, observability, cron_providers, kanban, platforms, security-guidance | 382 files, ~89k lines |
| `hermes_cli/` | CLI commands, config system (`config*.py`), profiles, auth flows, model setup, plugins manager, MCP config, cron CLI, kanban, gateway management, doctor, update | 605 files, ~241k lines |
| `hermes_state*.py` (root) | SQLite session/state store: schema, messages, sessions, FTS search, WAL, repair, portability (export/import), usage | ~30 files, ~1.2 MB |
| `hermes_constants.py`, `hermes_logging.py`, `hermes_bootstrap.py`, `hermes_startup_watchdog.py` | Paths (HERMES_HOME), logging, bootstrap, startup watchdog | ~130 KB |
| `gateway/` | Messaging gateway process (Telegram, Discord, Slack, WhatsApp, Signal, email, ~20 platforms), session lifecycle, delivery, hooks, API server, scale-to-zero | 178 files, ~94k lines |
| `tui_gateway/`, `ui-tui/` | JSON-RPC backend and Ink/TS terminal UI | ~39k py lines + TS |
| `cron/` | Built-in scheduler: jobs, ticks, worker env, delivery, preflight, blueprints | 34 files, ~17k lines |
| `acp_adapter/` | Agent Client Protocol adapter (editor integration) | 14 files, ~4.5k lines |
| `skills/` | Bundled skills (SKILL.md format) by category | 331 files |
| `optional-skills/` | Opt-in skills catalog, including `blockchain/` and `finance/` categories | 788 files |
| `optional-mcps/` | Catalog of third-party MCP server definitions (Stripe, Plaid, Robinhood, twelve-data, etc.) | 65 files |
| `plugin-catalog/` | Plugin catalog metadata | 299 files |
| `pm/` | Internal package manager used to install extras, Node, tools on demand | 53 files, ~11k lines |
| `hermes_platform/` | OS/platform abstraction helpers | 12 files |
| `web/`, `apps/`, `website/` | Web dashboard, Electron desktop app and installer, Docusaurus docs (444 docs pages) | TS/MD |
| `docker/`, `Dockerfile`, `docker-compose.yml`, `nix/` | Container and Nix packaging | small |
| `evals/`, `tests/`, `tests-js/` | Evaluations and tests (tests dir is ~1.2M py lines) | large |
| `scripts/` | Release, install, maintenance scripts | 189 files |
| `locales/` | i18n strings | 17 files |
| `cli-config.yaml.example`, `.env.example` | Example config (122 KB) and example env (26 KB) | |
| `SOUL.md` | Default persona prompt | 667 B |
| `AGENTS.md` (+ per-area `AGENTS.md`) | Developer guide; states design invariants: prompt-cache stability, narrow core | 37 KB |

## Key docs to read (Verified present)

- `website/docs/developer-guide/`: `architecture.md`, `agent-loop.md`, `prompt-assembly.md`, `context-compression-and-caching.md`, `tools-runtime.md`, `provider-runtime.md`, `programmatic-integration.md`, `session-storage.md`, `cron-internals.md`, `egress-internals.md`, `memory-provider-plugin.md`, `creating-skills.md`, `middleware.md`, `observer-hooks.md`
- `website/docs/user-guide/`: `configuration.md`, `security.md`, `profiles.md`, `docker.md`, `which-file-does-what.md`, `egress/`, `secrets/`, `features/` (cron, mcp, memory, skills, curator, delegation, api-server, tool-gateway, fallback-providers, goals, heartbeat, loops, hooks)
- `website/docs/reference/`: `environment-variables.md`, `mcp-config-reference.md`, `cli-commands.md`
- `website/docs/guides/python-library.md` (programmatic use)

## Two design invariants that matter for us (Verified, `AGENTS.md` lines ~15-30)

1. **Per-conversation prompt caching is sacred.** The system prompt is byte-stable for the life of a conversation; skills, tools, and memory changes default to taking effect next session.
2. **Narrow core.** Every model tool is sent on every API call, so capability should come from skills, plugins, or MCP servers rather than new core tools.

## Sub-agent scope adjustments

The brief's six areas fit the structure. Adjustments:
- **A (architecture)** also covers `agent/curator.py`, `agent/background_review.py`, `agent/learning_*` (self-improvement), and `agent/moa_*`, `tools/delegate_tool*.py` (concurrency).
- **B (models)** covers `agent/*adapter.py`, `agent/auxiliary_*`, `agent/provider_*`, `plugins/model-providers/`, `providers/`, `hermes_cli/config_providers.py`, `agent/usage_pricing.py`, `agent/credits_tracker.py`.
- **C (tools/MCP)** covers `tools/`, `toolsets.py`, `model_tools.py`, `tools/approval*.py`, `optional-mcps/`, `mcp_serve.py`.
- **D (skills/memory)** covers `skills/`, `optional-skills/`, `agent/skill_*`, `tools/skill*`, `tools/memory_tool*.py`, `agent/memory_*`, `plugins/memory/`, `hermes_state*.py`, `hermes_state_portability.py`.
- **E (runtime)** covers `cron/`, `gateway/` (API server, scale-to-zero), `hermes_cli/config*.py`, profiles, `Dockerfile`, `hermes_constants.py`, programmatic integration docs, `batch_runner.py`, `acp_adapter/`.
- **F (security)** covers `agent/redact.py`, egress docs, `hermes_logging.py`, `agent/trace_upload.py`, `hermes_cli/diagnostics_upload.py`, update checks, `pm/`, `tools/skills_guard.py`, secrets docs.
