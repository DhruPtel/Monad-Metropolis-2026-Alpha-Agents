# @alpha-agents/ui

The design system shared by `apps/web` and `apps/console`.

- `src/styles.css`: the design tokens, the only place raw values appear. Apps import it with `@import "@alpha-agents/ui/styles.css";` and list `@alpha-agents/ui` in `transpilePackages`.
- `src/components/ui`: base components. `src/components`: product components (StatusPill and ReasonMessage render from packages/domain).
- `src/tokens.ts`: the token manifest the `/design` page renders.
- Tests: component tests under jsdom, and a guard that fails on any raw color, size or font in this package or in any app, and on any component missing from `/design`.

`components.json` lets the shadcn CLI add components here; rewrite its `@/` imports to relative paths, because consumers resolve this package from `node_modules`.
