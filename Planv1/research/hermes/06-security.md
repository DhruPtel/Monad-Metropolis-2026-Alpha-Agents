# 06. Hermes Agent: Security, Privacy, and Outbound Traffic

| Field | Value |
|---|---|
| Commit | `085d9ee608893bb0611c2fc339c19d8848af9f2b` (commit date 2026-09-25) |
| Release tag | `v2026.9.24` (HEAD is past it) |
| License | MIT |
| Scope | Egress destinations, telemetry, logging and persistence, secrets, prompt-injection defenses, runtime installs and code execution, skill-content leakage channels |

Labels: **Verified** means seen in code or in-repo docs at the cited path. **Inferred** means reasoning from code structure that was not traced end to end.

---

## 1. Trust model in one paragraph

**Verified** (`SECURITY.md` §2.2 to §2.4): Hermes states that "the only security boundary against an adversarial LLM is the operating system." The approval gate, output redaction, Skills Guard, threat-pattern scanners, and env scrubbing are all declared "in-process heuristics", not boundaries. Bypasses of them are explicitly out of scope for security reports (§3.2). Skills and plugins "execute arbitrary Python at import time" and run with full agent privileges (§2.4, §2.5). The supported posture for untrusted input is "whole-process wrapping" (Docker or NVIDIA OpenShell), which is what our E2B microVM plus egress allowlist provides. Everything below should be read with that in mind: our sandbox and egress allowlist are the real controls; Hermes' own guards are defense in depth.

---

## 2. Outbound network destinations (egress allowlist input)

"Default" below means: a fresh config (`hermes_cli/config_defaults.py`) with our LiteLLM gateway configured as a custom OpenAI-compatible `model.base_url`, no other API keys in env, and no Nous Portal login.

### 2.1 Required for our deployment

| Destination | Triggering code path | On by default? | How to disable / control |
|---|---|---|---|
| Our LiteLLM gateway (`model.base_url`) | Main chat calls (`agent/turn_api_request.py`), plus every auxiliary task (compression, vision, title generation, approval guardian, background review, curator consolidation, MCP aux, `/review`) which default to `provider: "auto"` = inherit main model (`config_defaults.py` `auxiliary` block, lines ~703 to 760). Also `/models` probes of the same host for context length (`agent/model_metadata.py` `_resolve_custom_endpoint_context_length`, `fetch_endpoint_model_metadata`). | Yes | Required. **Verified.** |
| Our MCP servers (chain, data, platform) | `tools/mcp_tool*.py` | Only when configured in `mcp_servers` | Required. **Verified.** |

### 2.2 Contacted by default (block unless we need them)

| Destination | Triggering code path | On by default? | How to disable |
|---|---|---|---|
| `models.dev` (`https://models.dev/api.json`) | `agent/models_dev.py` `fetch_models_dev()` (lazy on metadata/pricing/vision lookups; stale cache served and refreshed by a background daemon thread `_start_background_refresh_models_dev`). Callers include `agent/image_routing.py`, `agent/usage_pricing.py`, `hermes_cli/model_switch_providers.py`. | Yes, lazily. Fails soft (returns `{}` / stale cache). **Verified.** | No off switch found. Redirect with `models_dev.url` (config, `config_defaults.py` line ~2040) to an internal mirror, or let the egress firewall block it (fail-soft). Whether our custom-provider path ever triggers it is **Inferred** (likely yes via image routing or pricing). |
| `openrouter.ai/api/v1/models` (`OPENROUTER_MODELS_URL` in `hermes_constants.py`) | `agent/model_metadata.py` `fetch_model_metadata()` step 5f (provider is openrouter), step 6 (provider unknown), and the Nous path. | Only when provider is OpenRouter/Nous/unknown. With a custom provider the effective provider is `custom`, so step 6 is skipped. **Verified** control flow; whether other callers reach it is **Inferred** unlikely. | Block at firewall; fail-soft. |
| `hermes-agent.nousresearch.com/docs/api/model-catalog.json` | `hermes_cli/model_catalog.py`; gateway background watcher `gateway/run_watchers.py` `_model_catalog_refresh_watcher` (started in `gateway/run_startup.py` line ~1490), TTL 20 min; also `/model` picker. | Yes (`model_catalog.enabled: True`). **Verified.** | `model_catalog.enabled: false`. |
| GitHub (`github.com` via `git ls-remote`, `api.github.com/repos/.../commits`, `.../compare`) and `hermes-assets.nousresearch.com` (release records) | Passive update check: `hermes_cli/banner.py` `prefetch_update_check()` (CLI banner), `tui_gateway/server.py` line ~86, `hermes_cli/_startup_fast.py`; all call `hermes_cli/source_check.py` `check_for_updates(passive=True)`, which uses `hermes_cli/source_releases.py` `_PUBLIC_BASE`. | Yes (`updates.check: True`). Returns early when the install stamp is unsupported. **Verified.** | `updates.check: false` (checked at `source_check.py` line ~364). Gateway-only runs may not call it (**Inferred**). |
| GitHub releases plus `hermes-assets.nousresearch.com` mirror (tirith binary) | `tools/tirith_security.py` `ensure_installed()` starts a background `pm.ensure("tirith")` when `security.tirith_enabled: True` and lazy installs are allowed. Pinned hashes in `pm/lock.json`, mirror layout in `pm/artifact-mirror.json`. | Yes. **Verified.** | Pre-install tirith in the image, or `security.tirith_enabled: false`, or `security.allow_lazy_installs: false`. |
| PM lazy installs: PyPI (via uv, default index), GitHub releases, `nodejs.org`, `registry.npmjs.org`, `cdn.playwright.dev`, `ffmpeg.martin-riedl.de`, `packages.termux.dev`, `hermes-assets.nousresearch.com` mirror | `pm/install.py` `lazy_installs_allowed()`; `pm.ensure(...)` / `pm.ensure_import(...)` calls across tools and plugins (browser, TTS, trace upload, LSP servers `agent/lsp/install.py`, etc.). Hosts from `pm/lock.json`, `pm/packages.py`. | Yes (`security.allow_lazy_installs: True`, `config_defaults.py` line ~1769). **Verified.** PyPI being the default index is **Inferred** from `pm/index_config.py` (uv default, bridged from `PIP_INDEX_URL`). | `security.allow_lazy_installs: false` freezes to the bundled feature set (`pm/features.py` docstring). `HERMES_DISABLE_LAZY_INSTALLS=1` also works but docs say it is internal. Note: the `pm/install.py` docstring claims the official Docker image sets it, but the `Dockerfile` does not (**Verified** by grep). |
| Keyless web search/extract: `mcp.exa.ai`, `search.parallel.ai`, `api.keenable.ai`, Firecrawl keyless cloud; DuckDuckGo et al. via `ddgs` if importable | `tools/web_tools.py` `_get_backend()` autodetect ladder, last rung `_keyless_backend()` in `plugins/web/keyless_mcp.py`; `agent/web_search_registry.py` `_keyless_tier_enabled()` defaults True. `web_search`/`web_extract` are in `_HERMES_CORE_TOOLS` (`toolsets.py` line 12). | Yes, when the model calls web tools and no keyed backend is set. **Verified.** | Do not enable the `web` toolset (we provide web search via our data MCP server), or set `web.keyless_fallback: false` plus explicit `web.backend`. |
| Arbitrary URLs | `web_extract`, `browser_*` (local Chromium or cloud), `vision_analyze` image download (`tools/vision_tools.py`, SSRF-checked via `tools/url_safety.py`), `@url:` context references in user text | When the model calls those tools | Disable those toolsets; SSRF guard blocks private IPs and cloud metadata (`tools/url_safety.py`). |
| Microsoft Edge TTS service | `text_to_speech` tool (core tool list) with `tts.provider: "edge"` default (`config_defaults.py` line ~1054) | Only if the model calls TTS | Remove `tts` toolset. Exact host is inside the `edge-tts` package (**Inferred**). |
| `api.osv.dev` | `tools/osv_check.py` before launching an MCP server via `npx`/`uvx`; fail-open | Only for npx/uvx MCP launches | Use HTTP MCP servers or pre-installed binaries. |

### 2.3 Off by default (opt-in only)

| Destination | Code path | Enabled by | Notes |
|---|---|---|---|
| `telemetry.nousresearch.com/v1/telemetry` | `hermes_cli/observability/shared_metrics_sender.py`, config in `shared_metrics_send_config.py` | `telemetry.shared_metrics.enabled: true` AND `.send: true` (two separate opt-ins, `config_defaults.py` lines ~2300 to 2312) | Endpoint deliberately not env-overridable. Content is bounded enums only (see §3). **Verified.** |
| Operator OTLP collector | `agent/monitoring/otlp_exporter.py` | `monitoring.gateway_health_export.enabled` with an endpoint | "Content-free by construction" per `config_defaults.py` comment and `agent/monitoring/__init__.py`. **Verified** (docstring level). |
| Langfuse (`cloud.langfuse.com` or self-host) | `plugins/observability/langfuse/__init__.py` | `hermes plugins enable observability/langfuse` + `HERMES_LANGFUSE_*` keys | Captures full LLM inputs including system prompt (`_serialize_system_prompt`, `_messages_for_langfuse_input`) and tool args/results, truncated to 12000 chars by default. Would leak skills. **Verified.** |
| NeMo Relay exporters | `agent/relay_runtime.py` `_configured_plugin_inputs()` | `HERMES_NEMO_RELAY_PLUGINS_TOML` env pointing to a relay plugin TOML | Trace/trajectory capture. **Verified** gate. |
| Outbound webhooks (any URL) | `agent/outbound_webhooks.py` `register_from_config()` | `hooks.outbound` entries in config | Payload includes `tool_input` and extra hook kwargs (`agent/shell_hooks.py` `_payload_fields`). Skipped under `HERMES_SAFE_MODE=1`. **Verified.** |
| `huggingface.co` | `agent/trace_upload.py` `upload_session_trace()` | Operator runs `hermes sessions ... upload` / `/upload-trace` with `HF_TOKEN` | Full transcript, secret-redacted, private dataset by default. |
| `paste.rs`, `dpaste.com`, `portal.nousresearch.com/api/diagnostics/upload-url` (then S3 presigned PUT) | `hermes_cli/debug.py`, `hermes_cli/diagnostics_upload.py` | Operator runs `hermes debug share` or `/debug` | Uploads logs that may contain "verbatim content of your recent messages" (`debug.py` `_PRIVACY_NOTICE`). |
| `gateway-gateway.nousresearch.com` (Skill Sync) | `tools/skills_sync_client.py` `DEFAULT_SYNC_BASE_URL`; push triggered by `skill_manage` writes (`tools/skill_manager_tool.py` `_maybe_debounced_sync_push`) and curator pulls | Nous login with admin JWT claim AND per-skill `sync` opt-in (docstring: "INERT unless the user is a Nous admin") | Would upload skill trees. Never log into Nous Portal inside our sandbox. **Verified** docstring gate. |
| Nous Portal / inference / tool gateway (`portal.nousresearch.com`, `inference-api.nousresearch.com`, managed Firecrawl/Perplexity/Modal) | `hermes_cli/auth_nous.py`, `tools/managed_tool_gateway.py`, `plugins/web/firecrawl/provider.py` | Nous OAuth login | Not used by us. |
| Skills hubs: `api.github.com`, `skills.sh`, `clawhub.ai`, `browse.sh`, `chat-agents.lobehub.com`, `hermes-agent.nousresearch.com/docs/api/skills-index.json` | `tools/skills_hub*.py`, `hermes_cli/skills_hub.py` | Hub search/install/check commands | We install skills ourselves; block. |
| Plugin catalog `hermes-agent.nousresearch.com/docs/api/plugin-catalog.json` | `hermes_cli/plugin_catalog.py` line ~354 | Plugin CLI commands | Block. |
| OpenRouter as aux fallback | `auxiliary` auto-chain (`config_defaults.py` lines ~703 to 727) | Only when `OPENROUTER_API_KEY` is present | Never put that key in the sandbox. |
| `petdex.dev` | `agent/pet/manifest.py` | `display.pet.enabled` (default False) | UI toy. |
| Gateway relay | `gateway/relay/` | `GATEWAY_RELAY_URL` / `gateway.relay_url` | Not used. |
| Messaging platforms (Telegram, Discord, Slack...) | `gateway/platforms/`, `plugins/platforms/` | Platform tokens configured | We should use only the API server adapter. |

### 2.4 Proposed sandbox allowlist

Minimum: our LiteLLM gateway host, our MCP server hosts, and nothing else. Optionally our own internal mirror for `models.dev` (set `models_dev.url`). Everything else in §2.2 fails soft when blocked, provided we also set the config switches below so Hermes does not spin background retries (**Inferred**: blocked hosts produce debug/warning log noise and short timeouts, not crashes; confirm in a spike).

Config to bake into the image (ideally via Managed Scope, `/etc/hermes/config.yaml`, `website/docs/user-guide/managed-scope.md`, so the agent cannot override it by editing `~/.hermes/config.yaml`):

```yaml
updates: {check: false}
model_catalog: {enabled: false}
security: {allow_lazy_installs: false, tirith_enabled: false, redact_secrets: true}  # or preinstall tirith
web: {keyless_fallback: false}
telemetry: {shared_metrics: {enabled: false, send: false}}
curator: {enabled: false}
hooks: {outbound: []}
```

---

## 3. Telemetry and analytics

- **Exists, off by default. Verified.** `hermes_cli/observability/shared_metrics*.py`. Two independent opt-ins, `telemetry.shared_metrics.enabled` (local collection into a SQLite store under the profile) and `telemetry.shared_metrics.send` (transmission). `resolve_send_config()` refuses to send if `enabled` is false and refuses non-HTTPS endpoints. Packages are only sent if their whole period falls in a recorded consent window (`send_consent_windows` table in `shared_metrics.py`).
- **Content: Verified bounded.** `shared_metrics_contract.py` validates every counter against closed enum sets (`_COUNTER_DIMENSION_VALUES`): hermes version, OS family, architecture, install method, task outcomes, duration buckets, tool categories, skill lifecycle action and provenance, use-count buckets. `skill_load_fields()` is documented as "without exporting local skill identity". Model route metric carries model and provider identifier strings (length-capped).
- **No third-party analytics SDKs.** Grep for posthog, sentry, amplitude, mixpanel, segment finds nothing in `pyproject.toml` or runtime code. The only PostHog reference is Hermes forcing `CUA_DRIVER_RS_TELEMETRY_ENABLED=0` for the computer-use driver (`config_defaults.py` `computer_use.cua_telemetry: False`). **Verified.**
- The "analytics" dashboard route (`hermes_cli/web_routers/analytics.py`) is local token/cost analytics, not remote. **Verified.**

---

## 4. Logging and local persistence

| Artifact | Path | Written by default? | Contains prompts / skills / tool output? |
|---|---|---|---|
| `agent.log` (INFO+), `errors.log` (WARNING+), `gateway.log`, `gui.log` | `$HERMES_HOME/logs/` (rotating, 5 MB x 3 default; `logging` block in config) | Yes | Mostly metadata. Turn start logs an 80-char user-message preview (`agent/turn_context.py` line ~1037); tool completion logs name, duration, char count (`agent/tool_executor.py` line ~1083); tool failure logs first 200 chars of the result (line ~1349). All formatted with `RedactingFormatter` (`hermes_logging.py` line ~379). DEBUG level may add more (**Inferred**). |
| `request_dump_<session>_<ts>.json` | `$HERMES_HOME/sessions/` (`agent/agent_init.py` line ~1178) | **Yes, automatically** on non-retryable 4xx and on retry exhaustion (`agent/turn_recovery.py` lines ~985, ~1183); also on every request when `HERMES_DUMP_REQUESTS=1` | **Full request body**: system prompt (with any skill text in it), all messages, tool definitions. Secret-redacted with `force=True` but not content-redacted (`agent/agent_runtime_helpers.py` `dump_api_request_debug`). **Verified.** High-risk for skill leakage if the sandbox home is exported. |
| Session DB `state.db` (SQLite, FTS) | `$HERMES_HOME/state.db` | Yes | Full system prompt text in `system_prompts` table (deduped by hash), every message including tool results (`messages.content`, `tool_calls`, `reasoning`) (`hermes_state_common.py` `SCHEMA_SQL`). So skill_view outputs and skill-derived reasoning are stored verbatim. **Verified** schema; that skill_view output lands there is **Inferred** from tool results being persisted as messages. |
| Trajectories (`trajectory_samples.jsonl`, `failed_trajectories.jsonl`) | Current working directory (`agent/trajectory.py` `save_trajectory`) | No (`save_trajectories=False` default, `run_agent.py` line ~270) | Full conversations in ShareGPT format when on. |
| Memory | `$HERMES_HOME/memories/` (built-in), injected into system prompt | Yes (`memory.memory_enabled: True`) | Whatever the agent chooses to remember; writes scanned with strict threat patterns. |
| Agent-created skills, curator backups | `$HERMES_HOME/skills/`, `skills/.curator_backups/`, `skills/.archive/` | Yes (background review and `skill_manage` enabled; curator enabled) | Can hold copies or derivatives of skill text. |
| Checkpoints | `tools/checkpoint_manager.py` snapshots of files the agent edits | No. **Corrected in synthesis (report 07 §5 row 5):** `checkpoints.enabled: False` by default (`hermes_cli/config_defaults.py` line 476) | File contents when enabled. |
| iron-proxy log | `$HERMES_HOME/proxy/iron-proxy.log` | Only with `hermes egress` | Per-request records. |

Redaction (`agent/redact.py`): regex-based secret masking (vendor key prefixes, assignments in env/YAML dumps, URL credentials, bearer tokens, phone numbers, registered vault values). On by default (`security.redact_secrets: True`). It targets credentials, not arbitrary prose, so **it does nothing to protect skill contents**. **Verified.**

---

## 5. Secrets and API keys

**How read and stored (Verified):**
- Primary store is `$HERMES_HOME/.env`, loaded at startup (`hermes_cli/env_loader`). OAuth tokens in `auth.json`, `.anthropic_oauth.json`, `auth/google_oauth.json`; MCP OAuth tokens in `mcp-tokens/`.
- External secret sources (`agent/secret_sources/`: Bitwarden `bws`, 1Password `op`, generic `command`) hydrate env vars at startup through `registry.py` `apply_all` with a precedence ladder (`website/docs/user-guide/secrets/index.md`).
- Browser autofill vault: `agent/vault_store.py`, Fernet-encrypted in `$HERMES_HOME/vault/` with the key file beside it (0600). "Model-blind": values filled server-side, and `agent/redact.py` `register_vault_redaction_value` scrubs them from browser tool results.
- Multi-profile gateway: `agent/secret_scope.py` context-local secret scope, fails closed.
- Managed Scope: admin-pinned `/etc/hermes/.env` wins over user `.env` and shell (`managed-scope.md`).

**Can the agent, tools, or skills read them?**
- **File tools: blocked (heuristic).** `agent/file_safety.py` `get_read_block_error()` denies reads of `.env` (any project `.env*`), `auth.json`, `webhook_subscriptions.json`, `mcp-tokens/`, `vault/`, `browser-profile/`, Bitwarden caches. Writes to `.env` are hard-denied (`build_write_denied_paths`). The code itself labels this "Defense-in-depth, not a security boundary; the terminal tool can still bypass" (`_DID_SUFFIX`). **Verified.**
- **Terminal subprocesses: blocklist scrub.** `tools/environments/local_env_policy.py` strips a derived blocklist (`_build_provider_env_blocklist`: all provider key env vars from `PROVIDER_REGISTRY`, tool and messaging vars from `OPTIONAL_ENV_VARS`, plus a static list). It is a blocklist, so any env var Hermes does not know about (for example our own `AGENT_ID` or custom tokens) passes through to the shell. **Verified.** The shell can still `cat ~/.hermes/.env` (the redactor masks recognizable values in output, `redact_terminal_output`, but that is a heuristic).
- **execute_code child: allowlist-ish scrub.** `tools/code_execution_env.py` drops anything containing `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `AUTH`, `DSN`, `WEBHOOK`, etc., then keeps only safe prefixes (`PATH`, `HOME`, `LANG`, `XDG_`...). **Verified.**
- **Passthrough:** a skill's `required_environment_variables` (registered on `skill_view`) or `terminal.env_passthrough` re-allow named vars into children, but never provider credentials (`tools/env_passthrough.py` `_is_hermes_provider_credential`, fix for GHSA-rhgp-j443-p4rf). **Verified.**
- **In-process code (skills' Python, plugins, hooks) can read everything**, including `os.environ` and in-memory keys (`SECURITY.md` §2.3). **Verified** (policy statement).

For us: the only secret in the sandbox should be the per-agent LiteLLM virtual key (and possibly MCP auth tokens). Treat both as readable by the model. Budget caps on the virtual key and short-lived MCP tokens are the mitigation. iron-proxy (`hermes egress`, `agent/proxy_sources/iron_proxy.py`) can keep real keys outside a Docker sandbox by swapping placeholder tokens at the proxy, but it is Docker-backend specific (`egress-internals.md`).

---

## 6. Prompt-injection defenses

All are heuristics per `SECURITY.md` §2.4 and §3.2 ("Prompt injection per se" is out of scope).

| Surface | Defense | Code | Strength |
|---|---|---|---|
| Web and browser and MCP tool results | Wrapped in `<untrusted_tool_result source="...">` with a "treat as DATA" preamble; embedded delimiter tokens are defanged; advisory threat scan attaches `_tool_output_risk` metadata (never blocks). Applies to `web_extract`, `web_search`, `browser_*`, `mcp_*`, results of 32+ chars. | `agent/tool_dispatch_helpers.py` `make_tool_result_message`, `_maybe_wrap_untrusted`, `_UNTRUSTED_TOOL_NAMES`, `_UNTRUSTED_TOOL_PREFIXES` | **Verified.** Note: `read_file`, `terminal`, `execute_code`, document readers, and `delegate_task` results are NOT wrapped. Our MCP tool results WILL be wrapped (prefix `mcp_`). |
| Context files (AGENTS.md, .cursorrules, SOUL.md) | `context`-scope threat scan; matches BLOCK the file (SOUL.md in HERMES_HOME only warns) | `agent/prompt_builder.py` `_scan_context_content` | **Verified.** |
| Memory writes, skill installs, cron prompts | `strict`-scope scan (adds exfil-to-URL, SSH backdoor, `.hermes/.env`, config modification, hardcoded secrets); blocks on first hit | `tools/threat_patterns.py` `first_threat_message`; `tools/memory_tool_store.py`; `tools/cronjob_prompt_scan.py` | **Verified.** Caution: a legitimate private skill containing e.g. an API-key-shaped literal or "send ... to https://" could be blocked when written via `skill_manage` (**Inferred**). |
| MCP tool descriptions | Scanned at registration | `tools/mcp_tool_registration.py` `_tool_candidates` -> `_scan_mcp_description` | **Verified.** |
| MCP server trust tiers | `trust: untrusted` requires approval for write-capable tools | `tools/mcp_tool.py` line ~475, `tools/mcp_tool_handlers.py` line ~60 | **Verified.** Default is `full`. |
| Installable skills | Skills Guard regex scan with trust-aware install policy (builtin never scanned; community blocked on any caution finding) | `tools/skills_guard.py` `INSTALL_POLICY`, `scan_skill`; optional `tools/skills_ast_audit.py` (diagnostic only) | **Verified.** |
| Dangerous shell commands | Approval gate, default `approvals.mode: "smart"` (LLM guardian via `auxiliary.approval`), `cron_mode`/`unattended_mode`: `deny`; tirith pre-exec scanner | `tools/approval*.py`, `tools/tirith_security.py`, `config_defaults.py` `approvals` line ~1639 | **Verified.** `pip install`, `npm install`, `curl` (without pipe to shell) are not gated (`tools/approval_detection.py`). |
| SSRF | Private IP and cloud-metadata blocking, redirect re-validation, DNS rebinding guard | `tools/url_safety.py` | **Verified.** |
| Code the agent writes | `plugins/security-guidance` appends warnings (non-blocking) | `plugins/security-guidance/` | **Verified.** |

---

## 7. Runtime package installs and arbitrary code execution

- **Hermes itself installs packages at runtime** via `pm/` (uv for Python extras, pinned binaries and npm packages per `pm/lock.json` with SHA256 and optional GPG/cosign provenance). Gated by `security.allow_lazy_installs` (default True). With it False, the feature list is frozen to the bundled `enabled-features.json` (`pm/features.py`). **Verified.**
- **The agent can install packages and run arbitrary code** via `terminal` (default backend `local`, i.e. directly in the sandbox, `config_defaults.py` `terminal.backend: "local"`) and `execute_code` (persistent Python kernel as a subprocess, `tools/code_execution_tool.py`). The only in-process controls are the approval gate and tirith, which do not gate `pip install`. **Verified.**
- **Skills can carry scripts** and plugins/skills are imported into the agent process (`SECURITY.md` §2.4).
- **MCP stdio servers** launched via npx/uvx fetch packages at launch, checked against OSV malware advisories (fail-open, `tools/osv_check.py`).
- **The agent can edit Hermes config.** `config.yaml` and `auth.json` are read-denied for file tools but deliberately NOT write-denied (`agent/file_safety.py` comment citing #45947); the shell can edit anything writable. So the agent could add `hooks.outbound`, change `model.base_url`, or enable plugins for the next session. **Verified.** Mitigation: Managed Scope (root-owned `/etc/hermes/config.yaml`, and fix `HERMES_MANAGED_DIR` in the image) plus the egress firewall.

Control for us: the E2B VM is the boundary; egress allowlist prevents package fetches and exfiltration; set `allow_lazy_installs: false`; pre-bake every dependency. Decide per tier whether `terminal` and `execute_code` are exposed at all (for a research agent that talks only to our MCP tools, both can likely be disabled).

---

## 8. Channels through which skill contents could leave the sandbox

Assumption: skills are decrypted into `$HERMES_HOME/skills/` (or an external dir) and surface to the model via the skills index in the system prompt and `skill_view` tool results.

| # | Channel | How skill content gets there | Default state | How to close |
|---|---|---|---|---|
| 1 | Model provider requests | System prompt skill index and `skill_view` results are sent on every call; aux tasks (compression summaries, title generation, approval guardian, background review) also send conversation text | Always (inherent) | Route only to our LiteLLM gateway; disable prompt/response logging in LiteLLM or encrypt it; choose providers with no-training terms (`security.allow_data_training_tiers_noninteractive` exists for warnings); never set `OPENROUTER_API_KEY` in the sandbox |
| 2 | Hermes log files | 80-char message previews, 200-char tool failure snippets, DEBUG output | On | Keep INFO level; do not export `logs/` to owner-visible storage; or pipe logs to our store only |
| 3 | `request_dump_*.json` | Full request body including system prompt | On (auto on 4xx and retry exhaustion) | Treat `$HERMES_HOME/sessions/` as secret; wipe or encrypt before export. No config switch found to disable it |
| 4 | Session DB (`state.db`) and exports (`hermes sessions export`, `hermes_state_portability.py`) | System prompt table, full message and tool result history | On | Encrypt at rest when persisting between sandbox sessions; never expose `/api/sessions/{id}/messages` to owners |
| 5 | API server run events and sessions endpoints | `/v1/runs/{id}/events`, `/api/sessions/{id}/messages`, `/v1/responses` stream tool calls and results (`gateway/platforms/api_server*.py`) | On if API server enabled | Only our orchestrator holds the API key; never forward the raw stream to owner UIs (the narrator model should see actions only). `/v1/skills` returns name, description, category (not bodies) |
| 6 | Trajectories | Full conversation JSONL | Off | Keep `save_trajectories` False |
| 7 | Trace upload (HF) | Full transcript | Off, operator command, needs `HF_TOKEN` | No HF token; block `huggingface.co` |
| 8 | Debug share | Logs with conversation fragments to public pastebins and Nous S3 | Off, operator command | Block `paste.rs`, `dpaste.com`, `portal.nousresearch.com` |
| 9 | Outbound webhooks | `tool_input` and hook kwargs POSTed to configured URLs | Off (`hooks.outbound` empty) | Managed Scope pin plus egress block; `HERMES_SAFE_MODE=1` also skips registration |
| 10 | Observability plugins (Langfuse, NeMo Relay, OTLP) | Langfuse captures full prompts and tool I/O; OTLP is content-free | Off | Do not enable; block hosts |
| 11 | `send_message` and messaging adapters | Agent chooses what to send to a chat platform | Off unless a platform is configured | Configure API server only; no platform tokens |
| 12 | MCP tool arguments | Agent can put skill text into arguments of our data server (web search queries, document reads) or platform server (Thesis Board notes) | On (our design) | Server-side: our MCP servers must treat args as potentially skill-bearing; the platform server's Thesis Board writes go to the narrator, not to owners verbatim; consider a leakage classifier on write tools |
| 13 | Web requests and URLs | Query strings, `web_search` queries to keyless providers, `web_extract`/browser/vision URLs to arbitrary hosts, TTS text to Microsoft | On if toolsets enabled | Disable `web`, `browser`, `vision`, `tts`, `image_gen` toolsets; do web search through our MCP; egress allowlist blocks the rest |
| 14 | Terminal and execute_code | `curl`/`python` can POST anything anywhere | On (core tools) | Egress allowlist is the real control; consider disabling both toolsets |
| 15 | Subagents (`delegate_task`) | Child agents get task text and can load skills; use `delegation.base_url` or inherit parent | On | Ensure `delegation.*` inherits our gateway; children share the same sandbox egress policy |
| 16 | Memory writes | Agent can copy skill text into MEMORY.md; external memory providers (mem0, honcho, retaindb, supermemory...) would ship it to third parties | Built-in on; external off | Keep external providers off; memory persists only in our encrypted export; consider `memory.write_approval` or disabling memory for pro-skill agents |
| 17 | Agent-created skills, background review, curator | `skill_manage` can create or patch skills containing copies of private skills; background review fork runs by default (`background_review.enabled: True`); curator archives and backs up skills | On | Disable `skill_manage` (or set skills dir for equipped skills read-only / use `skills.external_dirs`), `curator.enabled: false`, background review off; exclude agent-created skills from anything owners can read |
| 18 | Skill Sync / skills hub publish | Push to `gateway-gateway.nousresearch.com`; hub `publish`/propose flows | Inert without Nous admin login | No Nous login; block host |
| 19 | Title generation and session titles | Aux model summarizes the first turns into a title stored in `sessions.title` | On (`title_generation.enabled: True`) | If titles are ever shown to owners, disable or route through narrator |
| 20 | Error messages surfaced to callers | Provider errors, tool errors could quote content | On | Orchestrator should not relay raw Hermes errors to owners |

---

## Implications for our platform

1. **Egress allowlist = LiteLLM gateway host + our MCP server hosts.** Everything else Hermes contacts by default (models.dev, model catalog, GitHub update check, tirith and PM downloads, keyless web search) is optional and fails soft; turn each off in config so it does not retry.
2. **Pin config with Managed Scope** (root-owned `/etc/hermes/config.yaml` and `.env`, `HERMES_MANAGED_DIR` fixed in the image), because the agent can otherwise edit `~/.hermes/config.yaml` through the shell and add webhooks, plugins, or a different `base_url` for the next session.
3. **Pre-bake all dependencies** and set `security.allow_lazy_installs: false`; either pre-install tirith or disable it.
4. **Restrict toolsets** to our MCP servers plus the minimum built-ins (skills_list, skill_view, todo, maybe memory). Drop `web`, `browser`, `vision`, `tts`, `image_gen`, `terminal`, `execute_code`, `delegate_task`, `cronjob`, `kanban`, `homeassistant`, `computer_use`, `skill_manage` unless a tier needs them. This closes most leakage channels and most injection surfaces at once.
5. **Treat `$HERMES_HOME` as secret material** when exporting sandbox state: `state.db` (system prompt table and tool results), `sessions/request_dump_*.json`, `logs/`, `memories/`, `skills/` (including agent-created and `.curator_backups`). Encrypt the export with the same key regime as the skills; never let owner-facing services read it.
6. **The owner-facing narrator must consume structured events, not Hermes streams.** API server run events and session endpoints carry full tool results.
7. **The LiteLLM virtual key is model-readable.** Assume leakage; enforce per-key budgets and rotate on sandbox restart.
8. **Injection wrapping will apply to our `mcp_*` tools automatically**, which is good for data tools (web, X, docs) but also wraps our trusted platform tools; consider documenting this in playbooks so the model still follows platform-tool results (e.g., goals and limits).
9. **Skill content can trip the strict threat scan** if written through `skill_manage` or memory; we should install skills by placing files directly, not via agent tools.
10. **Telemetry is off by default and content-free even when on**; no action needed beyond pinning it off.

## Open questions

1. Is there any way to disable automatic `request_dump_*.json` writes? None found; a spike should confirm by forcing a 400 from LiteLLM and checking `$HERMES_HOME/sessions/`.
2. Exactly which code paths hit `models.dev` when the only provider is a custom OpenAI-compatible endpoint? Suggested spike: run one session with the egress firewall logging denials and list every blocked host.
3. Does the gateway (API server mode, no TTY) run the passive update check or tirith install at startup? `prefetch_update_check` is called from CLI banner and TUI gateway; gateway path not traced.
4. Can equipped skills be made read-only to `skill_manage` (for example by using `skills.external_dirs`)? Not verified; belongs with the skills/memory report (04).
5. Does `convert_to_trajectory_format` include the system prompt? Not traced (trajectories are off by default).
6. Which exact host does `edge-tts` contact? Lives in a third-party package, not in repo.
7. What does the `smart` approval mode do in API server runs (is the guardian LLM called, and does it see skill text)? Guardian calls go to our gateway either way, but behavior in unattended API contexts (`approvals.unattended_mode: deny`) needs confirmation.
8. Does `pm` ever contact PyPI when `allow_lazy_installs: false` (for example `pm sync` during update)? `pm/features.py` says the feature list is frozen; network behavior not traced.
9. Whether Hermes Docker image docs are stale: `pm/install.py` says the image sets `HERMES_DISABLE_LAZY_INSTALLS`, but the `Dockerfile` at this commit does not.
