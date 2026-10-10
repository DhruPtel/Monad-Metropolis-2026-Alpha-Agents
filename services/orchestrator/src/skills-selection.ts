import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadBuiltinSet } from "@alpha-agents/skills/packages";

/**
 * The skill selection check (P3-U7, spike Q-07 / B-02, a launch gate):
 * `pnpm test:skills:selection`. Hermes selects skills only from its index,
 * one line per skill with the description cut at 57 characters, under a
 * preamble that tells the model to load any matching skill with skill_view.
 * This reproduces that index and preamble exactly, gives the model each
 * stage's task (and tasks for each skill, and one that needs none) without
 * naming a skill, and records which skills it loads, three times per case on
 * the Scan model and the reasoning model. It also measures the index's size in
 * tokens (H-30). Through LiteLLM; costs a few cents. Writes evidence/p3-u7/.
 */
const ROOT = resolve(import.meta.dirname, "../../..");
process.loadEnvFile(join(ROOT, ".env"));
const base = process.env.LITELLM_BASE_URL ?? "http://127.0.0.1:4000";
const key = process.env.LITELLM_MASTER_KEY ?? "";
const REPEATS = 3;
const MODELS = ["scan-cheap", "research-strong"] as const;

const set = loadBuiltinSet();
/** Hermes' index line: the description is cut at 57 characters plus "..." when it is longer than 60. */
const indexLine = (name: string, d: string) =>
  `    - ${name}: ${d.length > 60 ? `${d.slice(0, 57)}...` : d}`;
const INDEX = [
  "## Skills",
  "Before replying, scan the skills below. If a skill matches or is even partially relevant to your task, you MUST load it with skill_view(name) and follow its instructions.",
  ...set.packages.map((p) => indexLine(p.hermesName, p.manifest.description.model)),
].join("\n");

const SYSTEM = [
  "You are an Alpha Agent: an onchain financial agent on Monad for a portfolio of USDC and WMON.",
  "You research and propose; the platform's runner makes trades from the owner's plan.",
  "",
  INDEX,
].join("\n");

interface Case {
  readonly name: string;
  readonly task: string;
  /** At least one of these must be loaded (empty: none should be). */
  readonly expect: readonly string[];
  readonly forbid?: readonly string[];
}

const CASES: readonly Case[] = [
  {
    name: "scan-stage",
    task: "SCAN stage. Look over the market for Monad and MON now and flag what changed and what deserves deeper research.",
    expect: ["aa-playbook-scan"],
  },
  {
    name: "dive-stage",
    task: "DIVE stage on the theme MON_VOL_SPIKE: MON's 24-hour volatility rose sharply. Work out what is behind it and what it implies.",
    expect: ["aa-playbook-dive"],
  },
  {
    name: "challenge-stage",
    task: "CHALLENGE stage. Here is a thesis from the last Dive: 'Monad DEX volume keeps rising for 5 days as a new lending market draws liquidity.' Review it.",
    expect: ["aa-playbook-challenge"],
  },
  {
    name: "zoom-out-stage",
    task: "ZOOM OUT stage. Given the latest research, decide whether the owner's plan should change.",
    expect: ["aa-playbook-zoom-out"],
  },
  {
    name: "raw-amounts",
    task: "A contract read returned totalSupply 248874271770783 for USDC. How many USDC is that?",
    expect: ["aa-monad-assets-basics"],
  },
  {
    name: "trade-cost",
    task: "What would buying 1,000 USD of MON on the trading venue cost in price impact right now?",
    expect: ["aa-uniswap-v4-swap"],
  },
  {
    name: "regime",
    task: "Is Monad DeFi risk-on or risk-off this week, judging by TVL, yields and DEX volume?",
    expect: ["aa-defi-regime-read"],
  },
  {
    name: "narratives",
    task: "What are people on X saying about Monad today, and is the attention growing or fading?",
    expect: ["aa-narrative-and-flow-tracker"],
  },
  {
    name: "deep-research",
    task: "Check whether the claim that a large Monad protocol was exploited yesterday is true, using several sources.",
    expect: ["aa-deep-dive-research", "aa-playbook-dive"],
  },
  {
    name: "plan-parameters",
    task: "Should the plan's volatility brake or band width be different given MON's recent volatility?",
    expect: ["aa-usdc-wmon-band-rebalancer", "aa-playbook-zoom-out"],
  },
  // F-U8: the two skills added with research v2.
  {
    name: "token-screen",
    task: "screen_token answered REFUSED for a token with OWNER_POWERS failed and LIQUIDITY skipped. What does that mean for holding it?",
    expect: ["aa-token-risk-screen"],
  },
  {
    name: "portfolio-draft",
    task: "ZOOM OUT stage. Two theses stand: WBTC at a fair weight of 15% and a mid cap at 8%. Draft the target portfolio with cash, bands and exits inside a Balanced envelope.",
    expect: ["aa-portfolio-construction", "aa-playbook-zoom-out"],
  },
  {
    name: "scan-not-dive",
    task: "SCAN stage. Keep it broad and cheap.",
    expect: ["aa-playbook-scan"],
    forbid: ["aa-playbook-dive"],
  },
  // The first version of this case gave no thesis; the Scan model rightly asked for one instead of loading anything.
  {
    name: "challenge-not-dive",
    task: "CHALLENGE stage: you are the skeptic. The Dive's thesis: 'MON's 24-hour volatility stays above 150% for the next 5 days.' Try to break it.",
    expect: ["aa-playbook-challenge"],
    forbid: ["aa-playbook-dive"],
  },
  { name: "none-needed", task: "Reply with the single word ready.", expect: [] },
];

const TOOLS = [
  {
    type: "function",
    function: {
      name: "skill_view",
      description: "Load a skill's full instructions by name.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
  },
];

async function complete(model: string, system: string, user: string, withTools = true) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...(withTools ? { tools: TOOLS, tool_choice: "auto" } : {}),
    }),
  });
  if (!res.ok) throw new Error(`LiteLLM answered ${res.status}`);
  return (await res.json()) as {
    usage?: { prompt_tokens?: number };
    choices: { message: { tool_calls?: { function: { name: string; arguments: string } }[] } }[];
  };
}

const results: { model: string; case: string; loaded: string[][]; pass: boolean }[] = [];
for (const model of MODELS) {
  for (const c of CASES) {
    const loaded: string[][] = [];
    for (let i = 0; i < REPEATS; i += 1) {
      const r = await complete(model, SYSTEM, c.task);
      loaded.push(
        (r.choices[0]?.message.tool_calls ?? [])
          .filter((t) => t.function.name === "skill_view")
          .map((t) => {
            try {
              return String((JSON.parse(t.function.arguments) as { name?: unknown }).name ?? "");
            } catch {
              return "";
            }
          }),
      );
    }
    const ok = (names: string[]) =>
      (c.expect.length === 0 ? names.length === 0 : c.expect.some((e) => names.includes(e))) &&
      !(c.forbid ?? []).some((f) => names.includes(f));
    const pass = loaded.every(ok);
    results.push({ model, case: c.name, loaded, pass });
    console.log(
      `${pass ? "PASS" : "FAIL"}  ${model.padEnd(16)} ${c.name.padEnd(20)} ${loaded.map((l) => l.join("+") || "none").join(" | ")}`,
    );
  }
}

// H-30: the index's cost in tokens, as the prompt token difference with and without it.
const withIndex = await complete("scan-cheap", SYSTEM, "Reply with ok.", false);
const without = await complete(
  "scan-cheap",
  SYSTEM.slice(0, SYSTEM.indexOf("## Skills")),
  "Reply with ok.",
  false,
);
const indexTokens = (withIndex.usage?.prompt_tokens ?? 0) - (without.usage?.prompt_tokens ?? 0);
console.log(
  `H-30: the index of ${set.packages.length} skills and playbooks is ${INDEX.length} characters, ${indexTokens} prompt tokens on scan-cheap`,
);

const passed = results.filter((r) => r.pass).length;
const report = {
  unit: "P3-U7",
  check: "skill selection (Q-07, B-02), from descriptions only, as Hermes indexes them",
  at: new Date().toISOString(),
  setHash: set.setHash,
  index: INDEX,
  indexChars: INDEX.length,
  indexTokens,
  repeats: REPEATS,
  results,
  passed,
  total: results.length,
};
const dir = join(ROOT, "evidence", "p3-u7");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "selection.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `${passed} of ${results.length} cases passed on every repeat; report: evidence/p3-u7/selection.json`,
);
if (passed !== results.length) process.exitCode = 1;
