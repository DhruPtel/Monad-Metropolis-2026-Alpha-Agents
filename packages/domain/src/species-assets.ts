import { SPECIES, type Species } from "./species.ts";
import { slotsFor } from "./tiers.ts";

/**
 * The species asset manifest (D-188): what the app shows for each of the 25
 * species. A species with a model is shown in 3D; one without shows its 2D
 * image, or a tier-styled placeholder when it has no image either. The app
 * never reads the model from onchain metadata (D-182).
 *
 * Paths are served by apps/web from `public/`. `scripts/assets/check-models.ts`
 * (pnpm assets:check) validates every model listed here against the limits in
 * `scripts/assets/model-check.ts`.
 */
export interface ModelProvenance {
  /** How the mesh was made. */
  readonly mesh: string;
  /** How the rig was made, or null for an unrigged model. */
  readonly rig: string | null;
  /** Who owns it and on what terms, with the decision that records it. */
  readonly license: string;
}

export interface SpeciesModel {
  readonly path: string;
  /**
   * Named socket nodes in slot order: slot 1 is the first entry. A model needs
   * at least as many sockets as its tier has slots (3, 5, 8).
   */
  readonly sockets: readonly string[];
  /** True when the model carries a skeleton the viewer animates. */
  readonly rigged: boolean;
  readonly provenance: ModelProvenance;
}

export interface SpeciesAsset {
  readonly species: Species;
  /** The 2D image, or null when the species has no art yet (a placeholder is shown). */
  readonly image: string | null;
  /** The 3D model, or null while the species has none (D-189). */
  readonly model: SpeciesModel | null;
}

/** Sockets on the bee, in slot order: base uses 3, medium 5, pro 8. */
export const BEE_SOCKETS = [
  "socket_thorax_top",
  "socket_head",
  "socket_abdomen_top",
  "socket_thorax_left",
  "socket_thorax_right",
  "socket_abdomen_left",
  "socket_abdomen_right",
  "socket_abdomen_rear",
] as const;

const MESHY_PAID: ModelProvenance = {
  mesh: "Meshy AI image-to-3D from the owner's concept art, paid plan (D-190)",
  rig: "UniRig, cleaned up and exported from Blender 4.5 (D-157)",
  license: "Owned by the founders; commercial use allowed (D-157, D-190)",
};

const ART: Readonly<Record<string, { image?: string; model?: SpeciesModel }>> = {
  bee: {
    image: "/species/bee.webp",
    model: {
      path: "/models/bee.glb",
      sockets: BEE_SOCKETS,
      rigged: true,
      provenance: MESHY_PAID,
    },
  },
};

export const SPECIES_ASSETS: readonly SpeciesAsset[] = SPECIES.map((species) => {
  const art = ART[species.slug];
  return { species, image: art?.image ?? null, model: art?.model ?? null };
});

/** The asset entry for an onchain species index (1 to 25). */
export function speciesAsset(index: number): SpeciesAsset {
  const asset = SPECIES_ASSETS[index - 1];
  if (!asset || index < 1) throw new RangeError(`no species at index ${index}`);
  return asset;
}

/** The socket names a model must carry for its species' tier, in slot order. */
export function requiredSockets(asset: SpeciesAsset): readonly string[] {
  if (!asset.model) return [];
  return asset.model.sockets.slice(0, slotsFor(asset.species.tier));
}
