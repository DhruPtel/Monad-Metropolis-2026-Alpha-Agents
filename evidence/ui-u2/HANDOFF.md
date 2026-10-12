# UI-U2 handoff: polish and fast iteration

Unit: UI-U2. Status: done. The third unit of the four-unit session of 2026-10-12.

## Commits

- `73e402c` feat(agent): the replay tool's backend: every stage's prompt and every cycle's SOUL.md stored, the REPLAY cycle on the stored prompt, caps, ceiling and model with an edited playbook or skill mounted, every tool answering from the stored results through the replay hook and refusing unknown inputs, migration 0035, the saved playbook versions, the routes, and the tests [UI-U2]
- `e678faf` feat(web): the replay tool in the dev console: the Replay link on every model stage, the replay page, the fixtures, the baselines and the tests [UI-U2]
- `130913c` feat(web): the reveal moment and the owner's UI direction on the remaining pages: the moment on the mint panel and My Agents, the window's square tiles and makeup switch, fact tiles, the goal and research tile rows, the vault's tiles, the design page, the tests and baselines [UI-U2]
- `6bd53a4` feat(web): the console's Agents page as tiles [UI-U2]
- `23bc33c` chore(infra): the UI-U2 sources formatted with Prettier, and the live replay evidence [UI-U2]
- The last commit: docs(plans): the UI-U2 LOGS entry, L-238 to L-240, A-95, the migration test's table list, and this handoff [UI-U2]

## Test results

| Check | Result |
| --- | --- |
| services/orchestrator cycle.test.ts | 26 passed: the replay case (the stored prompt sent word for word, the edited playbook mounted under the built-in frontmatter, the original SOUL.md with the replay's marker, nothing fetched, every tool call free and marked replay, the unknown input refused NOT_STORED, the brief accepted against the stored figures, no proposal or activity, the view and the not-replayable reasons) and the routes case (the view, the start, a bad override refused, the save, REPLAY refused as a console cycle; the console's fixtures written) |
| services/orchestrator materialize, playbook-overrides, terminal | the text override under the package's frontmatter, written read-only; the saved versions per agent and playbook, never saved twice, the latest mounted; the terminal's kinds |
| services/data-tools server.test.ts | 26 passed: inside a replay web_search and read_url answer from the hook with nothing metered or fetched, an unknown input refused INVALID_INPUT with the stored-inputs message, another lease untouched |
| packages/db | the migration test lists platform.playbook_overrides |
| packages/ui | reveal-moment (the countdown words, the rarity words with the one-of-one, hidden until Reveal then the art and the rarity, waiting with the time left), goal tiles, research tiles, the makeup switch, the window tiles; the design-tokens test over the new files |
| apps/web unit | the seen flag's key and storage guard |
| apps/console unit | the replay helpers: changed texts, the stored input summary, the comparison rows |
| Playwright web suite (1440px and 380px, axe on every capture) | 308 passed, 2 skipped plainly after the re-baseline: mint (waiting with the countdown hidden in the capture, ready with Reveal, revealed with the rarity and the link, seen after a reload), My Agents (waiting, ready, the moment after Reveal with the one-of-one), window (the tiles, the table toggle), goal, research, vault, design |
| Playwright console suite | 122 passed plainly after the re-baseline: the cycles page with Replay, the replay page (the prompt, the inputs, the editable text, Run replay to the replay's URL, the comparison, Save as new version), the Agents tiles with every earlier control |
| vitest, whole | 222 files, 2665 passed |
| pnpm typecheck, lint, format:check, registry:check | clean; 30 live, 24 deferred |
| Live replay on the dev stack | evidence/ui-u2/LIVE_REPLAY.md: a review cycle (0.216 USDC) and its Zoom out replayed with an edited playbook in a real sandbox (0.186 USDC, the model alone; three calls answered from the store, get_portfolio refused as not stored), the edit saved as version 1 |

Acceptance, as the prompt lists it:

1. The reveal moment: automatic and fair onchain, hidden until Reveal, the rare-pull moment with the real art and the rarity emphasised, one-of-ones special, the pre-reveal placeholder with the time remaining.
2. The performance window: square tiles, the table behind a toggle, friendly empty states.
3. The UI direction on the goal, research, vault and window pages and the console's Agents page.
4. The replay tool in the dev console: pick a stored stage, edit the playbook or skill text in place, rerun on the exact stored inputs, old and new side by side with the cost, only the model paid, edits saved as new versions only when chosen.
5. Component and screenshot tests at 1440px and 380px with the accessibility check for every changed page, and tests that a replay uses only stored inputs.

## Model spend

About 0.25 USD at LiteLLM's cost for the live replay check (11 calls on research-medium); 0.40 USDC charged to agent #1's credits with the markup. The day's spend before the check was 4.468 USD; the gateway's daily budget is 15 USD.

## What the owner should check or try

- `pnpm dev:all`, then the console's Cycles page: Replay this stage on the Zoom out of the review cycle already there, change a line of the playbook, Run replay, compare, Save as new version. Remove the row in `platform.playbook_overrides` to return agent #1 to the built-in text.
- Mint on the web app and watch the countdown, then click Reveal. My Agents shows the moment for an agent whose reveal you never saw in this browser.
- The window, goal, research and vault pages, and the console's Agents page, as tiles.

## Open issues for the next unit

- x_search posts' text is not stored, so a replayed Dive sees posts without their text.
- The brief validator's eight-word rule reads the built-in playbook texts, not a saved version's (W-2).
- A-95 lists the readings to confirm: the moment's pages, the countdown's basis, the seen flag's scope, the replay's limits, the saved version's reach.

Push: `git push`
