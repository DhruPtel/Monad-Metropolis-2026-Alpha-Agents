# Agent 3D assets

Every species has an entry in the species asset manifest, `packages/domain/src/species-assets.ts` (D-188): its tier, a 2D image, and a 3D model with named sockets. A species with a model is shown in 3D on the configure page; one without shows its 2D image, or a placeholder styled by tier when it has no image. The model is never in onchain metadata (D-182).

## What exists (NFT-U1)

The owner's art (`assets-incoming/`, gitignored, 1.2 GB of PNGs and Meshy exports) covers 25 of the 34 species with an image and 24 of them with a model; `scripts/assets/incoming.json` maps every source file to its species and pins it by sha256. The other nine species (Tick, Ground beetle, Cricket, Firefly, Water strider, Earwig, Horseshoe crab, Trilobite, Cicada) keep the tier-styled placeholder until their art arrives.

| Species                                                                                                                                                                                                                                                                                        | 2D image                       | Model                | Size            | Triangles        | Sockets                           | Rig                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------------- | --------------- | ---------------- | --------------------------------- | ------------------ |
| Bee (pro, 1 of 1)                                                                                                                                                                                                                                                                              | `/species/bee.webp`            | `/models/bee.glb`    | 1.90 MB         | 25,229           | 8 on bones                        | 46 joints (P1-U11) |
| Larva grub, Roly-poly, Ant, Weevil, Ladybug (base); Silkworm, Moth, Centipede, Grasshopper, Butterfly, Leaf insect (medium); Praying mantis, Hercules beetle, Jumping spider, Mantis shrimp, Dragonfly, Scorpion, Stag beetle, Atlas moth, Snake, Hummingbird, Fish, Crab, Orchid mantis (pro) | `/species/<slug>.webp`, 1024px | `/models/<slug>.glb` | 0.70 to 1.04 MB | 37,978 to 38,000 | 8 on the shell (`BOUNDS_SOCKETS`) | none               |

Every image is 1024px on its longest side (WebP, quality 82, 90 to 190 kB); the 25 together are 3.2 MB and the 24 models 20.8 MB, so the repository stays small while the originals stay out of it.

## Unrigged models (NFT-U1)

The Meshy exports are unrigged, 0.6 to 2.6 million triangles and 25 to 90 MB each. `pnpm assets:build-models` turns each into a model the viewer can load: welded and simplified to 38,000 triangles with the meshopt simplifier, textures to 1024px WebP, turned by its `yaw` in `incoming.json` so it faces the camera, scaled to a longest side of 3.4 units and stood on the platform with its lowest point at y = 0 (baked into the vertices, so the file carries no transform), then given the eight `BOUNDS_SOCKETS` and compressed with meshopt and quantization. A socket is a plain node on the shell, found by walking out from the bounds' centre along a fixed direction (top, head, tail, the sides, the front quarters and the rear) and keeping the furthest vertex within a cylinder of that ray, so a leg or a wing tip never wins over the body; it floats 0.03 units off the surface. The viewer moves an unrigged model as one body: it slides in while growing from 72% to full size, settles, and then breathes (a 0.03-unit bob and a 1.5 degree sway at 0.25 Hz); the activation hover lifts it as it lifts the bee (`ANIM_CONFIG.unrigged`).

## Provenance

- Bee mesh: Meshy AI image-to-3D from the owner's concept art, on a paid Meshy plan, so the founders own it with commercial use allowed (D-157, D-190).
- Bee rig: UniRig, cleaned up and exported from Blender 4.5 (D-157).
- Bee concept art (`/species/bee.webp`): the owner's recorded source (D-157).
- Source file: the Apiary prototype's `public/models/bee_rig_opt.glb`, sha256 `5f7e2d7bd19664b5c12add839178fc30d0d823ac53f83cc0aa1f2658b5bdeb47`.

## Pipeline

1. Concept art to mesh with an image-to-3D tool on a plan that allows commercial use.
2. For a rigged species: rig with UniRig, clean up in Blender, export GLB, then `pnpm assets:build-bee <source>` (the bee's build: it drops the skin attribute sets three.js never reads, adds the named socket nodes parented to body, head and abdomen bones, never wings or legs, and applies meshopt with quantization). A new rigged species gets its own build script on the same pattern, with its sockets listed in the manifest in slot order.
3. For an unrigged species: put the export in `assets-incoming/3d/NFT_Model/` and its image in `assets-incoming/2d/NFT/`, add both to `scripts/assets/incoming.json` under the species' slug with their sha256, add the slug to `WITH_IMAGE` in `packages/domain/src/species-assets.ts`, then `pnpm assets:build-images` and `pnpm assets:build-models <slug>`. Check the facing in the viewer; if the model faces away from the camera, set its `yaw` (degrees about +Y) in `incoming.json` and build it again.
4. Check: `pnpm assets:check` validates every model in the manifest, and `scripts/assets/incoming.test.ts` checks the mapping against the manifest, the committed files and, when the originals are present, the folder.

## Limits (`scripts/assets/model-check.ts`)

| Limit        | Value                                                         | Why                                                                            |
| ------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| File size    | 3 MB                                                          | One model per page, loaded on mobile                                           |
| Triangles    | 40,000                                                        | Light for an integrated GPU                                                    |
| Textures     | 2048px                                                        | The bee's textures; larger buys nothing at viewer size                         |
| Longest side | 2.5 to 4.5 units                                              | The camera, platform and walk-in are tuned for about 3.4                       |
| Sockets      | at least the tier's slots (3, 5, 8), named as in the manifest | Slots are anchored to them; an unrigged model carries all eight bounds sockets |
| Rig          | a skin exactly when the manifest says rigged                  | The viewer poses only rigged models; an unrigged one moves as one body         |
| Compression  | meshopt, never Draco                                          | Draco's decoder would load from a CDN                                          |
