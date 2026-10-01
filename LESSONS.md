# Alpha Agents: Lessons

One entry for every bug found and fixed, newest at the bottom. Every unit session reads this file first. Append only. Format:

## L-[number]: [short title]
Unit: [unit ID]
What happened: what went wrong and how it showed up.
Cause: the root cause.
Fix: what was changed.
Lesson: one sentence rule to avoid it next time.

## L-1: TypeScript 7 is outside the typescript-eslint peer range
Unit: P0-U1
What happened: `pnpm add -D typescript` installed TypeScript 7.0.2, and pnpm reported unmet peer dependencies across every typescript-eslint package, which accepts only `>=4.8.4 <6.1.0`.
Cause: An unpinned add takes the newest major, and TypeScript 7 (the native port) shipped before typescript-eslint supported it.
Fix: Pinned `typescript` to `~6.0.0` (6.0.3); the install then reported no peer warnings and lint and typecheck passed.
Lesson: After adding any dev tool, read the peer dependency warnings and pin to the newest version every consumer supports, never just the newest version.

## L-2: pnpm doctor runs pnpm's built-in command, not our script
Unit: P0-U2
What happened: `pnpm doctor` printed a pnpm config warning and exited 0 without running any of our checks, so it looked like a pass. Three error messages in `scripts/dev.js` still told the user to run `pnpm doctor`.
Cause: `doctor` is a built-in pnpm command, and pnpm runs built-ins ahead of package.json scripts with the same name. Only `pnpm run doctor` reaches our script.
Fix: The README documents `pnpm run doctor`, and the hints in `scripts/dev.js` now say `pnpm run doctor` (5df4326).
Lesson: Before naming a root script, check that `pnpm <name>` is not a pnpm built-in (doctor, test, install, update, audit and others), and always write `pnpm run <name>` in docs and error messages.

## L-3: forge 1.8 cannot fork Monad with the default Ethereum EVM
Unit: P0-U2
What happened: `pnpm test:fork` failed in `setUp` with "vm.createSelectFork: cannot create a `monad` fork with an EVM instantiated for `ethereum`", even though anvil was serving chain 143 correctly.
Cause: Foundry 1.8 builds network-specific EVMs. forge defaults to `ethereum` unless told otherwise, while anvil detects `monad` from the forked chain ID (anvil_nodeInfo reported network monad, hardfork MonadTen).
Fix: Set `network = "monad"` in `chains/monad/foundry.toml`, so every forge command (build, test, scripts, CI) uses the Monad EVM (b0b91c2).
Lesson: Every Foundry project for a non-Ethereum chain sets `network` in foundry.toml, and fork work confirms the EVM family through anvil_nodeInfo rather than chain ID alone.
