# apps/web

The Alpha Agents web app (P0-U6). Pages arrive in their own units (FINAL_PLAN.md 4.10) and are built only from the design system in `packages/ui`. See "Web app and design system" in the root README.

- `src/app/globals.css`: imports the design tokens from `@alpha-agents/ui/styles.css`.
- `src/components/shell`: the app shell (navigation, chain indicator, beta banner).
- `src/app/design`: the `/design` page, every token and component in every state.
- `e2e`: Playwright screenshot, accessibility and navigation tests, with baselines in `e2e/__screenshots__`.

## Since 2026-10-13

- Home: the Vivarium logo in the hero, Mint an agent first, the flow pills larger.
- Set goal: style tiles with the owner's icons, the allocation split, the most positions, and every section folded as a collapsible card; Research settings (model tier, how often, budget, reserve) live on the Research tab.
- Research: the run's status, a research record, What happened written live from each call, a clickable branch chart with a step panel, and Review plan when a run finishes.
- Trading: Automatic trading folds to its state, Live trades with progress per token and each leg's state, a collapsible trade history, plan cards labelled with their run; a plan the account already matches shows as Hold.
- Overview and Vault: one shared Activity panel (`src/components/activity`); the Vault tab's About as a plain list and the Deposit tab first.
- Configure: a 2D or 3D view, quick links, a skill-slot toggle, and the skill inventory as catalog cards in pages of six.
- Mint: only the final catalog of 25 species with art; no 1 of 1 badges.
