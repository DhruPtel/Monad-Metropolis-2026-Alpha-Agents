# Prototype review: Apiary Configure screen

*Review of the prototype at `/home/dhrupatel/Monad-Test` (package name `apiary-configure`, product name "Apiary"), done on 2026-10-01 to decide how to bring it into Alpha Agents. The prototype was read only. Nothing in it was modified, installed, built or run. Its dev server was not started, because the code gives every value this report needs and starting Vite writes a cache into the prototype's `node_modules`.*

Compared against: `CLAUDE.md`, `Planv2/FINAL_PLAN.md` sections 1.5, 2.1, 4.1.1 to 4.1.5, 4.5.4, 4.10, 4.12 and 5.1, `Planv2/BUILD_PLAN.md` section 1, Phases 0, 1, 6 and B and the section 4 cut line, `Planv2/DECISIONS_AND_OPEN_QUESTIONS.md` (D-034, D-045, D-115, D-141, D-142, D-150, Q-25, Q-26), `LOGS.md`, and the code in `packages/ui` and `apps/web`.

Effort sizes in this note are relative, in keeping with the plan's no-time-estimates rule: **S** is a small part of the unit that absorbs it, **M** is a substantial part of a unit, **L** is most of a unit or more.

---

## 0. Summary

The prototype is one screen: a polished, dark, dense Configure page with a rigged, procedurally animated 3D bee on a shader platform, a skill inventory, a skill detail slide-over, a simulated test run, four sockets, an ERC-721 mint and an ownership-gated model loader. It is about 4,900 lines of TypeScript plus a 74-line Solidity contract.

What it gives us:

- **A finished visual language** that is very close to what `FINAL_PLAN.md > 4.10` describes (graphite, off-white, brass, lime as the single accent, muted red for negatives, monospace for numbers). Our tokens already sit near it; section 2 lists the exact changes to match it.
- **A working 3D viewer and a proven asset pipeline** (image-to-3D, auto-rig, Blender, glTF Transform, React Three Fiber and drei), which is most of the risk in P6-U1.
- **A Configure page layout and interaction model** that P6-U6 can adapt.
- **A small, clean wallet and mint flow** whose state handling is worth keeping as a pattern.

What it does not give us:

- **No socket attachment.** Skills are never attached to the model. The "slots" are 2D HTML hexagons at fixed pixel offsets from the canvas centre; they do not follow the model when it orbits, walks or hovers. Our plan's core 3D mechanic (named socket empties, parts parented to them) is not started.
- **No usable contract.** `ApiaryAgents` is a free, unlimited, freely transferable ERC-721. It has none of AgentNFT's requirements (tier, USDC price, token-bound account, epochs, escrow-only transfers, allowlist). There is no SkillNFT at all; skills are mock data.
- **Different auth stack.** It uses RainbowKit; we use Privy (D-045, D-115).
- **Nothing passes our design-token guard as is.** 195 lines across 22 of its 38 source files use raw hex, `rgba()` or arbitrary pixel values that `packages/ui/src/design-tokens.test.ts` rejects.

Recommendation in one line: **adopt the look through our tokens, port the 3D viewer and the asset pipeline into an early P6-U1, adapt the Configure layout in P6-U6, take the mint and gate flows as patterns only, and leave the contract and the mock data behind.**

---

## 1. Stack

### 1.1 Versions (installed in the prototype's `node_modules`, read from each package's `package.json`)

| Area | Prototype | Alpha Agents | Notes |
|---|---|---|---|
| Framework | Vite 8.3.1 SPA, `@vitejs/plugin-react` 6.1.1 | Next.js 16.3.8 App Router | Different. Prototype code uses `import.meta.env`, `window` at module scope and has no server boundary |
| React | 19.3.0 | 19.3.0 | Same |
| TypeScript | 7.0.2 | ^6.0.3 (root) | Prototype compiles on TS 7; must be checked under our TS 6 strict config |
| CSS | Tailwind 4.3.3 via `@tailwindcss/vite` | Tailwind 4.3.3 via `@tailwindcss/postcss` | Same version |
| Component kit | None (hand-written components, inline SVG icons) | shadcn/ui 4.21.1 on Radix 1.6.7, lucide-react 1.49.0, sonner, cva | Prototype has no Radix: its slide-overs and menus are custom |
| Fonts | Inter 400/500/600 and JetBrains Mono 400/500 from the Google Fonts CDN | Geist Sans and Geist Mono, self-hosted with `next/font` | Different family and delivery |
| 3D | three 0.186.1, @react-three/fiber 9.8.1, @react-three/drei 10.7.8, @types/three 0.186.0 | Not installed yet; D-115 names React Three Fiber with drei | Versions are compatible with React 19.3 |
| Chain | wagmi 2.19.5, viem 2.56.9, @tanstack/react-query 5.103.3 | Not installed yet; D-115 names wagmi, viem, TanStack Query | Same libraries |
| Wallet UI | @rainbow-me/rainbowkit 2.2.11 (MetaMask, OKX, Rabby, Coinbase, Phantom, WalletConnect) | Privy (D-045, D-115), MetaMask and OKX | Conflict: RainbowKit is dropped |
| Contracts | Foundry, Solidity 0.8.28, cancun, OpenZeppelin 5.7.0 and forge-std 1.16.2 from npm | Foundry 1.8.3, forge-std 1.16.2 via Soldeer (D-148) | OZ is not yet in our repo |
| Tests | 8 Foundry tests; no frontend tests | Vitest (555), Playwright screenshots at 1440px and 380px, axe | Prototype brings no frontend tests |

### 1.2 Consequences

- Every prototype component that touches the browser must become a client component (`"use client"`). The 3D canvas must be loaded with `next/dynamic` and `ssr: false`, both to avoid server rendering of WebGL and to keep three.js out of every other route's bundle. The prototype's production bundle is a single 1.96 MB `index-*.js` with three, drei, RainbowKit and wagmi together; there is no code splitting.
- `import.meta.env.VITE_*` becomes `process.env.NEXT_PUBLIC_*` read through `@alpha-agents/config`.
- `src/web3/wallets.ts` and `session.ts` exist only to tame RainbowKit and EIP-6963 discovery; Privy replaces both.

---

## 2. Visual style

### 2.1 Values the prototype uses

All values are from `src/index.css`, `src/web3/Web3Provider.tsx`, `src/components/viewer/AgentScene.tsx` and a scan of every class in `src/`.

**Colors** (the token block in `src/index.css`, with WCAG contrast measured against `--surface`):

| Prototype token | Value | Use | Contrast on #14161A |
|---|---|---|---|
| `--bg` | #0E1013 | Page, header strip | |
| `--surface` | #14161A | Panels, top bar, cards | |
| `--surface-2` | #1C1F24 | Raised fills, slot fill, slider track | |
| `--border` | #262A31 | Every border and divider, scrollbar thumb | |
| `--text` | #EDEAE3 | Primary text (warm off-white) | 15.08 |
| `--text-dim` | #8B8F96 | Secondary text, labels | 5.58 |
| `--accent` | #B6FF2E | Lime: primary button, focus ring, positive deltas, selection, glow | 14.95 |
| `--accent-dim` | #7FB01F | Lime outlines: secondary button border, slot strokes, slider fill | 7.01 |
| `--brass` | #C9A227 | Tier badge, viewer corner marks, Legendary rarity | 7.49 |
| `--negative` | #D9534F | Negative deltas, errors | 4.57 |
| `--warn` | #E0A800 | Model load failure, wallet standby | 8.43 |
| `--rare` | #8FA9C4 | Rare rarity, cool fill light | 7.45 |
| (RainbowKit only) | #5C6068 | Modal dim text | 2.87, fails AA |
| (viewer) | radial gradient #181B21 to #0E1013, 60% by 55% at 50% 48% | Canvas background | |
| (platform shader) | disc #1A1D23, grid cell #2B3039, grid section #3A4A24, ring #B6FF2E | 3D platform | |
| (lights) | key #FFF2DE at 2.6, rim #9DB4E6 at 0.8, ambient 0.3; Lightformers #F4F0E8, #8FA9C4, #B6FF2E | Scene lighting | |

Publisher accents are data, not tokens: #28A0F0, #375BD2, #A47CF3, #3DD9C1, #FF8A3D, #C9A227, #8B8F96, #D9534F (see 8.2 on why these must not ship).

**Typography.** Inter for UI, JetBrains Mono for numbers, addresses, codes and small uppercase labels. Body is 13px with line-height 1.4 and `font-variant-numeric: tabular-nums` globally. Weights 400, 500 and 600 only (21 uses of `font-medium`, 13 of `font-semibold`, no bold). The size scale in use, by frequency: 11px (35), 12px (30), 13px (17), 11.5px (12), 10.5px (12), 12.5px (7), 14px (5), 15px (4), 10px (3), 20px (2), 22px (2), 16px (1), 9.5px (1). Section labels are mono, 10.5px, uppercase, `tracking-[0.12em]`; socket labels are mono 10.5px at `0.08em`; the agent name is 22px semibold `tracking-tight`.

**Spacing and sizing.** 4px base (Tailwind default), so the same unit as ours. Common steps: `px-4` and `gap-2` (22 each), `gap-1.5`, `gap-3`, `gap-2.5`, `px-2.5`, `px-3.5`, `py-3.5`. Control heights are small: 28px (`h-7`, pills and chrome buttons), 32px (`h-8`, icon buttons), 34px (main actions), 36px (`h-9`, full-width actions), 44px (panel headers, `h-11`). App grid: rows 56px (top bar), 72px (agent header), the viewer, 180px (bottom panel); columns 300px, the viewer, 320px. Below 1024px the side panels become tabs above the viewer.

**Radii.** 3px (tags, publisher marks), 4px (chips, labels, small buttons), 6px (`rounded-md`: cards, panels, all main buttons; 34 uses), full (dots, avatars). Nothing larger than 6px.

**Effects.** The look is flat: cards have no drop shadow, only a 1px border. Shadows are reserved for floating things and for selection:

| Effect | Value |
|---|---|
| Dialog and menu | `0 8px 24px rgba(0,0,0,0.45)` |
| Large overlay | `0 12px 32px rgba(0,0,0,0.5)` |
| Slide-over panel edge | `12px 0 24px rgba(0,0,0,0.35)` |
| Lime glow (lit empty socket) | `0 0 14px rgba(182,255,46,0.18)` |
| Selected card | `0 0 0 1px var(--accent), 0 0 18px rgba(182,255,46,0.22)` |
| Highlighted slot | `drop-shadow(0 0 7px rgba(182,255,46,0.55))` |
| Open card or flash | `0 0 0 1px var(--accent)` (outer or inset) |
| Publisher stripe | 2px (cards) or 3px (sockets) left border in the publisher accent |
| Translucency | `bg-surface/80` and `/90` with `backdrop-blur-[2px]` over the canvas only |
| Tints | `color-mix(in oklab, var(--accent) 12%/30%/35%/50%, transparent)`; `bg-accent/5`, `/10`, `/15` |

**Motion.** `--t-fast` 140ms, `--t-med` 180ms, `--ease-snap` `cubic-bezier(0.2, 0, 0, 1)`; most transitions are `duration-150`. Hover lifts cards by 2px (`-translate-y-0.5`). `slot-pulse` (2.4s opacity 0.45 to 0.95) on empty slots and `status-pulse` (1.8s expanding lime ring) on the status dot. A global `prefers-reduced-motion` rule cuts every animation and transition, and the 3D scene stops auto-rotate and the bee's sequence when it is set.

**Signature details.** Brass corner marks (10px L-shapes at 60% opacity) frame the viewer; hexagonal slot markers with a 1px leader line and a label chip; mono `build 0x4c91` and `slots 3/4` readouts in the viewer's bottom corners; a 1.5px dashed hexagon for empty sockets; custom 4px range sliders with a hollow lime thumb.

### 2.2 Comparison with our tokens (`packages/ui/src/styles.css`)

| Role | Prototype | Ours | Difference |
|---|---|---|---|
| Background | #0E1013 | `--palette-graphite-900` #121412 | Ours is green-tinted graphite; prototype is cool blue graphite, a step darker |
| Surface | #14161A | `graphite-850` #181B18 | Same tint difference |
| Raised | #1C1F24 | `graphite-800` #1E221E | Same |
| Overlay | (none; uses #1C1F24) | `graphite-750` #262A26 | |
| Border | #262A31 | `graphite-700` #313631 | Prototype borders are darker and quieter |
| Strong border | (uses `text-dim` on hover) | `graphite-600` #434943 | |
| Text | #EDEAE3 (warm) | `offwhite` #EEF0EA (green-cool) | |
| Muted text | #8B8F96 | `ash` #A3AA9F / `ash-dim` #848B80 | Prototype has one dim level, ours has two |
| Lime | #B6FF2E | #B6FF3B | Visually identical |
| Lime dim | #7FB01F | (none) | We lack a dim lime for outlines |
| Brass | #C9A227 (saturated gold) | #C9A35C (muted) | Noticeable |
| Negative | #D9534F | #E57068 | Prototype red is deeper and less pink |
| Warning | #E0A800 | (none) | We lack one; our "stale data" and "awaiting approval" flags need one |
| Rarity | #8FA9C4 | (none) | |
| Type | Inter / JetBrains Mono, 13px body, 11 to 13px dominant | Geist Sans / Mono, 16px base, scale 12/14/16/18/22/28/36 | Prototype is much denser |
| Radii | 3, 4, 6px | sm 4, md 6, lg 10, xl 14px; Card uses lg | Our cards are rounder |
| Card shadow | none | `--shadow-raised` on every Card | Prototype is flat |
| Control heights | 28, 32, 34, 36px | Button sm 32, md 40, lg 48px | Ours are larger |
| Motion | 140/180ms, snap easing, reduced-motion rule | No motion tokens | |

### 2.3 Proposed token changes

These edits to `packages/ui/src/styles.css` make the design system match the prototype. They change values, not names, wherever a name already exists, so no component has to change except where noted. Every one alters the P0-U6 and P0-U4 Playwright screenshots, which must be re-baselined in the same commit.

**Palette (`:root`):**

```css
/* Graphite: cool blue-grey instead of green-grey */
--palette-graphite-950: #0e1013;   /* new: page background */
--palette-graphite-900: #14161a;   /* was #121412 */
--palette-graphite-850: #181b21;   /* was #181b18; also the viewer glow centre */
--palette-graphite-800: #1c1f24;   /* was #1e221e */
--palette-graphite-750: #22262c;   /* was #262a26; interpolated, prototype has no overlay step */
--palette-graphite-700: #262a31;   /* was #313631 */
--palette-graphite-600: #3a3f47;   /* was #434943; interpolated hover border */
/* Text */
--palette-offwhite: #edeae3;       /* was #eef0ea */
--palette-ash: #8b8f96;            /* was #a3aa9f */
--palette-ash-dim: #6e727a;        /* was #848b80; interpolated, 3.9:1 on surface, for non-essential text only */
/* Accents */
--palette-lime: #b6ff2e;           /* was #b6ff3b */
--palette-lime-bright: #c8ff6b;    /* unchanged */
--palette-lime-dim: #7fb01f;       /* new */
--palette-red: #d9534f;            /* was #e57068 */
--palette-red-deep: #3a1d1c;       /* was #3a1f1d; re-tinted to the new red */
--palette-brass: #c9a227;          /* was #c9a35c */
--palette-amber: #e0a800;          /* new */
--palette-steel: #8fa9c4;          /* new */
```

**Semantic tokens (`[data-theme="dark"]`):**

```css
--background: var(--palette-graphite-950);  /* was graphite-900 */
--surface: var(--palette-graphite-900);     /* was graphite-850 */
--surface-raised: var(--palette-graphite-800);
--surface-overlay: var(--palette-graphite-750);
--primary-muted: var(--palette-lime-dim);   /* new: outlines of secondary lime buttons, slot strokes */
--warning: var(--palette-amber);            /* new: stale data, awaiting approval, load failures */
--rare: var(--palette-steel);               /* new: rarity label (FINAL_PLAN 4.1.3 derives rarity from supply) */
--viewer-glow: var(--palette-graphite-850); /* new: centre of the 3D viewer's radial background */

--shadow-raised: none;                                        /* was a drop shadow: cards are flat */
--shadow-overlay: 0 8px 24px rgb(0 0 0 / 0.45);               /* was 0 8px 32px / 0.5 */
--shadow-panel: 12px 0 24px rgb(0 0 0 / 0.35);                /* new: slide-over edge */
--shadow-glow: 0 0 14px rgb(182 255 46 / 0.18);               /* was 0 0 12px / 0.35 */
--shadow-selected: 0 0 0 1px var(--primary), 0 0 18px rgb(182 255 46 / 0.22); /* new */
```

Each new semantic color also needs its `--color-*` line in `@theme inline` and an entry in `COLOR_TOKENS` in `packages/ui/src/tokens.ts`, which the token test checks; each new shadow needs its `--shadow-*` mapping and a `SHADOW_SCALE` entry.

**Type scale.** Shift the scale down one notch and add a dense step, so the existing names keep their roles:

```css
--type-2xs: 0.6875rem;  --type-2xs-leading: 1rem;      /* new, 11px: captions, mono labels, chips */
--type-xs: 0.75rem;     --type-xs-leading: 1rem;       /* unchanged, 12px */
--type-sm: 0.8125rem;   --type-sm-leading: 1.125rem;   /* was 0.875rem; 13px body and controls */
--type-base: 0.9375rem; --type-base-leading: 1.375rem; /* was 1rem; 15px */
--type-lg: 1.125rem;    /* unchanged */
--type-xl: 1.25rem;     --type-xl-leading: 1.75rem;    /* was 1.375rem; 20px panel title */
--type-2xl: 1.375rem;   --type-2xl-leading: 1.75rem;   /* was 1.75rem; 22px agent name */
--type-3xl: 1.75rem;    --type-3xl-leading: 2.25rem;   /* was 2.25rem */
--type-label-tracking: 0.12em;                         /* new: uppercase mono section labels */
```

and set the body to `text-sm` instead of `text-base` in the `@layer base` rule, with `font-variant-numeric: tabular-nums` on `body`. The prototype's half-pixel sizes (10.5, 11.5, 12.5px) collapse onto 11, 12 and 13px; the difference is not visible at a glance.

**Fonts.** To match exactly, replace Geist with Inter (400, 500, 600) and JetBrains Mono (400, 500) loaded through `next/font/google`, which downloads at build time and serves the files from our own origin, so the "self-hosted fonts" rule in P0-U6 still holds. `--font-sans` and `--font-mono` keep their names. This is the one change that is a matter of taste rather than of matching: Geist is close to Inter in shape, and keeping it costs little of the look. Owner's call.

**Radii.**

```css
--shape-radius-xs: 0.1875rem; /* new, 3px: tags and marks */
--shape-radius-sm: 0.25rem;   /* unchanged */
--shape-radius-md: 0.375rem;  /* unchanged */
--shape-radius-lg: 0.375rem;  /* was 0.625rem: cards and panels at 6px */
--shape-radius-xl: 0.5rem;    /* was 0.875rem */
```

**Motion (new).**

```css
--motion-fast: 140ms;
--motion-medium: 180ms;
--motion-ease: cubic-bezier(0.2, 0, 0, 1);
```

with `--ease-snap` and `--duration-*` mappings in `@theme`, the `slot-pulse` and `status-pulse` keyframes, and the prototype's global `prefers-reduced-motion` rule in `@layer base`.

**Component changes that follow** (not token edits, but needed for the match): Button sizes become `sm` 28px, `md` 36px, `lg` 40px; add a `secondary-accent` Button variant (transparent, `border-primary-muted`, `text-primary`, `is-hover:bg-primary/10`) for "Run agent test"-style actions; add `Tag` (3px radius, 18px tall, 10 to 11px text) for rarity and category; add `SectionLabel` (mono, `text-2xs`, uppercase, label tracking). Our `Card` keeps its API.

---

## 3. 3D

### 3.1 Library and rendering

- **Library:** three 0.186.1 through @react-three/fiber 9.8.1 and @react-three/drei 10.7.8 (`useGLTF`, `OrbitControls`, `Environment`, `Lightformer`, `Html`). This is exactly D-115.
- **Canvas** (`AgentViewer.tsx`): `dpr={[1, 2]}`, antialias, alpha, `powerPreference: 'high-performance'`, camera at (0, 1.9, 5.6), fov 32. The default frame loop renders every frame.
- **Scene** (`AgentScene.tsx`): ambient 0.3, a warm key and a cool rim directional light, and a `<Environment resolution={128} frames={1}>` built from three Lightformers, so reflections come from a tiny, render-once cube map and **no HDR file is fetched**. The platform is one plane with a custom GLSL shader (disc, two grid scales fading to the edge, a lime ring with a Gaussian glow that brightens when a slot is highlighted): one draw call.
- **Controls:** orbit with rotate and zoom only, damping 0.08, distance 3.2 to 8, polar 0.45 to 1.5 rad; auto-rotate at 0.5 that pauses on interaction and resumes after 3 s; disabled under reduced motion.
- **Model component** (`RiggedBee.tsx`, 866 lines): loads the GLB with `useGLTF`, discovers the skeleton, and animates it procedurally because the file has no animation clips. `BONE_MAP` maps body, head, antennae, wings and six legs (hip and knee) to bones, either inferred from hierarchy and rest positions or pinned by name. `ANIM_CONFIG` holds a tripod gait, a walk-in sequence, idle motion, wing beat, hover with bob, and a `DEFORM_DAMPING` dial. Because the auto-rig's weights bleed into the thorax, wing bones barely move; the visible wing stroke comes from translucent additive copies of the wing geometry pivoting rigidly at the wing root. On select it plays walk in, settle, lift, hover; about 4 s to a steady hover.
- **Errors:** a React error boundary per model URL shows "Failed to load model" and clears drei's cache so a retry refetches. A `Suspense` fallback shows "Loading model".
- **Dev panel:** scale (log slider), rotation X and Y, replay, state readout.

### 3.2 How parts attach to the body

**They do not.** No skill geometry exists, nothing is parented to a bone or an empty, and there is no socket naming in the model. The four "slots" are `SlotMarker` components: SVG hexagons placed in screen space at fixed offsets (`SLOT_POSITIONS`: ±170px, -130px and +90px from the canvas centre) with a leader line and the skill name. They stay still while the model orbits, walks and flies.

The concept art (`images/1.png`) does show hexagonal sockets on the bee's thorax and abdomen ("socket / 04", "wing hinge", "sensor band"), so the art direction anticipates our socket design; the mesh just never received sockets.

What our plan needs (`FINAL_PLAN.md > 4.10`, P6-U1 acceptance) is still to be built: named socket empties in Blender, parts modelled with their origin at the attachment point, and parenting at runtime. The rig suggests a better variant than static empties: parent each `socket_*` empty to a bone (thorax, abdomen, head) in Blender, so equipped parts move with the walk and hover. Because the thorax deforms under the current weights, parts on bones that move a lot (wings, legs) will float off the skin; put sockets on the body, head and abdomen bones only, or re-weight in Blender (the README already names this as the clean fix).

### 3.3 Model files

Measured by parsing each GLB's JSON chunk:

| File | Size | Triangles | Vertices | Skin | Textures | Generator | Used at runtime |
|---|---|---|---|---|---|---|---|
| `Bee.glb` (repo root) | 60.0 MB | 1,732,330 | 923,915 | none | 3 JPEG, 9.7 MB total | pygltflib 1.16.5 | No (source) |
| `public/models/bee.glb` | 1.76 MB | 45,776 | 37,329 | none | 3 WebP, 1.35 MB | glTF-Transform 4.5.0, meshopt + quantization | No |
| `public/models/Bee_rig.glb` | 24.9 MB | 25,229 | 27,098 | 46 joints | 3 PNG, 21.2 MB | Blender glTF I/O 4.5.51 | No |
| `public/models/bee_rig_opt.glb` | **3.65 MB** | 25,229 | 27,098 | 46 joints | 3 WebP (up to 2048px), 1.37 MB | glTF-Transform 4.5.0 | **Yes** (all three tokens' metadata and the dev toggle) |

The runtime model is `bee_rig_opt.glb`: one mesh, one `BakedMaterial`, 46 bones, no animation clips, and five sets of `JOINTS_n`/`WEIGHTS_n` attributes of which three.js reads only the first. The optimize command used is in the prototype README (`gltf-transform optimize ... --texture-compress webp --texture-size 2048`, everything else off). Geometry is not compressed in that file.

### 3.4 Performance

- **Download:** 3.65 MB per model. Dropping `JOINTS_1` to `JOINTS_4` and `WEIGHTS_1` to `WEIGHTS_4` (unused by three.js), then applying meshopt and quantization as `bee.glb` already does, should bring it to roughly the 1.5 to 2 MB range; that estimate is untested. Textures at 1024px for a viewer this size would cut further.
- **GPU:** 25k triangles, one skinned mesh, one material, one shader plane and a 128px environment map is light; any integrated GPU handles it. The wing cue adds a few transparent draws.
- **CPU:** the procedural rig updates about 20 bones per frame plus a damped orbit; cheap. The frame loop never idles (auto-rotate keeps it busy), so the tab draws at full rate while open; `frameloop="demand"` when idle would save battery.
- **JS:** three and drei are the largest part of the 1.96 MB main bundle; in Next.js they must be split into the configure and mint routes.
- **Waste in the build output:** `dist/models` ships all three GLBs (30.3 MB), including the unused 24.9 MB `Bee_rig.glb`.
- **Issues to fix on port:** `buildRig` logs a full bone table with `console.table` in production, not only in development; the dev panel gear is visible in production whenever a model is loaded; `useGLTF`'s cached scene is mutated in place (two viewers of the same URL would fight over one skeleton), so the port must clone with `SkeletonUtils.clone`.
- **No static fallback.** Without WebGL the canvas simply fails. P6-U6's acceptance requires a static fallback; the prototype has none.

### 3.5 Where the assets came from

- **Concept art:** `images/1.png`, 1254 by 1254 RGB, a hand-drawn-style mecha bee with annotations. Provenance is not recorded anywhere in the prototype. It reads as generated art; treat it as unknown until the owner confirms.
- **Mesh:** an image-to-3D export. The file `Meshy_AI_Mecha_Bee_Concept_Art_0925065409_texture.glb:Zone.Identifier` (a Windows "downloaded from the internet" marker, ZoneId 3; the GLB itself is gone) names **Meshy AI** as the source. `Bee.glb` (60 MB, 1.7M triangles, written by pygltflib) is consistent with the raw export.
- **Rig:** UniRig (named in the prototype README), then cleaned up and exported from Blender 4.5 (`Bee_rig.glb:Zone.Identifier` shows that file was also downloaded, which fits an online rigging step).
- **Optimization:** `@gltf-transform/cli`, run with `npx` (README).
- **Images in metadata:** `public/metadata/1.json` to `3.json` point at `/images/1.png` to `/images/3.png`, but `public/images/` holds only `.gitkeep`; the one image sits at `images/1.png`, outside `public/`, so every token image 404s and the UI falls back to a placeholder.

---

## 4. NFTs

### 4.1 What exists

**Contract** `contracts/src/ApiaryAgents.sol` ("Apiary Agents", symbol AGENT), MIT, OpenZeppelin 5.7.0:

- `ERC721 + ERC721Enumerable + ERC721URIStorage + Ownable`.
- `mint()`: public, free, unlimited, one token per call, ids from 1, `_safeMint` to the caller, stores `"<id>.json"` as the token URI.
- `setBaseURI(string)` owner-only, emits EIP-4906 `BatchMetadataUpdate(1, type(uint256).max)`.
- Transfers are unrestricted. No tier, no price, no supply cap, no allowlist, no pause.
- `Deploy.s.sol` refuses a mismatched chain id and validates the key format without echoing it; deploy targets Monad testnet 10143 (or Base Sepolia).
- 8 Foundry tests: sequential ids, enumeration, enumeration after transfer, token URI, missing token reverts, base URI move, owner-only, interfaces.

**Metadata** (`public/metadata/<id>.json`, served from the site):

```json
{
  "name": "UNIT-07",
  "description": "Front-line execution unit. Tuned for fast fills and tight risk bands.",
  "image": "/images/1.png",
  "attributes": [{ "trait_type": "species", "value": "bee" }, { "trait_type": "tier", "value": "Pro" }],
  "model": "/models/bee_rig_opt.glb"
}
```

`model` is a custom field. Paths are root-relative, which only this app can resolve (the README says so). Only tokens 1 to 3 have files.

**Minting flow** (`src/web3/agents.ts`, `MintControl.tsx`): connect if needed, switch network if needed, `writeContractAsync(mint)`, wait for the receipt, fail on revert, parse the `Transfer` from zero to the caller for the new id, refetch the owned list. States: idle, signing, pending (with explorer link), success, error, with "Rejected in wallet" separated from other errors.

**Ownership gate:** `balanceOf`, then `tokenOfOwnerByIndex` per index, then `tokenURI` and metadata per token (polled every 20 s). On selection it reads `ownerOf` and `tokenURI` fresh, refuses unless the owner is the connected wallet, then loads the model; `ownerOf` is re-checked every 15 s and a transfer, account switch or network switch unloads the model. The README states correctly that this is a UX gate, not access control, and sketches a SIWE-gated model route.

**Skills:** no contract. Eight mock skills in `src/data.ts` with publisher, rarity (Common, Rare, Legendary), supply, price in MON, audit status, creator stake, usage counts and a canned test output.

### 4.2 Against AgentNFT (`FINAL_PLAN.md > 4.1.1`, P1-U3)

| AgentNFT requirement | ApiaryAgents |
|---|---|
| `mint(tier)` paying USDC | Free `mint()`, no tier |
| Tier per token (base, medium, pro), `slotsOf` 3, 5, 8 | Tier is a metadata string only; four fixed sockets for every token |
| Atomic ERC-6551 account create plus initialize | None |
| `ownerEpoch` bump on every `_update`, `epochStartedAt` | None |
| Transfers only by the escrow; refuse transfers to agent accounts; no burn while the account holds anything | Transfers unrestricted |
| Mint allowlist with a flag only the timelock can disable | None |
| `AgentMinted(agentId, owner, tier, tba)`, `OwnerEpochBumped` | Standard `Transfer` only |
| Enumeration | `ERC721Enumerable` (ours does not need it: the indexer and API list agents with a watermark, P1-U4) |
| Mainnet 143 | Testnet 10143 |

Nothing in the contract survives into AgentNFT. Two small patterns are worth copying by hand: `setBaseURI` emitting EIP-4906 so indexers refresh, and the deploy script's chain-id check and value-free key validation.

### 4.3 Against SkillNFT (`FINAL_PLAN.md > 4.1.3`, P6-U2)

There is no SkillNFT. The mock `Skill` type is useful as a UI shape but disagrees with our model in several places:

| Our model | Prototype mock |
|---|---|
| Types: protocol, strategy, research | Research, Strategy, Execution, Protocol |
| Slots by summed slot cost against tier (3, 5, 8) | Four sockets, one per category, one skill each |
| Price in USDC | Price in MON |
| Rarity derived from supply (a label, not onchain) | Stored rarity |
| Content-hashed versions, statuses, audit attestation hash | Free-text audit fields |
| The nine launch skills of 4.5.4 | Eight invented skills under real company names |

### 4.4 Metadata recommendation

Keep the shape, change the fields: standard `name`, `description`, `image` as absolute IPFS or Arweave URIs (Q-26), the GLB in the standard `animation_url` field so wallets and marketplaces can show it, `attributes` with `tier` and `slots`, and our own `properties` block for the socket layout version. Images must exist before anything is pinned.

---

## 5. Components and pages

Planned pages and units are from `FINAL_PLAN.md > 4.10` and `BUILD_PLAN.md > 4`.

| Prototype piece | What it is | Serves |
|---|---|---|
| `App.tsx` layout (top bar, agent header, three columns, bottom panel, compact tabs) | The Configure screen frame | P6-U6 configure page |
| `viewer/AgentViewer.tsx` | Canvas wrapper, corner marks, readouts, overlay and badge slots | P6-U1, P6-U6; P1-U10 mint page tier preview; P7-U7 gallery thumbnails (with a static image) |
| `viewer/AgentScene.tsx` | Lights, environment, shader platform, orbit, error boundary | P6-U1 |
| `viewer/RiggedBee.tsx` | Rig discovery, procedural walk, hover, wing cue | P6-U1 (the "base body" component) |
| `viewer/stage.ts` | Platform height and radius | P6-U1 |
| `viewer/SlotMarker.tsx` | 2D hex slot overlay with leader and label | P6-U6, as an HTML label anchored to a 3D socket with drei `Html` |
| `viewer/DevPanel.tsx` | Scale, rotation, replay | P6-U1 tuning; P0-U4 dev console as a 3D tuning panel |
| `SkillInventory.tsx` | Left panel: filter by type and rarity, list | P6-U6 inventory; P8-U2 marketplace grid filters |
| `SkillCard.tsx` | Skill card with publisher stripe, tags, price | P6-U6, P8-U2 marketplace grid |
| `skills/SkillDetail.tsx` | Slide-over: publisher, what it does, unlocks, technical spec, audit, stake, usage, Equip, Test | P8-U2 skill detail page; P6-U6 detail panel |
| `skills/PublisherMark.tsx`, `VerifiedBadge` | Monogram mark, verified badge | P8-U2 (verified flag from PublisherRegistry) |
| `skills/RunPanel.tsx` | Simulated timestamped run log and result | No direct planned page. Could show a real "last cycle" log on the agent profile (P5-U1); a simulated run must be labeled |
| `AgentOverview.tsx` | Right panel: identity, "What this agent does", equipped list, Run agent test | P6-U6 capability deltas panel; P5-U1 build card |
| `AgentHeader.tsx` | Name, tier, owner, status, four counters | P5-U1 profile header; counters map to P7-U5 demand counters |
| `configure/SocketStrip.tsx` | Four socket tiles | P6-U6 slot arithmetic display |
| `configure/BottomPanel.tsx` | Actions plus disclaimer | P6-U6 "Activate build" area |
| `web3/MintControl.tsx` | Mint button with every transaction state | P1-U10 mint page |
| `web3/AgentCollection.tsx` | "My agents" panel of token cards | P1-U9 My Agents agent list; P7-U7 gallery card |
| `web3/ViewerGate.tsx` | Empty states: no contract, disconnected, wrong chain, empty, error | P6-U6 and P1-U9 empty states (as `EmptyState` variants) |
| `web3/WalletButton.tsx` | RainbowKit account menu | Nothing (Privy, P1-U2) |
| `TopBar.tsx` | Logo, mint, wallet, bell | Nothing (our `AppShell` exists) |
| `Glyph.tsx`, `icons.tsx` | 8 skill glyphs, 12 UI icons as inline SVG | Skill glyphs as part icons until P6-U1 art lands; UI icons replaced by lucide |
| `lib/agent.ts` `describeAgent` | Plain-language build description | P6-U6 capability description (must come from skill manifests, not prose in code) |
| `lib/build.ts` | Socket for a skill, fake build hash | Superseded by BuildRegistry `buildHash` |
| `web3/agents.ts` | Owned list, verified load, live owner, mint hook | Patterns for P1-U9, P1-U10, P6-U6 |
| `web3/metadata.ts` | `resolveUri` (ipfs and relative), `fetchMetadata`, `trait` | P1-U9, P7-U7, P8-U2 |
| `data.ts` | Mock skills, publishers, agent stats | Nothing; replaced by registry and API data |
| `contracts/` | ApiaryAgents | Nothing (see 4.2) |

Not present in the prototype but on the planned Configure page: proposed versus active build, "Activate build" sending `setBuild`, build history, the goal form, slot arithmetic by tier, the static fallback, the environment and beta labels, the canonical agent state and account mode.

---

## 6. Port, adapt or rebuild

| Piece | Verdict | Reason | Effort |
|---|---|---|---|
| Visual language | **Adapt into tokens** | Values go into `styles.css` (section 2.3); no prototype CSS is copied | S (P0-U6 follow-up; re-baseline screenshots) |
| Asset pipeline (image-to-3D, UniRig, Blender, glTF Transform command) | **Port as a documented process** | Proven on one body; extend with socket empties, part models, meshopt, attribute pruning, LOD thumbnails | M (P6-U1) plus art time; licensing first (8.2) |
| `bee_rig_opt.glb` | **Adapt** | Usable as the reduced-scope "one base body" only after the license is confirmed and sockets are added in Blender | M |
| `AgentScene.tsx` (lights, environment, platform shader, orbit, error boundary) | **Port with small changes** | Already matches D-115; colors must come from CSS variables read at runtime (our token test forbids hex in source); `"use client"` and dynamic import | S |
| `RiggedBee.tsx` | **Adapt** | Valuable but bee-specific; strip production logging, clone the scene, gate tuning to development, add socket lookup by name and part parenting, respect `frameloop="demand"` | M |
| `AgentViewer.tsx` | **Adapt** | Keep the frame, corner marks and readouts; replace screen-space slots with sockets in 3D; add the static fallback | S to M |
| `SlotMarker.tsx` | **Adapt** | Re-anchor with drei `Html` to each socket's world position; rebuild with tokens | S |
| Configure layout (`App.tsx` grid, compact tabs) | **Adapt** | Right structure; rewire state to BuildRegistry (proposed versus active), slots by tier and slot cost, embed the goal form, remove "Run backtest", wire "Activate build" | L (P6-U6) |
| `SkillCard`, `SkillDetail`, `SkillInventory`, `PublisherMark` | **Rebuild on our design system** | Good designs, but every one uses raw values and custom overlays; rebuild on `Card`, `Badge`, `Dialog` or a new `Sheet`, using the prototype as the visual spec | M each for P6-U6 and P8-U2, shared |
| `AgentOverview`, `AgentHeader`, `SocketStrip`, `BottomPanel` | **Rebuild on our design system** | Same reason; also must show canonical states (4.12) and the beta label | M (P6-U6) |
| `RunPanel` | **Rebuild later, only if needed** | No planned page needs a simulated run; real cycle logs come from the narrator | S |
| `MintControl` state machine and `useMintAgent` | **Adapt the logic, rebuild the UI** | The state model and receipt parsing are right; our mint adds USDC approve, tier, allowlist state and `AgentMinted` parsing | S to M (P1-U10) |
| Ownership gate (`useOwnedAgents`, `useAgentLoad`, `useLiveOwner`) | **Adapt as a pattern** | Our list comes from the API with a watermark (P1-U4), not `tokenOfOwnerByIndex`; the fresh `ownerOf` recheck before acting is worth keeping | S |
| `metadata.ts` | **Port with small changes** | Small, correct, generic | S |
| `AgentCollection` | **Rebuild on our design system** | Good card design for My Agents and the gallery | S to M |
| RainbowKit config, `wallets.ts`, `session.ts`, `WalletButton` | **Drop** | Privy replaces them (D-045, D-115) | none |
| `ApiaryAgents.sol`, tests, deploy script | **Drop** (copy two patterns by hand) | Fails every AgentNFT requirement (4.2) | none |
| `data.ts` mock skills and publishers | **Drop** | Real company names; wrong skill model (4.3, 8.2) | none |
| `DevPanel` | **Port to the dev console** | Useful for tuning sockets and scale; must not ship in `apps/web` production | S |

---

## 7. Units this accelerates

| Unit | How much | What the prototype supplies | What is still to build |
|---|---|---|---|
| **P6-U1** 3D asset pipeline | **Most** | A working body, the full image-to-3D, rig and optimize chain, the R3F scene, platform, lighting, error handling | Sockets, nine part models plus one generic part, per-tier color variants, size budget, thumbnails, licensing |
| **P6-U6** Configure page | **Large** | Layout, interaction model (hover lights the socket, empty socket filters the inventory, detail slide-over), responsive tabs, visual spec for every panel | BuildRegistry wiring, proposed versus active, slot arithmetic, capability deltas from manifests, goal form, build history, static fallback, rebuilding every component on our tokens |
| **P1-U10** Mint page | **Moderate** | Mint transaction states, receipt parsing, the 3D body for the tier cards | USDC approval and payment, tiers, supply, allowlist state, Privy, landing page counters |
| **P8-U2** Marketplace and skill detail | **Moderate** | Skill card, skill detail, publisher mark, verified badge, filter design | Real listings, escrow purchase, "Equip to agent", creator portal |
| **P1-U9** My Agents | **Small** | Agent card and empty states | Everything about funding, balances, spend, feed |
| **P5-U1** Agent profile and build card | **Small** | Header layout, "What this agent does" panel | Feeds, research board, "why the agent did not trade" |
| **P7-U7** Agent gallery | **Small** | Agent card | Grid, filters, static fallback |
| **P0-U6** Design system | **Small** | The token values in 2.3 | Applying them and re-baselining screenshots |
| **P1-U3** AgentNFT | **None** | Two hand-copied patterns | Everything |

### 7.1 Can 3D move earlier?

**Yes, and P1-U10 is a reason to do it.** P6-U1 depends only on P0-U1 (`BUILD_PLAN.md > 3`, Phase 6 table), so its late position (unit 48 of the build order) comes from ordering, not from a dependency. Meanwhile P1-U10's mint page must show "the base body per tier", which needs the body from P6-U1. Today that is an unstated dependency.

Recommended change, for the owner to decide and record as a D-number in `DECISIONS_AND_OPEN_QUESTIONS.md` (reordering units is an owner decision; `CLAUDE.md` says build in plan order):

1. **Move P6-U1 (reduced) to just before P1-U10** in section 4, starting from this prototype. Its beta reduction already fits: one base body with a color variant per tier, sockets, nine part models, one generic part.
2. **Add P6-U1 to P1-U10's "Depends on"**, so the mint page's tier cards render the real body.
3. **Keep P6-U6 where it is.** It depends on P6-U5 (skills listed as NFTs) and on BuildRegistry (P6-U2); the prototype does not remove those dependencies.

An option the owner may prefer: split P6-U1 into a body-and-viewer unit before P1-U10 and a parts unit later, because the nine part models need the nine skills' final names and the socket layout, which are firmer by Phase 6.

The deadline is October 13, 2026, and Phase 0 has just closed (`LOGS.md`). Pulling 3D earlier only helps if the art work (sockets, parts) runs alongside the backend units; the configure page itself cannot move ahead of the contracts it writes to.

---

## 8. Risks

### 8.1 Dependencies and integration

- **RainbowKit versus Privy.** The prototype's wallet layer conflicts with D-045 and D-115. Drop it entirely; do not install both.
- **wagmi and Privy versions.** Privy's wagmi adapter pins a range of wagmi 2.x. The prototype's wagmi 2.19.5 and viem 2.56.9 are only safe to carry over if that adapter accepts them; check at P1-U2.
- **TypeScript 7 versus 6.** Prototype code was checked by TS 7.0.2; ours runs ^6.0.3 strict. Expect small type differences on port.
- **Vite to Next.js.** `import.meta.env`, module-scope `window` access (`wallets.ts`, `App.tsx`'s `matchMedia` initializer) and the absence of client boundaries all need changes. The Canvas must be dynamically imported with `ssr: false`.
- **Bundle size.** three plus drei add a large client bundle; they must stay out of every route except configure, mint and gallery.
- **Design-token guard.** 195 lines in 22 of 38 prototype source files contain raw hex, `rgba()` or arbitrary pixel values (`text-[11px]`, `rounded-[4px]`, `shadow-[...]`, `h-[34px]`) that `design-tokens.test.ts` rejects. Nothing can be pasted in; every component is rebuilt on tokens.
- **3D colors and tokens.** Shader uniforms and light colors are hex in `AgentScene.tsx`. Our guard forbids hex in components, so the 3D module must read colors from CSS variables at runtime (`getComputedStyle`) or from a token export generated from `styles.css`.
- **Decoders.** If Draco compression is ever used, drei's `useGLTF` fetches the Draco decoder from the gstatic CDN by default; self-host it. Meshopt (used by `bee.glb`) decodes from a bundled module and is fine.
- **OpenZeppelin.** Not in our repo yet; if P1-U3 uses OZ 5.x it arrives through Soldeer (D-148), not npm as in the prototype.

### 8.2 Licensing and provenance

- **Model license (Q-25).** The mesh came from Meshy AI. Meshy's terms differ by plan: outputs on its free plan have historically been public under a Creative Commons attribution license, and paid plans grant private, commercial ownership. Which plan produced this file is not recorded. Q-25 requires an image-to-3D tool with a commercial license. **Do not ship the bee until the owner confirms the plan and the terms in force when it was generated**, or regenerate it on a paid plan.
- **Concept art.** `images/1.png` has no recorded source or license. Confirm before it is used as token art or on the mint page.
- **Rig.** UniRig produced the skeleton; confirm its license covers commercial use of outputs, and note whether an online service was used (the `Bee_rig.glb` download marker suggests one).
- **Real company names and brand colors.** `data.ts` uses Arbitrum, Chainlink, Pyth, Morpho Labs and Kuru as skill publishers with their brand colors, plus made-up audit, stake and usage figures. Shipping that implies endorsement and misstates facts about real companies. Use none of it, not even in a demo video.
- **Prototype code.** The prototype carries no license file. It appears to be the owner's own work; if anyone else wrote any part, confirm before copying code. It is not on the clean-room list in `CLAUDE.md` (BoringVault, Morpho, Zodiac, monad-agent-kit, Bankr); the Morpho name in `data.ts` is a mock publisher label, not Morpho code.

### 8.3 Conflicts with our rules and plan

- **Em dash.** `index.html`'s title puts an em dash between "Apiary" and "Configure". That is the only em dash in the prototype's source, metadata and contract; strip it if any text is reused (`CLAUDE.md`: never use em dashes).
- **No backtest button.** The prototype has "Run backtest" in the bottom panel; `FINAL_PLAN.md > 4.10` says the configure page has no backtest button.
- **Unlabeled demo data.** The agent header shows a hard-coded Vault TVL ($12,480, +2.1%), 6 depositors, 41 watchers and 2 signal buyers from `data.ts`, with a "Running" status, and the overview's "Run agent test" plays a canned log. `BUILD_PLAN.md > 1` requires demo and simulated activity to be labeled at origin.
- **"Deploy build" wording.** The prototype's disclaimer says "Deployed builds trade real funds". Our flow is "Activate build" via `setBuild`, and every financial screen must show the environment and the "unaudited beta" label.
- **Frontend rule.** `CLAUDE.md` requires every page to use only design-system components and tokens; see 8.1.
- **Static fallback.** P6-U6 requires a render without WebGL; the prototype fails without it.
- **Production debug output.** The bone table is logged in production builds, and the dev panel shows in production.
- **Client-only gate.** Model files are public static assets; the ownership check only decides what the UI shows. The prototype README says so. For us this matters little (art is public NFT media), but the configure page's write actions must go through the API's ownership and epoch checks, never this gate.
- **Contract.** Free unlimited mint and unrestricted transfers contradict AgentNFT (4.2). Not to be deployed anywhere connected to our environments.
- **Chain.** Monad testnet 10143 only; our beta is mainnet 143 with labeled testnet fallbacks. Fine for a reference, not for config.

### 8.4 Secrets and agent configuration

- The prototype contains `.env` and `contracts/.env`. Their values were not read (only variable names were listed, with values redacted). `contracts/.env` is where the prototype keeps `PRIVATE_KEY`. **Never copy either file into this repository.**
- **No `.claude/` folder** exists in the prototype. **No hooks** of any kind: it is not a git repository (no `.git`, so no git hooks), there is no Husky, and neither `package.json` defines `prepare`, `postinstall` or other lifecycle scripts. Nothing was ignored on that account because nothing was found.
- The prototype README contains no instructions aimed at an AI agent.

---

## 9. Suggested next steps

1. Owner confirms the Meshy plan and terms, the concept art source and the UniRig terms (8.2). Record the answer under Q-25.
2. Owner decides the font question (Inter and JetBrains Mono, or keep Geist) and approves the token changes in 2.3; apply them as a P0-U6 follow-up with re-baselined screenshots.
3. Owner decides whether to move P6-U1 (reduced) before P1-U10 and records it as a D-number (7.1).
4. P6-U1 starts from `bee_rig_opt.glb`, `AgentScene.tsx` and `RiggedBee.tsx`: add socket empties parented to body, head and abdomen bones in Blender, prune unused skin attributes, apply meshopt, set a size budget (the prototype shows 3.65 MB unoptimized geometry is the ceiling to beat), add the static fallback.
5. P6-U6 and P8-U2 use the prototype's screens as the visual specification, rebuilt on `packages/ui`.
