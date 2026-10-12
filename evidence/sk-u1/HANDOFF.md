# SK-U1 handoff: private skill upload

Unit: SK-U1. Status: done.

## Commits

- `5a8667f` feat(agent): the owner's own skill as a checked package: the format rules over files in memory as over a folder, checkOwnerSkill with the owner's two rules and the static audit, RULE_WORDS, platform.owner_skills (migration 0031) and OwnerSkillStore; 58 tests, one per rule [SK-U1]
- `e51f60b` feat(agent): the owner's skills mount read-only beside the built-in ones: materialize, the sandbox boot's H-11 probe over the owner's folder, the task context reading the store, the console's skills route; 4 tests [SK-U1]
- `f1ec2e9` feat(api): the owner's skill routes: GET, POST with every finding named, DELETE; 3 tests [SK-U1]
- `0496b7f` feat(web): the skills components on /design: SkillTile, SkillGrid, SkillUploadForm, SkillFindings, OwnerSkillsEmpty; 5 component tests [SK-U1]
- `dd7555a` feat(web): the owner's skills page at /agents/:id/skills, the upload helpers, the links from the portfolio and My Agents, the screenshot suite at 1440px and 380px with axe [SK-U1]
- `1590cf6` test(web): the design page's baselines with the Skills section [SK-U1]
- `f1a24b0` feat(agent): every stage's prompt names the owner's skills as it names the playbook, the live run (pnpm test:skill:live) and its evidence [SK-U1]
- The last commit: docs(plans): the SK-U1 LOGS entry, L-232, A-91 and this handoff [SK-U1]

## Test results

| Check | Result |
| --- | --- |
| packages/skills | 58 passed: every format rule F1 to F8 and static rule S1 to S15 refused with its rule named, the owner's two rules, the words for every rule, the in-memory loader hashing a built-in package as the folder loader does |
| services/orchestrator (the mount, the boot, the prompt line) | the owner's files written as root under the equipped directory, the mount made read-only and the owner's folder probed (H-11), a writable folder refusing the boot, a platform skill's id refused, the prompt line; the scan, cycle and noop suites pass |
| apps/control-api | the routes: the list to the owner alone (another owner 403, no session 401), a refused package with every finding and its words, a package mounted with its warning, the same content again, the same version with other content refused (F1), a new version taking over, removal |
| packages/ui | 5 component tests; the design-tokens test over the new page |
| apps/web unit | 212 passed (the upload helpers among them) |
| Playwright skills.spec.ts (1440px and 380px, axe on every captured state) | 8 passed: the empty state and the built-in tiles, a refused package with its findings, a mounted package with a warning, the owner's tile and the remove dialog, another owner's wallet seeing nothing, the page without a wallet |
| Playwright design.spec.ts | 10 passed with the Skills section |
| Playwright web suite | 272 passed and 2 skipped at both widths, with 22 captures of the portfolio, the v3 portfolio and My Agents differing only by the new Skills link and button; those three specs' baselines refreshed and 82 passed on a plain rerun; skills.spec.ts 8 passed and design.spec.ts 10 passed on plain reruns |
| vitest node, ui, web | node 137 files, 1648 passed (vitest exits 1 on the pre-existing unhandled rejection of scan.test.ts, as in P7-U4); ui 21 files, 570 passed; web 25 files, 212 passed |
| pnpm typecheck, lint, format | clean |
| The live run (`pnpm test:skill:live`) | 11 of 11 checks passed for 0.173 USD: two agents minted and provisioned; the owner's watchlist package passing every rule and recorded by its content hash; listed by the orchestrator as mounted with kind owner and absent from the other agent's mount; a Scan whose sandbox booted with the skill under the read-only mount; the agent loading aa-owner-monad-watchlist with skill_view beside its Scan playbook and writing the OWNER WATCHLIST section the skill asks for and the prompt never names; 0.173 USD of model spend under the 10 USD cap); evidence/sk-u1/live-2026-10-12T08-12-38.267Z.json. The first run passed 9 of 11: the agent loaded only its playbook, so every stage's prompt now names the owner's skills (A-91 item 7); evidence/sk-u1/live-2026-10-12T08-12-38.267Z.json |

Acceptance, as the prompt lists it:

- An owner uploads their own skill package for their own agent only, through the existing skill format and every existing audit check, with clear findings when it fails: `POST /v1/agents/:id/skills` takes the package's files, runs F1 to F8 and S1 to S15 through the same code as the built-in set, and answers 422 with every finding, each with what it means and what to do next.
- Mounted read-only like the built-in skills: `materialize` places the owner's packages under the equipped directory as `aa-<id>`, the boot makes the mount read-only and probes the owner's folder (H-11); the live run's sandbox booted with it.
- Never shown to other owners: the routes are owner-only; another agent's mount has nothing of it (the live run's second agent); the page shows another wallet nothing.
- Versioned by content hash: `platform.owner_skills` keeps one row per version by content hash; the same version with other content is refused.
- The upload page from packages/ui with new components on /design first, per the owner's UI direction: one input (the skill's folder) in a small dialog, tiles about three across, every empty state and finding saying what it means and what to do next.
- Tests: a skill that fails each audit check (packages/skills/src/owner.test.ts), another owner never seeing it (app.test.ts, skills.spec.ts, the live run), the read-only mount (materialize.test.ts, the live run's boot), one live run within the $10 cap where an agent loads an uploaded skill.

## Model spend

0.291 USD over the two live runs (0.118 for the first, 0.173 for the second), both on the Scan model; no other model call.

## What the owner should check or try

- `pnpm dev:all`, then open an agent's portfolio and follow "Skills" (or "Skills" on My Agents): upload a folder with skill.json and SKILL.md (a copy of apps/web/e2e/fixtures/owner-notes with publisher.address set to your wallet is a start); watch the findings for a package that breaks a rule; a package that passes shows as "Yours".
- The agent's next task (a Scan from the portfolio's research action, or a cycle) mounts it; the console's Agents page lists it with kind owner; the Scan's notes follow it.
- `/design#skills` shows every state of the new components.
- `pnpm test:skill:live` repeats the live run on a stack of its own (about six minutes, under 0.20 USD).

## Open issues for the next unit

- The skill is mounted at the agent's next sandbox; a sandbox already running keeps the set it booted with (as for built-in changes).
- The console's Agents page lists the owner's skill but offers no upload; the web page is the owner's.
- The skill marker leak test (B-04, W-1) now has the owner's skills to cover beside the built-in ones.

Push: `git push`
