# apps/web

The Alpha Agents web app (P0-U6). Pages arrive in their own units (FINAL_PLAN.md 4.10) and are built only from the design system in `packages/ui`. See "Web app and design system" in the root README.

- `src/app/globals.css`: imports the design tokens from `@alpha-agents/ui/styles.css`.
- `src/components/shell`: the app shell (navigation, chain indicator, beta banner).
- `src/app/design`: the `/design` page, every token and component in every state.
- `e2e`: Playwright screenshot, accessibility and navigation tests, with baselines in `e2e/__screenshots__`.
