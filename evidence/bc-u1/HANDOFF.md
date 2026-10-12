# BC-U1 handoff: beta completeness

Unit: BC-U1. Status: done. The second unit of the four-unit session of 2026-10-12.

## Commits

- `4bbd124` feat(agent): the beta's open items closed: the console's Arm with the account it manages, the Trades setup text for vaults, the skills route's running task and the page's note, the research sources page's owner-paid count, X and CoinMarketCap as owner-key sources with migration 0034, the corrected registry deferrals, the in-app skill editor (templates, the check route, SkillEditor and Textarea, the create dialog), the audit, and tests for each [BC-U1]
- The next commit: test(web): the baselines of the skills, settings and design specs and the console suite, and each key tile saying whether the platform's key serves without the owner's [BC-U1]
- The last commit: docs(plans): the BC-U1 LOGS entry and this handoff [BC-U1]

## The audit

evidence/bc-u1/AUDIT.md: every item of the definition of done inside the beta scope is working end to end on the fork; item 8 (the profile, the Gallery, the feed) is after the beta by D-371; the reveal moment is UI-U2's. The registry's 30 live tools resolve; its 24 deferrals each sit outside the beta scope, three of them with reasons corrected in this unit. The gaps found and closed are the five open items of the last handoffs, the skill editor, and the stale deferral reasons; the vault UI's remaining pieces (W-6) and the handover exception are after the beta.

## Test results

| Check | Result |
| --- | --- |
| packages/domain | the three paid sources with their tools and the lowercase ids; the skill templates (in packages/skills: every template passes every check with the owner as publisher, another wallet's publisher refused as F7) |
| packages/market, services/data-tools | X search on the owner's bearer token and CoinMarketCap on the owner's key, each for that agent alone, the other agent refused before the meter and told where a key goes, the key in no answer or meter record, the call priced at 0 and metered as the owner's (2 new, in 80) |
| apps/control-api | the three sources listed and a CoinMarketCap key taken and removed, an unknown source 404; the check route refusing (F7, S1) and passing without saving, another owner 403, a bad body 400; the running task reported from an active lease (3 new, in 78) |
| apps/console | the source posting the chosen account to the arm route and reporting the managed account; the research words (2 new, in 69) |
| packages/ui | SkillEditor: the templates, an edit per file, the check's states, Save closed until the check passes, the blocking count; the design-tokens test over the new section (2 new, 894 in all with the web and console projects) |
| apps/web unit | the editor hook's template files and check states (2 new) |
| Playwright skills.spec.ts (1440px and 380px, axe on every capture) | 12 passed: a skill created from the Owner notes template with the live check passing, a shell command typed into SKILL.md refused as the text changes, the Watchlist template one click away, Save through the upload route with the editor's three files and more than one check before it, the owner's tile after; the running-task notice |
| Playwright settings.spec.ts | 8 passed with the three key tiles, each saying whether the platform's key serves without the owner's |
| Playwright design.spec.ts | 10 passed with the SkillEditor and Textarea specimens |
| Playwright skills, settings and design plainly after the baselines | 30 passed |
| Playwright console suite | re-baselined (the Addresses page carried NFT-U1's new addresses, the Agents page the Manage choice beside Arm) and 114 passed on a plain run |
| Playwright web suite, whole, plain | 308 passed, 2 skipped at both widths |
| vitest node, ui, web, console | node 141 files, 1670 passed and 1 skipped; ui, web and console 59 files, 893 passed |
| pnpm registry:check | passes: 30 live, 24 deferred, each named with its unit |
| pnpm typecheck, lint, format | clean |

Acceptance, as the prompt lists it:

- The audit lists every in-scope feature and tool with its state, and every deferred tool ID with whether it belongs to the beta scope: evidence/bc-u1/AUDIT.md.
- Every gap inside the beta scope built, smallest first: the registry reasons, the Trades text, the Arm choice, the running-task note, the owner-paid count, X and CoinMarketCap, the skill editor; the out-of-scope items are suggestions in the LOGS entry.
- Creating skills in the app: a template to start from, SKILL.md and skill.json (and the template's notes file) in a simple text editor, validated live against the format and audit checks through the platform, saved through the existing upload path; the components in packages/ui on /design first.
- The open items of the last handoffs inside the beta scope: all five closed.
- Tests for everything added, and the registry check passing with no unexplained deferral in the beta scope.

## Model spend

None: no model was called in this unit.

## What the owner should check or try

- `pnpm dev:all`, then an agent's Skills page: "Create a skill", pick Owner notes or Watchlist, edit the text and watch the findings follow (type a shell command into SKILL.md to see it refused); Save mounts it at the agent's next task.
- Settings: add an X bearer token or a CoinMarketCap key; the console's Research page then counts the day's calls on owners' keys and marks each.
- The console's Agents page: "Manage: vault" beside Arm registers the vault's grant without expiry; the Trades page's setup cards say so.

## Open issues for the next unit

- The vault UI's remaining pieces (W-6), the reduce-only handover exception and the parity fixture's vault case are after the beta.
- The editor checks through the platform after a 600 ms pause; a browser-side first pass of the format rules would cut round trips on slow links.
- The window page's tiles, the console's Agents page layout and the reveal moment are UI-U2's.

Push: `git push`
