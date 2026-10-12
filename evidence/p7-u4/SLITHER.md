# P7-U4 Slither review

Slither 0.11.6 on chains/monad (`slither . --filter-paths "dependencies|test|script"`), 2026-10-12: 373 results in all, the same 373 as after P7-U3. The result lists of the two runs, normalized without line numbers, are identical: nothing the factory gained this unit (`vaultCap`, `setVaultCap`, `RaiseVaultCap`, `depositsEnabled`, `disableDeposits`, `EnableDeposits`, `isVault`, the vault branch of `recordDeposit`, the two new entries of `_validate` and `_apply`) is named by any detector, and no earlier result moved or disappeared. The F-U3, F-U4, P7-U1, P7-U2 and P7-U3 reviews stand for every result on AccountFactoryV3, both implementations and the Executor set.

## Checked by hand

- `recordDeposit` keeps its one state write after every check: the allowlist (when on), then the vault's cap or the personal cap by `isVault[msg.sender]`, then the platform cap, then `platformTotal`; a vault's deposit while public deposits are off needs the depositor on the allowlist whether or not the allowlist is on (`PublicDepositsDisabled`), and nothing on the way out reads the factory (`recordWithdrawal` never reverts for a registered account).
- `isVault` is set only in `createVault`, beside `isAccount` and `vaultOf`, in the one path that deploys a vault; a personal account can never report against the vault cap, and a vault can never report against the personal cap.
- The two new timelocked actions take the existing encodings: `RaiseVaultCap` an amount (as the other raises), `EnableDeposits` no value (as `DisableAllowlist`), and `_validate` refuses any other encoding; `setVaultCap` only lowers and `disableDeposits` only closes, as every instant change tightens.
- The deploy script asserts the vault cap and the public-deposit flag of a fresh deployment and the execution window of every one; `pnpm assert:state` (MV-S15) reads them back with 68 other values and fails on any mismatch.
