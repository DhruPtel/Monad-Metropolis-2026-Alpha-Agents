# BK-U1 handoff: bring your own key

Unit: BK-U1. Status: done.

## Commits

- `5298c29` feat(agent): the owner's own data keys at rest: PAID_DATA_SOURCES, keyHint, ownerKeyProblem, the platform's one sealed envelope (sealSecret, openSecret), OwnerKeyStore with platform.owner_keys (migration 0032) and tool_calls.paid_by; 12 tests [BK-U1]
- `bd9430f` feat(tools): Dune on the owner's own key for that agent alone: the data tools ask for the agent's key, run the saved query on it with budgets under the agent's scope, charge nothing and meter the call as the owner's; the orchestrator opens the key for the tool servers only and redacts it; the console marks such calls; a test with a recorded Dune response [BK-U1]
- `b9900b3` feat(api): the owner's data key routes: GET, PUT (sealed under ORCHESTRATOR_SECRET, answering the hint alone), DELETE; 2 tests [BK-U1]
- `792d6bd` feat(web): the settings components on /design: DataKeyCard, DataKeyGrid, DataKeyForm; 2 component tests [BK-U1]
- `9096d88` feat(web): the owner's settings page at /agents/:id/settings, the links from the portfolio, the skills page and My Agents, the screenshot suite at 1440px and 380px with axe [BK-U1]
- `a043d6b` test(web): the skills and design baselines with the Settings link and section [BK-U1]
- `afc0acb` test(web): the portfolio and My Agents baselines with the Settings link [BK-U1]
- The last commit: docs(plans): the BK-U1 LOGS entry, A-92 and this handoff [BK-U1]

## Test results

| Check | Result |
| --- | --- |
| packages/domain, packages/trading | the paid source registry, the hint and the key's problems (3); the sealed envelope round trip, a tampered or foreign ciphertext refused (1); the store: sealed at rest, listed by hint alone, opened for the tool servers, replaced, deleted outright, another agent empty (1) |
| services/data-tools | Dune on the owner's key for that agent alone with a recorded Dune response: the other agent refused before the meter and told where a key goes, the key sent to Dune and in no answer or meter record, the call priced at 0 and metered as the owner's, the next call refused once the key is gone (1 new, in 44) |
| apps/control-api | the key routes: the list to the owner alone, the sealed row opening to the key under the secret, the hint-only answers, another owner refused, replacement and deletion (2 new) |
| packages/ui | 2 component tests; the design-tokens test over the new page |
| apps/web unit | 212 passed |
| Playwright settings.spec.ts (1440px and 380px, axe on every captured state) | 8 passed: the Dune tile without a key, adding a key in the dialog (the key sent once, the input emptied, the tile showing the hint alone, nothing of the key in the page), removing it, another owner's wallet, the page without a wallet |
| Playwright skills.spec.ts and design.spec.ts | 18 passed with the Settings link and section |
| Playwright portfolio, v3 portfolio and My Agents specs | 82 passed after their baselines took the Settings link and button (one plan test missed a status line's 5-second window on the plain rerun and passed when portfolio.spec.ts ran again, 44 of 44: a timing noted in the LOGS entry) |
| Playwright web suite | 301 passed and 2 skipped at both widths, with one holdings capture of My Agents differing by the new buttons; refreshed and 8 passed on a plain rerun |
| vitest node, ui, web; the forks project | node 139 files, 1656 passed (vitest exits 1 on the pre-existing unhandled rejection of scan.test.ts); ui 22 files, 577 passed; web 25 files, 212 passed; the forks project 17 files, 67 passed one file at a time |
| pnpm typecheck, lint, format | clean |

Acceptance, as the prompt lists it:

- An owner adds their own Dune API key, and the same mechanism for other paid data sources: `PUT /v1/agents/:id/keys/dune`; `PAID_DATA_SOURCES` takes the next source by one row and one branch in the data tools (A-92).
- Stored encrypted: AES-256-GCM under ORCHESTRATOR_SECRET (`platform.owner_keys.ciphertext`); the test opens the row to the key and nothing else does.
- Used only for that owner's agent through the platform tool servers: the data tools ask for the calling agent's key; the other agent is refused; the live orchestrator opens the key in its own process for the tool servers alone.
- Never placed in the sandbox: nothing of it is written to the sandbox's files or environment (the key accessor exists only in the tool server deps, not in the task context or `materialize`); logs: the orchestrator registers the key with its redactor the moment it opens it; the browser after saving: every answer carries the hint only, the page clears the input before the save returns and never shows the key again (settings.spec.ts).
- Deletable: `DELETE` removes the row outright; the next call is refused as not configured.
- Metered separately: `tool_calls.paid_by` and the daily budgets under `dune:owner:<agent>`; the console's research page marks calls on an owner's key; such calls charge the agent's credits nothing (A-92).
- With the owner's key present, the Dune tool becomes available to that agent only: the data tools test, with the platform holding no Dune key at all.
- The settings page from packages/ui per the owner's UI direction: one tile per source, one input in a small dialog, every state saying what it means and what to do next.
- Tests include encryption at rest, the key never reaching the sandbox, logs or the browser after saving, another agent never using it, deletion, and a recorded Dune response.

## Model spend

None: no model was called in this unit.

## What the owner should check or try

- `pnpm dev:all` (the control API now needs ORCHESTRATOR_SECRET, which .env has), then open an agent's portfolio and follow "Settings": add your Dune key; the tile shows its last four characters only. Run a research task: the console's Research page shows the dune_query call marked "Owner's key" with no charge.
- `/design#settings` shows the components in every state.
- Remove the key: the next dune_query answers that Dune is not configured and says where a key goes.

## Open issues for the next unit

- X and CoinMarketCap stay on the platform's keys; adding them to `PAID_DATA_SOURCES` needs each source's own key path in the data tools.
- The console's Research sources page shows the platform's daily Dune use; an owner's scope is counted apart but not shown there yet.
- A key saved while a sandbox is running is used from the agent's next tool call, since the tool servers read the store per call.

Push: `git push`
