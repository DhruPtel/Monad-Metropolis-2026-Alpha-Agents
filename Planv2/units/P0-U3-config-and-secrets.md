UNIT: P0-U3 Config, secrets, and environment IDs

GOAL
A single, validated configuration system for every service: defined environments, a complete .env.example, typed config loading that fails fast and never leaks secrets, and secret scanning so nothing sensitive reaches the public repo.

READ FIRST
CLAUDE.md, LESSONS.md, Planv2/BUILD_PLAN.md (build rules, P0-U3, the Phase 0 owner setup checklist, and any applicable "Lessons from Alpha Markets"), and the parts of Planv2/FINAL_PLAN.md covering environments, chain IDs, secrets, and the beta guard. If BUILD_PLAN's P0-U3 adds requirements not listed here, include them and list them in the handoff.

DEPENDS ON
P0-U1, P0-U2.

IN SCOPE
1. Environment IDs. Define exactly three: local (anvil fork of Monad mainnet), testnet (Monad testnet, chain 10143), and beta (Monad mainnet, chain 143, guarded). Each maps to a chain ID and the names of the environment variables it uses. Selected by APP_ENV, defaulting to local.
2. Config package at packages/config: a typed loader using zod that validates every variable for the selected environment at startup, fails with a clear message naming any missing or invalid variable, and never includes secret values in errors, logs, or thrown objects. Mark each variable as secret or public in the schema, and provide a redacted summary function for safe logging.
3. Mainnet guard. In the beta environment, the loader refuses to start any service that can sign transactions unless an explicit BETA_SIGNING_ENABLED=true is set. Nothing in local or testnet can point at chain 143 for signing.
4. Complete .env.example. List every variable the full build will need, grouped by service, each with a placeholder value, a one-line comment, and the unit that first uses it. Include MONAD_TESTNET_RPC_URL as a separate variable from MONAD_RPC_URL. Draw the list from the Phase 0 owner setup checklist. Do not add real values.
5. Update the existing scripts to use the shared config where practical, and apply the same minimum-block check from ForkConfigTest in scripts/lib/config.js.
6. pnpm dev:status also checks that anvil reports network monad.
7. Secret scanning: add a secret scanner (gitleaks or an equivalent) as a CI job, and as a script the owner can run locally before pushing. Scan the full existing git history once and report the result.
8. Fix wording: every mention of "pnpm doctor" in BUILD_PLAN.md and the P0-U2 unit prompt becomes "pnpm run doctor".
9. Tests: unit tests for the config package covering a valid config per environment, missing variables, invalid values, the mainnet guard, and that no secret value ever appears in error messages or the redacted summary.

OUT OF SCOPE
The address book and shared domain types (P0-U5), the dev console (P0-U4), any real accounts or keys, KMS integration, hosting configuration, and any network calls other than the RPC checks already in doctor.

DELIVERABLES
packages/config with tests, the expanded .env.example, updated scripts, the dev:status network check, the secret scanning CI job and local script, the wording fixes, and a README section on environments and configuration.

ACCEPTANCE TESTS
- Config tests pass, including the secret-leak tests.
- Starting with APP_ENV=beta and a signing service without BETA_SIGNING_ENABLED=true fails with a clear message.
- A missing required variable fails with a message naming the variable but not printing any value.
- pnpm run doctor, dev:up, dev:status (including the network monad check), and test:fork still pass.
- The secret scanner passes on the full history and runs in CI.
- All existing checks pass: lint, format:check, typecheck, vitest, forge build, non-fork forge tests.
- git status is clean, and .env is not committed.

HOW THE OWNER TESTS IT
1. Run pnpm run doctor, then pnpm dev:up and pnpm dev:status.
2. Run the local secret scan script given in the README.
3. Temporarily rename .env, start any check that loads config, confirm the error names the missing variable without showing values, then restore .env.
4. After pushing, confirm all CI jobs pass, including secret scanning.

COMMITS
Commit incrementally as each part works, for example:
- feat(infra): add environment IDs and typed config package [P0-U3]
- feat(infra): add mainnet signing guard to config [P0-U3]
- chore(infra): expand .env.example for the full build [P0-U3]
- chore(infra): add secret scanning to CI and local scripts [P0-U3]
- fix(infra): check anvil network in dev:status [P0-U3]
- docs(plans): correct pnpm run doctor wording [P0-U3]

WHEN DONE
Add a LOGS.md entry, and add a LESSONS.md entry for every bug fixed. Commit them. Then post the handoff message described in CLAUDE.md. Do not push.
