# Alpha Agents: Build Log

One entry after every unit and every playtest, newest at the bottom, so this file reads as a chain of development. Append only; never edit an earlier entry, add a new one that corrects it. Format:

## [date], [unit ID or "Playtest"], [short name]
Status: done, partial, or blocked
Summary: two to four sentences on what was built or tested and anything left open.
Bugs: none, or the lesson IDs for bugs found and fixed.
Commit: the commit hash, if any.

## 2026-09-30, Setup, Phase 0 owner setup checklist
Status: partial
Summary: Installed and verified on the development machine (WSL2): Node 22.23.1, pnpm 9.14.4, git 2.43.0, Python 3.13.11, and Foundry 1.8.3 (forge) in ~/.foundry/bin. Missing: Foundry on PATH (forge is not found without the full path), and a usable Docker; the Docker Desktop CLI 29.8.0 and Compose v5.5.1 are present through WSL integration, but the daemon socket returns "permission denied" for this user, so Docker does not work yet. Both block P0-U2. Not yet verifiable from this session: every account and API key in the checklist (Monad RPC providers, testnet MON and USDC, deployer, multisig, guardian and sentinel keys, cloud KMS, E2B, model providers, Privy, Envio, Sentry, search, X, Dune, CoinGecko, wallet data provider, hosting, domain, pinning, 3D tooling, x402 facilitator, mainnet funds, hackathon registrations, legal counsel, external reviewers) and their spending caps; the GitHub repository exists as the origin remote (DhruPtel/Monad-Metropolis-2026-Alpha-Agents), and Actions CI is confirmed on the first push.
Bugs: none.
Commit: none (recorded with the P0-U1 log commit).

## 2026-09-30, P0-U1, Repo and tooling
Status: done
Summary: The repository is now a pnpm 9 workspace on Node 22 with strict TypeScript 6.0, an ESLint flat config (typescript-eslint strict and stylistic), Prettier, EditorConfig, Vitest passing with no tests, and a GitHub Actions CI that runs lint, format:check, typecheck and test after a frozen-lockfile install; the folder layout from the plan exists with one README per folder, the README carries the beta status, `Planv2/units/` holds the template and this prompt, and the main-branch rule is recorded as D-147 in its own section 1.9, sourced to the unit prompt because D-140 allows only four source labels. `.gitignore` also now ignores `Reference/` (a different project's lessons file, kept local) and WSL `*:Zone.Identifier` files, so `git status` is clean without committing either. Suggestions for later units: the root `typecheck` only covers root config files, so when P0-U5 adds packages it should add per-package tsconfigs and switch the root script to `pnpm -r typecheck` or project references; pin the CI actions to commit SHAs; add `~/.foundry/bin` to PATH and the user to the `docker` group before P0-U2.
Bugs: L-1.
Commit: 0cbb784, 02891a3, e2e4c58, ce6cef4, 1c892d4, 5663be0, plus the log commit.
