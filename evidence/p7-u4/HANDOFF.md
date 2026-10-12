# P7-U4 handoff: vault creation, caps, allowlists and the vault UI

Unit: P7-U4. Status: done.

## Commits

- `4ba6ba6` feat(contracts): the factory's vault cap, the public-deposit launch flag and the MV-S15 state assertion (pnpm assert:state), five factory tests, the address book's moved factory and implementations [P7-U4]
- `139aa60` feat(api): the public vault reading: rpcVaultReaderV3, vaultV3Json, vaultPerformance from the vault's snapshot rows, GET /v1/agents/:id/vault?wallet= with the funding address; 8 reader tests and 3 route tests [P7-U4]
- `0b52919` feat(web): the vault components on /design: VaultPanel, VaultPositionCard, VaultDepositForm, VaultWithdrawForm, ContributeCreditsPanel, VaultCreateCard, the words, ScoreTile exported; 15 component tests; the Vault section [P7-U4]
- `051274b` feat(web): the vault page at /agents/:id/vault, its hook and pure helpers (7 tests), the vault ABI and revert words, the portfolio's vault link [P7-U4]
- `4af41e7` test(web): the vault page's screenshot suite at 1440px and 380px with axe, the fake vault and its route, the chain-clock and status fixes (L-226, L-227), the scan after the fade (L-228), the refreshed baselines [P7-U4]
- `74a6b71` test(agent): the vault's live run on a fork of its own (pnpm test:vault:live) with its evidence [P7-U4]
- The last commit: docs(plans): the P7-U4 LOGS entry, L-226 to L-228, A-89, the Slither review and this handoff [P7-U4]

## Test results

| Check | Result |
| --- | --- |
| forge build, forge fmt --check | clean (AccountFactoryV3 14,231 bytes of runtime) |
| forge test | 667 passed, 0 failed, 12 skipped (the fork and testnet tests when no fork is named); forge fmt --check clean |
| pnpm test:fork (forge fork tests, the address book check) | 54 passed, 0 failed on a fresh fork; the address book check PASS for executor_v3 (41,210 bytes), account_factory_v3 (14,231), personal_account_v3_implementation (41,232) and strategy_vault_v3_implementation (61,812) |
| MV-S15 (`pnpm assert:state`, scripts/lib/state-assert.js) | 70 values of the deployed v3 set match the intent on a fresh fork (the throwaway deploy on 8567 and the live run on 8569); the comparison's 4 unit tests pass |
| pnpm typecheck; lint; format | pnpm typecheck, pnpm lint and pnpm format:check clean |
| vitest (node project) | 134 files, 1603 passed; vitest exits 1 on the pre-existing unhandled rejection of services/orchestrator/src/scan.test.ts (a 401 from a streamable HTTP tool endpoint, unrelated to this unit, as in P7-U2) |
| The vault reader, route, helper and component tests | packages/trading 8, apps/control-api 3, apps/web 7, packages/ui 15 |
| vitest packages/ui, apps/web (unit), the forks project | vitest packages/ui 557 passed (its design-tokens test asked for the newly exported ScoreTile on /design, so the Vault section gained a performance specimen); apps/web unit 207 passed; the forks project 62 passed and 5 skipped in 17 files one at a time, where class-a.fork.test.ts failed its deploy on an upstream timeout after three retries and passed 5 of 5 alone afterwards |
| Playwright web suite (1440px and 380px, axe on every captured state) | the whole web suite 279 passed and 2 skipped at 1440px and 380px (one research capture failed on a spinner baseline that predated Step 0's animation freeze; refreshed, the research spec passes 12 of 12 on a plain rerun); vault.spec.ts 16 of 16 (8 tests at each width, 7 captures per width, axe on every captured state, the dialogs included); the design page's full capture and scan with the new Vault section |
| The live run (`pnpm test:vault:live`, fork on 8569) | every one of 23 checks passed on a fresh fork on port 8569 (MV-S15 over 70 values, the vault created, staked and opened, two deposits of 30 USDC, every position read through the API's reader with a stranger refused, the vault armed and 5 USDC traded into WMON through the agent's pipeline and Executor v3, two snapshot rows and the live point in the performance series, after the lockup one depositor out in kind across USDC and WMON and the other paid 29.76 USDC exactly as the reader previewed, the leader's stake staying); no model was called; evidence/p7-u4/live-2026-10-12T03-11-49.276Z.json |
| Slither | 373 results, the same 373 as after P7-U3: nothing the factory gained is named by any detector (evidence/p7-u4/SLITHER.md) |

Acceptance, as the prompt lists it:

- Vault creation through the factory with the beta caps and allowlists: `createVault` (P7-U2) now under `vaultCap`, the allowlist and `depositsEnabled`; `test_AVaultIsBoundByTheVaultCap_NotThePersonalCap`, `test_TheAllowlistGatesVaultDeposits_AndNeverExits`, `test_PublicVaultDepositsWaitTheLaunchDecision`, `test_TheVaultCapLowersAtOnce_AndRaisesOnlyByTimelock`; MV-S15 fails on any mismatch (`scripts/lib/state-assert.test.js`).
- The vault UI from packages/ui with new components on /design first: the Vault section of the design page; the page at `/agents/:id/vault`: creating a vault, depositing, the lockup shown plainly, withdrawing and redeeming in kind, the holdings and performance from the value snapshots, and "Fund this agent" for non-owners labeled as a contribution to the credits.
- Component and screenshot tests at 1440px and 380px with an accessibility check: `apps/web/e2e/vault.spec.ts` (8 tests, 7 captures per width, axe on each), `packages/ui/src/components/agent/vault.test.tsx` (15), the design page's own capture and scan.
- A live run on a separate fork: create a vault, deposit from two wallets, let the agent trade, redeem in kind from one, withdraw the other after the lockup: `services/orchestrator/src/live-vault.ts`, evidence/p7-u4/live-<tag>.json.

## Model spend

None: no model was called in this unit (A-89).

## What the owner should check or try

- `pnpm deploy:executor-v3` on the playtest fork, then `pnpm assert:state`, then `pnpm dev:all`; open an agent's portfolio and follow "Vault": create it, stake, open deposits; from another allowlisted wallet (`pnpm custody:allow <wallet>`) deposit, watch the lock, and after a day (or `advanceTime` on the fork) withdraw in USDC and in kind.
- `/design#vault` shows every state of the new components.
- `pnpm test:vault:live` repeats the live run on a fork of its own in about two minutes.

## Open issues for the next unit

- The model-driven activation path still arms and funds the personal account; the vault needs the orchestrator's /arm with the vault grant.
- The lockup setting, the fee proposal and the handover acceptance have no UI yet (W-6).
- The console's Trades page prints a vault grant's `validUntil` as a date.

Push: `git push`
