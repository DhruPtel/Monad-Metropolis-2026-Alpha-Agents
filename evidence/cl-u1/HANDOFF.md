# CL-U1 handoff: cleanup of the open issues inside the beta scope

Status: done. Two readings recorded as assumptions (A-99, A-100). Started on the owner's instruction after M-FAST.

## Commits of this unit

- one commit: fix(agent): CL-U1's cleanup (the scan test's unhandled rejection, the replayed X search's text line, the hourly feed grace, the canary confirmed timer, the testnet stack's playtest steps, the skill editor's browser-side first pass) [CL-U1]
- one commit: docs(plans): the CL-U1 LOGS entry, L-257, A-99, A-100 and this handoff [CL-U1]

## Test results

- typecheck, lint, format:check clean.
- Tests passing: packages/skills (with the new quick-check test), packages/policy, services/data-tools, packages/domain, the web editor test, and services/orchestrator/src/scan.test.ts with a clean exit code (the unhandled rejection is gone).
- Playwright not run: no page changed its layout.

## What the owner should check or try

- `pnpm test` in the node project now exits 0.
- At the next `pnpm testnet:up` (after the recording), watch the two new lines at the end of its start: the allowlist upserts and the gas step; both report a failure without stopping the stack. The change could not be run live during this unit.
- In the skill editor, a broken skill.json or a disallowed file path shows its finding at once, before any round trip.
- Replay a Dive with an X search: each post now says its text was not kept.

## Open issues

- A-99 (the 15-minute hourly grace) and A-100 (X text stays unstored) are for the owner to confirm.
- The testnet stack's new start steps were not run live.

## Push

```
git push
```
