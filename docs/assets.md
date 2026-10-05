# Agent 3D assets

Every species has an entry in the species asset manifest, `packages/domain/src/species-assets.ts` (D-188): its tier, a 2D image, and a 3D model with named sockets. A species with a model is shown in 3D on the configure page; one without shows its 2D image, or a placeholder styled by tier when it has no image. The model is never in onchain metadata (D-182).

## What exists (P1-U11)

| Species   | 2D image                   | Model             | Size    | Triangles | Sockets | Rig       |
| --------- | -------------------------- | ----------------- | ------- | --------- | ------- | --------- |
| Bee (pro) | `/species/bee.webp`, 768px | `/models/bee.glb` | 1.90 MB | 25,229    | 8       | 46 joints |

Only the bee is in 3D (D-189). The prototype's mantis, scorpion, dragonfly and stag beetle exports are unrigged, 0.8 to 1.7 million triangles and 32 to 45 MB each, and no jumping spider or mantis shrimp model exists.

## Provenance

- Bee mesh: Meshy AI image-to-3D from the owner's concept art, on a paid Meshy plan, so the founders own it with commercial use allowed (D-157, D-190).
- Bee rig: UniRig, cleaned up and exported from Blender 4.5 (D-157).
- Bee concept art (`/species/bee.webp`): the owner's recorded source (D-157).
- Source file: the Apiary prototype's `public/models/bee_rig_opt.glb`, sha256 `5f7e2d7bd19664b5c12add839178fc30d0d823ac53f83cc0aa1f2658b5bdeb47`.

## Pipeline

1. Concept art to mesh with an image-to-3D tool on a plan that allows commercial use.
2. Rig with UniRig, clean up in Blender, export GLB.
3. Optimize textures with glTF Transform (WebP, 2048px at most).
4. Add sockets and compress: `pnpm assets:build-bee <source>` drops the skin attribute sets three.js never reads, adds the named socket nodes parented to body, head and abdomen bones (never wings or legs, whose weights drag the shell), and applies meshopt with quantization. A new species gets its own build script on the same pattern, with its sockets listed in the manifest in slot order.
5. Check: `pnpm assets:check` validates every model in the manifest.

## Limits (`scripts/assets/model-check.ts`)

| Limit        | Value                                                         | Why                                                      |
| ------------ | ------------------------------------------------------------- | -------------------------------------------------------- |
| File size    | 3 MB                                                          | One model per page, loaded on mobile                     |
| Triangles    | 40,000                                                        | Light for an integrated GPU                              |
| Textures     | 2048px                                                        | The bee's textures; larger buys nothing at viewer size   |
| Longest side | 2.5 to 4.5 units                                              | The camera, platform and walk-in are tuned for about 3.4 |
| Sockets      | at least the tier's slots (3, 5, 8), named as in the manifest | Slots are anchored to them                               |
| Rig          | a skin exactly when the manifest says rigged                  | The viewer animates only rigged models                   |
| Compression  | meshopt, never Draco                                          | Draco's decoder would load from a CDN                    |
