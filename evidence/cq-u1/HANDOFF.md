# CQ-U1 handoff: cleanup after the sprint

Status: done. UX-U2 was not started, on the owner's change of plan (front-end work moved to the ui-lane worktree).

## Commits

- 6bf9b62 refactor(agent): remove 17 unused definitions, share the owner pages' two-decimal USDC and percent formatters, and register the variables the stacks read [CQ-U1]
- 9571a7e fix(web): hold every owner page's polls while its tab is hidden, read MAX_SUPPLY once and USDC's price once per portfolio read [CQ-U1]
- a3c705f docs(infra): the README's architecture, where things live and how to run each stack (local fork, testnet, hosted, Base fork), and a README for every package and service that lacked one [CQ-U1]
- 25180c6 test(web): the web suite on UX-U1's tabbed portfolio and vault, the reports route in the e2e fake, a tab opened by its link, and the baselines retaken [CQ-U1]
- efe1568 test(web): the console's baselines with the Base environment's address book tab and MINT_OPEN on the environment page, checked at 1440px and 380px [CQ-U1]
- the records commit: docs(plans): the CQ-U1 LOGS entry, L-264, L-265 and this handoff [CQ-U1]

## What changed

- Dead code: knip found no unused file. 17 unused definitions were deleted, with the imports they left unused. The dead vitest coverage setting was removed.
- Loose ends:
  - Identical formatters and `alive()` are now shared.
  - The window page's links into the portfolio's tabs work again (L-264).
  - The e2e fake now serves the reports route.
  - The web specs now follow UX-U1's tabbed layout (L-265).
- Connections:
  - Every web call reaches a route, and every route reaches its service.
  - Nine undocumented variables are now in the registry and `.env.example`. None is set in `.env`.
  - `registry:check` passed.
  - The address book matches every environment: local per `test:fork`, testnet 32 of 32, canary 49 of 49, Base 37 of 37.
- Efficiency:
  - Polls wait while their tab is hidden.
  - `MAX_SUPPLY` is read once.
  - The v3 portfolio reads USDC's price once.
- Docs: the README covers the architecture, where things live and all four stacks. Eleven folders gained a README.

## Test results

- `pnpm typecheck`, `pnpm lint` and `pnpm format:check` are clean.
- vitest:
  - node, ui, web and console projects: 2,650 passed, 1 skipped.
  - forks project: 70 of 70.
- `pnpm test:fork`: 54 forge tests pass, and the address book check passes. Every deploy receipt was read on its own fork.
- Web Playwright: 308 passed, 2 skipped on a plain run after the re-baseline, with each spec's axe scan clean. The first run since UX-U1 had failed 26 tests; those are fixed.
- 51 web and 4 console captures were retaken after checking each one at 1440px and 380px.
- Console Playwright: 122 of 122.

## What the owner should check

- At https://vivarium-testnet.vercel.app, open an agent's performance window and press "Recent trades". The portfolio should open on its Trade history tab.
- On Research, the reports card should say "No reports yet", or list the reports.
- After the reboot, the stack, tunnel and registrar were restarted and Vercel was redeployed to the new tunnel URL. If logins fail, check that Privy's allowed origins still include the Vercel URL.

## Open issues for the next unit

- The vault page's deposit and withdraw sit in the "Your performance" tab, which is closed by default. This is for the front-end lane.
- `class-a.fork.test.ts` rewrites the tracked `evidence/f-t2/registrar-gas.json` on every run.
- The control API's owner check reads ownership twice on every owner request, with no cache. This needs a decision, because the check is meant to be fresh (FINAL_PLAN 4.10).
- About 328 needless `export` keywords.
- The `packages/workflows` package, which nothing imports yet.
- The `tailwindcss` devDependencies may be redundant.
- From M-FAST:
  - The Base trade flow still needs the v2 reader.
  - The Scan hits its turn cap on a new chain.
  - The orchestrator's log lines go missing on the Base stack.
  - The SIGNER_DOWN incident's resume path is unchecked.
- A-99, A-100 and A-102 need your confirmation.
- The console's page title still says Alpha Agents. That belongs to the full REN-U1.
- The full list is in LOGS.md.

## Model spend

None in this unit. Spend over the last 24 hours, from earlier units and the stacks, is 3.90 USD.

## Push

```
git push
```
