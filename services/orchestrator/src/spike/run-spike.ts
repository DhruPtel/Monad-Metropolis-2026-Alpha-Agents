/**
 * P1-U1 spike driver: one Hermes run, headless, in an E2B sandbox, end to end.
 *
 *   pnpm spike:hermes            (after pnpm spike:hermes:template once)
 *
 * What it does, in order:
 * 1. Starts Postgres and LiteLLM (compose profile `agent`) and mints a per-agent virtual key.
 * 2. Starts the stub platform tools server and the gate locally, and a Cloudflare quick tunnel
 *    to the gate.
 * 3. Stores the gate secret, the virtual key and the tool token as E2B secrets and creates a
 *    sandbox whose egress is denied except to the tunnel host, with a per-host rule that makes
 *    E2B's egress proxy inject the three headers (Q-04). No credential is passed to the sandbox.
 * 4. Checks egress, the read-only skill mount and TLS through the injector, renders HERMES_HOME,
 *    starts Hermes' API server, runs one stage with an idempotency key, replays the key, and
 *    collects the structured complete_stage result.
 * 5. Exhausts a second key's budget on purpose and records exactly what Hermes does.
 * 6. Downloads the sandbox's writable files and every process environment and scans them for
 *    every credential; writes a redacted report to evidence/p1-u1/; tears everything down.
 *
 * Teardown (tunnel, local servers, E2B secrets, the sandbox) also runs on SIGINT, SIGTERM and
 * after an overall deadline, so an interrupted run leaves nothing behind. Each cleanup step is
 * registered before the resource it removes is created, so a resource that is still being
 * created when the run stops is found by name or by its runTag metadata.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CommandExitError, Sandbox, Secret, SecretError } from "e2b";
import { loadConfig, type Secret as ConfigSecret } from "@alpha-agents/config";
import { CompleteStageOutput, startPlatformTools } from "@alpha-agents/platform-tools";
import {
  GATE_HEADER,
  LLM_KEY_HEADER,
  startGate,
  TOOL_TOKEN_HEADER,
  type GateLogEntry,
} from "./gate.ts";
import { renderHermesFiles, TEMPLATE_NAME } from "./hermes-config.ts";
import { HermesRuns, type HttpCall } from "./hermes-runs.ts";
import { composeUpLiteLLM, LiteLLMAdmin } from "./litellm.ts";
import { assertNoSecrets, scanForSecrets } from "./secret-scan.ts";
import { startTunnel } from "./tunnel.ts";

const ROOT = resolve(import.meta.dirname, "../../../..");
const HH = "/home/user/hermes-home";
const SKILLS = "/opt/agent-skills";
const API_PORT = 8642;
const AGENT_ID = "agent-spike-1";
const MODEL = "scan-cheap";
const DEADLINE_MS = 30 * 60_000;

const random = () => randomBytes(24).toString("hex");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Shell {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function sh(
  sbx: Sandbox,
  cmd: string,
  opts: { user?: "root" | "user"; envs?: Record<string, string>; timeoutMs?: number } = {},
): Promise<Shell> {
  try {
    const r = await sbx.commands.run(cmd, {
      user: opts.user ?? "user",
      timeoutMs: opts.timeoutMs ?? 60_000,
      ...(opts.envs ? { envs: opts.envs } : {}),
    });
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    if (err instanceof CommandExitError) {
      return { exitCode: err.exitCode, stdout: err.stdout, stderr: err.stderr };
    }
    throw err;
  }
}

/** HTTP into the sandbox's own loopback (Hermes' API server), by running curl inside it. */
function sandboxCall(sbx: Sandbox): HttpCall {
  return async (method, url, headers, body) => {
    const bodyPath = `/tmp/req-${randomUUID()}.json`;
    if (body !== undefined) await sbx.files.write(bodyPath, body, { user: "user" });
    const h = Object.entries(headers)
      .map(([k, v]) => `-H ${shq(`${k}: ${v}`)}`)
      .join(" ");
    const data = body === undefined ? "" : `--data-binary @${bodyPath}`;
    const r = await sh(sbx, `curl -s -i -m 30 -X ${method} ${h} ${data} ${shq(url)}`);
    if (body !== undefined) await sh(sbx, `rm -f ${bodyPath}`);
    if (r.exitCode !== 0) throw new Error(`curl in sandbox failed with ${r.exitCode}`);
    const split = r.stdout.indexOf("\r\n\r\n");
    const head = split === -1 ? r.stdout : r.stdout.slice(0, split);
    const lines = head.split("\r\n");
    const status = Number(/^HTTP\/\S+ (\d+)/.exec(lines[0] ?? "")?.[1] ?? 0);
    const replyHeaders: Record<string, string> = {};
    for (const line of lines.slice(1)) {
      const i = line.indexOf(":");
      if (i > 0) replyHeaders[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    return { status, headers: replyHeaders, body: split === -1 ? "" : r.stdout.slice(split + 4) };
  };
}

function findCloudflared(): string {
  const candidates = [process.env.CLOUDFLARED, join(homedir(), ".local/bin/cloudflared")];
  for (const c of candidates) if (c && existsSync(c)) return c;
  const which = spawnSync("which", ["cloudflared"], { encoding: "utf8" });
  if (which.status === 0) return which.stdout.trim();
  throw new Error("cloudflared not found: install it to ~/.local/bin or set CLOUDFLARED");
}

async function main(): Promise<number> {
  const envFile = join(ROOT, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const config = loadConfig({
    name: "Hermes spike",
    requires: ["E2B_API_KEY", "LITELLM_MASTER_KEY", "ANTHROPIC_API_KEY"],
  });
  const reveal = (name: "E2B_API_KEY" | "LITELLM_MASTER_KEY" | "ANTHROPIC_API_KEY") =>
    (config.values[name] as ConfigSecret).reveal();
  const cloudflared = findCloudflared();
  const runTag = `p1u1-${Date.now()}`;
  const report: Record<string, unknown> = { unit: "P1-U1", runTag, template: TEMPLATE_NAME };
  const checks: Record<string, boolean> = {};
  const cleanup: (() => unknown)[] = [];

  const gateSecret = random();
  const toolToken = random();
  const litellmUrl = `http://127.0.0.1:${process.env.LITELLM_PORT ?? "4000"}`;
  const admin = new LiteLLMAdmin(litellmUrl, reveal("LITELLM_MASTER_KEY"));
  const secrets: Record<string, string> = {
    anthropicKey: reveal("ANTHROPIC_API_KEY"),
    litellmMasterKey: reveal("LITELLM_MASTER_KEY"),
    e2bApiKey: reveal("E2B_API_KEY"),
    gateSecret,
    toolToken,
  };

  let tornDown: Promise<void> | undefined;
  /** Runs every cleanup step once, newest first, then writes the redacted report. */
  const teardown = () =>
    (tornDown ??= (async () => {
      for (const fn of cleanup.splice(0).reverse()) {
        try {
          await fn();
        } catch {
          // teardown is best effort; the sandbox also times out on its own
        }
      }
      // LiteLLM error messages name the key by a masked suffix; keep even that out of evidence.
      const text = JSON.stringify(report, null, 2).replace(/sk-\.\.\.\w+/g, "sk-...<masked>");
      assertNoSecrets(text, secrets);
      const dir = join(ROOT, "evidence/p1-u1");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `spike-${new Date().toISOString().replaceAll(":", "-")}.json`);
      writeFileSync(path, `${text}\n`);
      console.log(text);
      console.log(`report: ${path.slice(ROOT.length + 1)} (sha256 ${sha256(text).slice(0, 12)})`);
    })());
  const onSignal = (signal: NodeJS.Signals) => {
    console.error(`${signal}: tearing down (send it again to exit at once)`);
    report.error = `interrupted by ${signal}`;
    report.checks = checks;
    report.passed = false;
    void teardown().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let deadlineTimer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(
      () => reject(new Error(`overall deadline of ${DEADLINE_MS / 60_000} minutes passed`)),
      DEADLINE_MS,
    );
  });

  const spike = async (): Promise<number> => {
    console.log("1/6 LiteLLM");
    composeUpLiteLLM(join(ROOT, "infra/compose.yaml"), envFile);
    await admin.waitReady(180_000);
    const agentKey = await admin.createKey(AGENT_ID, [MODEL], 0.5);
    secrets.agentVirtualKey = agentKey;

    console.log("2/6 tools server, gate, tunnel");
    const tools = await startPlatformTools({ token: toolToken });
    cleanup.push(() => tools.close());
    const gate = await startGate({ gateSecret, litellmUrl, platformToolsUrl: tools.url });
    cleanup.push(() => gate.close());
    const tunnel = await startTunnel(cloudflared, gate.url);
    cleanup.push(() => tunnel.close());
    let tunnelUp = false;
    for (let i = 0; i < 30 && !tunnelUp; i += 1) {
      try {
        const res = await fetch(`${tunnel.url}/healthz`, {
          headers: { [GATE_HEADER]: gateSecret },
        });
        tunnelUp = res.status === 200;
      } catch {
        // DNS for a new quick tunnel takes a few seconds
      }
      if (!tunnelUp) await sleep(2000);
    }
    if (!tunnelUp) throw new Error("the tunnel never answered /healthz from this machine");
    report.tunnel = { host: "<random>.trycloudflare.com", reachableFromHost: true };

    console.log("3/6 E2B secrets and sandbox");
    const names = { gate: `${runTag}-gate`, llm: `${runTag}-llm`, tool: `${runTag}-tool` };
    cleanup.push(async () => {
      for (const n of Object.values(names)) await Secret.destroy(n).catch(() => false);
    });
    // Q-04: E2B Secrets keep the values out of the sandbox's network config as well. A team
    // without them gets 403, and then the transform carries the value itself. Either way E2B's
    // egress proxy adds the headers outside the sandbox, so no value exists inside it.
    let useSecrets = true;
    try {
      await Secret.create(names.gate, gateSecret);
    } catch (err) {
      if (!(err instanceof SecretError) || !err.message.startsWith("403")) throw err;
      useSecrets = false;
    }
    if (useSecrets) {
      await Secret.create(names.llm, agentKey);
      await Secret.create(names.tool, toolToken);
    }
    report.credentialPath = useSecrets ? "e2b-secrets" : "e2b-literal-transform";
    const inject = (name: string, value: string) => (useSecrets ? Secret.fill(name) : value);
    const network = (llmName: string, llmValue: string) => ({
      allowOut: [tunnel.host],
      denyOut: ["0.0.0.0/0"],
      rules: {
        [tunnel.host]: [
          {
            transform: {
              headers: {
                [GATE_HEADER]: inject(names.gate, gateSecret),
                [LLM_KEY_HEADER]: inject(llmName, llmValue),
                [TOOL_TOKEN_HEADER]: inject(names.tool, toolToken),
              },
            },
          },
        ],
      },
    });
    // Killed by metadata, not by handle, so a sandbox still being created is found too.
    cleanup.push(async () => {
      const found = Sandbox.list({ query: { metadata: { runTag } } });
      while (found.hasNext)
        for (const info of await found.nextItems()) await Sandbox.kill(info.sandboxId);
    });
    const created = Date.now();
    const sbx = await Sandbox.create(TEMPLATE_NAME, {
      timeoutMs: 20 * 60_000,
      metadata: { unit: "P1-U1", agent: AGENT_ID, runTag },
      network: network(names.llm, agentKey),
    });
    report.sandbox = { createMs: Date.now() - created };

    console.log("4/6 checks and the run");
    const egress = {
      exampleCom: await sh(sbx, "curl -sS -m 10 -o /dev/null https://example.com"),
      anthropicDirect: await sh(sbx, "curl -sS -m 10 -o /dev/null https://api.anthropic.com"),
      rawIp: await sh(sbx, "curl -sS -m 10 -o /dev/null http://1.1.1.1"),
      tunnelHealth: await sh(
        sbx,
        `curl -sS -m 20 -o /dev/null -w '%{http_code}' https://${tunnel.host}/healthz`,
      ),
      tunnelForged: await sh(
        sbx,
        `curl -sS -m 20 -o /dev/null -w '%{http_code}' -H 'x-alpha-gate: forged-by-the-sandbox' https://${tunnel.host}/healthz`,
      ),
    };
    report.egress = Object.fromEntries(
      Object.entries(egress).map(([k, v]) => [
        k,
        { exitCode: v.exitCode, out: v.stdout.trim(), err: v.stderr.trim().slice(0, 200) },
      ]),
    );
    checks.nonAllowlistedHostsFail =
      egress.exampleCom.exitCode !== 0 &&
      egress.anthropicDirect.exitCode !== 0 &&
      egress.rawIp.exitCode !== 0;
    const injectionWorks = egress.tunnelHealth.stdout.trim() === "200";
    checks.headerInjectionWorks = injectionWorks;
    checks.sandboxCannotForgeGateHeader = egress.tunnelForged.stdout.trim() === "200";
    report.q04 = injectionWorks
      ? "E2B egress header injection works: the gate accepted the sandbox's request with credentials the sandbox never held."
      : "E2B egress header injection did not authenticate the request; see egress.tunnelHealth. The fallback proxy is needed.";
    if (!injectionWorks)
      throw new Error("header injection failed; stopping before the run (see report.q04)");

    // The skill mount: written by root, read-only to the agent user.
    const skillText = readFileSync(
      join(ROOT, "services/orchestrator/spike-skills/spike-stage-report/SKILL.md"),
      "utf8",
    );
    await sbx.files.write(`${SKILLS}/spike-stage-report/SKILL.md`, skillText, { user: "root" });
    await sh(
      sbx,
      `chown -R root:root ${SKILLS} && chmod 555 ${SKILLS} ${SKILLS}/spike-stage-report && chmod 444 ${SKILLS}/spike-stage-report/SKILL.md`,
      { user: "root" },
    );
    const touch = await sh(sbx, `touch ${SKILLS}/new-file`);
    const append = await sh(sbx, `sh -c 'echo x >> ${SKILLS}/spike-stage-report/SKILL.md'`);
    checks.skillMountReadOnly = touch.exitCode !== 0 && append.exitCode !== 0;

    const apiServerKey = random();
    const files = renderHermesFiles({
      gatewayBaseUrl: `https://${tunnel.host}/v1`,
      platformToolsUrl: `https://${tunnel.host}/mcp`,
      agentId: AGENT_ID,
      skillsDir: SKILLS,
      model: MODEL,
      apiServerKey,
      apiServerPort: API_PORT,
    });
    for (const [name, text] of Object.entries(files))
      await sbx.files.write(`${HH}/${name}`, text, { user: "user" });
    await sbx.files.write(`${HH}/.no-bundled-skills`, "", { user: "user" });
    const envs = { HERMES_HOME: HH, HOME: "/home/user" };
    const booted = Date.now();
    await sbx.commands.run(`hermes gateway run > /home/user/gateway.log 2>&1`, {
      background: true,
      user: "user",
      envs,
    });
    const runs = new HermesRuns(`http://127.0.0.1:${API_PORT}`, apiServerKey, sandboxCall(sbx));
    await runs.waitHealthy(180_000);
    (report.sandbox as Record<string, unknown>).hermesBootMs = Date.now() - booted;

    const skillHash = (
      await sh(sbx, `sha256sum ${SKILLS}/spike-stage-report/SKILL.md`)
    ).stdout.split(" ")[0];
    const before = new Set(
      (await sh(sbx, `find ${HH} -type f | sort`)).stdout.split("\n").filter(Boolean),
    );
    await sh(sbx, "touch /tmp/run-marker && sleep 1");

    const idem = `${AGENT_ID}:cycle-1:scan`;
    const input = "Stage: SCAN. Finish this stage using your skills.";
    const started = Date.now();
    const first = await runs.start(idem, input, `${AGENT_ID}-s1`);
    const final = await runs.waitFinished(first.runId, 300_000);
    const replay = await runs.start(idem, input, `${AGENT_ID}-s1`);
    report.run = {
      status: final.status,
      failure: final.failure,
      ms: Date.now() - started,
      output: String(final.raw.output ?? "").slice(0, 200),
      usage: final.raw.usage ?? null,
    };
    report.replay = { sameRun: replay.runId === first.runId, replayedHeader: replay.replayed };
    checks.runCompleted = final.status === "completed";
    checks.idempotentReplay = replay.runId === first.runId;

    const stage = tools.stages[0];
    const parsed = stage ? CompleteStageOutput.safeParse(stage.output) : undefined;
    report.completeStage = {
      calls: tools.stages.length,
      input: stage?.input ?? null,
      outputValid: parsed?.success ?? false,
    };
    checks.completeStageSchemaValid = tools.stages.length >= 1 && parsed?.success === true;
    checks.skillUsed = stage?.input.candidates.some((c) => c.thesisCode === "MARKER_K7Q2") ?? false;

    const after = (await sh(sbx, `find ${HH} -type f | sort`)).stdout.split("\n").filter(Boolean);
    const created_ = after.filter((f) => !before.has(f)).map((f) => f.slice(HH.length + 1));
    const outsideHome = (
      await sh(
        sbx,
        `find / -xdev -newer /tmp/run-marker -type f -not -path '/proc/*' -not -path '${HH}/*' -not -path '/tmp/*' 2>/dev/null | sort`,
        { user: "root" },
      )
    ).stdout
      .split("\n")
      .filter(Boolean);
    const forbidden = created_.filter(
      (f) =>
        f.startsWith("memories/") ||
        f.startsWith("pending/") ||
        (f.startsWith("skills/") && !/^skills\/\.usage\.json(\.lock)?$/.test(f)),
    );
    report.filesWrittenDuringRun = {
      inHermesHome: created_,
      outsideHermesHome: outsideHome,
      forbidden,
    };
    const skillHashAfter = (
      await sh(sbx, `sha256sum ${SKILLS}/spike-stage-report/SKILL.md`)
    ).stdout.split(" ")[0];
    checks.noSkillOrMemoryWrites = forbidden.length === 0 && skillHashAfter === skillHash;

    // LiteLLM writes spend in batches, so a read right after the run can still show zero (L-10).
    const gateCompletions = gate.log.filter((e) => e.path.endsWith("/chat/completions"));
    const served = gateCompletions.filter((e) => e.status === 200).length;
    let spend = await admin.keyInfo(agentKey);
    let logs = await admin.spendLogs(agentKey);
    for (let i = 0; i < 20 && (spend.spend === 0 || logs.length < served); i += 1) {
      await sleep(3000);
      spend = await admin.keyInfo(agentKey);
      logs = await admin.spendLogs(agentKey);
    }
    report.spend = {
      keyAlias: spend.alias,
      spendUsd: spend.spend,
      spendLogRows: logs.length,
      models: [...new Set(logs.map((l) => l.model))],
      gateChatCompletions: gateCompletions.length,
    };
    checks.modelCallsOnAgentKey = spend.spend > 0 && logs.length > 0 && logs.length >= served;

    const rss = await sh(sbx, "ps -o rss= -C hermes,python3.14 | awk '{s+=$1} END {print s}'");
    const du = await sh(sbx, `du -sk ${HH} | cut -f1`);
    report.footprint = {
      rssKb: Number(rss.stdout.trim()) || null,
      hermesHomeKb: Number(du.stdout.trim()) || null,
    };

    console.log("5/6 budget exhaustion");
    const budgetKey = await admin.createKey(`${AGENT_ID}-budget`, [MODEL], 0.0000001);
    secrets.budgetVirtualKey = budgetKey;
    const budgetSecret = `${runTag}-llm-budget`;
    if (useSecrets) {
      cleanup.push(() => Secret.destroy(budgetSecret).catch(() => false));
      await Secret.create(budgetSecret, budgetKey);
    }
    await sbx.updateNetwork(network(budgetSecret, budgetKey));
    await sleep(3000);
    const logMark = gate.log.length;
    const bStarted = Date.now();
    const bRun = await runs.start(`${AGENT_ID}:cycle-2:scan`, input, `${AGENT_ID}-s2`);
    let bFinal;
    try {
      bFinal = await runs.waitFinished(bRun.runId, 300_000);
    } catch (err) {
      bFinal = {
        status: "did-not-finish",
        failure: String(err),
        raw: {} as Record<string, unknown>,
      };
    }
    const bGate: GateLogEntry[] = gate.log.slice(logMark).filter((e) => e.upstream === "litellm");
    report.budgetExhaustion = {
      runStatus: bFinal.status,
      failure: bFinal.failure,
      runRaw: JSON.stringify(bFinal.raw).slice(0, 1500),
      ms: Date.now() - bStarted,
      gatewayCalls: bGate.map((e) => ({
        path: e.path,
        status: e.status,
        errorBody: e.errorBody ?? null,
      })),
      budgetKeySpend: (await admin.keyInfo(budgetKey)).spend,
    };

    console.log("6/6 secret scan of the sandbox");
    await sh(
      sbx,
      `mkdir -p /tmp/scan && (for p in /proc/[0-9]*; do tr '\\0' '\\n' < $p/environ 2>/dev/null; tr '\\0' ' ' < $p/cmdline 2>/dev/null; echo; done) > /tmp/scan/proc.txt; ` +
        `tar czf /var/tmp/scan.tgz --ignore-failed-read /home /root /tmp /etc /var/log /run ${SKILLS} 2>/dev/null; true`,
      { user: "root", timeoutMs: 180_000 },
    );
    const archive = await sbx.files.read("/var/tmp/scan.tgz", { format: "bytes", user: "root" });
    const scanDir = mkdtempSync(join(tmpdir(), "p1u1-scan-"));
    cleanup.push(() => rmSync(scanDir, { recursive: true, force: true }));
    writeFileSync(join(scanDir, "scan.tgz"), archive);
    mkdirSync(join(scanDir, "x"));
    spawnSync("tar", ["xzf", join(scanDir, "scan.tgz"), "-C", join(scanDir, "x")]);
    // /run holds directories with mode 000 (systemd's inaccessible/dir); the scan must read all.
    spawnSync("chmod", ["-R", "u+rwX", join(scanDir, "x")]);
    const hits = scanForSecrets(join(scanDir, "x"), secrets);
    report.secretScan = {
      archiveBytes: archive.byteLength,
      scanned: [
        "/home",
        "/root",
        "/tmp",
        "/etc",
        "/var/log",
        "/run",
        SKILLS,
        "every /proc/*/environ and cmdline",
      ],
      hits,
    };
    checks.noCredentialInSandbox = hits.length === 0;

    report.checks = checks;
    report.passed = Object.values(checks).every(Boolean);
    return report.passed ? 0 : 1;
  };

  try {
    return await Promise.race([spike(), deadline]);
  } catch (err) {
    report.error = String(err instanceof Error ? err.message : err);
    report.checks = checks;
    report.passed = false;
    return 1;
  } finally {
    clearTimeout(deadlineTimer);
    await teardown();
  }
}

// Exit explicitly: after a deadline the abandoned spike() may still hold timers or sockets.
process.exit(await main());
