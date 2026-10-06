import { randomUUID } from "node:crypto";
import type { SandboxProvider } from "./sandbox.ts";
import { type Log, type Redactor, errorText, randomToken, sha256Hex } from "./secrets.ts";
import { type AgentRef, type Lease, LeaseHeldError, type Store } from "./store.ts";

/**
 * Sandbox leases (FINAL_PLAN 4.3.1: one runtime lease per agent, so two
 * sandboxes never act for one agent). Postgres refuses a second active lease
 * for an agent (partial unique index); every lease has an expiry, and the
 * sandbox is created with the same lifetime, so E2B stops it even if this
 * process is killed. The gate token is returned once and only its hash kept.
 */
export interface LeaseGrant {
  readonly lease: Lease;
  /** The per-lease gate token, injected at E2B's egress (D-203). Never stored or logged. */
  readonly gateToken: string;
}

export interface LeaseOptions {
  readonly store: Store;
  readonly provider: SandboxProvider;
  /** The sweep namespace every lease and sandbox is tagged with (for example "local"). */
  readonly namespace: string;
  /** This orchestrator run. */
  readonly runTag: string;
  readonly redactor: Redactor;
  readonly log: Log;
  readonly now?: () => Date;
}

export class LeaseManager {
  private readonly o: LeaseOptions;

  constructor(options: LeaseOptions) {
    this.o = options;
  }

  private now(): Date {
    return this.o.now?.() ?? new Date();
  }

  /** The metadata on every sandbox this namespace starts. */
  sandboxTags(lease: Lease): Record<string, string> {
    return {
      app: "alpha-agents",
      namespace: this.o.namespace,
      runTag: this.o.runTag,
      leaseId: lease.leaseId,
      agent: `${lease.chainId}-${lease.agentId}`,
    };
  }

  /**
   * Grants a lease, or throws LeaseHeldError while the agent holds another.
   * An expired lease for the agent is released first, so a timeout never blocks it.
   */
  async acquire(ref: AgentRef, purpose: string, ttlMs: number): Promise<LeaseGrant> {
    const held = await this.o.store.activeLease(ref);
    if (held && held.expiresAt <= this.now()) await this.release(held.leaseId, "expired");
    else if (held) throw new LeaseHeldError(ref);
    const gateToken = randomToken();
    this.o.redactor.add(gateToken);
    const lease = await this.o.store.insertLease({
      leaseId: randomUUID(),
      ref,
      runTag: this.o.runTag,
      namespace: this.o.namespace,
      purpose,
      gateTokenHash: sha256Hex(gateToken),
      expiresAt: new Date(this.now().getTime() + ttlMs),
    });
    this.o.log(`lease ${lease.leaseId} granted to agent ${ref.agentId} for ${purpose}`);
    return { lease, gateToken };
  }

  /** Milliseconds a lease has left; the sandbox's own timeout is set to this. */
  remainingMs(lease: Lease): number {
    return Math.max(0, lease.expiresAt.getTime() - this.now().getTime());
  }

  async attachSandbox(leaseId: string, sandboxId: string): Promise<void> {
    await this.o.store.setLeaseSandbox(leaseId, sandboxId);
  }

  /**
   * Ends a lease and stops its sandbox. The lease ends first, so its gate token
   * stops working at once; a sandbox that cannot be stopped still dies at its timeout.
   */
  async release(leaseId: string, reason: string): Promise<void> {
    const lease = await this.o.store.lease(leaseId);
    if (!lease) return;
    const ended = await this.o.store.endLease(leaseId, reason);
    const ids = new Set<string>();
    if (lease.sandboxId) ids.add(lease.sandboxId);
    // A sandbox still being created when the lease ended is found by its tag.
    try {
      for (const s of await this.o.provider.list({ app: "alpha-agents", leaseId })) ids.add(s.id);
    } catch (err) {
      this.o.log(
        `listing sandboxes for lease ${leaseId} failed: ${errorText(err, this.o.redactor)}`,
      );
    }
    for (const id of ids) {
      try {
        await this.o.provider.kill(id);
      } catch (err) {
        this.o.log(`stopping sandbox ${id} failed: ${errorText(err, this.o.redactor)}`);
      }
    }
    if (ended) this.o.log(`lease ${leaseId} ended (${reason}); ${ids.size} sandbox stopped`);
  }

  async releaseForAgent(ref: AgentRef, reason: string): Promise<void> {
    const held = await this.o.store.activeLease(ref);
    if (held) await this.release(held.leaseId, reason);
  }

  /** Ends every expired lease in this namespace. Runs on a timer. */
  async reapExpired(): Promise<number> {
    const expired = await this.o.store.activeLeases({
      namespace: this.o.namespace,
      expiredBy: this.now(),
    });
    for (const lease of expired) await this.release(lease.leaseId, "expired");
    return expired.length;
  }
}
