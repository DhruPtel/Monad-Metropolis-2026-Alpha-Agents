import type { Gate } from "./gate.ts";
import { GATE_HEADER } from "./gate.ts";
import { API_SERVER_PORT, HERMES_HOME, materialize } from "./hermes/materialize.ts";
import { EQUIPPED_DIR, PLAYBOOKS_DIR, SKILLS_ROOT, WORKSPACE_DIR } from "./hermes/schema.ts";
import type { AgentConfig } from "./hermes/schema.ts";
import type { LeaseManager } from "./leases.ts";
import type { SandboxHandle, SandboxProvider } from "./sandbox.ts";
import { type Log, type Redactor, errorText, randomToken } from "./secrets.ts";
import { HermesRuns, type HttpCall } from "./spike/hermes-runs.ts";
import type { AgentRef, Store } from "./store.ts";

/**
 * The dev console's no-op task (P0-U4 extension point): start the agent's
 * sandbox under a lease, run one trivial Hermes task through the gate and
 * LiteLLM, return a structured result, and stop the sandbox. It proves the
 * whole path an agent cycle will use, with nothing an agent can act on.
 */
export const NOOP_PROMPT =
  "This is a platform health check. Do not call any tools. Reply with exactly one word: NOOP_OK";
export const NOOP_LEASE_MS = 10 * 60_000;

export interface NoopResult extends Record<string, unknown> {
  readonly kind: "noop";
  readonly agentId: number;
  readonly generation: number;
  readonly tier: string;
  readonly slots: number;
  readonly playbook: string;
  readonly configHash: string;
  readonly leaseId: string;
  readonly sandboxId: string;
  readonly runId: string;
  readonly runStatus: string;
  readonly replied: string;
  readonly answeredNoopOk: boolean;
  /** Model calls the gate forwarded to LiteLLM for this lease, and how many succeeded. */
  readonly modelCalls: number;
  readonly modelCallsOk: number;
  /** Model calls the gate refused with 402 because credits ran out (P1-U6, D-209). */
  readonly modelCallsRefusedForCredits: number;
  /** "billing" when the run ended because credits ran out. */
  readonly stopReason: "completed" | "billing" | "failed";
  /** Each request the gate forwarded or refused, in order: method, path and status, nothing else. */
  readonly gatedCalls: readonly string[];
  readonly sandboxStopped: boolean;
  readonly timingsMs: {
    readonly sandbox: number;
    readonly hermesBoot: number;
    readonly run: number;
    readonly total: number;
  };
}

export interface TaskContext {
  readonly store: Store;
  readonly leases: LeaseManager;
  readonly provider: SandboxProvider;
  readonly template: string;
  /** Starts the gate's tunnel if needed and returns its public host. */
  readonly tunnelHost: () => Promise<string>;
  readonly gate: Gate;
  readonly redactor: Redactor;
  readonly log: Log;
}

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** HTTP into the sandbox's own loopback (Hermes' API server), by running curl inside it. */
function sandboxCall(sbx: SandboxHandle): HttpCall {
  let n = 0;
  return async (method, url, headers, body) => {
    const bodyPath = `/tmp/req-${(n += 1)}.json`;
    if (body !== undefined) await sbx.writeFile(bodyPath, body, "user");
    const h = Object.entries(headers)
      .map(([k, v]) => `-H ${shq(`${k}: ${v}`)}`)
      .join(" ");
    const data = body === undefined ? "" : `--data-binary @${bodyPath}`;
    const r = await sbx.run(`curl -s -i -m 30 -X ${method} ${h} ${data} ${shq(url)}`);
    if (body !== undefined) await sbx.run(`rm -f ${bodyPath}`);
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

async function must(sbx: SandboxHandle, cmd: string, user: "root" | "user" = "user") {
  const r = await sbx.run(cmd, { user });
  if (r.exitCode !== 0)
    throw new Error(`sandbox setup failed (${r.exitCode}): ${cmd.slice(0, 80)}`);
}

/** Writes the agent's files and the read-only skill mount, then starts Hermes' API server. */
export async function bootHermes(
  sbx: SandboxHandle,
  config: AgentConfig,
  /** The gate as the sandbox sees it: the model under /v1, the tool servers under /mcp. */
  gateOrigin: string,
  redactor: Redactor,
): Promise<HermesRuns> {
  const apiServerKey = randomToken();
  redactor.add(apiServerKey);
  const files = materialize(config, {
    gatewayBaseUrl: `${gateOrigin}/v1`,
    toolsOrigin: gateOrigin,
    apiServerKey,
  });
  await must(
    sbx,
    `mkdir -p ${PLAYBOOKS_DIR} ${EQUIPPED_DIR} ${WORKSPACE_DIR} && chown user:user ${WORKSPACE_DIR}`,
    "root",
  );
  for (const [path, text] of Object.entries(files.playbooks))
    await sbx.writeFile(path, text, "root");
  // The skill mount is root-owned and read-only to the agent's user (FINAL_PLAN 4.3.2).
  await must(
    sbx,
    `chown -R root:root ${SKILLS_ROOT} && find ${SKILLS_ROOT} -type d -exec chmod 555 {} + && find ${SKILLS_ROOT} -type f -exec chmod 444 {} +`,
    "root",
  );
  for (const [name, text] of Object.entries(files.home))
    await sbx.writeFile(`${HERMES_HOME}/${name}`, text, "user");
  await sbx.spawn(`hermes gateway run > /home/user/gateway.log 2>&1`, {
    user: "user",
    envs: { HERMES_HOME, HOME: "/home/user" },
  });
  return new HermesRuns(`http://127.0.0.1:${API_SERVER_PORT}`, apiServerKey, sandboxCall(sbx));
}

export async function runNoopTask(ctx: TaskContext, taskId: string): Promise<void> {
  const task = await ctx.store.task(taskId);
  if (!task || !(await ctx.store.startTask(taskId))) return;
  const ref: AgentRef = { chainId: task.chainId, agentId: task.agentId };
  const started = Date.now();
  let leaseId: string | null = null;
  try {
    const runtime = await ctx.store.runtime(ref);
    if (runtime?.status !== "ready") throw new Error(`agent ${ref.agentId} is not provisioned`);
    const config = runtime.config as unknown as AgentConfig;
    const grant = await ctx.leases.acquire(ref, "noop", NOOP_LEASE_MS);
    leaseId = grant.lease.leaseId;
    await ctx.store.setTaskLease(taskId, leaseId);
    const host = await ctx.tunnelHost();

    const t0 = Date.now();
    const sbx = await ctx.provider.create({
      template: ctx.template,
      timeoutMs: ctx.leases.remainingMs(grant.lease),
      metadata: ctx.leases.sandboxTags(grant.lease),
      allowHost: host,
      injectHeaders: { [GATE_HEADER]: grant.gateToken },
    });
    await ctx.leases.attachSandbox(leaseId, sbx.id);
    const sandboxMs = Date.now() - t0;
    ctx.log(`task ${taskId}: sandbox ${sbx.id} started for agent ${ref.agentId}`);

    const t1 = Date.now();
    const runs = await bootHermes(sbx, config, `https://${host}`, ctx.redactor);
    await runs.waitHealthy(180_000);
    const bootMs = Date.now() - t1;

    const t2 = Date.now();
    const agent = `${ref.chainId}-${ref.agentId}`;
    const run = await runs.start(`${agent}:noop:${taskId}`, NOOP_PROMPT, `${agent}-noop-${taskId}`);
    const final = await runs.waitFinished(run.runId, 240_000);
    const runMs = Date.now() - t2;
    const replied = String(final.raw.output ?? final.raw.final_response ?? "").trim();

    await ctx.leases.release(leaseId, "task finished");
    const lease = await ctx.store.lease(leaseId);
    const calls = ctx.gate.callsFor(leaseId);
    const result: NoopResult = {
      kind: "noop",
      agentId: ref.agentId,
      generation: config.agent.generation,
      tier: config.tier.name,
      slots: config.tier.slots,
      playbook: config.tier.playbook.version,
      configHash: runtime.configHash,
      leaseId,
      sandboxId: sbx.id,
      runId: run.runId,
      runStatus: final.status,
      replied: ctx.redactor.redact(replied).slice(0, 200),
      answeredNoopOk: /\bNOOP_OK\b/.test(replied),
      modelCalls: calls.length,
      modelCallsOk: calls.filter((c) => c.status === 200).length,
      modelCallsRefusedForCredits: calls.filter((c) => c.status === 402).length,
      gatedCalls: calls.map((c) => `${c.method} ${c.path} ${c.status}`),
      stopReason:
        final.status === "completed"
          ? "completed"
          : calls.some((c) => c.status === 402)
            ? "billing"
            : "failed",
      sandboxStopped: lease?.status === "ended",
      timingsMs: {
        sandbox: sandboxMs,
        hermesBoot: bootMs,
        run: runMs,
        total: Date.now() - started,
      },
    };
    if (result.stopReason === "billing") {
      const n = result.modelCallsRefusedForCredits;
      await ctx.store.finishTask(taskId, {
        error: `billing: the agent's credits ran out; the gate refused ${n} model call${n === 1 ? "" : "s"} with 402 and the run ended ${final.status}`,
        result,
      });
    } else if (final.status !== "completed") {
      await ctx.store.finishTask(taskId, {
        error: `the Hermes run ended ${final.status}: ${ctx.redactor.redact(String(final.failure ?? "")).slice(0, 200)}`,
        result,
      });
    } else {
      await ctx.store.finishTask(taskId, { result });
    }
    ctx.log(
      `task ${taskId}: ${final.status}, ${result.modelCalls} model calls, sandbox stopped in ${result.timingsMs.total} ms`,
    );
  } catch (err) {
    const message = errorText(err, ctx.redactor);
    if (leaseId) await ctx.leases.release(leaseId, "task failed");
    await ctx.store.finishTask(taskId, { error: message });
    ctx.log(`task ${taskId}: failed: ${message}`);
  }
}
