# A: MCP server structure (sub-agent A)

Scope: the repo has no MCP server (see `00-phase0-orientation.md`). Everything below is either read from the client side (Verified) or inferred about the hosted closed server at `https://api.monad.exploreme.pro/mcp` and about MCP/SDK behaviour from knowledge (Inferred). The server was not reachable from this machine, so no live `tools/list` was captured. `node_modules` is not installed, so library behaviour of `@ai-sdk/mcp` and `ai` is from knowledge, not from reading their source here.

## Summary table

| Question | Short answer | Label |
|---|---|---|
| Transport | Three different declarations: Streamable HTTP (`.mcp.json`), stdio via `mcp-remote` (Codex), legacy SSE (`src/mcp-client.ts`) | Verified (configs), Inferred (which one the server really speaks) |
| Tool registration | Invisible. Client pulls tools dynamically with `client.tools()`; no local schemas | Verified |
| Output shape | Unknown. Bridge assumes a JSON string or plain object; MCP returns a `CallToolResult` envelope | Verified (bridge code), Inferred (mismatch) |
| Errors | No handling of `isError`; signing errors become ad hoc `_signingError` fields in a string | Verified |
| Auth / identity | None anywhere. No headers, tokens, API keys, or session concept for the MCP server | Verified |
| Per-client tool filtering | None, neither client nor (evidently) server. Only prompt text says "never use X" | Verified (client), Inferred (server) |
| Official MCP SDK | Not used. Client is `@ai-sdk/mcp` 1.0.36 | Verified |

## 1. How the MCP connection is built

### Declared transports (Verified)

| File | Declaration | Transport it implies |
|---|---|---|
| `.mcp.json` | `"type": "http", "url": "https://api.monad.exploreme.pro/mcp"` | Streamable HTTP (Claude Code's `http` type) |
| `.cursor/mcp.json` | `"url": ".../mcp"` only | Cursor picks remote; it tries Streamable HTTP and falls back to SSE (Inferred) |
| `.codex/config.toml` | `command = "npx"`, `args = ["mcp-remote", ".../mcp"]` | stdio locally, bridged by `mcp-remote` to the remote server |
| `src/mcp-client.ts` `getMonadMCPClient()` | `createMCPClient({ transport: { type: "sse", url } })` | Legacy HTTP+SSE |
| `src/utils.ts` `getMcpUrl()` | `MONAD_MCP_URL` env override, default `https://api.monad.exploreme.pro/mcp` | Same URL for all |

Excerpt, `src/mcp-client.ts` lines 11 to 16:

```ts
mcpClient = await createMCPClient({
  transport: {
    type: "sse",
    url,
  },
});
```

`getMonadMCPClient()` caches a single module-level client (`let mcpClient`), and `closeMCPClient()` closes it; `runAgent()` in `src/agent.ts` calls `closeMCPClient()` in a `finally`. So the AI SDK path opens one connection per `runAgent()` call (Verified).

### What the docs say (Verified)

- `docs/ARCHITECTURE.md` line 10: "MCP server: `https://api.monad.exploreme.pro/mcp` (HTTP transport)." Section "MCP configs (per platform)" says Claude Code must use `"type": "http"` and Codex needs `mcp-remote` "(Codex only supports STDIO)".
- `docs/codex-setup.md`: "Codex supports MCP servers via STDIO transport only (not remote HTTP/SSE)" and "This uses the `mcp-remote` npm package to bridge HTTP/SSE to STDIO." Troubleshooting mentions `mcp-remote` timeouts.
- `docs/claude-code-setup.md` and `docs/cursor-setup.md`: say the IDE "automatically detects" the config; no transport detail.
- `docs/ARCHITECTURE.md` "Core (AI SDK)" describes `src/mcp-client.ts` only as a "`createMCPClient` wrapper" and never mentions SSE.

### The inconsistency

The docs and every IDE config say HTTP, while the library path uses `type: "sse"` (Verified). The URL path is `/mcp`, which is the conventional Streamable HTTP endpoint; legacy SSE servers usually expose a separate `/sse` GET endpoint plus a `/messages` POST endpoint (Inferred). An SSE client does a GET and waits for an `endpoint` event. A Streamable HTTP server will only answer that GET if it also implements the optional server-to-client stream or a backwards-compatibility shim. So either the hosted server supports both transports on `/mcp`, or the AI SDK demos (`examples/01-send-tokens.ts`, `examples/02-deploy-and-verify.ts`) fail to connect. We cannot test which (Inferred, untestable here). `@ai-sdk/mcp` also accepts `type: "http"` for Streamable HTTP, so the fix would be one word (Inferred from knowledge of the package).

### Is SSE deprecated? (Inferred, from knowledge of the spec)

Yes. The MCP spec revision 2025-03-26 replaced the "HTTP+SSE" transport (from 2024-11-05) with "Streamable HTTP": a single endpoint accepting POST (JSON or an SSE-framed response stream) and optional GET for server-initiated messages, with an optional `Mcp-Session-Id` header. The old HTTP+SSE transport is kept only as a backwards-compatibility option; later revisions (2025-06-18, 2025-11-25) keep Streamable HTTP and stdio as the two standard transports. New servers should not be SSE-only. For our platform-side server, Streamable HTTP is the right choice.

## 2. Tool registration, schemas, descriptions

### Nothing registered locally (Verified)

No file in the repo defines a server tool. `src/mcp-client.ts` `getMCPTools()` just returns `client.tools()`:

```ts
export async function getMCPTools(): Promise<Record<string, any>> {
  const client = await getMonadMCPClient();
  return client.tools();
}
```

Called with no `schemas` argument, `@ai-sdk/mcp` runs `tools/list` and builds one AI SDK tool per server tool, using the server's name, description, and JSON Schema `inputSchema`, and an `execute` that calls `tools/call` (Inferred from the package's documented "schema discovery" mode). Implications:

- Names, descriptions, and input schemas are entirely server-controlled and can change without any client release. The client has no compile-time types (`Record<string, any>`) and no pinned tool set (Verified from the signature; consequence Inferred).
- The model sees exactly what the server advertises, including tools the kit tells it never to use (see section 5).
- The only local knowledge of the tool surface is prose: `README.md` "MCP Tools" table, `CLAUDE.md`, and the hard-coded list in `src/signing-bridge.ts`.

### What the client reveals about the server's tool surface (Verified)

- `src/signing-bridge.ts` `PREPARE_TOOLS` names seven tools: `prepare_native_transfer`, `prepare_transaction`, `prepare_erc20_transfer`, `prepare_erc721_transfer`, `prepare_erc1155_transfer`, `prepare_token_approval`, `prepare_contract_write`. The last four appear in neither `README.md` nor `CLAUDE.md`, suggesting the server has more tools than documented (Inferred).
- `examples/01-send-tokens.ts`, `.claude/skills/send/SKILL.md`, `.claude/skills/deploy/SKILL.md` call `get_transaction_receipt`, which is not in the README table (Verified).
- `CLAUDE.md`, `examples/01-send-tokens.ts` system prompt, and `.claude/skills/wallet/SKILL.md` all forbid `generate_disposable_test_wallet`, which by their own description "exposes private keys". So the server exposes a key-generating tool to every client (Verified that the kit says so; Inferred that it exists on the server).
- Parameter names seen in prose: `from`, `to`, `amount` (string, e.g. `"0.001"`) for `prepare_native_transfer`; `serializedTransaction` for `broadcast_signed_raw_transaction`; `address`, `compilerType`, `compilerVersion`, `standardJson` for `verify_evm_contract_standard_json`; `address`, `abi`, `functionName` for `read_evm_contract`; `limit` for `list_evm_blocks` (Verified in `.claude/skills/*/SKILL.md` and examples).
- The `prepare_*` tools return unsigned tx JSON with fields like `to`, `value`, `data`, `gas`/`gasLimit`, `gasPrice` or `maxFeePerGas`/`maxPriorityFeePerGas`, `nonce`, `chainId` (Inferred from `normalizeTx()` in `src/wallet.ts`, which reads exactly those keys). Numeric fields are decimal or hex strings passed to `BigInt()`.

This is a "prepare calldata, client signs" design: the model receives raw unsigned transactions. Our design deliberately avoids this (intents only, never calldata).

### How `src/agent.ts` and `src/signing-bridge.ts` consume the tools (Verified)

- `runAgent()` in `src/agent.ts`: `getMCPTools()`, then `augmentToolsWithSigning(mcpTools)`, then passes the map to `generateText({ tools: tools as any, maxSteps })`. The `as any` cast hides a type mismatch (below).
- `augmentToolsWithSigning()` in `src/signing-bridge.ts`: shallow-copies the tool map; for each name in `PREPARE_TOOLS` that exists, replaces `execute` with a wrapper that calls the original, parses the result, calls `signTransaction()` from `src/wallet.ts`, and returns `JSON.stringify({...unsigned, signedTransaction, _note})`. It also injects a local tool `get_wallet_address` with a hand-written `parameters` object.

Excerpt, `src/signing-bridge.ts` lines 40 to 50:

```ts
const result = await originalExecute(args, options);
let unsigned: Record<string, unknown>;
try {
  unsigned =
    typeof result === "string" ? JSON.parse(result) : result;
} catch {
  return result;
}
```

Two likely defects (Inferred, could not run):

1. **Result envelope mismatch.** An `@ai-sdk/mcp` tool's `execute` returns the MCP `CallToolResult` object (`{ content: [{ type: "text", text: "..." }], isError?, structuredContent? }`), not a string or a bare tx. The bridge takes the object branch, so `unsigned` is the envelope. `normalizeTx()` then finds none of `to`, `value`, `data`, etc., and either viem throws or a meaningless empty tx gets signed. The unsigned tx the server actually returned sits unread inside `content[0].text`.
2. **AI SDK major-version mismatch.** `package-lock.json` pins `ai` 4.3.19 (depends on `@ai-sdk/provider` 1.1.3) but `@ai-sdk/mcp` 1.0.36 depends on `@ai-sdk/provider` 3.0.8 and `@ai-sdk/provider-utils` 4.0.23, i.e. the AI SDK v6 generation (Verified from lockfile). The file comment at `src/signing-bridge.ts` line 1 notes "MCP tools use inputSchema (not parameters)"; `ai` v4 `generateText` reads `tool.parameters`. The injected `get_wallet_address` uses v4-style `parameters` with a raw JSON Schema object not wrapped in `jsonSchema()`. The two halves speak different tool shapes (Inferred that this breaks at runtime).

The subscription path (Claude Code, Cursor, Codex) does not use this code at all; there the model manually pipes JSON to `scripts/sign-tx.ts` per `CLAUDE.md` and the skills (Verified).

### Illustrative, not from the kit: registering one tool with the official SDK

A sketch of how one of our read tools would look with `@modelcontextprotocol/sdk` (TypeScript), using `registerTool` with zod `inputSchema`, an `outputSchema`, and `structuredContent`. Identity comes from the authenticated request, not from parameters.

```ts
const server = new McpServer({ name: "chain-tools", version: "0.1.0" });
server.registerTool("get_remaining_limits", {
  title: "Remaining trade limits",
  description: "Remaining trades, notional and allocation headroom for the calling agent's account.",
  inputSchema: { account: z.enum(["personal", "vault"]) },
  outputSchema: { tradesLeft24h: z.number().int(), maxTradeUsd: z.string(),
                  usdcFloorUsd: z.string(), asOfBlock: z.number().int() },
}, async ({ account }, extra) => {
  const agentId = agentFromAuth(extra.authInfo);   // never from args
  const out = await limits.forAgent(agentId, account);
  return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
});
```

The SDK validates `structuredContent` against `outputSchema` and advertises both schemas in `tools/list` (Inferred from SDK knowledge; exact field names such as `extra.authInfo` should be checked against the pinned SDK version).

## 3. How errors reach the agent (Verified unless marked)

- No client file checks `isError`. `grep` for `isError` returns nothing in `src/`, `examples/`, `scripts/`.
- `augmentToolsWithSigning()`: if parsing fails it returns the raw result; if `signTransaction()` throws it returns a JSON string with `_signingError: e.message` and `_note: "Signing failed. Check wallet setup: npm run wallet:simple"`. This is ad hoc, unschematised, and sent back as a successful tool result. `e.message` from `signViaDaemon()` in `src/wallet.ts` can include the socket path and raw daemon output (`Invalid daemon response: ${data}`).
- If a server tool returns `isError: true`, the bridge still tries to sign the envelope (Inferred, follows from defect 1 above).
- Errors thrown by `execute` (network, protocol) are not caught in `runAgent()`; only `finally { closeMCPClient() }`. In `ai` v4, a thrown tool error aborts `generateText` rather than being fed back to the model (Inferred from knowledge of v4).
- `src/utils.ts` `logStep()` prints tool results as strings truncated to 500 chars; no error classification.
- Server-side error format is unknown. Standard MCP practice is `isError: true` with a text message for tool-level failures and JSON-RPC errors for protocol failures (Inferred).

Conclusion: not structured. For our server we should return `isError: true` plus a typed `structuredContent` error object (stable `code`, `message`, `retryable`, and for intents a `policyViolation` detail such as which Executor limit was hit), and keep that schema in `outputSchema` as a union (Inferred recommendation).

## 4. Authentication, sessions, caller identity

Verified: none.

- `.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`: URL or command only, no `headers`, no `env`, no bearer token.
- `src/mcp-client.ts`: transport config has only `type` and `url`; no `headers`, no `authProvider`.
- `.env.example`: only `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, wallet fields, `SIGNER_MODE`, `MONAD_MCP_URL`. No MCP credential.
- A repo-wide grep for `header`, `authoriz`, `bearer`, `api_key`, `session` (excluding `.env`, `.keystore/`, `research/`, lockfile) finds only the LLM API key lines.
- Caller identity is purely a parameter: the wallet address is injected into the system prompt (`examples/01-send-tokens.ts`, `examples/02-deploy-and-verify.ts`) or read with `grep` (skills), and the model passes it as `from` to `prepare_*` and as the address to `get_balance`. The server cannot know, and apparently does not care, who is calling. This is safe for them only because their server never holds keys or moves funds; it would be unacceptable for us.

Side note (Verified dependency, Inferred meaning): `@ai-sdk/mcp` depends on `pkce-challenge`, i.e. the client library supports OAuth 2.1 with PKCE via an `authProvider`, and its HTTP/SSE transports accept a `headers` map. The kit uses neither.

### How per-agent identity could be bound to the connection (Inferred, general design)

- **Bearer token per agent, validated by the server.** Each agent sandbox gets a connection credential (short-lived signed token or opaque key) that maps to exactly one agent ID, tier, and account set. The server resolves identity in auth middleware (with the official SDK, `requireBearerAuth` populates `authInfo`, reachable from tool handlers via `extra.authInfo`) and never accepts an agent or account ID as a tool argument, except to select between accounts that identity already owns.
- **E2B firewall header injection.** Since E2B can inject a header at egress, the sandbox config only holds the server URL; the firewall adds `Authorization: Bearer <agent token>` for that host. The model and Hermes process never see the token, so prompt injection cannot exfiltrate or swap it. The server must then also check that the request came via the platform egress (mTLS, IP allowlist, or a second injected header) so a leaked token alone is not enough.
- **`Mcp-Session-Id` is not authentication.** It is a server-issued correlation ID for Streamable HTTP state, visible to the client, and the spec warns against using it for auth. Session state must be keyed to the authenticated principal, and a session ID presented with a different principal must be rejected.
- **Platform-side server fits this better** than an in-sandbox server: an in-sandbox server would need the credential or policy data inside the sandbox, which breaks "credentials never enter the sandbox".
- Metering then hangs off the same resolved identity: count paid calls per agent ID in the handler wrapper, not per session.

## 5. Enabling or disabling tools per client

Verified: nothing.

- `src/mcp-client.ts` `getMCPTools()` returns every tool the server lists; no filter.
- `src/signing-bridge.ts` `augmentToolsWithSigning()` adds a tool and wraps some, but removes none. `generate_disposable_test_wallet` is passed to the model.
- `.claude/settings.json` has only a `PreToolUse` hook on `Bash` running `scripts/guard.sh`; no `permissions.allow/deny` for `mcp__monad__*` tools. Claude Code could deny `mcp__monad__generate_disposable_test_wallet` there, but the kit does not.
- The skills (`.claude/skills/*/SKILL.md`), `CLAUDE.md`, and the example system prompts only say "NEVER use `generate_disposable_test_wallet`". This is instruction-level, not enforcement.
- No evidence of server-side tiers or per-client tool sets; since there is no auth, the server cannot distinguish clients anyway (Inferred).

Client-side allowlisting (IDE permissions, Hermes include/exclude lists, filtering `client.tools()`) reduces what the model sees and is useful for prompt hygiene, but a compromised or misconfigured client can still call any tool the server exposes. For our tiers the server must decide: filter `tools/list` by the authenticated tier and also reject `tools/call` for tools outside the tier (Inferred recommendation). The official SDK supports enabling/disabling registered tools and sending `notifications/tools/list_changed`, but that is per server instance; per-caller filtering is simplest by building a server instance per authenticated session or by checking tier in a shared handler wrapper (Inferred).

## 6. How Hermes would connect

Per our earlier research, Hermes Agent reads MCP servers from its config (YAML, a `mcp_servers` map), supports stdio servers (`command`, `args`, `env`) and HTTP servers (`url`, `headers`), and lets each server entry carry tool include/exclude lists; it can run headless. Exact key names below are Inferred and must be checked against the pinned Hermes version.

- **Against this kit's hosted server:** point Hermes at `https://api.monad.exploreme.pro/mcp` as an HTTP server, or at `npx mcp-remote <url>` as stdio (the Codex pattern). No headers are needed because the server has no auth (Verified that the kit uses none). Add `generate_disposable_test_wallet` to the exclude list. Hermes would then face the same "sign it yourself" flow, which does not match our never-sign design, so this server is at most a read-only data source.
- **Against our platform-side server (recommended shape):** one HTTP entry per agent sandbox with only the URL in config; E2B's firewall injects the per-agent `Authorization` header, so the `headers` field stays empty in the sandbox. Use Hermes' per-server include list as a second, client-side layer mirroring the agent's tier, while the server remains the authority. Deny-by-default egress should allow only that host.
- **In-sandbox server alternative:** a stdio entry launching our server inside the sandbox. It avoids a network hop but puts server code, RPC access, and some credential inside the sandbox, contradicting the credential-free sandbox goal. Our lean to platform-side is supported by this analysis (Inferred).

## Library note

The kit's only MCP dependency is `@ai-sdk/mcp` 1.0.36 (Vercel AI SDK MCP client, Apache-2.0, `package-lock.json`). It does not depend on `@modelcontextprotocol/sdk` (Verified in `package.json` and lockfile). So the kit offers nothing reusable for building a server; for our server we would use the official SDK (TypeScript or Python) directly.

## Open questions

1. Which transport does the hosted server actually speak on `/mcp`: Streamable HTTP only, or also legacy SSE? Do the AI SDK demos connect at all? (Needs network access to the host, which is blocked here.)
2. What is the real `tools/list` output: exact tool count, input schemas, whether any tool declares `outputSchema` or returns `structuredContent`, and whether `prepare_erc721_transfer`, `prepare_contract_write`, `generate_disposable_test_wallet`, etc. exist as the client code implies?
3. Does the hosted server issue `Mcp-Session-Id`, rate-limit by IP, or have any hidden auth or tier logic?
4. Does `augmentToolsWithSigning()` ever work with `@ai-sdk/mcp` 1.0.36 given the `CallToolResult` envelope and the `ai` 4.3.19 vs provider 3.x mismatch? (Would need `npm install` and a run, which our rules forbid.)
5. How does the hosted server format tool errors (`isError` text, JSON-RPC errors, or success payloads with error fields)?
6. For Hermes: exact config keys for per-server headers and tool include/exclude, whether it honours `outputSchema`/`structuredContent`, and whether it handles `notifications/tools/list_changed` (needed if tiers change mid-session).
7. For our server: per-session server instances versus a shared instance with tier checks in a handler wrapper; which scales better with one Hermes instance per agent?
