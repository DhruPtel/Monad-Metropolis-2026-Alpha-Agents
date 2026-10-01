UNIT: P0-U6 Web foundation and design system

GOAL
Create the web app foundation and a design system that every future page is built from: design tokens, base components, an app shell, and a /design page showing everything in one place. This prevents each page from inventing its own styling.

READ FIRST
CLAUDE.md (including the frontend rule), LESSONS.md, Planv2/BUILD_PLAN.md (build rules and applicable "Lessons from Alpha Markets"), the frontend sections of Planv2/FINAL_PLAN.md (4.10 and the page list), and the visual direction in Planv1's design brief. Also read packages/domain for the canonical modes, reason codes, and amount helpers.

DEPENDS ON
P0-U1, P0-U3, P0-U5.

IN SCOPE
1. Plan update: add P0-U6 to the unit list and dependency graph in Planv2/BUILD_PLAN.md, after P0-U5 and before P0-U4, and record it in Planv2/DECISIONS_AND_OPEN_QUESTIONS.md as an owner decision. P0-U4 (dev console) now depends on P0-U6 and must use its components.
2. Next.js app in apps/web with the App Router, TypeScript, Tailwind CSS, and shadcn/ui. Self-host fonts with next/font. Add pnpm dev:web to start it.
3. Design tokens, defined once as CSS variables and wired into Tailwind, so no component uses raw color or size values. Dark theme only for now, structured so a light theme can be added later. Starting values from the design brief:
   - Background: graphite, around #121412, with slightly lighter surface layers for cards and panels.
   - Text: off-white primary, muted secondary.
   - Accent: lime green, around #B6FF3B, used only for primary actions, active states, and positive values.
   - Negative: muted red, used only for losses and errors.
   - Secondary detail: brass.
   - Typography: a crisp sans-serif for UI, and a monospace font for all numbers, amounts, and addresses. A defined type scale.
   - Spacing scale, corner radius, borders, and shadows.
4. Base components, each with all its states (default, hover, focus, disabled, loading, error where relevant):
   - Button (primary, secondary, ghost, danger), Card, Input, Select, Slider, Tabs, Dialog, Tooltip, Toast, Skeleton, Table, EmptyState.
   - StatBar: label, value, bar, and optional positive or negative delta.
   - StatusPill: uses the canonical mode enum from packages/domain, never its own list.
   - RiskBadge (Conservative, Balanced, Aggressive) and DemandCounter (icon, count, daily change).
   - ReasonMessage: renders a policy reason code from packages/domain as the owner-facing message. This is the building block for "why the agent did not trade".
   - AmountDisplay and AddressDisplay: format bigint amounts using the domain helpers, and shorten addresses with a copy button.
   - BetaBanner: the "unaudited beta" label, shown on every page.
5. App shell: top navigation (Dashboard, Gallery, Marketplace, Leaderboard, My Agents, Create), chain indicator, a placeholder wallet button (real login comes in P1-U2), and a placeholder notifications button. Responsive: navigation collapses on mobile.
6. /design page: a token section (color swatches, type scale, spacing) and every component in every state, with realistic sample data from the design brief (agent names like UNIT-07, amounts, modes, reason codes).
7. Tests:
   - Component tests with Vitest and Testing Library.
   - Playwright screenshot tests of the /design page at desktop and mobile (380px) widths, run in the official Playwright Docker image so screenshots match between local runs and CI. Commit the baseline screenshots.
   - An automated accessibility check (axe) on the /design page.
8. CI: add a web job that builds the app and runs the component and screenshot tests.
9. Small fixes carried from P0-U5:
   - Oracle age: a price exactly 300 seconds old must now fail, matching "under 5 minutes".
   - Add a VAULT_IN_HANDOVER reason code with its owner-facing message, and use it for agent swaps on a vault in handover instead of EPOCH_MISMATCH.
   - Update FINAL_PLAN.md 4.4.5 so the tool registry lives in packages/domain, with packages/skills re-exporting it.
   - Record all three in DECISIONS_AND_OPEN_QUESTIONS.md.

OUT OF SCOPE
Real pages (landing, mint, My Agents, and the rest come in their own units), Privy login, data fetching, the API, charts, 3D models, and a light theme.

DELIVERABLES
apps/web with tokens, base components, app shell, and the /design page, component and screenshot tests with committed baselines, the accessibility check, the CI web job, the P0-U5 fixes, updated plan docs, and a README section on the web app and design system.

ACCEPTANCE TESTS
- pnpm dev:web serves the app, and /design shows every token and every component in every state.
- No component contains raw color, size, or font values; everything comes from tokens.
- StatusPill and ReasonMessage use packages/domain directly, and a test fails if a mode or reason code has no rendering.
- Screenshot tests pass at desktop and mobile widths, and changing a token value makes them fail.
- The accessibility check passes with no serious violations.
- The oracle age, VAULT_IN_HANDOVER, and registry location fixes are tested.
- All existing checks still pass: lint, format:check, typecheck, vitest, forge build, non-fork forge tests, secrets:scan, doctor, dev:status, test:fork.
- The CI web job passes. git status is clean.

HOW THE OWNER TESTS IT
1. Run pnpm dev:web and open http://localhost:3000/design.
2. Review the look: colors, fonts, spacing, and how each component feels. Write down anything to change.
3. Resize the browser to phone width and check the navigation and components.
4. After pushing, confirm all CI jobs pass.

COMMITS
Commit incrementally as each part works, for example:
- docs(plans): add P0-U6 design system unit [P0-U6]
- feat(web): add Next.js app with Tailwind and shadcn/ui [P0-U6]
- feat(web): add design tokens [P0-U6]
- feat(web): add base components [P0-U6]
- feat(web): add domain-driven StatusPill, ReasonMessage, and amount display [P0-U6]
- feat(web): add app shell and /design page [P0-U6]
- test(web): add component, screenshot, and accessibility tests [P0-U6]
- chore(infra): add web job to CI [P0-U6]
- fix(infra): apply oracle age, handover reason, and registry location fixes [P0-U6]

WHEN DONE
Add a LOGS.md entry, and add a LESSONS.md entry for every bug fixed. Commit them. Then post the handoff message described in CLAUDE.md. Do not push.
