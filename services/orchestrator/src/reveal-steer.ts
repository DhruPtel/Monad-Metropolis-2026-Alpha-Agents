import { randomBytes } from "node:crypto";
import { AGENT_MAX_SUPPLY, SPECIES } from "@alpha-agents/domain";
import { type Hex, encodeAbiParameters, keccak256 } from "viem";

/**
 * Steered reveals on the local fork only (D-221). On the fork the keeper
 * plays Entropy and delivers the random number itself, so it may pick a
 * number under which a chosen agent draws a chosen species. This replays
 * AgentNFT's draw exactly (AgentNFT.sol `_entropyCallback` and `reveal`):
 *
 *   seed    = keccak256(abi.encode(randomNumber, sequence, block.chainid, address(this)))
 *   draw(n) = uint256(keccak256(abi.encode(seed, n))) % remaining
 *
 * with `remaining` starting at MAX_SUPPLY - (next - 1) and each drawn species
 * leaving the deck in mint order. Nothing here touches a chain, and nothing
 * outside the fork's simulated delivery calls it: on testnet and mainnet the
 * number comes from Pyth Entropy and is never chosen by the platform.
 */
export interface BatchContext {
  readonly sequence: bigint;
  readonly chainId: number;
  readonly contract: Hex;
  /** The first agent the batch reveals (AgentNFT's nextToReveal). */
  readonly next: number;
  /** The batch's last agent. */
  readonly last: number;
  /** Slots left per species, index 0 for species 1 (AgentNFT's remainingOf). */
  readonly deck: readonly number[];
}

export function revealSeed(randomNumber: Hex, c: BatchContext): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint64" }, { type: "uint256" }, { type: "address" }],
      [randomNumber, c.sequence, BigInt(c.chainId), c.contract],
    ),
  );
}

/** The species each agent of the batch draws under this number, as the contract would assign them. */
export function simulateBatch(randomNumber: Hex, c: BatchContext): Map<number, number> {
  const seed = revealSeed(randomNumber, c);
  const deck = [...c.deck];
  let remaining = BigInt(AGENT_MAX_SUPPLY - (c.next - 1));
  const out = new Map<number, number>();
  for (let n = c.next; n <= c.last; n += 1) {
    let draw =
      BigInt(
        keccak256(
          encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [seed, BigInt(n)]),
        ),
      ) % remaining;
    let species = 0;
    for (let s = 0; s < deck.length; s += 1) {
      const count = BigInt(deck[s] ?? 0);
      if (draw < count) {
        species = s + 1;
        break;
      }
      draw -= count;
    }
    if (species === 0) throw new Error("the deck is smaller than the remaining count");
    deck[species - 1] = (deck[species - 1] ?? 0) - 1;
    remaining -= 1n;
    out.set(n, species);
  }
  return out;
}

/**
 * A random number under which `agentId` draws `species`, or null when that
 * species has no slot left or none was found within the tries (the caller then
 * delivers an ordinary random number).
 */
export function findRandomNumber(
  target: { readonly agentId: number; readonly species: number },
  c: BatchContext,
  maxTries = 100_000,
  random: () => Hex = () => `0x${randomBytes(32).toString("hex")}`,
): Hex | null {
  if (target.agentId < c.next || target.agentId > c.last) return null;
  if ((c.deck[target.species - 1] ?? 0) <= 0) return null;
  for (let i = 0; i < maxTries; i += 1) {
    const candidate = random();
    if (simulateBatch(candidate, c).get(target.agentId) === target.species) return candidate;
  }
  return null;
}

/** A species index from its slug ("bee"), or null for "random"; throws on anything else. */
export function speciesFromSlug(slug: string): number | null {
  if (slug === "random") return null;
  const s = SPECIES.find((x) => x.slug === slug);
  if (!s) throw new Error(`no species "${slug}"; use a slug such as bee, or random`);
  return s.index;
}

/** Who a steer is aimed at: a wallet's next reveal, or one pending agent. */
export type SteerTarget =
  | { readonly kind: "wallet"; readonly wallet: string }
  | { readonly kind: "agent"; readonly agentId: number; readonly owner: string };

export interface SteerRecord {
  readonly steerId: string;
  readonly target: SteerTarget;
  readonly species: number;
  readonly status: "pending" | "applied" | "failed" | "cancelled";
  readonly appliedAgentId: number | null;
  readonly note: string | null;
  readonly createdAt: Date;
}

export interface SteerOutcome {
  readonly status: "applied" | "failed" | "cancelled";
  readonly agentId?: number;
  readonly note: string;
}

/** Where steers live: Postgres in the orchestrator (`DbSteerStore`), memory in tests. */
export interface SteerStore {
  /** Pending steers for the chain, oldest first. */
  pending(chainId: number): Promise<SteerRecord[]>;
  /** Recent steers of any status, newest first. */
  recent(chainId: number, limit: number): Promise<SteerRecord[]>;
  /** Records a steer; a pending steer for the same target is cancelled first. */
  create(chainId: number, target: SteerTarget, species: number): Promise<SteerRecord>;
  /** Resolves a pending steer; false when it was no longer pending. */
  resolve(steerId: string, outcome: SteerOutcome): Promise<boolean>;
}

/** A batch the keeper is about to reveal, with each agent's current owner. */
export interface SteerBatch {
  readonly next: number;
  readonly last: number;
  /** Lowercase owner per agent ID of the batch. */
  readonly owners: ReadonlyMap<number, string>;
}

export interface SteerChoice {
  readonly agentId: number;
  readonly species: number;
  readonly source: "console" | "first";
  readonly steerId?: string;
}

const lower = (a: string) => a.toLowerCase();

export const sameTarget = (a: SteerTarget, b: SteerTarget): boolean =>
  a.kind === "wallet"
    ? b.kind === "wallet" && lower(a.wallet) === lower(b.wallet)
    : b.kind === "agent" && a.agentId === b.agentId;

/** The agent of the batch a pending steer would apply to, or null if none. */
export function agentForSteer(target: SteerTarget, batch: SteerBatch): number | null {
  if (target.kind === "agent")
    return target.agentId >= batch.next && target.agentId <= batch.last ? target.agentId : null;
  for (let id = batch.next; id <= batch.last; id += 1)
    if (batch.owners.get(id) === lower(target.wallet)) return id;
  return null;
}

/**
 * What the local keeper should steer (D-221): the first reveal on a fresh fork
 * (agent #1) to `firstSpecies`, and any steer the dev console recorded, aimed
 * at a wallet or at one pending agent. Steers live in the store (Postgres in
 * the orchestrator), so a restart keeps them. Local only.
 */
export class RevealSteering {
  readonly firstSpecies: number | null;
  readonly store: SteerStore;
  readonly chainId: number;

  constructor(firstSpecies: number | null, store: SteerStore, chainId: number) {
    this.firstSpecies = firstSpecies;
    this.store = store;
    this.chainId = chainId;
  }

  /**
   * The steer for a batch: the oldest pending steer that names an agent of the
   * batch, else agent #1's first species. Agent steers that can no longer apply
   * (already revealed, or the agent now has another owner, as after a fork
   * reset) are failed here with the reason.
   */
  async targetFor(batch: SteerBatch): Promise<SteerChoice | null> {
    for (const steer of await this.store.pending(this.chainId)) {
      const t = steer.target;
      if (t.kind === "agent" && t.agentId < batch.next) {
        await this.store.resolve(steer.steerId, {
          status: "failed",
          note: `agent #${t.agentId} was already revealed`,
        });
        continue;
      }
      const agentId = agentForSteer(t, batch);
      if (agentId === null) continue;
      if (t.kind === "agent" && batch.owners.get(agentId) !== lower(t.owner)) {
        await this.store.resolve(steer.steerId, {
          status: "failed",
          agentId,
          note: `agent #${agentId} now belongs to another wallet (was the fork reset?)`,
        });
        continue;
      }
      return { agentId, species: steer.species, source: "console", steerId: steer.steerId };
    }
    if (batch.next === 1 && this.firstSpecies !== null)
      return { agentId: 1, species: this.firstSpecies, source: "first" };
    return null;
  }

  /**
   * After the batch's number was delivered: the chosen steer is applied (or
   * failed when no number could give that species), and every other pending
   * steer whose agent was in this batch fails, since that agent is now revealed.
   */
  async settle(choice: SteerChoice, batch: SteerBatch, applied: boolean): Promise<void> {
    if (choice.steerId)
      await this.store.resolve(choice.steerId, {
        status: applied ? "applied" : "failed",
        agentId: choice.agentId,
        note: applied
          ? `agent #${choice.agentId} revealed as the chosen species`
          : `the species has no slot left for agent #${choice.agentId}; it revealed at random`,
      });
    for (const steer of await this.store.pending(this.chainId)) {
      const agentId = agentForSteer(steer.target, batch);
      if (agentId === null) continue;
      await this.store.resolve(steer.steerId, {
        status: "failed",
        agentId,
        note: `agent #${agentId} was revealed in a batch steered for agent #${choice.agentId}`,
      });
    }
  }
}

/** Steers in memory, for tests. */
export class MemorySteerStore implements SteerStore {
  private readonly rows: { chainId: number; record: SteerRecord }[] = [];
  private seq = 0;

  async pending(chainId: number): Promise<SteerRecord[]> {
    return this.rows
      .filter((r) => r.chainId === chainId && r.record.status === "pending")
      .map((r) => r.record);
  }

  async recent(chainId: number, limit: number): Promise<SteerRecord[]> {
    return this.rows
      .filter((r) => r.chainId === chainId)
      .map((r) => r.record)
      .reverse()
      .slice(0, limit);
  }

  async create(chainId: number, target: SteerTarget, species: number): Promise<SteerRecord> {
    for (const r of this.rows)
      if (
        r.chainId === chainId &&
        r.record.status === "pending" &&
        sameTarget(r.record.target, target)
      )
        r.record = { ...r.record, status: "cancelled", note: "replaced by a newer choice" };
    this.seq += 1;
    const record: SteerRecord = {
      steerId: `steer-${this.seq}`,
      target,
      species,
      status: "pending",
      appliedAgentId: null,
      note: null,
      createdAt: new Date(Date.now() + this.seq),
    };
    this.rows.push({ chainId, record });
    return record;
  }

  async resolve(steerId: string, outcome: SteerOutcome): Promise<boolean> {
    const row = this.rows.find((r) => r.record.steerId === steerId);
    if (row?.record.status !== "pending") return false;
    row.record = {
      ...row.record,
      status: outcome.status,
      appliedAgentId: outcome.agentId ?? null,
      note: outcome.note,
    };
    return true;
  }
}

/**
 * The orchestrator's steering for an environment: local only (D-221). Any
 * other environment gets none, whatever the configuration holds; the config
 * loader also refuses to start them with a species set.
 */
export function revealSteeringFor(
  environment: string,
  firstSpeciesSlug: string | undefined,
  store: SteerStore,
  chainId: number,
): RevealSteering | null {
  if (environment !== "local") return null;
  return new RevealSteering(speciesFromSlug(firstSpeciesSlug ?? "bee"), store, chainId);
}
