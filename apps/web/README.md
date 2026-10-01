# apps/web

The Alpha Agents web app and its design system (P0-U6). Pages arrive in their own units (FINAL_PLAN.md 4.10) and are built only from the components and tokens here. See "Web app and design system" in the root README.

- `src/app/globals.css`: the design tokens, the only place raw values appear.
- `src/components/ui`: base components. `src/components`: product components and the app shell.
- `src/app/design`: the `/design` page, every token and component in every state.
- `e2e`: Playwright screenshot, accessibility and navigation tests, with baselines in `e2e/__screenshots__`.
