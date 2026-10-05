import { speciesByIndex } from "@alpha-agents/domain";
import type { AgentTable } from "@alpha-agents/db";

/**
 * The agents projection: what AgentNFT's events say about each agent. Pure, so
 * the same code applies a new range incrementally and rebuilds everything
 * after a reorg (P1-U4).
 */
export interface DecodedEvent {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly txHash: string;
  readonly logIndex: number;
}

export interface AgentDraft {
  agentId: number;
  owner: string | null;
  tba: string | null;
  species: number;
  tier: number;
  ownerEpoch: number;
  mintedBlock: number | null;
  mintedTx: string | null;
  blockNumber: number;
  blockHash: string;
}

const TIER_CODE = { base: 1, medium: 2, pro: 3 } as const;
const lower = (v: unknown) => String(v).toLowerCase();
const num = (v: unknown) => Number(v as bigint | number | string);

function draftFor(map: Map<number, AgentDraft>, agentId: number, e: DecodedEvent): AgentDraft {
  let draft = map.get(agentId);
  if (!draft) {
    draft = {
      agentId,
      owner: null,
      tba: null,
      species: 0,
      tier: 0,
      ownerEpoch: 0,
      mintedBlock: null,
      mintedTx: null,
      blockNumber: e.blockNumber,
      blockHash: e.blockHash,
    };
    map.set(agentId, draft);
  }
  return draft;
}

/** Applies events, in chain order, to the drafts; returns the agent IDs it changed. */
export function applyEvents(
  map: Map<number, AgentDraft>,
  events: readonly DecodedEvent[],
): Set<number> {
  const changed = new Set<number>();
  for (const e of events) {
    let draft: AgentDraft;
    switch (e.name) {
      case "AgentMinted":
        draft = draftFor(map, num(e.args.agentId), e);
        draft.owner = lower(e.args.owner);
        draft.tba = lower(e.args.tba);
        draft.mintedBlock = e.blockNumber;
        draft.mintedTx = e.txHash;
        break;
      case "Transfer":
        draft = draftFor(map, num(e.args.tokenId), e);
        draft.owner = lower(e.args.to);
        break;
      case "OwnerEpochBumped":
        draft = draftFor(map, num(e.args.agentId), e);
        draft.ownerEpoch = num(e.args.epoch);
        break;
      case "AgentRevealed": {
        draft = draftFor(map, num(e.args.agentId), e);
        const species = num(e.args.species);
        // The tier follows from the species (D-178); the event's tier must agree.
        const tier = TIER_CODE[speciesByIndex(species).tier];
        if (num(e.args.tier) !== tier) {
          throw new Error(
            `agent ${draft.agentId} revealed as species ${species} with tier ${num(e.args.tier)}`,
          );
        }
        draft.species = species;
        draft.tier = tier;
        break;
      }
      default:
        continue;
    }
    draft.blockNumber = e.blockNumber;
    draft.blockHash = e.blockHash;
    changed.add(draft.agentId);
  }
  return changed;
}

/** A draft as a database row; throws if the events never said who minted it. */
export function toRow(chainId: number, d: AgentDraft): AgentTable {
  if (d.owner === null || d.tba === null || d.mintedBlock === null || d.mintedTx === null) {
    throw new Error(`agent ${d.agentId} has events but no AgentMinted`);
  }
  return {
    chain_id: chainId,
    agent_id: d.agentId,
    owner: d.owner,
    tba: d.tba,
    species: d.species,
    tier: d.tier,
    owner_epoch: d.ownerEpoch,
    minted_block: d.mintedBlock,
    minted_tx: d.mintedTx,
    block_number: d.blockNumber,
    block_hash: d.blockHash,
  };
}

/** A database row back to a draft, to apply more events to. */
export function fromRow(row: AgentTable): AgentDraft {
  return {
    agentId: row.agent_id,
    owner: row.owner,
    tba: row.tba,
    species: row.species,
    tier: row.tier,
    ownerEpoch: row.owner_epoch,
    mintedBlock: row.minted_block,
    mintedTx: row.minted_tx,
    blockNumber: row.block_number,
    blockHash: row.block_hash,
  };
}
