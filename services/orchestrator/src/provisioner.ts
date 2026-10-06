import { randomBytes } from "node:crypto";
import { TIER_IDS, type Tier } from "@alpha-agents/domain";
import { type GatewayAdmin, GatewayError } from "./gateway-admin.ts";
import { DEFAULT_MODEL, type AgentOverrides, renderAgentConfig } from "./hermes/layers.ts";
import type { LeaseManager } from "./leases.ts";
import { type Log, type Redactor, decryptSecret, encryptSecret, errorText } from "./secrets.ts";
import type { AgentRef, Runtime, Store } from "./store.ts";

/**
 * Provisioning on reveal (D-202, D-203): render the agent's configuration,
 * create its LiteLLM virtual key with a starting budget, and record both.
 * Everything runs under the agent's advisory lock, and each external step is
 * checked before it is repeated, so a repeated event, a retried job or a crash
 * between steps never creates a second key or a second record:
 *
 * 1. The key value is generated once per generation and stored (encrypted)
 *    before LiteLLM is called, so a retry reuses it.
 * 2. LiteLLM is asked whether the alias exists before creating it; aliases are
 *    unique in LiteLLM, so a duplicate create is refused there too.
 *
 * Deprovisioning ends the agent's lease, deletes its key and confirms the
 * alias is gone. A reset deprovisions and provisions a new generation.
 */
export interface ProvisionerOptions {
  readonly store: Store;
  readonly gateway: GatewayAdmin;
  readonly leases: LeaseManager;
  readonly namespace: string;
  readonly secret: string;
  readonly redactor: Redactor;
  readonly log: Log;
  /** USD on a new key until credits set budgets (P1-U6). */
  readonly startingBudgetUsd: number;
  readonly overrides?: (ref: AgentRef) => AgentOverrides;
}

export type ProvisionOutcome =
  | { readonly status: "provisioned"; readonly runtime: Runtime }
  | { readonly status: "already"; readonly runtime: Runtime }
  | { readonly status: "skipped"; readonly reason: string };

export const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function keyAliasFor(namespace: string, ref: AgentRef, generation: number): string {
  return `aa-${namespace}-${ref.chainId}-${ref.agentId}-g${generation}`;
}

/** The alias prefix of every key this namespace owns, for the sweep. */
export const aliasPrefix = (namespace: string): string => `aa-${namespace}-`;

const tierName = (tier: number): Tier => {
  const name = TIER_IDS[tier - 1];
  if (!name) throw new Error(`tier ${tier} is not a revealed tier`);
  return name;
};

export class Provisioner {
  private readonly o: ProvisionerOptions;

  constructor(options: ProvisionerOptions) {
    if (!NAMESPACE_PATTERN.test(options.namespace))
      throw new Error(`invalid namespace ${options.namespace}`);
    this.o = options;
  }

  /** Decrypts an agent's virtual key for the gate. Never logged (registered with the redactor). */
  virtualKey(runtime: Runtime): string | null {
    if (runtime.status !== "ready" || !runtime.keyCiphertext) return null;
    const key = decryptSecret(runtime.keyCiphertext, this.o.secret);
    this.o.redactor.add(key);
    return key;
  }

  async provision(ref: AgentRef): Promise<ProvisionOutcome> {
    return this.o.store.withAgentLock(ref, () => this.provisionLocked(ref));
  }

  private async provisionLocked(ref: AgentRef): Promise<ProvisionOutcome> {
    const agent = await this.o.store.indexedAgent(ref);
    if (!agent || agent.species === 0) return { status: "skipped", reason: "not revealed" };
    let runtime = await this.o.store.runtime(ref);
    const matches = runtime && runtime.tier === agent.tier && runtime.species === agent.species;
    if (runtime?.status === "ready" && matches) return { status: "already", runtime };
    if (runtime && runtime.status !== "deprovisioned" && !matches) {
      // A reorg changed the reveal: retire the old generation before the new one.
      await this.deprovisionLocked(ref, "reveal changed");
      runtime = await this.o.store.runtime(ref);
    }

    // Resume an unfinished attempt of the same generation with its stored key.
    const resume =
      runtime && (runtime.status === "provisioning" || runtime.status === "failed") && matches
        ? runtime
        : null;
    const generation = resume ? resume.generation : (runtime?.generation ?? 0) + 1;
    const alias = keyAliasFor(this.o.namespace, ref, generation);
    const key = resume?.keyCiphertext
      ? decryptSecret(resume.keyCiphertext, this.o.secret)
      : `sk-aa-${randomBytes(24).toString("hex")}`;
    this.o.redactor.add(key);

    const { config, hash } = renderAgentConfig(
      {
        chainId: ref.chainId,
        agentId: ref.agentId,
        species: agent.species,
        tier: tierName(agent.tier),
        generation,
      },
      this.o.overrides?.(ref),
    );
    await this.o.store.beginProvisioning({
      ref,
      generation,
      tier: agent.tier,
      species: agent.species,
      config: config as unknown as Record<string, unknown>,
      configHash: hash,
      keyAlias: alias,
      keyCiphertext: encryptSecret(key, this.o.secret),
      budgetUsd: this.o.startingBudgetUsd.toFixed(6),
    });

    try {
      if (!(await this.o.gateway.hasAlias(alias))) {
        try {
          await this.o.gateway.createKey({
            key,
            alias,
            models: [config.hermes.model.default],
            maxBudgetUsd: this.o.startingBudgetUsd,
            metadata: {
              app: "alpha-agents",
              namespace: this.o.namespace,
              chain_id: ref.chainId,
              agent_id: ref.agentId,
              generation,
            },
          });
        } catch (err) {
          // A create whose reply was lost: the alias exists now, and it is ours.
          if (!(err instanceof GatewayError) || !(await this.o.gateway.hasAlias(alias))) throw err;
        }
      }
    } catch (err) {
      const message = errorText(err, this.o.redactor);
      await this.o.store.setRuntimeStatus(ref, "failed", { lastError: message });
      this.o.log(`agent ${ref.agentId}: provisioning failed: ${message}`);
      throw err;
    }
    await this.o.store.setRuntimeStatus(ref, "ready");
    const ready = await this.o.store.runtime(ref);
    if (!ready) throw new Error(`agent ${ref.agentId}: runtime vanished while provisioning`);
    this.o.log(
      `agent ${ref.agentId}: provisioned generation ${generation} (${config.tier.name}, ${config.tier.slots} slots, ${config.tier.playbook.version}, config ${hash.slice(0, 12)})`,
    );
    return { status: "provisioned", runtime: ready };
  }

  async deprovision(ref: AgentRef, reason: string): Promise<boolean> {
    return this.o.store.withAgentLock(ref, () => this.deprovisionLocked(ref, reason));
  }

  private async deprovisionLocked(ref: AgentRef, reason: string): Promise<boolean> {
    const runtime = await this.o.store.runtime(ref);
    if (!runtime || runtime.status === "deprovisioned") return false;
    await this.o.store.setRuntimeStatus(ref, "deprovisioning");
    await this.o.leases.releaseForAgent(ref, `deprovisioned: ${reason}`);
    await this.o.gateway.deleteAliases([runtime.keyAlias]);
    if (await this.o.gateway.hasAlias(runtime.keyAlias))
      throw new Error(`agent ${ref.agentId}: key ${runtime.keyAlias} still exists after delete`);
    await this.o.store.setRuntimeStatus(ref, "deprovisioned", { clearKey: true });
    this.o.log(`agent ${ref.agentId}: deprovisioned generation ${runtime.generation} (${reason})`);
    return true;
  }

  /** The dev console's reset (D-205): a new generation with a new key and a fresh config. */
  async reset(ref: AgentRef): Promise<ProvisionOutcome> {
    return this.o.store.withAgentLock(ref, async () => {
      await this.deprovisionLocked(ref, "reset");
      return this.provisionLocked(ref);
    });
  }
}

export { DEFAULT_MODEL };
