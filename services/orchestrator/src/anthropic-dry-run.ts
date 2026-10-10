import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryCallLog, MemoryIntentStore, startChainTools } from "@alpha-agents/chain-tools";
import type { ChainReaderV3 } from "@alpha-agents/chain-tools";
import { startDataTools } from "@alpha-agents/data-tools";
import type { Meter, WebProvider } from "@alpha-agents/data-tools";
import { DEFAULT_GOAL_INPUT } from "@alpha-agents/domain";
import { MemoryPlatformStore, startPlatformTools } from "@alpha-agents/platform-tools";
import { translateGoal } from "@alpha-agents/policy";
import type { AgentIdentity, ToolServer } from "@alpha-agents/tool-server";
import { connectClient, staticResolver } from "@alpha-agents/tool-server/testing";
import { cycleConfig, stagePrompt } from "./cycle/config.ts";
import {
  type CycleKind,
  REASONING_ALIASES,
  type Stage,
  stageCaps,
  stageCeilingUsdcE6,
} from "./cycle/stages.ts";
import { renderAgentConfig } from "./hermes/layers.ts";

/**
 * P0-API: a dry run of every model request shape against Anthropic's free
 * token-counting endpoint, spending nothing. For every alias in
 * infra/litellm/config.yaml (its real model ID) and every model stage of a
 * research cycle (Scan, routine and activation; Dive; Challenge; Zoom out), it
 * sends the stage's prompt, the cycle's SOUL.md as the system prompt, and
 * every tool our three tool servers offer, named as Hermes names them
 * (mcp__<server>__<tool>), and records the token count or the exact refusal
 * with its request ID. Hermes' own system text and built-in tools are not
 * reproduced here; this proves our prompts, our tool schemas and the
 * account, which is what fails when the account refuses.
 *
 *   node services/orchestrator/src/anthropic-dry-run.ts
 *
 * Reads ANTHROPIC_API_KEY from .env and never prints it. Writes
 * evidence/p0-api/dry-run-<time>.json. Exits 0 when every request counted.
 */
const ROOT = join(import.meta.dirname, "..", "..", "..");
const TOKEN = "d".repeat(43);
const IDENTITY: AgentIdentity = { chainId: 143143, agentId: 1, tier: "pro", leaseId: "dry-run" };

function envKey(): string {
  const text = readFileSync(join(ROOT, ".env"), "utf8");
  const line = text.split(/\r?\n/).find((l) => l.startsWith("ANTHROPIC_API_KEY="));
  const value =
    line
      ?.slice("ANTHROPIC_API_KEY=".length)
      .trim()
      .replace(/^["']|["']$/g, "") ?? "";
  if (!value) throw new Error("ANTHROPIC_API_KEY is not set in .env");
  return value;
}

/** The aliases and their model IDs as LiteLLM maps them, read from the config so the two never drift. */
function aliases(): { alias: string; model: string }[] {
  const text = readFileSync(join(ROOT, "infra", "litellm", "config.yaml"), "utf8");
  const out: { alias: string; model: string }[] = [];
  let alias: string | null = null;
  for (const line of text.split("\n")) {
    const name = /^\s*-\s*model_name:\s*(\S+)/.exec(line);
    if (name?.[1]) alias = name[1];
    const model = /^\s*model:\s*anthropic\/(\S+)/.exec(line);
    if (model?.[1] && alias) {
      out.push({ alias, model: model[1] });
      alias = null;
    }
  }
  return out;
}

interface AnthropicTool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

/** Every tool of one server, in Anthropic's tool format, named as Hermes exposes MCP tools. */
async function toolsOf(server: ToolServer, name: string): Promise<AnthropicTool[]> {
  const client = await connectClient(server.url, TOKEN);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => ({
    name: `mcp__${name}__${t.name}`,
    description: t.description ?? "",
    input_schema: t.inputSchema as Record<string, unknown>,
  }));
}

async function allTools(): Promise<{ tools: AnthropicTool[]; perServer: Record<string, number> }> {
  const resolve = staticResolver({ [TOKEN]: IDENTITY });
  const servers: ToolServer[] = [];
  try {
    // Chain tools of the fund agent's v3 set (every new account is on it, D-367).
    const readerV3 = { custodyPath: async () => "v3" } as unknown as ChainReaderV3;
    const chain = await startChainTools({
      resolve,
      reader: null,
      readerV3,
      log: new MemoryCallLog(10),
      intents: new MemoryIntentStore(),
      sessionKeyOf: async () => null,
    });
    servers.push(chain);
    const meter = {
      begin: async () => "dry-run",
      finish: async () => undefined,
    } as unknown as Meter;
    const provider: WebProvider = {
      name: "dry-run",
      search: async () => [],
      extract: async () => null,
    };
    const data = await startDataTools({
      resolve,
      meter,
      provider,
      lookup: async () => ["93.184.215.14"],
      probe: async () => new Response("", { status: 200 }),
      market: null,
      research: null,
      tokens: null,
    });
    servers.push(data);
    const platform = await startPlatformTools({ resolve, store: new MemoryPlatformStore() });
    servers.push(platform);
    const lists = await Promise.all([
      toolsOf(chain, "chain"),
      toolsOf(data, "data"),
      toolsOf(platform, "platform"),
    ]);
    return {
      tools: lists.flat(),
      perServer: { chain: lists[0].length, data: lists[1].length, platform: lists[2].length },
    };
  } finally {
    await Promise.all(servers.map((s) => s.close()));
  }
}

interface Result {
  readonly alias: string;
  readonly model: string;
  readonly stage: string;
  readonly status: number;
  readonly inputTokens: number | null;
  readonly errorType: string | null;
  readonly message: string | null;
  readonly requestId: string | null;
}

async function countTokens(
  key: string,
  body: Record<string, unknown>,
): Promise<Omit<Result, "alias" | "model" | "stage">> {
  const res = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const requestId = res.headers.get("request-id");
  const json = (await res.json().catch(() => ({}))) as {
    input_tokens?: number;
    error?: { type?: string; message?: string };
  };
  return {
    status: res.status,
    inputTokens: typeof json.input_tokens === "number" ? json.input_tokens : null,
    errorType: json.error?.type ?? null,
    message: json.error?.message ?? null,
    requestId,
  };
}

async function main(): Promise<void> {
  const key = envKey();
  const goal = translateGoal(DEFAULT_GOAL_INPUT);
  if (!goal.ok) throw new Error("the default goal does not translate");
  const stored = renderAgentConfig({
    chainId: 143143,
    agentId: 1,
    species: 14,
    tier: "pro",
    generation: 1,
  }).config;
  const { tools, perServer } = await allTools();
  const stages: { stage: Exclude<Stage, "TEST">; kind: CycleKind; label: string }[] = [
    { stage: "SCAN", kind: "ROUTINE", label: "SCAN (routine)" },
    { stage: "SCAN", kind: "ACTIVATION", label: "SCAN (activation)" },
    { stage: "DIVE", kind: "ROUTINE", label: "DIVE" },
    { stage: "CHALLENGE", kind: "ROUTINE", label: "CHALLENGE" },
    { stage: "ZOOM_OUT", kind: "ACTIVATION", label: "ZOOM_OUT (activation)" },
  ];
  const results: Result[] = [];
  for (const { alias, model } of aliases()) {
    if (alias === "narrator") {
      const r = await countTokens(key, {
        model,
        system:
          "You write one plain sentence from the facts given. Every number must come from the facts.",
        messages: [
          {
            role: "user",
            content: "Facts: stage SCAN ended DONE with 2 candidates at a cost of 0.12 USDC.",
          },
        ],
      });
      results.push({ alias, model, stage: "narrator entry", ...r });
      continue;
    }
    const reasoning = (REASONING_ALIASES as readonly string[]).includes(alias)
      ? (alias as (typeof REASONING_ALIASES)[number])
      : "research-strong";
    for (const s of stages) {
      const config = cycleConfig(stored, {
        kind: s.kind,
        goalBlock: goal.config.soulBlock,
        canary: "MARKER_DRYRUN_0000",
      });
      const prompt = stagePrompt({
        stage: s.stage,
        kind: s.kind,
        themeCode: s.stage === "DIVE" ? "MON_STAKING_FLOWS" : null,
        caps: stageCaps(s.stage, s.kind),
        ceilingUsdcE6: stageCeilingUsdcE6(s.stage, s.kind, reasoning),
        ...(s.stage === "CHALLENGE" ? { diveThemes: ["MON_STAKING_FLOWS", "USDC_DEPTH"] } : {}),
      });
      const r = await countTokens(key, {
        model,
        system: config.soul,
        tools,
        messages: [{ role: "user", content: prompt }],
      });
      results.push({ alias, model, stage: s.label, ...r });
    }
  }
  const dir = join(ROOT, "evidence", "p0-api");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `dry-run-${stamp}.json`);
  writeFileSync(
    file,
    `${JSON.stringify({ at: new Date().toISOString(), toolsPerServer: perServer, toolCount: tools.length, results }, null, 2)}\n`,
  );
  console.log(
    `tools offered: ${tools.length} (chain ${perServer.chain}, data ${perServer.data}, platform ${perServer.platform})`,
  );
  for (const r of results)
    console.log(
      `${r.status === 200 ? "OK  " : "FAIL"} ${r.alias.padEnd(16)} ${r.model.padEnd(28)} ${r.stage.padEnd(22)} ${
        r.inputTokens !== null
          ? `${r.inputTokens} input tokens`
          : `${r.status} ${r.errorType ?? ""}: ${r.message ?? ""}`
      } ${r.requestId ? `(${r.requestId})` : ""}`,
    );
  console.log(`report: ${file.slice(ROOT.length + 1)}`);
  process.exitCode = results.every((r) => r.status === 200) ? 0 : 1;
}

await main();
