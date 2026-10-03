/**
 * Local smoke test for the spike plumbing, with no credentials and no cloud: the pinned Hermes
 * from clones/hermes-agent runs headless on this machine against a scripted mock model, the
 * stub platform tools server and the real gate. A local injector plays E2B's egress proxy by
 * adding the gate headers. It proves the rendered config, the MCP wiring, skill loading and the
 * /v1/runs flow; it proves nothing about E2B, LiteLLM or a real model (run-spike.ts does).
 *
 *   node services/orchestrator/src/spike/local-smoke.ts
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startPlatformTools } from "@alpha-agents/platform-tools";
import { GATE_HEADER, LLM_KEY_HEADER, startGate, TOOL_TOKEN_HEADER } from "./gate.ts";
import { renderHermesFiles } from "./hermes-config.ts";
import { HermesRuns } from "./hermes-runs.ts";
import { startMockModel } from "./mock-model.ts";

const ROOT = resolve(import.meta.dirname, "../../../..");
const HERMES_BIN = join(ROOT, "clones/hermes-agent/.venv/bin/hermes");
const SKILLS_SRC = join(ROOT, "services/orchestrator/spike-skills");
const secret = () => randomBytes(24).toString("hex");
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Every file under a directory, relative, sorted. */
function listFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath, d.name).slice(dir.length + 1))
    .sort();
}

async function main() {
  const gateSecret = secret();
  const toolToken = secret();
  const llmKey = `sk-local-${secret()}`;
  const tools = await startPlatformTools({ token: toolToken });
  const model = await startMockModel();
  const gate = await startGate({ gateSecret, litellmUrl: model.url, platformToolsUrl: tools.url });

  // Plays E2B's egress proxy: adds the three headers outside "the sandbox", then forwards.
  const injector = createServer((req, res) => {
    const target = new URL(req.url ?? "/", gate.url);
    const up = httpRequest(
      target,
      {
        method: req.method,
        headers: {
          ...req.headers,
          host: target.host,
          [GATE_HEADER]: gateSecret,
          [LLM_KEY_HEADER]: llmKey,
          [TOOL_TOKEN_HEADER]: toolToken,
        },
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    req.pipe(up);
  });
  await new Promise<void>((r) => injector.listen(0, "127.0.0.1", r));
  const injectorUrl = `http://127.0.0.1:${(injector.address() as AddressInfo).port}`;

  const work = mkdtempSync(join(tmpdir(), "p1u1-smoke-"));
  const home = join(work, "hermes-home");
  const skills = join(work, "agent-skills");
  mkdirSync(home);
  writeFileSync(join(home, ".no-bundled-skills"), "");
  cpSync(SKILLS_SRC, skills, { recursive: true });
  for (const p of [
    join(skills, "spike-stage-report/SKILL.md"),
    join(skills, "spike-stage-report"),
    skills,
  ]) {
    chmodSync(p, p.endsWith(".md") ? 0o444 : 0o555);
  }
  const apiServerKey = secret();
  const port = 18642;
  const files = renderHermesFiles({
    gatewayBaseUrl: `${injectorUrl}/v1`,
    platformToolsUrl: `${injectorUrl}/mcp`,
    agentId: "agent-local-smoke",
    skillsDir: skills,
    model: "scan-cheap",
    apiServerKey,
    apiServerPort: port,
  });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(home, name), text);

  const hermes = spawn(HERMES_BIN, ["gateway", "run"], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: work, HERMES_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  hermes.stdout.on("data", (c: Buffer) => (output += c.toString()));
  hermes.stderr.on("data", (c: Buffer) => (output += c.toString()));

  const runs = new HermesRuns(`http://127.0.0.1:${port}`, apiServerKey);
  try {
    await runs.waitHealthy(60_000);
    const skillFile = join(skills, "spike-stage-report/SKILL.md");
    const skillHashBefore = sha(skillFile);
    const before = new Set(listFiles(home));
    const idem = "agent-local-smoke:cycle-1:scan";
    const input = "Stage: SCAN. Finish this stage using your skills.";
    const first = await runs.start(idem, input, "smoke-session-1");
    const final = await runs.waitFinished(first.runId, 120_000);
    const replay = await runs.start(idem, input, "smoke-session-1");
    console.log(
      JSON.stringify(
        {
          run: { id: first.runId, status: final.status, failure: final.failure },
          replay: { sameRun: replay.runId === first.runId, replayedHeader: replay.replayed },
          stagesRecorded: tools.stages.map((s) => s.input),
          modelRequests: model.requests.length,
          modelAuthorization: [...new Set(model.requests.map((r) => r.authorization))],
          toolsOffered: model.requests[0]?.tools,
          gateLog: gate.log.map((e) => `${e.method} ${e.path} ${e.status} ${e.upstream}`),
          toolResults: model.requests.at(-1)?.toolResults,
          skillUnchanged: sha(skillFile) === skillHashBefore,
          filesCreatedDuringRun: listFiles(home).filter((f) => !before.has(f)),
        },
        null,
        2,
      ),
    );
  } catch (err) {
    console.error(String(err));
    console.error(output.slice(-4000));
    process.exitCode = 1;
  } finally {
    hermes.kill("SIGTERM");
    await Promise.all([tools.close(), model.close(), gate.close()]);
    injector.close();
  }
}

await main();
