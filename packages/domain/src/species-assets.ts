import { SPECIES, type Species } from "./species.ts";
import { slotsFor } from "./tiers.ts";

/**
 * The species asset manifest (D-188): what the app shows for each of the 34
 * species. A species with a model is shown in 3D; one without shows its 2D
 * image, or a tier-styled placeholder when it has no image either. The app
 * never reads the model from onchain metadata (D-182).
 *
 * NFT-U1: the owner's art covers 25 species with an image and 24 of them
 * with a model (scripts/assets/incoming.json maps each source file); the
 * other nine keep the placeholder. Every model but the bee is an unrigged
 * Meshy export with the eight BOUNDS_SOCKETS placed on its shell, which the
 * viewer moves as one rigid body (a slide in and a gentle idle); the bee
 * keeps P1-U11's rig and bone sockets.
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

/**
 * Sockets on an unrigged model (NFT-U1), in slot order, placed on the shell
 * by scripts/assets/build-models.ts from the bounds' centre: base uses the
 * first 3, medium 5, pro all 8.
 */
export const BOUNDS_SOCKETS = [
  "socket_top",
  "socket_front",
  "socket_back",
  "socket_left",
  "socket_right",
  "socket_front_left",
  "socket_front_right",
  "socket_rear",
] as const;

const MESHY_PAID: ModelProvenance = {
  mesh: "Meshy AI image-to-3D from the owner's concept art, paid plan (D-190)",
  rig: "UniRig, cleaned up and exported from Blender 4.5 (D-157)",
  license: "Owned by the founders; commercial use allowed (D-157, D-190)",
};

const MESHY_UNRIGGED: ModelProvenance = {
  mesh: "Meshy AI image-to-3D from the owner's concept art, paid plan (D-190); simplified, scaled and given its bounds sockets by pnpm assets:build-models (NFT-U1)",
  rig: null,
  license: "Owned by the founders; commercial use allowed (D-157, D-190)",
};

/** The species whose image the owner's art covers (scripts/assets/incoming.json). */
const WITH_IMAGE = [
  "larva-grub",
  "roly-poly",
  "ant",
  "weevil",
  "silkworm",
  "moth",
  "centipede",
  "bee",
  "praying-mantis",
  "hercules-beetle",
  "jumping-spider",
  "mantis-shrimp",
  "dragonfly",
  "scorpion",
  "stag-beetle",
  "atlas-moth",
  "snake",
  "hummingbird",
  "fish",
  "ladybug",
  "grasshopper",
  "butterfly",
  "leaf-insect",
  "crab",
  "orchid-mantis",
] as const;
/** The species with an unrigged model (every imaged species but the bee, which is rigged). */
const WITH_BOUNDS_MODEL: ReadonlySet<string> = new Set(WITH_IMAGE.filter((slug) => slug !== "bee"));

const ART: Readonly<Record<string, { image?: string; model?: SpeciesModel }>> = {
  ...Object.fromEntries(
    WITH_IMAGE.map((slug) => [
      slug,
      {
        image: `/species/${slug}.webp`,
        ...(WITH_BOUNDS_MODEL.has(slug)
          ? {
              model: {
                path: `/models/${slug}.glb`,
                sockets: BOUNDS_SOCKETS,
                rigged: false,
                provenance: MESHY_UNRIGGED,
              } satisfies SpeciesModel,
            }
          : {}),
      },
    ]),
  ),
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

/** The asset entry for an onchain species index (1 to 34). */
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

/**
 * 2026-10-13 (owner): the final catalog the front end shows: the species with the owner's
 * art (25 of 34). The onchain deck of the testnet AgentNFT still holds the other nine (Tick,
 * Ground beetle, Cricket, Firefly, Water strider, Earwig, Horseshoe crab, Trilobite, Cicada);
 * an agent that drew one keeps its real name over the placeholder art.
 */
export const CATALOG_SPECIES = SPECIES.filter((s) => speciesAsset(s.index).image !== null);

/** Whether a species is in the final catalog. */
export function inCatalog(index: number): boolean {
  return CATALOG_SPECIES.some((s) => s.index === index);
}
