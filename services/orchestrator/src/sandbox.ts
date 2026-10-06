import { CommandExitError, Sandbox } from "e2b";

/**
 * Sandboxes behind an interface: E2B in the running service, an in-memory
 * provider in tests. Every sandbox carries metadata with the sweep namespace
 * and the run tag (L-19), and a hard timeout set at creation, so a sandbox
 * outlives a crashed orchestrator by at most its lease.
 */
export interface Shell {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SandboxSpec {
  readonly template: string;
  readonly timeoutMs: number;
  readonly metadata: Readonly<Record<string, string>>;
  /** The only host the sandbox may reach (the gate's tunnel host). */
  readonly allowHost: string;
  /** Headers E2B's egress proxy adds on the way to allowHost, outside the sandbox (D-203). */
  readonly injectHeaders: Readonly<Record<string, string>>;
}

export interface SandboxHandle {
  readonly id: string;
  run(
    cmd: string,
    opts?: { user?: "root" | "user"; envs?: Record<string, string>; timeoutMs?: number },
  ): Promise<Shell>;
  /** Starts a long-running command and returns at once. */
  spawn(
    cmd: string,
    opts: { user?: "root" | "user"; envs?: Record<string, string> },
  ): Promise<void>;
  writeFile(path: string, content: string, user: "root" | "user"): Promise<void>;
}

export interface SandboxInfo {
  readonly id: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface SandboxProvider {
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  kill(id: string): Promise<void>;
  /** Sandboxes whose metadata includes every given pair. */
  list(metadata: Readonly<Record<string, string>>): Promise<SandboxInfo[]>;
}

/** The E2B template built from infra/e2b/hermes.Dockerfile (P1-U1), named for the Hermes commit. */
export const HERMES_TEMPLATE = "alpha-agents-hermes-085d9ee";

export class E2BProvider implements SandboxProvider {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const sbx = await Sandbox.create(spec.template, {
      apiKey: this.apiKey,
      timeoutMs: spec.timeoutMs,
      metadata: { ...spec.metadata },
      network: {
        allowOut: [spec.allowHost],
        denyOut: ["0.0.0.0/0"],
        // A literal value: E2B Secrets return 403 for this team (L-16, D-164).
        rules: { [spec.allowHost]: [{ transform: { headers: { ...spec.injectHeaders } } }] },
      },
    });
    return {
      id: sbx.sandboxId,
      async run(cmd, opts = {}) {
        try {
          const r = await sbx.commands.run(cmd, {
            user: opts.user ?? "user",
            timeoutMs: opts.timeoutMs ?? 60_000,
            ...(opts.envs ? { envs: opts.envs } : {}),
          });
          return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
        } catch (err) {
          if (err instanceof CommandExitError)
            return { exitCode: err.exitCode, stdout: err.stdout, stderr: err.stderr };
          throw err;
        }
      },
      async spawn(cmd, opts) {
        await sbx.commands.run(cmd, {
          background: true,
          user: opts.user ?? "user",
          ...(opts.envs ? { envs: opts.envs } : {}),
        });
      },
      async writeFile(path, content, user) {
        await sbx.files.write(path, content, { user });
      },
    };
  }

  async kill(id: string): Promise<void> {
    await Sandbox.kill(id, { apiKey: this.apiKey });
  }

  async list(metadata: Readonly<Record<string, string>>): Promise<SandboxInfo[]> {
    const out: SandboxInfo[] = [];
    const pages = Sandbox.list({ apiKey: this.apiKey, query: { metadata: { ...metadata } } });
    while (pages.hasNext)
      for (const info of await pages.nextItems())
        out.push({ id: info.sandboxId, metadata: info.metadata ?? {} });
    return out;
  }
}

/** Sandboxes as records, for tests: create, kill and list behave like E2B's. */
export class MemoryProvider implements SandboxProvider {
  readonly sandboxes = new Map<string, { spec: SandboxSpec; files: Map<string, string> }>();
  readonly killed: string[] = [];
  private next = 1;
  /** Answers for commands run inside a sandbox; the default succeeds with no output. */
  onRun: (cmd: string) => Shell = () => ({ exitCode: 0, stdout: "", stderr: "" });

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const id = `mem-${this.next++}`;
    const files = new Map<string, string>();
    this.sandboxes.set(id, { spec, files });
    const onRun = (cmd: string) => this.onRun(cmd);
    return {
      id,
      run: async (cmd) => onRun(cmd),
      spawn: async (cmd) => void onRun(cmd),
      writeFile: async (path, content) => void files.set(path, content),
    };
  }

  async kill(id: string): Promise<void> {
    if (this.sandboxes.delete(id)) this.killed.push(id);
  }

  async list(metadata: Readonly<Record<string, string>>): Promise<SandboxInfo[]> {
    return [...this.sandboxes.entries()]
      .filter(([, s]) => Object.entries(metadata).every(([k, v]) => s.spec.metadata[k] === v))
      .map(([id, s]) => ({ id, metadata: s.spec.metadata }));
  }
}
