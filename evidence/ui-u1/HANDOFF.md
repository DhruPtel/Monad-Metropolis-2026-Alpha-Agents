# UI-U1 handoff: the owner's main pages, redesigned

Unit: UI-U1. Status: done.

## Commits

- `c87c1ab` feat(web): the owner-page components (UI-U1): the trading tile, the credits tile, position tiles, the portfolio hero, the guided setup flow, a standard loading block and the coming-after-the-beta page in packages/ui; the activation checklist takes an action and plain words per unmet item; the holdings panel is a tile grid; the fund panel keeps the funding address alone; the allowlist badges say what to do; an Owner pages section on /design [UI-U1]
- `978f9a0` feat(web): My Agents and the portfolio redesigned (UI-U1): the trading account as each card's centerpiece with its value, allocation, performance line, state and one primary action, credits and Research now near the top with add credits in a dialog, spend, activity, the funding address and holdings at the bottom; the portfolio opens with a visual hero, automatic trading right under it with every unmet check linked to its action and the permission item carrying the Turn on button, a guided setup flow, positions as tiles, deposit and withdraw in small dialogs that clear on success; plain-language allowlist messages; the nav keeps the live pages and every other path shows a designed coming-after-the-beta page; standard loading states; the specs follow [UI-U1]
- `2868a76` test(web): the redesigned pages' baselines at 1440px and 380px (UI-U1): every capture re-recorded for the trimmed nav, the credits tile, the add-credits, deposit and withdraw dialogs and a deposit done captured with axe; later setup steps keep their contrast (L-233), a blocked first step keeps its disabled button, the specs close a dialog before reading the page behind it (L-234) and the scans wait for finite animations (L-235); the vault, window, login and design specs follow the new words, links and home page [UI-U1]
- The last commit: docs(plans): the UI-U1 LOGS entry, L-233 to L-235, A-93 and this handoff [UI-U1]

## Test results

| Check | Result |
| --- | --- |
| packages/ui component tests | 12 new (TradingTile open, none and unread; CreditsTile; PositionTiles with a missing price and empty; PortfolioHero with and without a total; SetupFlow; PageLoading; ComingLater; ActivationChecks with actions and notes), the fund panel's and the caps' tests updated; 23 files, 593 passed |
| apps/web unit tests | the setup flow's rules (4: the first step with the only action, the allowlist naming and blocking with the button kept, the deposit threshold at 5 USDC, an API without goals and the armed states), the trading state words and the research line (2), the v2 asset rows (2); 27 files, 224 passed |
| Playwright my-agents.spec.ts (1440px and 380px, axe on every captured state) | 26 passed: the trading tile first with "Set up trading", the credits tile with the balance against the cap, the held note and Research now with its cost, the paused note saying what to do, Research now with no confirmation and its result, the refund dialog, add credits in its dialog (credited, over the cap, declined), another wallet seeing nothing |
| Playwright portfolio.spec.ts and portfolio-v3.spec.ts | 56 passed: the setup flow (the first step next with its action, blocked with the plain words, done after opening), the hero's total, donut, line, mode and prices, the arming card right under the hero, the permission item carrying the Turn on button, each unmet check's action, deposit and withdraw in their dialogs with every block named on the page and in the dialog, a success clearing the amount, the v3 account's tiles with their gains, the older account, the activation sweep, the plan, the managed account |
| Playwright vault, window, login, design, holdings, research, skills, settings, goal, mint, portal, wallets specs | pass with the new words, the trimmed nav, the home page's links and the tile grid |
| Playwright web suite, whole, plain run after the baselines | 302 passed and 2 skipped at both widths (an earlier plain run passed 296 with 6 failures from the scan helper waiting on an endless animation, L-235, fixed and rerun) |
| vitest node | 139 files, 1656 passed (vitest exits 1 on the pre-existing unhandled rejection of scan.test.ts) |
| forge, pnpm test:fork | not run: no contract and no address changed |
| pnpm typecheck, lint, format | clean |

Acceptance, as the prompt lists it:

- Redesigned from the design system, new components added to packages/ui and /design first, tokens only: `/design#owner-pages` shows every new component in every state; no one-off styling.
- The owner's UI direction: at most two inputs on a page (none on My Agents or the portfolio outside dialogs); every other input in a small dialog opened by a button (Add credits, Deposit, Withdraw, the managed-account choice); squarer tiles about three across (the trading and credits tiles, positions, credits, goal, limits and gas, the holdings); every checklist item, error and empty state in plain words with its action beside it.
- My Agents: the trading account is the centerpiece with its value, allocation chart, performance line, state and one primary action; credits near the top with Add credits in a dialog and "Research now" with one line on what it does and costs; spend, activity, the funding address with its QR code and all holdings at the bottom, the holdings as tiles.
- The portfolio: a visual hero; automatic trading directly under it; every unmet activation item linked to its action, the trading-permission item saying it is registered by the owner's wallet when they press "Turn on automatic trading" with the button right there; Deposit and a smaller, secondary Withdraw opening small dialogs; positions as tiles; one guided setup flow for opening, depositing, the goal and turning on.
- Messages: no "allowlist" wording reaches the owner; a validation or error message clears as soon as an action succeeds, and a successful deposit shows success alone.
- Navigation and loading: Dashboard, Gallery, Leaderboard, Marketplace and Create are out of the nav; "/", their paths and any unknown path show a designed "coming after the beta" page; My Agents and the portfolio show a loading block while they load.
- Tests: component and screenshot tests at 1440px and 380px with an accessibility check on every captured state; the existing e2e flows pass.

## Model spend

None: no model was called in this unit.

## What the owner should check or try

- `pnpm dev:all`, then My Agents: the trading tile with "Set up trading" or "Open portfolio", Add credits in its dialog, "Research now" and its line; the portfolio: the setup flow, the hero's Deposit and Withdraw dialogs, the "Turn on automatic trading" button beside the permission item in the checklist, positions as tiles.
- `/design#owner-pages` shows the components in every state; `/leaderboard`, `/gallery` or any unbuilt path shows the coming-after-the-beta page with the live pages.
- The words: any wallet off a deposit allowlist now reads "not yet allowed to deposit during the beta: ask the platform to add it".

## Open issues for the next unit

- The console's Agents page keeps the older layout; the owner's direction was for the web app's pages.
- The window page keeps its AssetMakeupTable; its tiles could follow the portfolio's.
- The My Agents card makes two more owner reads per poll (the arming and the window); a combined route would cut them if the poll ever matters.
- The vault page's deposit and withdraw already use dialogs (P7-U4); its cards could share the hero's shape in a later pass.

Push: `git push`
