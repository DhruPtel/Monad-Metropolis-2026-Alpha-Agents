UNIT: P0-U1 Repo and tooling

GOAL
Turn the repository into a working pnpm monorepo with linting, formatting, type checking, an empty test suite, and CI, so every later unit starts from a clean, checked base.

READ FIRST
CLAUDE.md, LESSONS.md, Planv2/BUILD_PLAN.md (build rules, unit prompt template, Phase 0 owner setup checklist, P0-U1), and the repository layout described in Planv2/FINAL_PLAN.md.

DEPENDS ON
Nothing.

IN SCOPE
1. pnpm workspace at the repo root: package.json, pnpm-workspace.yaml, .nvmrc set to Node 22, and an engines field for Node 22 and pnpm 9.
2. The folder layout from the plan: apps/web, apps/control-api, services/, packages/, chains/monad, chains/solana, infra/, evidence/, docs/adr/. Each folder gets only a short README.md stating its purpose. Do not scaffold any framework or app.
3. Shared tooling at the root: tsconfig.base.json with strict mode, ESLint with a flat config, Prettier, .editorconfig.
4. Root scripts: lint, format, format:check, typecheck, test. Use Vitest for test, configured to pass when there are no tests yet.
5. GitHub Actions workflow at .github/workflows/ci.yml that runs on push and pull request to main: install with a frozen lockfile, then lint, format:check, typecheck, and test.
6. Update .gitignore for pnpm, coverage output, and tool caches, keeping every existing entry.
7. Update README.md: replace the line "Do not use with real funds." with: "Status: unaudited beta. Mainnet access is limited to allowlisted testers with capped funds. Do not deposit funds you cannot afford to lose." Add a short section on the folder layout and the commands to install, lint, and test.
8. Create Planv2/units/ containing TEMPLATE.md (the unit prompt template from BUILD_PLAN section 1) and P0-U1-repo-and-tooling.md (this prompt, copied exactly).
9. Branch rule: update the build rules in Planv2/BUILD_PLAN.md to say all units commit directly to main, replacing "one branch per unit". Add the same rule to the Commits section of CLAUDE.md. Record it in Planv2/DECISIONS_AND_OPEN_QUESTIONS.md as an owner decision.
10. LOGS.md: add a first entry titled "Setup", recording the status of the Phase 0 owner setup checklist: installed (Node 22.23.1, pnpm 9.14.4, git, Python 3.13.11, Foundry 1.8.3 in ~/.foundry/bin), missing (Docker, Foundry on PATH), and not yet verifiable (all accounts and API keys).

OUT OF SCOPE
Foundry projects or contracts, Docker or any database, .env files or secrets (P0-U3), shared domain packages (P0-U5), the dev console (P0-U4), Next.js or any app framework, and any dependency beyond the tooling listed above. No network calls other than pnpm install.

DELIVERABLES
Workspace config, folder layout with READMEs, tooling configs, CI workflow, updated README.md, updated .gitignore, Planv2/units/ with two files, updated BUILD_PLAN.md, CLAUDE.md, and DECISIONS_AND_OPEN_QUESTIONS.md, and two LOGS.md entries (Setup and P0-U1).

ACCEPTANCE TESTS
- pnpm install succeeds and pnpm-lock.yaml is committed.
- pnpm lint, pnpm format:check, pnpm typecheck, and pnpm test all pass locally.
- ci.yml runs the same four checks with a frozen lockfile.
- git status is clean at the end, with no secrets, build output, or caches committed.
- No em dashes in any document you created or edited.

HOW THE OWNER TESTS IT
1. Push with git push.
2. Open the repository's Actions tab on GitHub and confirm the CI run passes.
3. Locally run: pnpm install, then pnpm lint, pnpm typecheck, pnpm test.

COMMITS
Commit incrementally as each part works, for example:
- chore(infra): add pnpm workspace and root config [P0-U1]
- chore(infra): add TypeScript, ESLint, Prettier, and Vitest config [P0-U1]
- chore(infra): add workspace folder layout [P0-U1]
- chore(infra): add GitHub Actions CI [P0-U1]
- docs: update README with beta status and setup commands [P0-U1]
- docs(plans): add unit template, P0-U1 prompt, and main-branch rule [P0-U1]
- docs: add setup and P0-U1 log entries [P0-U1]

WHEN DONE
Add a LOGS.md entry, and add a LESSONS.md entry for every bug fixed. Commit them. Then post the handoff message described in CLAUDE.md. Do not push.
