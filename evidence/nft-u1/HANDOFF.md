# NFT-U1 handoff: the real art, the new supply, and two mints per wallet

Unit: NFT-U1. Status: done. The first unit of the four-unit session of 2026-10-12.

## Commits

- `ba10f0d` feat(contracts): the new supply, 34 species and two mints per wallet: 500/300/200, the owner's three and the six the art holds appended after Cicada, the 7-bit deck and the 2-bit tier table, mintsOf against MINTS_PER_WALLET; the unit, fuzz and invariant suites and the domain test [NFT-U1]
- `3fb728f` feat(web): the real art for 25 species and 24 models: incoming.json, pnpm assets:build-images and assets:build-models, the manifest, the unrigged viewer motion, the checker and the mapping tests [NFT-U1]
- `c4a6eab` feat(web): two mints per wallet across the stack, and the mint page's new supply: the ABI, the API's eligibility with the mints used, the mint page and panel, the fakes and specs, migration 0033 [NFT-U1]
- `670a94e` feat(contracts): the new AgentNFT and the v3 set redeployed on the playtest fork, the owner's two agents minted again, the address book, the fork tier test, evidence/nft-u1/REDEPLOY.md [NFT-U1]
- `6f992af` fix(contracts): the v2 custody set redeployed against the new AgentNFT and recorded for the local fork; the fork suite matches every verified entry [NFT-U1]
- `6306d1d` test(web): the baselines for the real art, the new supply and two mints; the portal spec; D-372 to D-375, A-94, the plan documents, the README, L-236 and L-237 [NFT-U1]
- The last commit: docs(plans): the NFT-U1 LOGS entry and this handoff [NFT-U1]

## The art, inventoried

Every file in `assets-incoming/` (25 PNGs in 2d/NFT, 25 GLBs in 3d/NFT_Model; the Zone.Identifier markers ignored), matched to a species, pinned by sha256 in `scripts/assets/incoming.json`. The 3D matches were confirmed by each export's base colour atlas and the owner's export times beside the images; every model faces the camera as exported.

| Species | Tier | 2D file | 3D file | Note |
| --- | --- | --- | --- | --- |
| Larva grub | base | Annotated robotic grub with 虫 glyph.png | Meshy_AI_Armored_Mecha_Larva_1008003006_texture (1).glb | |
| Roly-poly | base | Robotic roly-poly_ annotated shell study.png | Meshy_AI_Armored_Mecha_Pillbug_1008014541_texture.glb | |
| Ant | base | Bone-armored ant against giant 蟻.png | Meshy_AI_Mecha_Ant_Scout_1008023745_texture.glb | |
| Tick | base | none | none | placeholder |
| Weevil | base | Robotic weevil against a giant Japanese glyph.png | Meshy_AI_Azure_Mecha_Beetle_1008035327_texture.glb | the teal export, by its atlas |
| Silkworm | medium | Cropped green caterpillar over giant 芋 glyph.png | Meshy_AI_Mecha_Caterpillar_Gre_1008205036_texture.glb | the caterpillar is the larva |
| Ground beetle | medium | none | none | placeholder |
| Cricket | medium | none | none | placeholder |
| Moth | medium | Pearl-White Robotic Silk Moth (1).png | Meshy_AI_Mecha_Moth_Scout_1009013953_texture.glb | the adult silk moth |
| Firefly | medium | none | none | placeholder |
| Centipede | medium | Curious Amber Robot Centipede.png | Meshy_AI_Yellow_Iron_Centipede_1009005150_texture.glb | |
| Water strider | medium | none | none | placeholder |
| Earwig | medium | none | none | placeholder |
| Bee | pro, 1 of 1 | Painted mechanical bee with extended wing.png | Bee.glb set aside | the image rebuilt at 1024px from the same painting; P1-U11's rigged bee.glb stays the model |
| Praying mantis | pro, 1 of 1 | Green Robotic Mantis Close-Up.png | Meshy_AI_Iron_Mantis_1005010242_texture.glb | |
| Hercules beetle | pro, 1 of 1 | Annotated blue robotic beetle portrait.png | Meshy_AI_Mecha_Stag_Beetle_1004172356_texture.glb | the royal-blue export, by its atlas and export time |
| Horseshoe crab | pro, 1 of 1 | none | none | placeholder |
| Jumping spider | pro | Orange Robotic Spider Close-Up.png | Meshy_AI_Arachnobot_16_1006190354_texture.glb | |
| Mantis shrimp | pro | Turquoise robotic mantis shrimp.png | Meshy_AI_Aqua_Mech_Lobster_1006195222_texture.glb | |
| Dragonfly | pro | Teal Dragonfly Close-Up with Cream Wings.png | Meshy_AI_Mechanical_Dragonfly__1004191239_texture.glb | |
| Scorpion | pro | Oxide-red robotic scorpion study.png | Meshy_AI_SC_3_Mecha_Scorpion_1005003029_texture.glb | |
| Trilobite | pro | none | none | placeholder |
| Stag beetle | pro | Mechanical Stag Beetle Close-Up.png | Meshy_AI_Crimson_Iron_Stag_Bee_1005013131_texture.glb | |
| Atlas moth | pro | Oxide-red robotic atlas moth (1).png | Meshy_AI_Crimson_Clockwork_Mot_1007171454_texture (1).glb | |
| Cicada | pro | none | none | placeholder |
| Snake (new, D-373) | pro | Crimson mecha snake and gold glyph.png | Meshy_AI_Crimson_Serpent_Mech_1009050042_texture.glb | |
| Hummingbird (new, D-373) | pro | Violet hummingbird and gold 鳥.png | Meshy_AI_Mechanical_Hummingbir_1009033145_texture.glb | |
| Fish (new, D-373) | pro | Annotated koi shifted beside a gold glyph.png | Meshy_AI_Mecha_Koi_1009051212_texture.glb | the art is a koi; "Fish" as the owner named it (A-94) |
| Ladybug (added, A-94) | base | Cherry-red robotic ladybug close-up.png | Meshy_AI_Ladybug_Mech_1008190626_texture.glb | no listed species names it |
| Grasshopper (added, A-94) | medium | Armored Grasshopper Close-Up.png | Meshy_AI_Mecha_Beetle_GH_8_1008214154_texture.glb | not folded into Cricket |
| Butterfly (added, A-94) | medium | Blue Robotic Butterfly Wing-Hinge Study.png | Meshy_AI_Mechanical_Monarch_1005022640_texture.glb | a monarch |
| Leaf insect (added, A-94) | medium | Sage leaf insect with 葉 glyph.png | Meshy_AI_Leafblade_Beetle_1008055518_texture.glb | |
| Crab (added, A-94) | pro | ChatGPT Image Oct 7, 2026, 12_01_17 AM.png | Meshy_AI_Crimson_Claw_Mech_1007060112_texture.glb | an orange crab with chelae |
| Orchid mantis (added, A-94) | pro | Robotic orchid mantis in bloom.png | Meshy_AI_Rose_Mantis_Automaton_1007183953_texture.glb | beside the one-of-one praying mantis |

No pre-reveal placeholder image and no collection image were in the folder; the drawn placeholder and `collection.png` stand as before.

## The final species list, tiers and counts

34 species, 1,000 agents: 500 base, 300 medium, 200 pro (D-372). Indexes are the onchain order; the nine new species are appended so the first 25 keep their indexes. Within each tier the supply divides as evenly as it can, the remainder to the tier's first species in onchain order (A-94).

| Index | Species | Tier | Count |
| --- | --- | --- | --- |
| 1 | Larva grub | base | 84 |
| 2 | Roly-poly | base | 84 |
| 3 | Ant | base | 83 |
| 4 | Tick | base | 83 |
| 5 | Weevil | base | 83 |
| 6 | Silkworm | medium | 28 |
| 7 | Ground beetle | medium | 28 |
| 8 | Cricket | medium | 28 |
| 9 | Moth | medium | 27 |
| 10 | Firefly | medium | 27 |
| 11 | Centipede | medium | 27 |
| 12 | Water strider | medium | 27 |
| 13 | Earwig | medium | 27 |
| 14 | Bee | pro | 1 |
| 15 | Praying mantis | pro | 1 |
| 16 | Hercules beetle | pro | 1 |
| 17 | Horseshoe crab | pro | 1 |
| 18 | Jumping spider | pro | 16 |
| 19 | Mantis shrimp | pro | 15 |
| 20 | Dragonfly | pro | 15 |
| 21 | Scorpion | pro | 15 |
| 22 | Trilobite | pro | 15 |
| 23 | Stag beetle | pro | 15 |
| 24 | Atlas moth | pro | 15 |
| 25 | Cicada | pro | 15 |
| 26 | Snake | pro | 15 |
| 27 | Hummingbird | pro | 15 |
| 28 | Fish | pro | 15 |
| 29 | Ladybug | base | 83 |
| 30 | Grasshopper | medium | 27 |
| 31 | Butterfly | medium | 27 |
| 32 | Leaf insect | medium | 27 |
| 33 | Crab | pro | 15 |
| 34 | Orchid mantis | pro | 15 |

The owner's own numbers in D-373 (100 each, 38 and 37, 18 and 17) hold without the six added species; removing any of the six from `SPECIES` and rebuilding the deck restores them, and the contract is redeployed at PB-U1 regardless.

## Test results

| Check | Result |
| --- | --- |
| forge (chains/monad) | build clean, `forge fmt --check` clean, 667 passed, 0 failed, 12 skipped (the fork and testnet tests when no fork is named); the AgentNFT suites 71, with the invariant that no wallet mints more than two |
| `pnpm test:fork` | 54 passed on a fresh fork; the address book matched every verified entry, including the moved v2 custody set |
| `pnpm assert:state` on the playtest fork | PASS, MV-S15: 71 values |
| `pnpm assets:check` | every model passes: the bee 1.90 MB rigged, the 24 unrigged models 0.70 to 1.04 MB at 37,978 to 38,000 triangles, 1024px textures, longest side 3.40, 8 sockets each |
| vitest node | 140 files, 1665 passed (vitest exits 1 on the pre-existing unhandled rejection of scan.test.ts, as in every unit since P7-U2) |
| vitest ui, web, console | 57 files, 882 passed |
| the forks project | 18 files, 70 passed one file at a time, with the new reveal-tiers.fork.test.ts: one species of every tier among the first 25 and the appended nine minted and revealed on a real fork with the right tier, slots and metadata, and a wallet's third mint refused |
| Playwright mint.spec.ts (1440px and 380px, axe on every capture) | 30 passed: the new supply and odds, every species row with its art or placeholder, up to two per wallet, one of two offered beside the first agent, both at the limit, sold out |
| Playwright portal.spec.ts | 32 passed: the tick on the placeholder with its slots, the bee's image without WebGL, three.js kept off a page without a model |
| Playwright design.spec.ts | 10 passed with the new tier cards and mint panels |
| Playwright web suite, whole, plain run after the baselines | 304 passed, 2 skipped at both widths |
| pnpm typecheck, lint, format | clean |

Acceptance, as the prompt lists it:

- AgentNFT with the new supply and species counts in the deck, two mints per wallet, every existing rule kept: `ba10f0d`, the suites updated, minting all 1,000 producing exactly the new counts under any randomness.
- Redeployed on the local fork with no reset, the owner's playtest state re-provisioned, the new addresses recorded: evidence/nft-u1/REDEPLOY.md and the address book.
- The mint page's odds, supply and per-wallet limit text: the mint page and panel, captured at both widths.
- The 2D art: every image in the manifest as a 1024px WebP, shown wherever the species image appears (the mint page's rows, the portal, My Agents, the design page); no pre-reveal placeholder was provided, so the drawn placeholder stays; the image link stays settable until frozen.
- The 3D models: every export in the manifest, simplified and compressed so the repository stays small, the originals ignored, every model through the checker, the eight bounds sockets on each model's shell, simple motion for any model, species without a model on the 2D fallback.
- Tests: the mapping (incoming.test.ts), the manifest (species-assets.test.ts), the checker on every model (model-check.test.ts), the mint page at both widths (mint.spec.ts), a fork mint revealing each tier (reveal-tiers.fork.test.ts).

## Model spend

None: no model was called in this unit. The day's spend stands at 4.468 USD from the earlier live runs.

## What the owner should check or try

- `pnpm dev:all`, then /mint: the 34 species with their art, 50/30/20 odds, "up to two per wallet"; mint a second agent from the playtest wallet and see both agents in the panel.
- /configure?agent=1: the bee in 3D as before. Reveal a fresh agent as any species with a model (the console's "Reveal next as") to see an unrigged model walk in as one body and breathe; the tick and the other eight without art show the placeholder with slots.
- A-94 lists what to confirm: the six added species and their tiers, the counts, "Fish" against "Koi".
- The old contracts stay on the playtest fork unused; agent 1's account on the F-U4 factory (80.10 USDC) is still withdrawable, since that factory reads the old AgentNFT.

## Open issues for the next unit

- The frozen IPFS upload of the images, the placeholder and `collection.png` belongs to PB-U1.
- The nine species without art keep the placeholder until their files drop into `assets-incoming/`, `incoming.json` and `WITH_IMAGE`, one build each.
- Unrigged models move as one body; a rig per species (UniRig, as the bee) would give them the walk, head turns and wing cue.
- The reveal moment (UI-U2) can show the 1024px art large; a 2048px build is one constant away.

Push: `git push`
