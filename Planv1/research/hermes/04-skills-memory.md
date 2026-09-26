# 04. Hermes Agent: Skills and Memory

| Field | Value |
|---|---|
| Commit | `085d9ee608893bb0611c2fc339c19d8848af9f2b` |
| Commit date | 2026-09-25 |
| Release tag | `v2026.9.24` (HEAD is past it) |
| License | MIT |
| Scope | Skill format, discovery, loading, self-authoring (skill_manage, background review, curator), built-in memory (MEMORY.md / USER.md), external memory providers, on-disk state, backup/export |

Labels: **Verified** = seen in code or in-repo docs (file and function cited). **Inferred** = my reasoning about behavior not directly proven by code.

---

## 1. Executive summary

1. **Skills are plain directories on disk** (`<dir>/[category/]<name>/SKILL.md` plus optional `references/`, `templates/`, `scripts/`, `assets/`). Hermes has no encryption, signing, or access-control layer for skill content. (Verified: `agent/skill_utils.py`, `tools/skills_tool.py`)
2. **Progressive disclosure in three levels.** The system prompt carries only an index of `name: description` lines (description truncated to 60 chars). Full SKILL.md body enters context only when the model calls `skill_view(name)`; support files only via `skill_view(name, file_path=...)`. Exception: `skills.auto_load` pins full bodies into the system prompt. (Verified: `agent/prompt_builder.py::_render_skills_index`, `agent/system_prompt.py::_auto_load_parts`)
3. **Extra skill roots are first-class**: `skills.external_dirs` (read at scan time, lowest precedence, never snapshotted to the prompt cache file), `skills.create_dir` (redirect where new skills are written), and trusted project dirs. This makes "inject decrypted skills into a fixed folder at sandbox start" straightforward. (Verified: `agent/skill_utils.py::get_all_skills_dirs`, `get_external_skills_dirs`, `get_skill_create_dir`)
4. **The agent can always read skill files**, via `skill_view` (by design), `read_file`, `search_files`, and `terminal`. The read denylist (`agent/file_safety.py::get_read_block_error`) does not cover skill directories (it only blocks `skills/.hub/`, credential files, `mcp-tokens/`, `browser-profile/`, `vault/`). Skills cannot be hidden from the agent that uses them.
5. **The agent is told to edit skills it uses.** The skills index preamble says "If a skill has issues, fix it with skill_manage(action='patch')" and "update it before finishing"; foreground `skill_manage` can patch skills in any root including `external_dirs`. Only the background review fork is barred from external, bundled, hub and pinned skills. (Verified: `agent/prompt_builder.py::_render_skills_index`, `tools/skill_manager_guards.py::_background_review_write_guard`, docs `features/skills.md` "External dirs are not a write-protection boundary")
6. **Decrypted skill content leaks into many persistent places** besides the skill folder: `state.db` (tool results in `messages`, full prompts in `system_prompts` / `sessions.system_prompt`), the skill mutation ledger and its content-addressed blobs, curator tarball snapshots, request dumps on API errors, pending-write staging files, and agent-authored skills or memory that paraphrase private skills.
7. **Built-in memory** is two small §-delimited Markdown files, `memories/MEMORY.md` (2,200 chars) and `memories/USER.md` (1,375 chars), injected as a frozen snapshot at session start. A background review fork (every 10 user turns for memory, every 10 tool iterations for skills by default) saves memory and skills automatically. (Verified: `tools/memory_tool_store.py`, `hermes_cli/config_defaults.py`, `agent/turn_context.py::_tick_memory_nudge`, `agent/turn_finalizer.py`)
8. **Export/restore exists** (`hermes backup` / `hermes import`, `hermes profile export/import`, `hermes backup --quick`), but none is shaped for our need. The quick snapshot omits `skills/` and `memories/`; profile export force-redacts text files; full backup includes `.env`/`auth.json`. A custom allow-list tarball of specific paths is the right approach.
9. **Thesis Board belongs in our MCP platform server, not in Hermes memory.** Hermes memory is tiny, unstructured, frozen per session, local to the sandbox, and written autonomously.

---

## 2. Exact skill format

### 2.1 Parser (Verified)

- `agent/skill_utils.py::parse_frontmatter(content)`: strips a UTF-8 BOM, requires the file to start with `---`, finds the closing `\n---\s*\n`, parses YAML with `hermes_yaml.safe_load`. On YAML error it falls back to naive `key: value` line splitting. Returns `(frontmatter_dict, body)`.
- Write-time validation is stricter: `tools/skill_manager_tool.py::_validate_frontmatter` requires `name` and `description`, description at most 1,024 chars, non-empty body, and on `create` only, description at most 60 chars (`SKILL_PROMPT_DESC_LIMIT`). Name must match `^[a-z0-9][a-z0-9._-]*$`, max 64 chars (`VALID_NAME_RE`, `MAX_NAME_LENGTH`). SKILL.md max 100,000 chars (`MAX_SKILL_CONTENT_CHARS`), supporting files max 1 MiB (`MAX_SKILL_FILE_BYTES`). These limits apply only to `skill_manage` writes, not to files placed on disk by other means.

### 2.2 Every frontmatter field found in code

| Field | Where read | Effect |
|---|---|---|
| `name` | `skills_tool.py::_find_all_skills`, `prompt_builder.py::_build_snapshot_entry`, `skill_view` | Display and lookup name. Falls back to the directory name. `skill_view` matches either dir name or frontmatter `name`. |
| `description` | `skill_utils.py::extract_skill_description` | Shown in the prompt index, truncated to 57 chars + `...` if over 60. `skills_list` truncates at 1,024. If absent, `skills_list` uses the first non-heading body line. |
| `version`, `author`, `license` | Hub/publishing metadata | No runtime effect found in loading path (Inferred from grep). |
| `platforms` | `skill_utils.py::skill_matches_platform` | OS gate (`macos`, `linux`, `windows`). Hidden from index/list; `skill_view` refuses on mismatch. |
| `environments` | `skill_utils.py::skill_matches_environment` | Offer-time relevance gate (`kanban`, `docker`, `s6`; unknown tags fail open). Explicit `skill_view` still works. |
| `requires_apps` | `skill_utils.py::skill_matches_apps` | Hidden unless every named app declaration is available (fail closed). |
| `deps` | `skills_tool.py::skill_view` | On load, calls `pm.ensure(dep)` for each package (internal package manager install). Failure adds a `deps_note`. |
| `required_environment_variables` (list of `{name, prompt, help, required_for, optional}`) | `tools/skills_tool_setup.py::_get_required_environment_variables` | On `skill_view`, checks `.env`; may prompt (CLI) for secrets; available names are registered for passthrough into `terminal`/`execute_code` sandboxes (`register_env_passthrough`). |
| `setup.collect_secrets`, `setup.help` | same | Alternate secret declaration shape. |
| `prerequisites.env_vars` | same | Legacy alias. |
| `required_credential_files` (list of `{path, description}`) | `skills_tool.py::_skill_readiness` | Files relative to HERMES_HOME; registered for mounting into remote backends; missing ones set `setup_needed`. |
| `compatibility` | `skill_view` | Passed through in the result (agentskills.io field). |
| `metadata` (whole mapping) | `skill_view` | Returned verbatim in the `skill_view` result. |
| `metadata.hermes.tags` / top-level `tags` | `skill_view` (`_parse_tags`) | Returned to model; hub search. |
| `metadata.hermes.related_skills` / top-level | `skill_view` | Returned to model. |
| `metadata.hermes.category` / top-level `category` | Documented in `skills/AGENTS.md` | The prompt index derives category from the directory path, not frontmatter (`_build_snapshot_entry`). |
| `metadata.hermes.requires_toolsets`, `requires_tools`, `fallback_for_toolsets`, `fallback_for_tools` | `skill_utils.py::extract_skill_conditions`, `prompt_builder.py::_skill_should_show` | Hide from index when requirements are absent or a primary tool is present. |
| `metadata.hermes.session_platforms` | same | Gateway channel gate (hide unless the session platform matches). |
| `metadata.hermes.config` (list of `{key, description, default, prompt}`) | `skill_utils.py::extract_skill_config_vars`, `resolve_skill_config_values` | Non-secret settings under `skills.config.<key>` in config.yaml, appended to the skill message as `[Skill config ...]` when loaded via slash/preload path (`skill_commands.py::_inject_skill_config`). |
| `metadata.hermes.blueprint` (`schedule`, `deliver`, `prompt`, `no_agent`) | `tools/blueprints.py` | Marks the skill as a suggested cron job on install (opt-in scheduling). |
| `allowed-tools` | `tools/skills_guard.py` | Informational scanner finding only; not enforced. |

Body features (Verified, `agent/skill_preprocessing.py::preprocess_skill_content`): `${HERMES_SKILL_DIR}` and `${HERMES_SESSION_ID}` are substituted (config `skills.template_vars`, default true). Inline `` !`cmd` `` shell snippets are executed and inlined only if `skills.inline_shell: true` (default false), 4,000 char cap per snippet.

Category descriptions: a `DESCRIPTION.md` with a `description:` frontmatter field inside a category directory labels that category in the index (`prompt_builder.py::_read_category_descriptions`).

---

## 3. Where skills are loaded from, when, and how they are selected

### 3.1 Roots and precedence (Verified)

| Tier | Path | Source |
|---|---|---|
| Project (highest) | `<git root>/.hermes/skills/`, `<git root>/.agents/skills/`, only if root is listed in `skills.trusted_project_dirs`; each SKILL.md is scanned by `skills_guard` and quarantined if "dangerous" | `skill_utils.py::get_project_skills_dirs`, `is_quarantined_project_skill` |
| Local | `$HERMES_HOME/skills/` (bundled skills are copied here by `tools/skills_sync.py::sync_skills`) | `hermes_constants` / `skills_tool.py::_skills_dir` |
| Create dir | `skills.create_dir` (if set and exists) | `skill_utils.py::get_skill_create_dir` |
| External | `skills.external_dirs` (list; `~` and `${VAR}` expanded, relative paths anchored at HERMES_HOME, non-existent dirs skipped) | `skill_utils.py::get_external_skills_dirs` |
| Plugin skills | `plugin:skill` namespaced, from plugins and memory providers | `skills_tool.py::_resolve_plugin_skill` |
| Org mirror | `skills/_org/<org_id>/`, only walked if `skills/_org/.active_org` exists (Nous org sync) | `skill_utils.py::iter_skill_index_files` |

Name collisions: in the prompt index, local skills win and external duplicates are skipped. In `skill_view`, two different skills with the same name across roots cause a hard refusal ("Ambiguous skill name"), unless one is in the project tier or they are byte-identical copies (`skills_tool.py::_locate_skill`). **Implication:** injected skill names must not collide with bundled or agent-created names.

Excluded directories during scans: `.git`, `.hub`, `.archive`, `.curator_backups`, `.locks`, `node_modules`, venvs, caches (`EXCLUDED_SKILL_DIRS`). Support dirs (`references`, `templates`, `assets`, `scripts`) under a SKILL.md are never scanned as skills. Symlinks are followed (`os.walk(..., followlinks=True)`).

Disabling: `skills.disabled` (global list) and `skills.platform_disabled.<platform>`; `hermes-agent` is essential and cannot be disabled (`ESSENTIAL_SKILLS`). Disabled skills are removed from the index and `skill_view` refuses them.

Bundled seeding: `sync_skills` runs on CLI startup (`hermes_cli/main.py::_sync_bundled_skills_for_startup`), on update, and in the Docker stage2 hook (`docker/stage2-hook.sh`). It never overwrites a same-named user skill and does not re-add skills the user deleted (tracked in `skills/.bundled_manifest`). A `.no-bundled-skills` marker in HERMES_HOME limits seeding to essential skills only (`skills_sync.py::NO_BUNDLED_SKILLS_MARKER`).

### 3.2 When loaded (Verified)

- The system prompt is built **once per session** and only rebuilt after context compression (`agent/system_prompt.py::build_system_prompt`, `invalidate_system_prompt`). The skills index sits at the start of the "volatile" tier.
- Index build is cached in two layers: an in-process LRU (`_SKILLS_PROMPT_CACHE`, 32 entries) and a disk snapshot `$HERMES_HOME/.skills_prompt_snapshot.json` (version 3). The disk snapshot covers only the local skills dir and is invalidated by a manifest of SKILL.md / DESCRIPTION.md file signatures (mtime/size). **External and project dirs are scanned fresh on every build** and are never written to the snapshot (`_build_skills_system_prompt_inner`).
- `skills_list` uses a separate per-process cache with a 30 second TTL and a directory-mtime signature (`skills_tool.py::_SKILLS_CACHE`).
- `skill_manage` success clears both the LRU and the disk snapshot (`_record_success` calls `clear_skills_system_prompt_cache(clear_snapshot=True)`), but the running session's prompt does not change until the next session or compression rebuild.

### 3.3 How selected (Verified)

- The index is emitted only if the agent has at least one of `skills_list`, `skill_view`, `skill_manage` (`system_prompt.py::_skills_prompt`). All three are in the `skills` toolset (`toolsets.py`).
- The index preamble instructs the model: "Before replying, scan the skills below. If a skill matches or is even partially relevant to your task, you MUST load it with skill_view(name)". Selection is entirely model-driven; there is no embedding retrieval or router.
- Other ways a skill body enters context: slash command `/<skill>` and bundles (`agent/skill_commands.py`, `agent/skill_bundles.py`, YAML in `$HERMES_HOME/skill-bundles/`), CLI preload `hermes -s <skill>` (`build_preloaded_skills_prompt`), and `skills.auto_load` (`build_auto_load_prompt`), which places full skill bodies into the stable system-prompt tier for every session on every surface (CLI, TUI, gateway, cron, API).

---

## 4. How much skill content enters model context, and when

| What | When | Size (Verified caps / Inferred sizes) |
|---|---|---|
| Index preamble + one line per visible skill: `    - name: description` grouped by category | Every session, system prompt | Description capped at 60 chars. With 58 bundled skills (`find skills -name SKILL.md`), Inferred ~5 KB, roughly 1.5k to 2k tokens. Each extra skill adds roughly 20 to 30 tokens. |
| `skills_list()` result | On demand | name + description (<=1,024 chars) + category per skill |
| `skill_view(name)` | On demand | Full SKILL.md text (frontmatter included, after template substitution) plus JSON metadata: tags, related_skills, `linked_files` listing (paths only), readiness fields, absolute `skill_dir`. No pagination: the agent must read the whole file (`skills/AGENTS.md`). Linter warns past ~24k chars body. |
| `skill_view(name, file_path=...)` | On demand | One support file's full text. Binary files return a size stub. Path traversal is blocked (`_serve_skill_file` uses `validate_within_dir`). |
| Scripts | Never auto-read | The agent runs them via `terminal` using `${HERMES_SKILL_DIR}` absolute paths. It can also read them. |
| Repeat `skill_view` of unchanged file | Same session | Returns a short "unchanged" stub (`tools/skills_tool_dedup.py`), reset on compression. |
| After compression | Mid session | Skill bodies can be pruned to `[SKILL_PRUNED]`; the model is told to reload (`prompt_builder.py::SKILLS_GUIDANCE`). |
| `skills.auto_load` skills | Every session | Full bodies in the system prompt, plus `[Skill directory: ...]` and supporting file list. |

---

## 5. How Hermes creates and edits its own skills

### 5.1 The `skill_manage` tool (Verified, `tools/skill_manager_tool.py`)

- One call shape: an `operations` array applied atomically (rollback on any failure). Actions: `create`, `patch` (old/new string, or full `content` rewrite), `write_file`, `remove_file` (support files under `references/ templates/ scripts/ assets/`), `delete`. Legacy flat shape and `edit` alias still accepted.
- New skills go to `$HERMES_HOME/skills/[category/]<name>/` or `skills.create_dir` if set (`_resolve_skill_dir`). Existing skills are modified **in place wherever they live**, including `external_dirs` (`_find_skill` iterates `get_all_skills_dirs()`).
- Per-skill locks under `skills/.locks/`.
- Side effects on every successful mutation (`_record_success`): append to the audit ledger `skills/.curator_ledger.jsonl` with before/after file manifests whose contents are stored content-addressed in `$HERMES_HOME/.curator_backups/blobs/` (`tools/skill_ledger.py`); clear prompt caches; update telemetry `skills/.usage.json`; debounced sync push to the Nous skill sync plane (inert unless the user is a Nous admin, `tools/skills_sync_client.py`).
- Optional security scan of agent-written skills: `skills.guard_agent_created` (default false).

### 5.2 Who calls it

- **Foreground agent**, prompted by the index preamble ("fix it with skill_manage(action='patch')", "After difficult/iterative tasks, offer to save as a skill", "update it before finishing") and `SKILLS_GUIDANCE` ("When you work out a non-trivial workflow, record it with skill_manage").
- **Background review fork** (`agent/background_review.py`): after a turn, if `_iters_since_skill >= skills.creation_nudge_interval` (default 10 tool iterations) and/or the memory counter fires, a forked AIAgent replays the conversation and decides what to save. It is restricted: `_background_review_write_guard` refuses pinned, external, bundled, hub-installed, and non-curator-managed skills, and requires a fresh `skill_view` read before writing. Skills it creates get `created_by: agent` in `.usage.json`. It can be disabled with `auxiliary.background_review.enabled: false`, zero nudge intervals, or `skip_background_review=True` on AIAgent (cron sets this).
- **Curator** (`agent/curator.py`): inactivity-triggered (default every 168 h, after 2 h idle), state in `skills/.curator_state`. Deterministic pass marks curator-managed skills stale after 14 days and archives to `skills/.archive/` after 30 days. Optional LLM consolidation pass (`curator.consolidate`, default false) takes a tarball snapshot to `skills/.curator_backups/<ts>/skills.tar.gz` first. Reports under `logs/curator/`. Only touches `created_by: agent` skills; external dirs are read-only to it. Disable with `curator.enabled: false`.

### 5.3 Disable, redirect, capture (Verified unless noted)

| Goal | Mechanism |
|---|---|
| No skill writing at all | Remove `skill_manage` from the toolset. There is no config key for a single tool; `toolsets.create_custom_toolset(...)` exists for programmatic use (Inferred: a custom toolset with only `skills_list` + `skill_view`). Memory guidance adapts when `skill_manage` is absent (`build_memory_guidance(..., skill_manage_available=False)`). |
| Stage all skill writes for review | `skills.write_approval: true`: every mutation from any origin is written as JSON to `$HERMES_HOME/pending/skills/<id>.json` instead of applied (`tools/write_approval.py::stage_write`); replay with `/skills approve`. The payload contains the full proposed content. |
| Redirect new skills | `skills.create_dir` (e.g. an "agent-learned" folder we export). |
| Stop background self-review | `auxiliary.background_review.enabled: false`, or `skills.creation_nudge_interval: 0` and `memory.nudge_interval: 0`. |
| Stop curator | `curator.enabled: false`. |
| Stop ledger/blob copies | `skills.ledger: false`. |
| Protect injected skills from edits | Not provided by Hermes. Filesystem permissions on the external dir (docs: "External dirs are not a write-protection boundary", `features/skills.md`). Inferred: a read-only mount makes `patch` fail with an OS error, which is surfaced as a tool error. |
| Capture changes | `.curator_ledger.jsonl` + blobs give a full per-mutation audit; or diff the skills dirs at shutdown; or intercept via `write_approval` staging. |

---

## 6. Memory storage

### 6.1 Built-in memory (Verified, `tools/memory_tool.py`, `tools/memory_tool_store.py`)

- Files: `$HERMES_HOME/memories/MEMORY.md` (agent notes) and `$HERMES_HOME/memories/USER.md` (user profile). Plain text entries separated by `\n§\n` (`ENTRY_DELIMITER`). Separate `.lock` files for cross-process locking; drift from external edits produces a `.bak` snapshot and refuses writes.
- Limits: `memory.memory_char_limit` 2,200 and `memory.user_char_limit` 1,375 (defaults in `hermes_cli/config_defaults.py`). No auto-compaction: an over-budget add returns an error with current entries and the model must consolidate.
- Injection: `MemoryStore.load_from_disk` renders a frozen block per target at session start (`MEMORY (your personal notes) [NN% ...]`). Mid-session writes go to disk but do not change the prompt until the next session or compression rebuild. Entries matching threat patterns are replaced by `[BLOCKED: ...]` in the prompt snapshot.
- Tool: single `memory` tool with `add` / `replace` / `remove` or batch `operations`, targets `memory` and `user`. No read action (content is already in the prompt). Writes are scanned by `tools/threat_patterns.py`.
- Config toggles: `memory.memory_enabled`, `memory.user_profile_enabled` (both false removes the tool), `memory.write_approval` (stages to `pending/memory/<id>.json`), `memory.nudge_interval` (default 10 user turns), `memory.provider` (external provider name).

### 6.2 What is remembered automatically

- **Background memory review** (Verified): every `memory.nudge_interval` user turns (`agent/turn_context.py::_tick_memory_nudge`), the post-turn fork is given the `memory` toolset and asked whether anything should be saved. The docs describe this as automatic, unprompted saving (`features/memory.md` "Background review notifications"). The fork runs on the main model by default, or on `auxiliary.background_review` model settings; the code comment estimates roughly 30K tokens per event (`agent/turn_finalizer.py`).
- **Foreground**: the `memory` tool schema and `build_memory_guidance` tell the model to save durable facts proactively; skills take priority for task knowledge.
- **Session transcripts**: every session and message is stored in `state.db` with FTS5 search, exposed through the `session_search` tool. This is the unbounded recall layer.
- **External providers** (Verified, `agent/memory_provider.py`, docs `memory-providers.md`): one at a time, additive. They can inject a system prompt block, prefetch before each turn, sync each turn (`sync_turn`), extract on session end, mirror built-in memory writes (`on_memory_write`), and add their own tools. Local ones (Holographic `memory_store.db`, ByteRover) live under HERMES_HOME; others are cloud (Honcho, Mem0, RetainDB, Supermemory, etc.).

---

## 7. Injecting decrypted skills at sandbox start and removing them at shutdown

### 7.1 Feasibility (Inferred, grounded in Verified mechanisms)

Yes, this fits Hermes well. Recommended shape:

1. At sandbox start, before the first session is created, the orchestrator decrypts equipped skills into a dedicated dir, for example `/run/agent-skills/` (tmpfs), laid out as `<category>/<name>/SKILL.md` plus support dirs.
2. Set `skills.external_dirs: ["/run/agent-skills"]` in config.yaml. External dirs are scanned directly on every prompt build, are not written into `.skills_prompt_snapshot.json`, and are treated as read-only by the curator and background review.
3. Optionally set `skills.auto_load` for tier playbooks that should always be active.
4. At shutdown, delete the dir (and scrub the other leak locations below).

Equip/unequip mid-session: the system prompt is frozen for the session, so the index will not show a newly equipped skill until a new session (Verified: `build_system_prompt` caching). `skill_view(name)` would still find a newly added skill because lookup scans disk (Verified: `_collect_skill_candidates`), but the model will not know it exists. Plan equips at session boundaries.

### 7.2 What would break or leak

| Component | Behavior with injected external skills | Risk |
|---|---|---|
| Skills index caches (`_SKILLS_PROMPT_CACHE`, `.skills_prompt_snapshot.json`) | External dirs bypass the disk snapshot; in-process LRU keyed by dir paths and tools. Fresh process per sandbox. | Low. Snapshot contains only local skills' names and descriptions. |
| `skills_list` cache | 30 s TTL | Low. |
| `skills_sync` (bundled seeding) | Writes only to `$HERMES_HOME/skills/`; if a bundled skill has the same name as an external one, sync defers to external and even removes an identical local shadow (`_defer_to_external`). | Low. Use `.no-bundled-skills` to keep the bundled set minimal and predictable. |
| Name collisions | `skill_view` refuses ambiguous names across roots | Medium. Namespace our skill names (e.g. `mnd-` prefix). |
| Foreground `skill_manage` | Can patch, rewrite, write_file, delete skills in external dirs | High. Agent is instructed to fix skills it loads. Must block with a read-only mount, remove `skill_manage`, or set `skills.write_approval: true`. |
| Ledger (`skills/.curator_ledger.jsonl`, `$HERMES_HOME/.curator_backups/blobs/`) | Any mutation of an injected skill stores full before/after content as blobs | High if writes are allowed. Set `skills.ledger: false` or prevent writes. |
| `pending/skills/*.json` | With write_approval, proposed full content of a patched private skill is staged here | Medium. Scrub at shutdown. |
| `.usage.json` | Records view/use counts by skill name (bumped for any skill) | Low (names only). |
| Curator | Ignores non-`created_by: agent` and external skills | Low. |
| Hub (`skills/.hub/lock.json`, `taps.json`, `audit.log`, `quarantine/`, `index-cache/`) | Not involved unless we use `hermes skills install` | None, if we do not use the hub. |
| Org sync / skill sync push | Inert without Nous admin JWT; external skills are excluded from sync candidates (`skills_sync_client.py`) | Low, and egress allowlist blocks it anyway. |
| `state.db` | `messages` rows hold every `skill_view` result (full skill text) and any `read_file`/`terminal` output of skill files; `system_prompts` and `sessions.system_prompt` hold the index and any auto-loaded skill bodies | High. Plaintext private skill content persists in the transcript DB. |
| Request dumps | On API errors, the full request body (system prompt + messages) is written to `$HERMES_HOME/sessions/request_dump_*.json` after secret redaction (`agent/agent_runtime_helpers.py`) | High. Scrub or keep on tmpfs. |
| Compression summaries, agent-created skills, MEMORY.md | Agent may paraphrase or copy private skill knowledge into its own skills or memory (Inferred) | High ("skill laundering": knowledge survives unequip). |
| Checkpoints (`checkpoints/`) | Filesystem checkpoint manager snapshots files the agent edits (Inferred it could include skill files if edited via file tools) | Medium. |
| Logs (`logs/`) | Tool call logging may include content (Inferred; not audited here) | Medium. |

### 7.3 Can skills be read-only or non-viewable?

- **Read-only**: only through OS permissions or a read-only mount. Hermes has no config to make a skill root immutable to the foreground agent (Verified: docs `features/skills.md`, lines 391 to 392). Pinned skills only block `delete`, not patch (`skills/AGENTS.md`).
- **Non-viewable to the agent**: not possible and not meaningful. The agent needs the content to use the skill, and `read_file`, `search_files` and `terminal` can read any file in the sandbox (the denylist in `agent/file_safety.py` does not include skill dirs; `terminal` has no path denylist at all, Inferred from the absence of one in the read-block code path). The secrecy boundary must be: owner never gets raw agent output or sandbox files; the narrator only sees actions and outcomes; all persisted state containing skill text is encrypted in our storage and never exposed.
- **Partial mitigation (Inferred)**: keep the sensitive logic in scripts that the agent executes rather than reads, but the agent can still `cat` them. Alternatively, move truly secret logic behind our MCP tools (server-side), so the skill text only says "call tool X", which is the only real protection.

---

## 8. Exporting and restoring agent state between sandboxes

### 8.1 Complete state inventory under HERMES_HOME

Paths Verified from code (`get_hermes_home() / ...` usages and module constants); "Role" column partly Inferred.

**Skills and learning**

| Path | Role | Export? |
|---|---|---|
| `skills/<cat>/<name>/...` | Agent-created and user skills, seeded bundled skills | Yes (agent-created only; exclude injected private skills) |
| `skills/.usage.json` (+ `.usage.json.lock`) | Telemetry and provenance (`created_by`, counts, state, pinned, sync flag) | Yes (needed for curator ownership) |
| `skills/.curator_state` | Curator scheduler state | Yes |
| `skills/.curator_ledger.jsonl` | Mutation audit log | Optional |
| `.curator_backups/blobs/` (at HERMES_HOME root) | Ledger content blobs | Optional (may contain private skill text) |
| `skills/.curator_backups/<ts>/skills.tar.gz` | Curator pre-consolidation snapshots | Optional |
| `skills/.archive/` | Archived (restorable) skills | Yes |
| `skills/.bundled_manifest` | Bundled sync origin hashes | Yes, if bundled skills are seeded |
| `.no-bundled-skills` | Opt-out marker | Yes (or recreate) |
| `skills/.hub/` (`lock.json`, `taps.json`, `audit.log`, `quarantine/`, `index-cache/`) | Hub provenance and caches | Only if hub is used |
| `skills/.locks/` | Lock files | No |
| `skills/.sync_state`, `skills/.sync_device_id`, `skills/_org/` | Nous skill sync | No |
| `skills/.termux_bundled_sync_stamp` | Termux only | No |
| `skill-bundles/*.yaml` | Slash-command bundles | If used |
| `.skills_prompt_snapshot.json` | Index cache | No (regenerable) |
| `cache/project_skill_scans/` | Scan cache | No |
| `pending/skills/`, `pending/memory/` | Staged writes | Yes if write_approval is on |

**Memory and identity**

| Path | Role | Export? |
|---|---|---|
| `memories/MEMORY.md`, `memories/USER.md` (+ `.lock`, `.bak`) | Built-in memory | Yes (the two .md files) |
| `SOUL.md` | Persona (slot 1 of prompt) | Provisioned by us, not exported |
| `memory_store.db` | Holographic provider facts | Only if that provider is used |
| `mem0.json`, `mem0_qdrant/`, `honcho.json` | Other provider config/data | Only if used |
| `config.yaml`, `.env`, `auth.json` | Config and secrets | Regenerate from our control plane; never export secrets |

**Session history and runtime**

| Path | Role | Export? |
|---|---|---|
| `state.db` | Sessions and transcripts (see tables below) | Yes if we want `session_search` continuity; contains private skill text |
| `sessions/` (`request_dump_*.json`, `sessions.json`, `saved/`) | Debug dumps, gateway session index | No (scrub) |
| `response_store.db` | API server `responses` / `conversations` tables (stored conversation payloads) | Only if we use API server response chaining |
| `runs_idempotency.db` | API server run idempotency | No |
| `verification_evidence.db` | Verification audit trail (`meta`, `verification_events`, `verification_state`) | Optional |
| `cron/jobs.json`, `cron/executions.db`, `cron/output/` | Built-in scheduler | No (our workflow runner replaces cron) |
| `kanban.db`, `kanban/boards`, `projects.db` | Kanban and projects | No |
| `logs/` (incl. `logs/curator/`) | Logs and reports | Ship to our observability, do not restore |
| `checkpoints/` | File-edit checkpoints | No |
| `plugins/`, `plugin-data/` | Installed plugins and their data | Provisioned, not exported |

**`state.db` tables** (Verified, `hermes_state_common.py::SCHEMA_SQL`, `SCHEMA_VERSION = 30`): `schema_version`, `system_prompts`, `sessions`, `messages`, `session_model_usage`, `state_meta`, `gateway_routing`, `gateway_hygiene_state`, `conversation_generations`, `gateway_heartbeats`, `compression_locks`, `session_turn_leases`, `async_delegations`, plus FTS5 virtual tables `messages_fts` and `messages_fts_trigram` (with their shadow tables and triggers). Sidecars `state.db-wal`, `state.db-shm`.

### 8.2 Existing commands (Verified)

| Command | What it does | Fit for us |
|---|---|---|
| `hermes backup [-o]` (`hermes_cli/backup.py::run_backup`) | Zip of the whole Hermes root (all profiles), SQLite via `sqlite3.backup()`, excludes venvs, caches, checkpoints, browser profiles, WAL sidecars. Includes `.env` and `auth.json`. | Too broad; includes secrets and injected skills. |
| `hermes import <zip>` (`run_import`) | Restores into current HERMES_HOME | Usable for restore of our own zip if format matches. |
| `hermes backup --quick` / `/snapshot` (`_QUICK_STATE_FILES`) | Only `state.db`, `config.yaml`, `.env`, `auth.json`, cron, gateway JSONs, a few DBs. **Excludes `skills/` and `memories/`.** | Not sufficient. |
| `hermes profile export/import` (`hermes_cli/profiles.py::export_profile`) | tar.gz of a profile, drops `.env`/`auth.json`, **force-redacts secret-shaped strings in every text file** (`.md`, `.json`, `.py`, ...) | Risky: redaction can silently alter skill or memory content. |
| `SessionDB.export_all` / `import_sessions` (`hermes_state_portability.py`) | JSON export/import of sessions with messages; import nulls `system_prompt` | Useful for transcript portability without copying the whole DB. |
| `hermes curator backup/rollback` | Tarball of `skills/` | Skills only. |

**Recommendation (Inferred):** write our own allow-list exporter (spike step, not run here): tar `skills/` minus injected dirs and lock/cache files, `memories/*.md`, `.curator_backups/blobs` only if ledger kept, `pending/`, and a `sqlite3.backup()` copy of `state.db` (or an `export_all` JSON). Encrypt with the agent key, store in our backend, restore before the first session. Always regenerate `config.yaml`, `.env`, `SOUL.md` from the control plane.

---

## 9. Thesis Board: Hermes memory vs external MCP tool

**Recommendation: implement the Thesis Board as tools on our platform MCP server (`write_thesis`, `update_thesis`, `list_theses`, `get_thesis`), stored in our database. Do not use Hermes built-in memory for it.** Optionally inject a compact "current theses" digest at session start.

| Criterion | Hermes built-in memory | External MCP tool (our platform server) |
|---|---|---|
| Capacity | 2,200 chars total (Verified) | Unbounded, structured |
| Structure | Free-text entries split by `§` | Typed records: id, asset, thesis, evidence links, confidence, status, stage (Scan/Dive/Challenge/Test/Zoom out), timestamps |
| Freshness | Frozen snapshot per session (Verified) | Live reads every call |
| Persistence | Local file inside a temporary sandbox; needs export | Already in our storage |
| Who writes | Model plus an autonomous background review fork (Verified) | Only explicit tool calls we validate |
| Consumers | Only this Hermes instance | Narrator, activity feed, approval cards, workflow runner, backtests |
| Audit / policy | None beyond threat-pattern scan | Our schema validation, versioning, per-agent ACL |
| Leakage | Could absorb paraphrased private skill content, would then need secrecy handling | We control what fields exist and what the narrator sees |

Keep built-in memory for what it is good at: small durable environment facts (for example "chain tools server returns amounts in wei"). Consider `memory.user_profile_enabled: false`, since there is no owner chat and USER.md would only contain inferences. Consider `memory.write_approval` off but auditing `MEMORY.md` diffs at shutdown. A custom memory provider plugin (`agent/memory_provider.py`) could surface theses via `system_prompt_block` / `prefetch`, but that puts platform logic inside Hermes; an MCP tool plus a session-start digest is simpler and keeps Hermes stock.

---

## Implications for our platform

1. **Skill delivery:** decrypt equipped skill NFTs to a tmpfs dir and point `skills.external_dirs` at it before session start. Namespace names to avoid collisions (collisions make `skill_view` refuse). Equip/unequip takes effect at the next session.
2. **Block agent edits of private skills:** mount the injected dir read-only, and either remove `skill_manage` via a custom toolset or set `skills.write_approval: true` so writes stage to `pending/skills/` for our review. Set `skills.ledger: false` or scrub `.curator_backups/blobs/` if writes are ever allowed.
3. **Treat these as containing private skill plaintext:** `state.db` (`messages`, `system_prompts`, `sessions.system_prompt`), `sessions/request_dump_*.json`, `pending/`, ledger blobs, agent-created skills, `MEMORY.md`, compression summaries. Encrypt them at rest in our storage; never surface them to the owner; scrub at shutdown what we do not export.
4. **Skill laundering policy:** decide whether agent-created skills derived from a private skill survive unequip. If not, tag sessions by equipped skills and review or drop agent-created skills that reference them. This is a product decision Hermes cannot enforce.
5. **Tier playbooks:** implement as `skills.auto_load` skills or `SOUL.md`, both provisioned by the orchestrator, not exported.
6. **Persistence:** build a custom allow-list export (skills minus injected, `.usage.json`, `.curator_state`, `.archive/`, `memories/*.md`, `state.db` backup or JSON export). Do not use `hermes profile export` (redaction mutates content) or `--quick` (omits skills and memory).
7. **Cost control:** the background review fork is a hidden per-turn cost billed through our gateway; tune `memory.nudge_interval`, `skills.creation_nudge_interval`, `auxiliary.background_review` (cheaper model), or disable it. Route `auxiliary` (curator) through the gateway too, or set `curator.enabled: false`.
8. **Bundled skills:** use `.no-bundled-skills` so each sandbox starts with only `hermes-agent` plus our skills, keeping the index small and deterministic.
9. **Thesis Board** lives in the platform MCP server, with a short digest injected at session start.

## Open questions

1. Does the programmatic path we will use (Python library, API server, or `hermes` CLI in the sandbox) run `sync_skills` at startup? Confirmed for CLI main and Docker stage2 hook; not verified for `gateway` API server or direct `AIAgent` use.
2. Exact behavior of `skill_manage` when the target is on a read-only mount (clean tool error vs partial ledger entries). Suggested spike: run a patch against a `chmod -R a-w` external dir in a scratch HERMES_HOME.
3. Whether any log file under `logs/` records tool results verbatim (would contain skill text). Not audited here; overlaps with the security area report.
4. Whether the `terminal` tool has any path denylist for reads. I found none in the read-block path, but did not audit `tools/terminal*` fully.
5. Whether a config-level per-tool disable exists (not just toolsets). I found `toolsets.create_custom_toolset` for programmatic use only.
6. Exact token size of the index for our deployment; depends on the final skill count. Suggested spike: call `build_skills_system_prompt()` in a scratch HERMES_HOME with our skill set and count tokens.
7. Whether context compression summaries (`agent/conversation_compression.py`) quote skill content, and whether they are stored in `state.db` (`_compressed_summary` column suggests yes).
8. Whether the background review fork's own transcript is persisted to `state.db` as a separate session.
