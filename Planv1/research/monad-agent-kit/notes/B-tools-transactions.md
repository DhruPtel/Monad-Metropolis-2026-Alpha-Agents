# B: Tools and Transactions (sub-agent B)

Scope: tool inventory, the unsigned transaction path in both flows, supported protocols, chain config, gas/nonce handling, and what we can reuse for our intent-based tool server. Repo HEAD `b0f0a09`. The MCP server is hosted and closed (see `00-phase0-orientation.md`), so every statement about server behaviour is **Inferred** unless it is proven by client code in this repo. Nothing was executed; all findings come from reading files.

## 1. Tool inventory

### 1.1 Sources and discrepancies (Verified)

Tool names appear in five places, and no two agree:

| Source | What it lists |
|---|---|
| `README.md` "MCP Tools" table (lines 272 to 283) | 15 tools |
| `CLAUDE.md` "MCP Server" section | README's 15 plus `get_evm_compiler_versions` and `get_erc721_token_by_address` (17) |
| `.claude/skills/*/SKILL.md` and `examples/*.ts` | Use `get_transaction_receipt`, which appears in **neither** README nor CLAUDE.md. `deploy/SKILL.md` and `02-deploy-and-verify.ts` also use `get_evm_compiler_versions` |
| `src/signing-bridge.ts` `PREPARE_TOOLS` | Adds `prepare_erc721_transfer`, `prepare_erc1155_transfer`, `prepare_token_approval`, `prepare_contract_write`, none of which are documented anywhere else |
| `CLAUDE.md`, `wallet/SKILL.md`, `examples/01-send-tokens.ts` | Forbid `generate_disposable_test_wallet`, which implies the server exposes it (a tool that returns a fresh private key into model context) |
| `docs/ARCHITECTURE.md` line 77 | Says the faucet tools `claim_faucet_tokens` and `get_faucet_payout_status` are **not in the kit**. That points to a shared server codebase across STAKEME's chain kits where testnet builds have faucet tools |

`docs/prompts.md` names no tools. It only gives natural language prompts. One of them ("Show my wallet address and the last 5 transactions") implies an account-history capability, probably `get_account_by_address` or `explorer_search` (Inferred).

Because `augmentToolsWithSigning` wraps only names that actually exist (`if (augmented[toolName])`), the four undocumented `prepare_*` names may or may not exist on the server. We could not list tools live because the endpoint is filtered from this machine.

### 1.2 Grouped list (descriptions Inferred from names and usage unless noted)

**Read tools**

| Tool | One-line description | Documented in |
|---|---|---|
| `get_balance` | Native MON balance of an address | README, CLAUDE.md, skills, example 01 |
| `get_token_balance` | ERC-20 balance of an address for a token | README, CLAUDE.md |
| `list_evm_blocks` | Recent blocks, takes `limit` (Verified from `send/SKILL.md` step 3) | README, CLAUDE.md, skills, ex 01 |
| `get_evm_block_by_height` | One block with its transactions | README, CLAUDE.md, skills, ex 01 |
| `read_evm_contract` | eth_call style view call, takes `address`, `abi`, `functionName` (Verified from `deploy/SKILL.md` step 9) | README, CLAUDE.md, skills, ex 02 |
| `get_evm_compiler_versions` | List of solc versions the explorer can verify with | CLAUDE.md, deploy skill, ex 02 |
| `list_erc20_tokens` | Explorer's ERC-20 token list | README, CLAUDE.md |
| `get_erc20_token_by_address` | ERC-20 metadata (name, symbol, decimals, likely supply) | README, CLAUDE.md |
| `get_erc721_token_by_address` | ERC-721 collection metadata | CLAUDE.md only |
| `explorer_search` | Free-text explorer search (address, tx, token) | README, CLAUDE.md |
| `get_account_by_address` | Explorer account view, likely including tx history | README, CLAUDE.md |
| `wait_for_transaction` | Polls until a tx hash is mined | README, CLAUDE.md, skills, examples |
| `get_transaction_receipt` | Receipt including `contractAddress` | skills and examples only |
| `get_wallet_address` | **Local** tool added by the bridge, returns `WALLET_ADDRESS` (Verified, `src/signing-bridge.ts` lines 78 to 84) | bridge only |

**Prepare tools** (return an unsigned transaction JSON, server side)

| Tool | One-line description | Documented in |
|---|---|---|
| `prepare_native_transfer` | Unsigned MON transfer; args `from`, `to`, `amount` in human units such as "0.001" (Verified args from `send/SKILL.md` step 4 and `01-send-tokens.ts`) | README, CLAUDE.md, skill, ex 01, bridge |
| `prepare_erc20_transfer` | Unsigned ERC-20 `transfer` | README, CLAUDE.md, bridge |
| `prepare_transaction` | Unsigned tx with **arbitrary** `to` and `data` (and no `to` means contract creation). Args `from`, `data`, optional `to` (Verified from `deploy/SKILL.md` step 4 and `02-deploy-and-verify.ts`) | README, CLAUDE.md, skill, ex 02, bridge |
| `prepare_erc721_transfer` | Unsigned NFT transfer | bridge only |
| `prepare_erc1155_transfer` | Unsigned multi-token transfer | bridge only |
| `prepare_token_approval` | Unsigned `approve` (spender and amount chosen by caller) | bridge only |
| `prepare_contract_write` | Unsigned call to a contract function by ABI and args | bridge only |

**Send, sign, and state-changing tools**

| Tool / mode | What it does | Where |
|---|---|---|
| `broadcast_signed_raw_transaction` | Server submits a signed raw tx (arg `serializedTransaction`, Verified from `send/SKILL.md` step 6) | Remote MCP |
| `verify_evm_contract_standard_json` | Submits source to the explorer for verification. Off-chain write, no funds | Remote MCP |
| `generate_disposable_test_wallet` | Returns a fresh keypair to the model (Inferred from the warnings) | Remote MCP, forbidden by docs only |
| `scripts/sign-tx.ts` | Local CLI signer, stdin JSON to stdout signed hex | Local |
| `make sign` | Wrapper for `sign-tx.ts`, native or inside the `dev` container (Verified, `Makefile` line 51) | Local |
| `src/signing-bridge.ts` wrapped `prepare_*` | Auto signs every prepare result | Local, AI SDK |
| `scripts/signer-daemon.ts` | Unix socket signer, auto or manual approval | Local |
| `src/wallet.ts` `signTransaction` | Library function, simple or secure mode | Local, exported from `src/index.ts` |

## 2. The unsigned transaction path

### 2.1 Common local parsing (Verified)

The same normalisation code is duplicated three times: `signLocally` in `scripts/sign-tx.ts` (lines 72 to 85), `normalizeTx` in `src/wallet.ts` (lines 78 to 95), and the `sign_transaction` case of `handleRequest` in `scripts/signer-daemon.ts` (lines 206 to 218). All three copy these fields and nothing else:

```ts
if (tx.to) txData.to = tx.to;
if (tx.value) txData.value = BigInt(tx.value as string);
if (tx.data) txData.data = tx.data;
if (tx.gas) txData.gas = BigInt(tx.gas as string);
if (tx.gasLimit) txData.gas = BigInt(tx.gasLimit as string);
if (tx.gasPrice) txData.gasPrice = BigInt(tx.gasPrice as string);
if (tx.maxFeePerGas) txData.maxFeePerGas = BigInt(...);
if (tx.maxPriorityFeePerGas) txData.maxPriorityFeePerGas = BigInt(...);
if (tx.nonce !== undefined) txData.nonce = Number(tx.nonce);
if (tx.chainId) txData.chainId = Number(tx.chainId);
```

The result goes straight to viem `account.signTransaction(txData)`.

What is and is not checked (Verified by absence, grep for `chainId|10143|143|allow|limit` finds only these lines):

- **No chainId pin.** `chainId` is taken from the input if present. If it is missing, viem signs without one. For a legacy (`gasPrice`) tx that yields a pre-EIP-155 signature that is replayable on any EVM chain (Inferred from viem's legacy serializer behaviour). The kit has no knowledge of Monad's chain ID at all.
- **No `from` check.** `from` is silently dropped. Nothing confirms the tx is meant for this wallet.
- **No destination allowlist, no value cap, no calldata inspection, no selector filter, no contract creation block.** Missing `to` is signed as a deployment.
- **No type check.** `type`, `accessList`, `authorizationList`, `blobs` are dropped, so EIP-7702 and blob txs cannot be signed (a side effect, not a control). viem infers the type from which fee fields are present.
- **Loose number parsing.** `BigInt("0.001")` throws, so human units are rejected, but hex and decimal strings both pass. A `value` of numeric `0` is skipped by the truthiness check (harmless).
- **Output.** `sign-tx.ts` `main` writes only the signed hex to stdout (line 120). Errors go to stderr.

### 2.2 Flow (a): Claude Code, CLAUDE.md and skills

Steps as documented in `CLAUDE.md` "Transaction Signing Flow" and `send/SKILL.md`, `deploy/SKILL.md` (Verified as documentation, behaviour of the remote tools Inferred):

1. Model calls MCP `prepare_native_transfer` or `prepare_transaction`. The server returns unsigned JSON (fields presumably `to`, `value`, `data`, `gas`, fee fields, `nonce`, `chainId`; Inferred from the fields the signer parses).
2. Model runs a Bash command it writes itself: `echo '<unsigned_tx_json>' | make sign` (skills) or `| npx tsx scripts/sign-tx.ts` (CLAUDE.md).
3. `sign-tx.ts` loads `.env` via `dotenv` (`config()` line 6). In `SIGNER_MODE=simple` (the default, `.env.example` line 11) it reads `process.env.PRIVATE_KEY` and signs in that child process. In `secure` mode it forwards `{action:"sign_transaction", tx}` over the Unix socket.
4. Model calls MCP `broadcast_signed_raw_transaction` with the hex, then `wait_for_transaction`, then `get_transaction_receipt`.

What the agent sees: the unsigned JSON, the signed hex, and receipts. It never sees the key directly.

The critical point: **the JSON piped into the signer is authored by the model, not by the MCP server.** Nothing binds step 2 to step 1. The model can pipe any JSON it likes (any `to`, `value`, `data`, `chainId`), so `sign-tx.ts` is an unconditional signing oracle for the agent. In simple mode, and in secure auto mode, there is no human or policy step at all.

### 2.3 Flow (b): AI SDK, `src/agent.ts` and `src/signing-bridge.ts`

- `runAgent` (`src/agent.ts` lines 28 to 67) calls `getMCPTools()` (remote tool set, unfiltered), wraps it with `augmentToolsWithSigning`, and passes **all** tools to `generateText` with `maxSteps` 15 (20 and 25 in the examples). No tool allowlist, no approval callback.
- `augmentToolsWithSigning` (`src/signing-bridge.ts` lines 24 to 87) replaces `execute` on each name in `PREPARE_TOOLS`. The new `execute` calls the original MCP tool, parses the result, calls `signTransaction(unsigned)` from `src/wallet.ts`, and returns `{...unsigned, signedTransaction, _note}` to the model.
- `signTransaction` (`src/wallet.ts` lines 18 to 28) picks `signLocally` (reads `PRIVATE_KEY` from `process.env` in the **same Node process as the agent loop**) or `signViaDaemon`.
- The model then calls `broadcast_signed_raw_transaction` itself. The bridge does not wrap broadcast.

So yes, **the bridge auto signs any `prepare_*` result the model triggers** (Verified). The only gate is which prepare tool names the server exposes. Since `prepare_transaction` accepts arbitrary `to` and `data`, and `prepare_token_approval` / `prepare_contract_write` are also wrapped, the model effectively controls a hot wallet: any transfer, any approval, any contract call, any deployment, limited only by the wallet balance. A second trust issue: the bridge signs whatever the **server** returns, not what the model asked for. A compromised server, or an overridden `MONAD_MCP_URL` (`src/utils.ts` `getMcpUrl`), can return a different `to`/`data` and the bridge signs it without comparison.

Possible bug (Inferred, needs confirming against `@ai-sdk/mcp` 1.0.36): AI SDK MCP tools normally return a `CallToolResult` object (`{content:[{type:"text",text:"..."}], isError}`), not a string. The bridge only `JSON.parse`s when `typeof result === "string"`. With an object it would pass the wrapper itself to `normalizeTx`, which finds no `to`/`value`/fee fields, and viem would likely fail with a signing error that is returned as `_signingError`. If so, the AI SDK demos do not work as shipped, and would start working (dangerously) as soon as someone fixes the parsing. Also, the local `get_wallet_address` tool uses a raw JSON Schema object as `parameters`, which `ai` 4.x normally expects wrapped with `jsonSchema()` (Inferred). Sub-agent A should confirm both.

### 2.4 `signer-daemon.ts` auto vs manual (Verified)

- Mode is `SIGN_MODE = process.argv.includes("--manual") ? "manual" : "auto"` (line 11). Default is **auto**.
- Both modes call `logTransaction(tx)` (lines 145 to 159), printing type (DEPLOY if no `to`, otherwise "TRANSFER"), to, value, gas, first 20 hex chars of data, and full JSON to the daemon's own terminal.
- Manual mode then calls `askApproval()`, a y/n TTY prompt. Auto mode signs immediately.
- There is no policy in either mode: no chain pin, no allowlist, no rate limit. The "TRANSFER" label is misleading because every call with a `to` (including `approve` or arbitrary contract calls) is labelled TRANSFER; the human has to decode calldata by eye.
- `get_private_key`, `export_key`, `export`, `dump` actions are refused (lines 236 to 245), which is cosmetic because no code path returns the key anyway.
- Only `sign_transaction` and `get_address` are supported. No `signMessage` or `signTypedData`, so Permit2 or EIP-712 flows are impossible through the daemon.

### 2.5 Can the private key reach the agent?

- Secure mode with the daemon in Docker (`docker-compose.yml` `signer`, `network_mode: "none"`, keystore mounted read-only): the key lives only in the daemon process. The agent cannot read it through any code path in this repo (Verified). It can still get anything signed in auto mode.
- Simple mode (default): the key is in `.env`, readable by any process the agent starts. Protection is only `scripts/guard.sh`, a regex deny list. In the AI SDK flow the key is loaded into the agent's own process by `dotenv` (`src/utils.ts` line 5). Note that `.claude/settings.json` runs `bash scripts/guard.sh '$TOOL_INPUT'` with **single quotes**, so the shell passes the literal string `$TOOL_INPUT`; Claude Code hooks receive tool input on stdin as JSON, not as that variable. If that is right, the guard sees a constant string and allows every command (Inferred, sub-agent C should confirm). Even when working, a regex list is bypassable (for example `npx tsx -e` with `dotenv` does not match `node.*\.env`).
- Remote `generate_disposable_test_wallet` returns a key into model context by design; only prose instructions prevent its use (Inferred).

### 2.6 Everything that can sign or send

`sign-tx.ts` (both modes), `make sign`, `signer-daemon.ts` (auto without human, manual with human), `src/wallet.ts` `signTransaction` (exported library API), the seven wrapped `prepare_*` tools in the AI SDK flow, and remote `broadcast_signed_raw_transaction`. Any signed hex held by the model can also be broadcast by other means (any RPC), since `broadcast` is not the only path to the chain.

Side note (Inferred): in Docker mode, `make sign` runs `sign-tx.ts` in the `dev` container, but the daemon's socket is in the `signer-socket` volume, which `dev` does not mount. Secure mode through `make sign` in Docker mode would therefore fail to find the socket.

## 3. Protocols and actions supported

Grep over all tracked files (excluding `package-lock.json`) for `uniswap|kuru|swap|quote|stake|staking|lend|router|oracle|deadline|decimals` returns no code or doc hits (the only "stake" hits are the `stakeme-team` org name). Verified.

| Action | Status |
|---|---|
| Native MON transfer | Supported (`prepare_native_transfer`) |
| ERC-20 transfer | Supported by server tool, no local example |
| ERC-721 / ERC-1155 transfer, token approval, contract write | Names wrapped by the bridge; existence on the server unconfirmed |
| Arbitrary contract call and deployment | Supported via `prepare_transaction` |
| Contract read | `read_evm_contract` |
| Explorer verification | `verify_evm_contract_standard_json` |
| Swaps (Uniswap v3/v4, Kuru, any aggregator), quotes | **Absent** |
| Oracle prices, pool prices | **Absent** |
| Staking, liquid staking | **Absent** |
| Lending, borrowing | **Absent** |
| Wrap/unwrap MON | Absent as a named tool; only possible via raw `prepare_transaction` |
| Portfolio value, positions, USD pricing | **Absent** |

The only way this kit could touch a DEX is by the model hand-crafting router calldata into `prepare_transaction`, which is exactly the pattern our design forbids.

## 4. Tokens, decimals, chain config, network selection

- **No chain config in the client** (Verified). No `viem/chains` import, no `defineChain`, no RPC URL, no chain ID constant anywhere in `src/`, `scripts/`, or `examples/`. The client never talks to an RPC node; everything goes through the MCP server.
- **Network selection is purely the MCP URL** (`getMcpUrl` in `src/utils.ts`, default `https://api.monad.exploreme.pro/mcp`, override `MONAD_MCP_URL`). `docs/ARCHITECTURE.md` states the target is mainnet. The chain ID in the signed tx is whatever the server puts in the unsigned JSON (Inferred: Monad mainnet is 143, testnet 10143; neither number appears in the repo).
- **Token addresses**: none hard-coded (no USDC, no WMON). Discovery is via `list_erc20_tokens` and `get_erc20_token_by_address` (Inferred).
- **Decimals**: the client never handles them. `prepare_native_transfer` takes a human amount ("0.001"), so the server converts to wei (Inferred). For `prepare_erc20_transfer` it is unknown whether the server looks up decimals or expects base units. `signer-daemon.ts` `formatValue` assumes 18 decimals for display, and uses `Number(wei) / 1e18`, which loses precision on large values (Verified).

## 5. Gas, nonces, deadlines

- **Gas and fees**: not estimated locally (Verified: no `estimateGas`, no fee logic). The client just copies `gas`/`gasLimit`, `gasPrice`, or EIP-1559 fields from the server's JSON. Estimation is server side (Inferred). If both `gas` and `gasLimit` are present, `gasLimit` wins silently.
- **Nonce**: copied from input with `Number()`. No local nonce tracking (Verified). The server presumably fills it from `eth_getTransactionCount(pending)` (Inferred). Two prepares before a broadcast would collide, and nothing detects a stale nonce before signing.
- **Deadlines**: no concept at all (no swaps). Signed txs have no expiry; a signed hex held by the model stays valid until the nonce is used.
- **Retries, replacement, stuck tx handling**: none on the client.

## 6. Adapt or remove, for our intent-based tool server

Our rule: the agent never produces calldata or signatures; only the platform (policy, simulation, Privy session key, Executor contract) moves funds.

| Kit tool / component | Verdict | Reason and what we would build instead |
|---|---|---|
| `get_balance`, `get_token_balance` | **Adapt** | Becomes `get_balances` scoped to the bound PersonalAccount/StrategyVault and operating wallet, typed output with decimals applied. Address comes from the authenticated connection, not model args |
| `get_erc20_token_by_address`, `list_erc20_tokens` | **Adapt, narrowed** | Return only the allowlisted assets (USDC, WMON) with fixed metadata. Arbitrary token lookup invites the model to reason about assets it cannot trade |
| `read_evm_contract` | **Replace** | Generic ABI calls give the model a raw chain surface. Replace with specific reads: oracle price, pool quote, portfolio value, remaining limits |
| `wait_for_transaction`, `get_transaction_receipt` | **Adapt** | Becomes `get_intent_status(intentId)`, which wraps receipt lookup internally. The agent should track intents, not tx hashes |
| `list_evm_blocks`, `get_evm_block_by_height`, `explorer_search`, `get_account_by_address` | **Drop or low tier only** | Not needed for portfolio management. Raw block and tx data from arbitrary accounts is a prompt injection channel (token names, calldata). Maybe a read-only research tier |
| `get_evm_compiler_versions`, `get_erc721_token_by_address` | **Drop** | Irrelevant to our product |
| `prepare_native_transfer` | **Remove** | Moves funds outside the Executor |
| `prepare_erc20_transfer` | **Remove** | Same. Any withdrawal must be an owner action, not an agent tool |
| `prepare_transaction` | **Remove** | Arbitrary `to`/`data` equals arbitrary contract calls and deployments; bypasses every Executor limit |
| `prepare_contract_write`, `prepare_token_approval` | **Remove** | Arbitrary calls and unlimited approvals; our Executor does exact approvals itself |
| `prepare_erc721_transfer`, `prepare_erc1155_transfer` | **Remove** | Could transfer the agent NFT itself, breaking ERC-6551 identity binding |
| `broadcast_signed_raw_transaction` | **Remove** | The agent never holds signed txs. Broadcast is internal to the platform |
| `verify_evm_contract_standard_json` | **Remove** | Deployment tooling, not an agent capability |
| `generate_disposable_test_wallet` | **Remove** | Returns key material to the model |
| `get_wallet_address` (local) | **Adapt** | Becomes `whoami`: agent token ID, TBA address, bound accounts, tier, derived from the session |
| `src/signing-bridge.ts` auto sign pattern | **Do not reuse** | The exact anti-pattern we are designing against: model triggers, signer signs, no policy |
| `scripts/sign-tx.ts`, `signer-daemon.ts` | **Do not reuse** | No policy hooks, no chainId pin, no EIP-712. Only the "key in a network-isolated process" idea is useful, and Privy session keys replace it |
| New, no kit equivalent | **Build** | `get_oracle_price`, `get_pool_quote`, `get_portfolio_value`, `get_remaining_limits`, `propose_swap`, `propose_rebalance` (return `intentId` and status, never calldata), `get_intent_status`, `cancel_intent` |

If any kit-style signer is kept anywhere (for example the operating wallet paying gas), it needs at minimum: chainId pinned to Monad mainnet, `from` asserted, destination allowlist (Executor only), value cap, selector allowlist, and rejection of contract creation.

## Open questions

1. What does the live server actually expose? We need its `tools/list` to confirm whether `prepare_contract_write`, `prepare_token_approval`, `prepare_erc721_transfer`, `prepare_erc1155_transfer`, `get_transaction_receipt`, and `generate_disposable_test_wallet` exist, and their input and output schemas. Blocked by the network filter on this machine.
2. What exact JSON does a `prepare_*` tool return (field names, hex vs decimal strings, `type`, whether `chainId` is always set)? Determines whether pre-EIP-155 signing can actually happen.
3. Does `@ai-sdk/mcp` 1.0.36 return a string or a `CallToolResult` object from `execute`? If an object, the bridge's parse fails and the AI SDK demos cannot sign as shipped (hand to sub-agent A).
4. Is the Claude Code guard hook effectively a no-op because of `'$TOOL_INPUT'` quoting (hand to sub-agent C)?
5. Does `prepare_erc20_transfer` take human units or base units, and does the server look up decimals itself?
6. Does the server estimate gas with Monad specifics in mind (Monad charges on gas limit, so over-estimation costs real MON)? Inferred concern, not verified.
7. Does the server do any per-caller auth or rate limiting on `prepare_*` and `broadcast`? No auth header is sent by any client config in the repo.
