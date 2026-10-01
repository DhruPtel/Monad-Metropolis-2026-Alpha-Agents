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

## L-4: A commit added a drift test without the generated file it checks
Unit: P0-U3
What happened: Commit ba76c22 added the config package with a test that compares the committed .env.example against the registry, but the regenerated .env.example was committed separately in the next commit (f51f7ab). Checked out on its own, ba76c22 fails that one test; every later commit passes.
Cause: The commits were split by topic (package, then template) after both files were already changed, without re-running the tests on what each commit actually contained.
Fix: f51f7ab committed the generated file, and all tests pass from there. History is not rewritten (CLAUDE.md), so ba76c22 stays as it is.
Lesson: A generated file goes in the same commit as the test that checks it, and the test suite runs against exactly what is staged before each commit.

## L-5: A double cast let a USDC value pose as a WMON amount
Unit: P0-U5
What happened: The turnover breach fixture passed `usdc(10_000n) + 1n` as the raw amount of a WMON sale. That is 0.00000001 WMON, so the "over the cap" fixture traded almost nothing and passed when it should have been rejected; the fixture test caught it.
Cause: The fixtures turned values into token amounts with inline `as bigint as AmountRaw` casts. The scale brand on `AmountRaw` exists to stop exactly this, and a double cast switches it off without a warning (Alpha Markets lesson 10).
Fix: The fixture now uses `wmonWorth(...)`, and every USDC value becomes an `AmountRaw` through one named helper, `usdcAmount`; no inline double cast is left in packages/policy (9f75851). The same session also isolated the insufficient-balance fixture, which had breached three other limits at once.
Lesson: Convert between scaled types only through a named helper, never an inline double cast, and make each breach fixture fail exactly one rule.

## L-6: Undoing a test edit with git checkout discarded uncommitted work
Unit: P0-U5
What happened: To prove the CI pin test could fail, the SHA pin on actions/checkout was edited back to `@v4`, then undone with `git checkout -- .github/workflows/ci.yml`. That restored the last commit, which had no pins at all, so all seven uncommitted SHA pins were lost; `git diff --stat` showing nothing exposed it.
Cause: `git checkout -- <file>` restores the file from the index, not from the state before the experiment, and the pins had not been committed yet.
Fix: The pins were re-applied with the same edit, the guard test passed, and they were committed in a3cdd8a.
Lesson: Undo a deliberate breakage by reversing that exact edit, or by restoring a copy saved first in the scratchpad, never with `git checkout` on a file that has uncommitted changes.

## L-7: Screenshot tests passed a changed token
Unit: P0-U6
What happened: Changing the brass token from #c9a35c to #c9a35d left the /design screenshot diff exactly as large as before the change (1,298 and 1,390 pixels, all from an unrelated copy change), so the token edit itself was invisible to the test that is meant to catch token changes.
Cause: `maxDiffPixels: 0` limits how many pixels may differ, but Playwright first decides whether a pixel differs with a per-pixel color `threshold` that defaults to 0.2, which absorbs small color changes.
Fix: The config sets `threshold: 0` as well. Rendering is deterministic inside the pinned Playwright image (three runs matched exactly), and the one-unit brass change now fails both screenshots (13,897 and 16,689 pixels).
Lesson: A visual regression test is proven only by watching the smallest change it must catch make it fail; set every tolerance, not just the pixel count.

## L-8: Button asChild broke the build with two children
Unit: P0-U6
What happened: `next build` failed prerendering `/` with "Slot failed to slot onto its children. Expected a single React element child".
Cause: Button always rendered `{loading ? spinner : null}{children}`, so with `asChild` the Radix Slot received two children (a null and the link) instead of one element.
Fix: With `asChild` the Button passes its child through alone; a component test renders a link through `asChild` (0eb7545, bc0df75).
Lesson: A component that supports `asChild` must hand Slot exactly its child and nothing else, and needs a test that uses it.

## L-9: The muted red token failed contrast on the overlay surface
Unit: P0-U6
What happened: The axe scan of /design reported a serious color-contrast violation: red drawdown text on the selected table row, 4.46:1 against the 4.5:1 AA minimum.
Cause: #e06a62 passed on the page background but not on `surface-overlay`, one of the surfaces negative values sit on.
Fix: The palette red moved to #e57068, about 4.8:1 on the overlay surface and 4.9:1 on the error surface; axe now reports no serious or critical violations (b560520).
Lesson: Check a text color's contrast against every surface token it can appear on, not only the page background; the axe scan of /design does this for every rendered pair.
