# 03. Hermes Agent: Tools and MCP

| Field | Value |
|---|---|
| Commit analyzed | `085d9ee608893bb0611c2fc339c19d8848af9f2b` |
| Commit date | 2026-09-25 |
| Release tag | `v2026.9.24` (HEAD is past it) |
| License | MIT |
| Scope | Tool registry, toolsets, built-in tools, MCP client, tool search (deferral), approvals, hooks, tool output limits |

Labels: **Verified** means seen in code (or in-repo docs, and said so). **Inferred** means reasoning about likely behavior. Where docs and code disagree, the code is treated as the truth and the disagreement is called out.

---

## 1. How the tool registry is built

### 1.1 Registration and discovery (Verified)

- `tools/registry.py` defines a process-wide `ToolRegistry` singleton (`registry`). Each tool module calls `registry.register(name=, toolset=, schema=, handler=, check_fn=, requires_env=, is_async=, emoji=, max_result_size_chars=, dynamic_schema_overrides=, override=)` at import time (`ToolRegistry.register`, `tools/registry.py` ~line 666).
- `discover_builtin_tools()` (`tools/registry.py` ~line 96) AST-scans every `tools/*.py` (and `tools/<pkg>/tool.py`) for a top-level `registry.register(...)` call, caches the verdict on disk keyed by mtime and size, and imports the matching modules. There is no manual import list. `model_tools.py` triggers discovery.
- `register()` rejects non-dict schemas and rejects cross-toolset name shadowing unless `override=True`; plugins additionally need `plugins.entries.<plugin_id>.allow_tool_override: true` to override a built-in (`_PluginOverridePolicy`, same file).
- Plugins register through `ctx.register_tool(...)` (for example `plugins/spotify/__init__.py`, `plugins/google_meet/__init__.py`, `plugins/platforms/a2a/tools.py`). MCP servers register via `tools/mcp_tool_registration.py::_register_candidates` into a toolset named `mcp-<server>`.
- Availability: `ToolRegistry.get_definitions(tool_names)` drops any tool whose `check_fn` returns False (results TTL-cached about 30 s, keyed by profile home, `_check_fn_cached`). Example: `web_search` is only exposed when `check_web_api_key` passes (`tools/web_tools.py` line ~542).
- Dispatch: `ToolRegistry.dispatch()` filters kwargs to what the handler accepts, bridges async handlers, and turns every exception into a JSON `{"error": ...}` string. All handlers must return a JSON string or a multimodal envelope (`_normalize_handler_result`).

### 1.2 From toolsets to the model-visible tool list (Verified)

1. **Toolsets** are named groups in the single `TOOLSETS` dict in `toolsets.py`. `_HERMES_CORE_TOOLS` is the default bundle every `hermes-<platform>` toolset inherits (`_bundle()`). Composite toolsets use `includes` (e.g. `debugging`, `safe`). `resolve_toolset()` expands recursively; `all` / `*` expands to every toolset.
2. **Per-surface selection** is resolved by `hermes_cli/tools_config.py::_get_platform_tools(config, platform)`:
   - reads `platform_toolsets.<platform>` (e.g. `cli`, `api_server`, `cron`, `acp`, `telegram`); if absent, falls back to the platform default (`hermes-<platform>`), minus `_DEFAULT_OFF_TOOLSETS` (`homeassistant, spotify, discord, discord_admin, video, video_gen, x_search, a2a, kanban`).
   - MCP servers: names of configured MCP servers in the list act as an allowlist; if none are named, every enabled server is included; the sentinel `no_mcp` excludes all (`_merge_mcp_servers`).
   - `agent.disabled_toolsets` is applied last as a global suppression list.
   - Callers: `cli.py` and `hermes_cli/oneshot.py` use platform `cli`; `gateway/platforms/api_server.py` uses `api_server`; `acp_adapter/session.py` uses `acp`.
3. **CLI override**: `hermes chat -t/--toolsets a,b,c` (`hermes_cli/_parser.py` line ~173) and `run_agent.py --enabled_toolsets/--disabled_toolsets`. Programmatic: `AIAgent(enabled_toolsets=[...], disabled_toolsets=[...])` (`run_agent.py` line 269).
4. **Schema assembly**: `model_tools.get_tool_definitions()` then `_compute_tool_definitions()`:
   - `_select_tool_names()` unions enabled toolsets, strips role-reserved toolsets (`setup`), then subtracts `disabled_toolsets` last.
   - `registry.get_definitions()` applies `check_fn`.
   - `_apply_dynamic_schemas()` rewrites a few descriptions so they only mention tools that are actually present (e.g. `browser_navigate`, `execute_code`, `delegate_task`), and drops `browser_exec` if `terminal` is absent (`_rewrite_browser_exec`).
   - `tools/schema_sanitizer.py::sanitize_tool_schemas` normalizes schemas.
   - `tools/tool_search.py::assemble_tool_defs` optionally replaces deferrable tools with three bridge tools (section 3.5).
5. Tools injected outside the toolset path: external memory-provider tools (`agent/memory_manager.py::inject_memory_provider_tools`, gated on the `memory` toolset) and context-engine tools (`agent/agent_init.py` ~line 2105, gated on `context_engine` being enabled or on `enabled_toolsets is None`).
6. At call time, calls to names not in `agent.valid_tool_names` get an error result and are not dispatched (`agent/turn_tool_round.py` ~line 94). Calls through the `tool_call` bridge are re-checked against the session scope (`agent/tool_executor.py::_unwrap_tool_search_call`).

`toolset_distributions.py` is only for `batch_runner.py` data generation (random toolset sampling). It is not a runtime tiering mechanism (Verified).

### 1.3 Built-in tool inventory

Sources: `grep registry.register` across `tools/`, `toolsets.py`, and `website/docs/reference/tools-reference.md` (descriptions condensed). "Core" means the tool is in `_HERMES_CORE_TOOLS` (on by default in `hermes-cli` and every messaging bundle). Toolset is the `TOOLSETS` key (registry toolset in parentheses when it differs). All Verified unless noted.

| Tool (model-visible name) | Toolset | Core | One-line description |
|---|---|---|---|
| `web_search` | `web`, `search` | yes | Web search via configured backend (Exa, Parallel, Firecrawl, Tavily, SearXNG, etc.) |
| `web_extract` | `web` | yes | Fetch up to 5 URLs as markdown/text; default 15,000-char per-page budget |
| `x_search` | `x_search` | no (default-off) | Read-only X/Twitter search via xAI; needs xAI credentials |
| `terminal` | `terminal` | yes | Run shell commands in the configured backend; background mode |
| `process_manage` | `terminal` | yes | List/poll/log/wait/kill/write background processes |
| `read_file` | `file` | yes | Read text/ipynb/docx/xlsx with line numbers and pagination |
| `write_file` | `file` | yes | Overwrite a file (requires prior read), syntax check |
| `patch` | `file` | yes | Fuzzy find-and-replace edit returning a diff |
| `search_files` | `file` | yes | Ripgrep content search or filename search |
| `execute_code` | `code_execution` | yes | Run a Python script that can call a whitelisted set of tools via RPC |
| `vision_analyze` | `vision` | yes | Analyze an image (native multimodal or auxiliary vision model) |
| `video_analyze` | `video` | no | Analyze a video URL/file |
| `image_generate` | `image_gen` | yes | Text-to-image / image edit via FAL, OpenAI, xAI, Krea |
| `video_generate`, `xai_video_edit`, `xai_video_extend` | `video_gen` | no | Video generation/edit via plugin backends |
| `text_to_speech` | `tts` | yes | TTS audio via Edge, ElevenLabs, OpenAI, xAI |
| `skills_list` | `skills` | yes | List skills (name + description) |
| `skill_view` | `skills` | yes | Load a skill's SKILL.md and linked files |
| `skill_manage` | `skills` | yes | Create/update/delete skills on disk |
| `memory` | `memory` | yes | Write persistent MEMORY.md / USER.md notes |
| `todo_list` | `todo` | yes | Session task list |
| `session_search` | `session_search` | yes | FTS search over past sessions in the local DB |
| `clarify` | `clarify` | yes | Ask the user a question (choices or free text) |
| `delegate_task` | `delegation` | yes | Spawn subagents with isolated context |
| `cronjob_manage` | `cronjob` | yes | Create/list/update/pause/run/remove scheduled jobs |
| `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_scroll`, `browser_back`, `browser_press`, `browser_get_images`, `browser_vision`, `browser_console` | `browser` | yes | Browser automation (accessibility snapshot, refs, screenshots, console) |
| `browser_cdp`, `browser_dialog` | `browser` (registry: `browser-cdp`) | yes | Raw CDP command; answer JS dialogs. Only when a CDP endpoint is reachable |
| `browser_exec` | `browser` (registry: `browser-use`) | yes | Runs browser-use Python on host; replaces other browser tools when `browser.backend: browser-use`; dropped when `terminal` absent |
| `browser_vault_list`, `browser_vault_unlock`, `browser_vault_fill`, `browser_vault_save_login`, `browser_vault_enter_code` | `browser` | yes | Credential vault for login forms |
| `computer_use` | `computer_use` | yes (gated on `cua-driver`) | Desktop control: screenshots, mouse, keyboard |
| `ha_list_entities`, `ha_get_state`, `ha_list_services`, `ha_call_service` | `homeassistant` | yes (default-off, needs `HASS_TOKEN`) | Home Assistant control |
| `kanban_show`, `kanban_list`, `kanban_complete`, `kanban_block`, `kanban_request_review`, `kanban_request_changes`, `kanban_heartbeat`, `kanban_comment`, `kanban_create`, `kanban_link`, `kanban_unblock`, `kanban_attach`, `kanban_attach_url`, `kanban_attachments` | `kanban` | yes (default-off, workflow gated) | Multi-agent kanban board worker/orchestrator tools |
| `manage_connections` | `connections` | yes (gated on Nous Portal connectors) | Connect managed connector accounts; install/enable/authorize catalog MCP servers |
| `manage_catalog` | `setup` | no (role-reserved) | Setup-profile-only plugin/skill install |
| `read_terminal`, `close_terminal`, `desktop_preview`, `drive_preview`, `annotate_preview`, `read_window_below`, `focus_pane`, `react_to_message`, `gui_tour`, `show_tip`, `apply_layout` | `desktop_ui` | no (desktop sessions only) | Desktop GUI affordances |
| `desktop_project` | `project` | no (desktop sessions only) | Create/switch desktop Projects |
| `discord`, `discord_admin` | `discord`, `discord_admin` | no | Discord read/participate and admin |
| `feishu_doc_read`, `feishu_drive_*` (4) | `feishu_doc`, `feishu_drive` | no | Feishu/Lark docs and comments |
| `yb_query_group_info`, `yb_query_group_members`, `yb_send_dm`, `yb_search_sticker`, `yb_send_sticker` | `hermes-yuanbao` | no | Yuanbao messaging |
| `spotify_*` (7) | `spotify` (plugin) | no | Spotify control (bundled plugin) |
| Google Meet tools | `google_meet` (plugin) | no | Join/transcribe Meet calls (plugin, Linux/macOS) |
| A2A tools | `a2a` (plugin) | no (default-off) | Agent-to-agent platform tools |
| `tool_search`, `tool_describe`, `tool_call` | (bridge, not registry) | n/a | Injected only when Tool Search activates (section 3.5) |
| `mcp__<server>__<tool>` | `mcp-<server>` | n/a | Dynamic MCP tools (section 3) |

Notes:
- `send_message_tool.py` exists but registers no model tool; `toolsets.py` says "there is deliberately no agent-callable send_message tool" (Verified).
- `tools/AGENTS.md` lists toolset keys `moa`, `rl`, `messaging`, `safe` etc. `moa`, `rl` and `messaging` are not present in `TOOLSETS` at this commit (Verified by grep); the AGENTS.md list is stale.

---

## 2. Tools that touch shell, filesystem, network, or browser, and how to restrict them

General switches (Verified unless noted):
- Remove a toolset for one surface: omit it from `platform_toolsets.<platform>` (explicit list).
- Remove it everywhere: `agent.disabled_toolsets: [terminal, file, ...]` (applied last, at tool granularity, `model_tools._select_tool_names`).
- CLI: `hermes chat -t search,todo,<mcp-server>`; programmatic: `AIAgent(enabled_toolsets=..., disabled_toolsets=...)`.
- `--safe-mode` / `HERMES_SAFE_MODE=1` disables plugins, MCP servers and shell hooks (`tools/mcp_tool_config.py::_load_mcp_config`, `website/docs/reference/environment-variables.md`). Not useful for us because it also disables MCP.
- There is **no per-individual-built-in-tool disable key**. Granularity is the toolset. The docs describe a `custom_toolsets:` config block (`website/docs/reference/toolsets-reference.md`), but no code reads it: `create_custom_toolset()` in `toolsets.py` has no caller (Verified by grep). Treat `custom_toolsets` as not implemented.

| Tool(s) | Shell | FS | Network | Browser | How to disable or restrict |
|---|---|---|---|---|---|
| `terminal`, `process_manage` | yes | yes | yes (anything the shell can reach) | no | Drop toolset `terminal`. Restrict: `terminal.backend` (local, docker, ssh, modal, daytona, singularity, vercel_sandbox; `tools/environments/`), `terminal.cwd`, `terminal.timeout`, `approvals.*`, `approvals.deny` globs (never bypassable), `security.tirith_*` |
| `execute_code` | yes (spawns Python subprocess) | yes | yes | no | Drop toolset `code_execution`. Restrict: `code_execution.mode` (`project`/`strict`), `code_execution.timeout` (default 300 s), `code_execution.max_tool_calls` (default 50). In-sandbox tool RPC limited to `SANDBOX_ALLOWED_TOOLS` = web_search, web_extract, read_file, write_file, search_files, patch, terminal, intersected with session tools (`tools/code_execution_tool.py` line 42). Approval via `check_execute_code_guard` |
| `read_file`, `write_file`, `patch`, `search_files` | no | yes | no | no | Drop toolset `file`. Guards: sensitive-path and protected-instruction-file checks (`tools/file_tools_write_guards.py`, `security.protected_instruction_files`). No configurable root/jail for file tools was found (Inferred from grep; see Open questions) |
| `web_search`, `web_extract` | no | writes cache (`cache/web`) | yes | no | Drop toolsets `web` and `search`. Config: `web.backend`, `web.search_backend`, `web.extract_backend` (SearXNG supported), `web.keyless_fallback: false`, `web.keyless_rescue: false`, `web.extract_char_limit`, `security.website_blocklist`, `security.allow_private_urls` |
| `x_search` | no | no | yes (xAI) | no | Default-off; needs xAI creds; drop `x_search` |
| `browser_*`, `browser_cdp`, `browser_dialog`, `browser_vault_*` | no | yes (downloads, screenshots) | yes | yes | Drop toolset `browser`. Config section `browser:` (`browser.backend`, `browser.cdp_url`). `web_search` is intentionally not in `browser`, so disabling browser does not remove search |
| `browser_exec` | yes (host Python) | yes | yes | yes | Removed automatically when `terminal` is not available (`model_tools._rewrite_browser_exec`) |
| `computer_use` | no | reads screen | no | desktop | Drop toolset `computer_use`; gated on `cua-driver` binary |
| `vision_analyze`, `video_analyze` | no | reads local files | yes (URLs, aux vision model) | no | Drop `vision` / `video` |
| `image_generate`, `video_generate`, `xai_video_*` | no | writes outputs | yes | no | Drop `image_gen` / `video_gen` |
| `text_to_speech` | no | writes audio | yes | no | Drop `tts` |
| `skill_manage` | no | yes (writes skill dirs) | no | no | Only removable with the whole `skills` toolset. To keep `skills_list`/`skill_view` but block writes, use a `pre_tool_call` hook (section 4.4) or `skills.write_approval: true` (stages mutations) |
| `memory` | no | yes (MEMORY.md, USER.md) | provider-dependent | no | Drop `memory` (also withholds external memory-provider tools) |
| `session_search` | no | reads state DB | no | no | Drop `session_search` |
| `cronjob_manage` | no | writes job store | no | no | Drop `cronjob` |
| `delegate_task` | indirect (children get terminal/file/web by default, `DEFAULT_TOOLSETS` in `tools/delegate_tool_toolsets.py`) | indirect | indirect | indirect | Drop `delegation`. Children are intersected with the parent's toolsets and never get `delegate_task`, `clarify`, `memory`, `send_message`, `cronjob_manage` (`DELEGATE_BLOCKED_TOOLS`) |
| `kanban_attach_url` and other kanban | no | yes | yes (URL download) | no | Default-off; drop `kanban` |
| `manage_connections` | no | writes MCP config/tokens | yes (Nous gateway, OAuth) | no | Drop `connections`. It can install catalog MCP servers and add them to the live session's toolset selection (`agent/inline_tool_executors.py::_scope_in_connected_mcp_servers`). Also set `tools.connectors.enabled: false` |
| `ha_*`, `discord*`, `spotify_*`, `feishu_*`, `yb_*` | no | no | yes | no | Default-off or platform-only; drop their toolsets |
| MCP tools | depends on server (stdio servers are local processes) | depends | yes | depends | `mcp_servers.<name>.enabled: false`, `tools.include/exclude`, `no_mcp`, `trust: untrusted` |

---

## 3. MCP servers

### 3.1 Configuration format (Verified in `website/docs/reference/mcp-config-reference.md`, cross-checked in code)

Config lives in `config.yaml` under `mcp_servers:` (loaded by `tools/mcp_tool_config.py::_load_mcp_config`, which also runs `_filter_suspicious_mcp_servers` via `hermes_cli/mcp_security.py::validate_mcp_server_entry` and `${VAR}` / `${env:VAR}` interpolation from the profile's secret scope). CLI helpers: `hermes mcp add|remove|list|test|login|reauth|configure` (`hermes_cli/mcp_config.py`).

Transports (`tools/mcp_tool_transport.py`):
- **stdio**: `command` + `args` + `env` (+ optional `cwd`). Spawned via the MCP SDK `stdio_client` with a filtered environment (`_build_safe_env`: safe baseline keys, `XDG_*`, secret-source vars, plus the entry's own `env`). There is an OSV malware preflight for the command (`_preflight_stdio_command`).
- **Streamable HTTP** (default for `url`): `_streamable_http_transport`, with a content-type preflight (`skip_preflight` to bypass).
- **SSE**: `url` + `transport: sse` (`_sse_transport`).
- `protocol: auto|stateless|legacy` for protocol-era negotiation.

Auth and headers:
- Static headers: `headers: {Authorization: "Bearer ${AGENT_MCP_TOKEN}"}` (HTTP/SSE only).
- `identity_header: {name, value_from: static|profile, value}` adds a caller-identity header unless `headers` already sets it (docs `website/docs/user-guide/features/mcp.md` line ~460; code references in `tools/mcp_tool_transport.py`).
- `auth: oauth` for OAuth 2.1 PKCE (browser or `hermes mcp login --flow device`); tokens in `<HERMES_HOME>/mcp-tokens/<server>.json`.
- mTLS: `client_cert`, `client_key`, `ssl_verify`.
- Redirects: a redirect header stripper exists (`_make_redirect_header_stripper`, `strict_redirect_headers`) so configured headers do not follow cross-origin redirects when strict mode is on (Verified names; exact semantics not deeply traced).

Other per-server keys: `enabled`, `timeout` (tool call, default 300 s, `tools/mcp_tool_common.py::_DEFAULT_TOOL_TIMEOUT`), `connect_timeout` (default 60 s), `supports_parallel_tool_calls`, `keepalive_interval`, `lazy`, `idle_timeout_seconds`, `max_lifetime_seconds`, `trust: full|untrusted`, `sampling:` (server-initiated LLM calls, **enabled by default**, routed through `agent.auxiliary_client.call_llm(task="mcp")`, `tools/mcp_tool_sampling.py`), `elicitation:` (enabled by default, routed to the approval surface).

Global: `mcp.discovery_concurrency` (default 4), `mcp.auto_reload_on_config_change` (default true), `/reload-mcp`.

Example for our platform (config only):

```yaml
mcp_servers:
  chain:
    url: "https://chain-tools.internal.example/mcp"
    headers:
      Authorization: "Bearer ${AGENT_MCP_TOKEN}"
      X-Agent-Id: "${AGENT_ID}"
    timeout: 60
    connect_timeout: 20
    trust: full
    sampling: {enabled: false}
    elicitation: {enabled: false}
    tools:
      resources: false
      prompts: false
  platform:
    url: "https://platform-tools.internal.example/mcp"
    headers:
      Authorization: "Bearer ${AGENT_MCP_TOKEN}"
    sampling: {enabled: false}
    elicitation: {enabled: false}
    tools: {resources: false, prompts: false}
```

### 3.2 Naming and prefixing (Verified)

- Wire name: `mcp__<server>__<tool>` (`tools/mcp_tool_schema.py::mcp_prefixed_tool_name`, `MCP_TOOL_NAME_PREFIX = "mcp__"`). Characters outside `[A-Za-z0-9_]` become `_`. Names over 64 chars are clamped with an 8-hex SHA-256 suffix.
- Each server's tools go in toolset `mcp-<server>`, with the bare server name registered as an alias (`registry.register_toolset_alias`). So `platform_toolsets.cli: [chain]` and `[mcp-chain]` both work.
- Utility tools per server (`mcp__<server>__list_resources`, `read_resource`, `list_prompts`, `get_prompt`) are registered only if the server advertises the capability and `tools.resources` / `tools.prompts` are not false.
- Collisions: an MCP tool that would shadow a built-in or another server's tool is skipped (`_register_candidates`, `_resolve_name_collisions`).
- Doc drift: `website/docs/user-guide/features/mcp.md` ("How Hermes registers MCP tools") still shows single-underscore `mcp_<server>_<tool>`; the code and the reference doc use `mcp__`. Several internal allowlists still use the `mcp_` prefix (e.g. `tools/budget_config.py::MCP_TOOL_PREFIX = "mcp_"`, `agent/tool_dispatch_helpers.py::_UNTRUSTED_TOOL_PREFIXES`), which still match because `mcp__` starts with `mcp_`.

### 3.3 Include/exclude filtering (Verified)

`tools/mcp_tool_registration.py::_make_tool_filter`: `tools.include` is a whitelist (exact names or fnmatch globs, `[]` registers nothing), `tools.exclude` a blacklist, include wins when both are set. Filters match the **original** server tool name, before sanitization.

### 3.4 Description and result hygiene (Verified)

- Tool descriptions are scanned for injection-like patterns (`_scan_mcp_description`), but a hit only **logs a warning**; the tool still registers.
- Unicode tag characters are stripped from descriptions and results (`strip_unicode_tags`).
- Every result from a tool whose name starts with `mcp_`, `browser_`, or equals `web_search`/`web_extract` is wrapped in `<untrusted_tool_result source="...">` with a "treat as data" preamble (`agent/tool_dispatch_helpers.py::_maybe_wrap_untrusted`), and gets an advisory threat scan (`_tool_output_risk_metadata`, never blocks). This applies to our own trusted MCP servers too.
- `trust: untrusted` makes every tool without `readOnlyHint: true` go through the approval gate (`tools/mcp_tool_handlers.py::_trust_gate_check`), fail-closed if the approval system errors.

### 3.5 Lazy start and Tool Search deferral (Verified)

- `lazy: true` registers tools from the on-disk schema cache and connects on first call (requires one prior live connect).
- **Tool Search** (`tools/tool_search.py`, config `tools.tool_search`, defaults in `hermes_cli/config_defaults.py` ~line 1963): `enabled: auto` (alias of `on`). It activates whenever **any** deferrable tool exists, and **every MCP tool is deferrable** (`is_deferrable_tool_name`: toolset starts with `mcp-`). Core tools never defer unless listed in `defer`. When active, the model sees `tool_search`, `tool_describe`, `tool_call` instead of the MCP schemas, plus an embedded listing (name + first sentence) if it fits `min(listing_max_tokens=4000, threshold_pct=5% of context)`.
- Consequence: with defaults, all of our MCP tools would sit behind the bridge and cost an extra describe round trip, and provider-native argument validation does not apply (Hermes validates locally, `tool_search_validation.py`). There is no per-server "keep eager" switch; the only way to keep MCP tools eager is `tools.tool_search.enabled: off` (Verified: `classify_tools` has no per-server exception).
- Tool Search also reaches Nous "connectors" when signed in to the Nous Portal; `tools.connectors.enabled: false` turns that off.

---

## 4. Permission and approval system

### 4.1 What it covers (Verified)

`tools/approval.py` is a **dangerous-action gate**, not a general per-tool permission system. It covers:
- Terminal commands: `check_all_command_guards()` (pattern detection in `tools/approval_detection.py`, Tirith scanner, hardline floors).
- `execute_code` scripts: `check_execute_code_guard()`.
- Actions flagged by plugins/shell hooks returning `approve` from `pre_tool_call` (`request_tool_approval`, called from `hermes_cli/plugins.py::_resolve_block_from_details`).
- File-tool writes to protected instruction files (`tools/file_tools_write_guards.py`), computer_use, SSH-config writes (per comment in `_run_approval_gate`).
- MCP tools on `trust: untrusted` servers (`_trust_gate_check`), MCP elicitation.
Ordinary tool calls (web_search, read_file, MCP tools on trusted servers, etc.) are not approval-gated.

### 4.2 Modes and keys (Verified, `hermes_cli/config_defaults.py` ~line 1639 and `tools/approval_context.py`)

| Key | Default | Meaning |
|---|---|---|
| `approvals.mode` | `smart` | `manual` (ask human), `smart` (guardian LLM decides APPROVE/DENY/ESCALATE first, `tools/approval_smart.py`), `off` (bypass). Unknown values fall back to `manual` |
| `approvals.cron_mode` | `deny` | Cron runs: deny or approve flagged commands |
| `approvals.single_query_mode` | `deny` | `hermes chat -q` runs |
| `approvals.unattended_mode` | `deny` | Sessions on platforms `webhook`, `msgraph_webhook`, `api_server` (`_UNATTENDED_APPROVAL_PLATFORMS`) |
| `approvals.deny` | `[]` | fnmatch globs on terminal commands; block even under `--yolo` or `mode: off` |
| `approvals.timeout` | 300 | Seconds to wait for a human |
| `approvals.smart_policy` | "" | Extra guardian rules |
| `command_allowlist` | `[]` | Permanently approved patterns |
| `security.approval.transport` | `builtin` | Plugin approval transport (could route to our own approval UI), `transport_fallback: deny` |
| `--yolo` / `HERMES_YOLO_MODE` | off | Bypass (frozen at import) |

Hardline catastrophic commands and `approvals.deny` rules are floors that nothing bypasses (`_floor_block`). Isolated backends (`docker` without host mounts, `singularity`, `modal`, `daytona`, `vercel_sandbox`) skip the dangerous-command prompts entirely (`_should_skip_container_guards`).

### 4.3 Headless behavior (Verified in `tools/approval.py`)

- Cron, `-q`, and unattended platforms: resolve instantly from their `*_mode` key (default deny); never park waiting for a human.
- **A context that is none of these** (no interactive CLI, no gateway, no `HERMES_EXEC_ASK`, no cron, no platform in the unattended list), which is what a plain Python `AIAgent` embedding looks like: `check_all_command_guards` **auto-approves** flagged terminal commands (only the floors still apply), and `_run_approval_gate` auto-approves unless the caller passed `fail_closed_when_no_human` (plugin `approve` directives use the fail-closed path via `request_tool_approval`; not traced for every caller). Code: the `if not is_cli and not is_gateway and not is_ask:` branches in both functions log a warning and return `_approved()`.
- `api_server` keeps `is_ask` for its `/v1/runs` approval bridge (comment in `_presence`), so on that surface a flagged action may go to a human-approval round trip rather than the `unattended_mode` shortcut (Inferred from the comment; not traced end to end).

### 4.4 Can we enforce a strict per-agent allowlist? Yes, by configuration (Verified mechanisms, Inferred composition)

Layers, strongest last:
1. **Schema level**: `platform_toolsets.<surface>: [todo, <mcp servers>...]` plus `agent.disabled_toolsets: [terminal, code_execution, file, browser, web, delegation, cronjob, connections, computer_use, ...]`. Tools not selected never reach the model.
2. **Call level**: calls to names outside `valid_tool_names` are rejected (`agent/turn_tool_round.py`); bridge calls re-checked (`_unwrap_tool_search_call`).
3. **Per-server tool filter**: `mcp_servers.<name>.tools.include`.
4. **Policy hook** (defense in depth): a shell `pre_tool_call` hook in `config.yaml` (`hooks:` block, `matcher` regex, `fail_closed: true`, exit code 2 or `{"action":"block"}` blocks) or a Python plugin hook. Non-TTY runs need `hooks_auto_accept: true`, `HERMES_ACCEPT_HOOKS=1`, or a pre-seeded `~/.hermes/shell-hooks-allowlist.json` (`website/docs/user-guide/features/hooks.md`, "Shell Hooks"). A timed-out or raising `pre_tool_call` callback fails closed.
5. **Server side**: our MCP servers authenticate each agent (bearer token or `identity_header`) and enforce tier and policy themselves. This is the only layer the agent's runtime cannot change.

Caveats (Verified):
- `_RECENTLY_SHIPPED_TOOLSETS` in `hermes_cli/tools_config.py` can auto-add newly shipped toolsets to a saved explicit list after an upgrade (empty at this commit). Pin the Hermes version and keep `agent.disabled_toolsets` as a backstop.
- `context_engine` is auto-added when a non-default context engine is active unless the list is explicitly empty.
- Anything that can run code (terminal, execute_code, browser_exec) can bypass tool-level policy by calling the network or filesystem directly. The allowlist is only strict if those are removed.

---

## 5. How tool outputs are fed back, and limits

Flow (Verified): handler returns JSON string (or multimodal envelope) -> `transform_tool_result` plugin hook may rewrite (`model_tools._apply_transform_tool_result_hook`) -> per-result spill (`tools/tool_result_storage.py::maybe_persist_tool_result`) -> per-turn budget (`enforce_turn_budget`) -> `make_tool_result_message` wraps untrusted content -> appended as a `role: tool` message.

| Layer | Default | Config key | Source |
|---|---|---|---|
| MCP hard cap per text payload | 2,000,000 chars (head/tail) | none | `tools/mcp_tool_content.py::_MCP_HARD_RESULT_CAP_CHARS` |
| MCP resource blob cap | 50 MB decoded | none | same file |
| Per-result spill threshold (built-ins) | 100,000 chars, or 15% of context window if smaller (floor 8,000) | none (registry `max_result_size_chars`) | `tools/budget_config.py::budget_for_context_window` |
| Per-result spill threshold (MCP) | 50,000 chars (capped by the above) | `tool_budget.mcp_result_size_chars` | `tools/budget_config.py` |
| Per-turn aggregate | 200,000 chars, or 30% of context (floor 16,000); largest results spilled first | none | same |
| Spill preview | first 1,500 chars + path, instructs model to page with `read_file` or `execute_code` | none | `_build_persisted_message` |
| Spill location | `$HERMES_HOME/cache/spillover/<id>.txt`, pruned after 24 h | none | `tool_result_storage.py` |
| `read_file` | never spilled (pinned `inf`); pagination `tool_output.max_lines` 2000, `max_line_length` 2000 | `tool_output.*` | `budget_config.PINNED_THRESHOLDS`, `tools/tool_output_limits.py` |
| Terminal output | 50,000 chars head+tail | `tool_output.max_bytes` | `tool_output_limits.py` |
| `execute_code` stdout/stderr | 50 KB / 10 KB, spill up to 5 MB | none | `code_execution_tool.py` |
| `web_extract` per page | 15,000 chars head+tail, full text cached | `web.extract_char_limit` (and per-call `char_limit`) | `config_defaults.py` web section |
| Hook-injected context | 10,000 chars spilled to `hook_outputs/` | `hooks.output_spill.max_chars/enabled/directory` | `tools/hook_output_spill.py` |
| Identical repeat results | from the 2nd byte-identical repeat over 512 chars, replaced by a reference stub | `tool_loop_guardrails.*` | `agent/tool_guardrails.py` |
| Loop guardrails | warnings on; hard stop on for non-interactive platforms; `loop_caps.max_web_searches` 50 | `tool_loop_guardrails.*` | `config_defaults.py` ~line 534 |

There is no LLM summarization of individual tool outputs at result time; summarization happens later through context compression (`compression:` section, covered in another report) (Verified that web_extract says "no LLM summarization"; compression not traced here).

Important interaction (Verified): the spill notice tells the model to use `read_file` or `execute_code`. If both are removed, a spilled MCP result is reduced to its 1,500-char preview. Either raise `tool_budget.mcp_result_size_chars`, keep MCP payloads small and paginated server-side, or keep `read_file` enabled.

---

## 6. Tier-based tool sets by configuration only

Yes, for the Hermes side this can be pure configuration, because each agent runs its own Hermes instance with its own `config.yaml` (Inferred from our architecture plus Verified config mechanisms). The orchestrator renders a per-tier config on provisioning. Two equivalent shapes:

- **Separate premium server**: `data_premium` MCP server present (or `enabled: true`) only for pro.
- **One data server, per-tier include list**: `tools.include` globs differ per tier.

Sketch (pro tier; base/medium drop the `data_premium` entry or set `enabled: false`):

```yaml
# Rendered per agent by the orchestrator. Surface shown for api_server; use cli if run via `hermes chat -q`.
platform_toolsets:
  api_server: [todo, memory, skills, chain, data, data_premium, platform]
agent:
  disabled_toolsets: [terminal, code_execution, file, browser, web, search, x_search,
                      delegation, cronjob, connections, computer_use, clarify,
                      image_gen, video, video_gen, tts, vision, session_search, kanban]

tools:
  tool_search: {enabled: off}      # keep our small MCP surface eager
  connectors: {enabled: false}
tool_budget:
  mcp_result_size_chars: 30000

approvals:
  mode: manual
  unattended_mode: deny
  single_query_mode: deny
  cron_mode: deny

hooks:
  pre_tool_call:
    - matcher: "^(?!mcp__(chain|data|data_premium|platform)__|todo_list$|memory$|skills_list$|skill_view$).*"
      command: "/opt/agent-hooks/deny.sh"   # exits 2
      fail_closed: true
hooks_auto_accept: true

mcp_servers:
  chain:
    url: "https://chain-tools.internal.example/mcp"
    headers: {Authorization: "Bearer ${AGENT_MCP_TOKEN}"}
    sampling: {enabled: false}
    elicitation: {enabled: false}
    tools: {resources: false, prompts: false}
  data:
    url: "https://data-tools.internal.example/mcp"
    headers: {Authorization: "Bearer ${AGENT_MCP_TOKEN}"}
    sampling: {enabled: false}
    tools:
      include: ["web_search", "read_document", "x_*", "dune_*", "defillama_*", "envio_*"]
      resources: false
      prompts: false
  data_premium:                       # pro only
    url: "https://data-premium.internal.example/mcp"
    headers: {Authorization: "Bearer ${AGENT_MCP_TOKEN}"}
    sampling: {enabled: false}
    tools: {resources: false, prompts: false}
  platform:
    url: "https://platform-tools.internal.example/mcp"
    headers: {Authorization: "Bearer ${AGENT_MCP_TOKEN}"}
    sampling: {enabled: false}
    tools: {resources: false, prompts: false}
```

Notes on the sketch:
- The hook regex is illustrative; the matcher semantics (full match vs search) should be confirmed in a spike (see Open questions). Blocking `skill_manage` while keeping `skills_list`/`skill_view` needs the hook because they share the `skills` toolset.
- `memory` is shown because it is local and harmless, but whether to keep it depends on the skills/memory report.
- Tier enforcement must also exist server-side (the token maps to agent id and tier), because config is only as trustworthy as the sandbox that holds it.

---

## Implications for our platform

1. **Use explicit `platform_toolsets` plus `agent.disabled_toolsets` in a rendered per-agent config.** Remove `terminal`, `code_execution`, `file`, `browser`, `delegation`, `cronjob`, `connections`, `computer_use`, `clarify` (no owner chat). This gives a real allowlist at the schema level, backed by the call-level name check.
2. **Add a fail-closed `pre_tool_call` shell hook as a second layer**, with `hooks_auto_accept: true` or a pre-seeded allowlist file so it registers in headless runs.
3. **Set `tools.tool_search.enabled: off`** for our small MCP surface, otherwise every MCP tool is hidden behind `tool_search`/`tool_describe`/`tool_call` by default.
4. **Disable MCP `sampling` and `elicitation` on our servers.** Sampling is on by default and lets a server spend the agent's model budget via the auxiliary client; elicitation routes to approval surfaces we do not have.
5. **Authenticate per agent with `headers: {Authorization: "Bearer ${AGENT_MCP_TOKEN}"}`** (secret in the profile `.env`) and enforce tier and policy in our MCP servers. Hermes config can express tiers, but server-side checks are the authority.
6. **Do not rely on approvals for safety in headless embedding.** In a plain library context flagged commands are auto-approved; if we remove shell/code tools this mostly stops mattering. If an approval path is ever needed, `security.approval.transport` (plugin transport) is the hook to route it to our approval cards.
7. **Expect all MCP results to be wrapped as untrusted data** and spilled above 50K chars. Keep our tool payloads compact and paginated, or tune `tool_budget.mcp_result_size_chars`, since without `read_file` a spilled result is only a 1,500-char preview.
8. **Turn off outbound defaults that would fight the egress allowlist**: `tools.connectors.enabled: false`, `web.keyless_fallback: false` (if built-in web is kept at all), and do not ship `optional-mcps` catalog entries.
9. **Pin the Hermes version** because toolset membership and "recently shipped" auto-enable logic can change between releases.

## Open questions

1. `custom_toolsets` is documented but no code reads it. Confirm with a spike (render a config, run `hermes tools --summary` or `get_tool_definitions`) and do not rely on it.
2. Shell hook `matcher` semantics (regex search vs full match, applied to which name when a call goes through the `tool_call` bridge). Needs a spike with `hermes hooks test pre_tool_call --for-tool X`.
3. Which surface we will run (`api_server`, `hermes chat -q`, or Python `AIAgent`) determines which `platform_toolsets` key and which approval branch applies. The `api_server` approval bridge (`is_ask`) was not traced end to end.
4. No configurable directory jail for `read_file` was found. If we keep `read_file` for spill recovery, can it read decrypted skill files or `.env` inside the sandbox? Sensitive-path checks exist (`_check_sensitive_path`) but their coverage was not audited here.
5. Whether `skill_view` exposes decrypted private skill content in tool results that are persisted to the session DB and could reach the narrator or exports (belongs with the skills/memory and security reports).
6. How `readOnlyHint` from our servers interacts with parallel execution and transport retry: only read-only tools are replayed after a session expiry; write-capable calls return `outcome_uncertain`. Our unsigned-intent tools should be idempotent or carry request ids.
7. Whether the injection-pattern scan on MCP descriptions (log-only) or the untrusted wrapper has measurable effects on model behavior with our own trusted tool outputs.
8. Tool Search tier behavior if we later exceed the context budget with many MCP tools (for pro tiers with many premium tools), and its prompt-cache cost.
