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

## L-10: A missing receipt was read as a reverted transaction
Unit: P0-U4
What happened: Minting test USDC failed with "transaction reverted on the fork" although the same calls succeeded by hand, and the minter allowance showed the first transaction had in fact executed.
Cause: `eth_getTransactionReceipt` was called once, immediately after `eth_sendTransaction`. Anvil returns the hash before the receipt is queryable, so the first read returned null, and the code treated "no receipt yet" as "failed". This is Alpha Markets lesson 6: state read too early after a write is indistinguishable from state never established.
Fix: `waitForReceipt` polls until the receipt exists (up to 15 seconds), and only a receipt with status other than 0x1 counts as a revert (907e19d).
Lesson: After any write, poll for the authoritative record and distinguish "not yet" from "failed"; a single read is never a verdict.

## L-11: pkill matched its own shell and killed the command
Unit: P0-U4
What happened: Twice, a command that stopped a server with `pkill -f 'next start ...'` (or `'next dev ...'`) and then did more work exited with code 144, and none of the later steps ran; the first time, three new files were never written.
Cause: `pkill -f` matches full command lines, and the shell running the command contained the same pattern text, so pkill killed the shell along with the server.
Fix: Servers are stopped by the PID that `ss -ltnp` reports for their port, then the remaining steps run as a separate command.
Lesson: Stop a process by its PID, never with a `pkill -f` pattern that also appears in the command doing the killing.

## L-12: getByRole("alert") also matched Next.js's route announcer
Unit: P0-U4
What happened: The console e2e test for a refused fork action failed with a strict-mode violation: `getByRole("alert")` resolved to two elements, one of them empty.
Cause: Next.js renders a hidden route announcer with role alert on every page, so a page-level alert query is never unique.
Fix: The action error message carries `data-testid="action-error"` and the test targets that (913c58d).
Lesson: In a Next.js app, target your own alerts by test ID, not by role alone.

## L-13: The live console tests could never reach the console from Docker
Unit: P0-U4 (housekeeping)
What happened: `pnpm test:console:live` failed all three tests with `net::ERR_CONNECTION_REFUSED` at http://127.0.0.1:3001 while the console answered 200 to curl on the same address.
Cause: The script ran Playwright in the pinned image with `--network=host`, but Docker Desktop on WSL2 runs containers in its own VM, so the container's 127.0.0.1 is not the distro's. The P0-U4 session saw this and logged the spec as not verified instead of fixing the runner.
Fix: `--live` now runs Playwright on the host's Chromium, installed once per machine (the README gives the command); the screenshot tests stay in the pinned image (97a8f33).
Lesson: Run a test that must reach a local service on the same network namespace as that service, and keep the pinned image only for tests whose output depends on the rendering environment.

## L-14: A table query missed the table because the label is on its region
Unit: P0-U4 (housekeeping)
What happened: Once the live tests could run, the snapshot test failed waiting for `getByRole("table", { name: "Snapshots" })`, although the page showed the snapshot row.
Cause: The design system's Table puts its `label` on the scrollable wrapper with role region, not on the table element, so no table has that accessible name. The spec had never run.
Fix: The test finds the region by name and the table inside it (501d02c).
Lesson: Query a design system Table through its labeled region, and never count a spec as written until it has run and passed once.

## L-15: The live funds test passed only on its first run
Unit: P0-U4 (housekeeping)
What happened: The second run of `pnpm test:console:live` failed on the USDC check: expected "1,234.56", received "3,703.68" and then "4,938.24".
Cause: Giving USDC mints on top of the current balance, and the test used one fixed address on a fork that keeps state between runs, so each run added to the previous runs' balance.
Fix: Each run uses a fresh random address (501d02c); three further runs passed.
Lesson: A test against shared, persistent state runs at least twice before it counts as passing, and uses fresh identifiers or restores what it changed.

## L-16: The spike assumed E2B Secrets, which this team cannot use
Unit: P1-U1
What happened: Before the cloud run, listing E2B secrets returned "403: Secrets are not available for this team", so the spike would have failed at `Secret.create`, after LiteLLM, the tools server and the tunnel were already up.
Cause: The driver was written against the Secrets API (`Secret.fill` in the egress rules) without first checking that the account's plan offers it; Q-04 was still open.
Fix: A probe with a throwaway sandbox showed that an egress transform with a literal header value is injected by E2B's proxy and never appears inside the sandbox. The driver tries Secrets first and falls back to literal values on that 403, recording `credentialPath` in the report (da1ab0b).
Lesson: Before writing code against a paid-plan cloud feature, call it once with a throwaway value and read the answer, and keep a recorded fallback for a 403.

## L-17: LiteLLM spend read right after the run showed zero
Unit: P1-U1
What happened: The first cloud run failed `modelCallsOnAgentKey`: the agent key reported spend 0 while its spend log already had two rows, and the budget key, read later in the same run, showed its spend.
Cause: LiteLLM writes key spend to the database in batches, so the read straight after the run came before the write. This is L-10 again: state read too early after a write looks like state never written.
Fix: The driver polls `/key/info` and `/spend/logs` (up to 60 seconds) until spend is above zero and there is a log row for every call the gate saw succeed (da1ab0b).
Lesson: Treat any spend, usage or billing counter as eventually consistent and poll it to a settled value before checking it.

## L-18: Adding /run to the sandbox scan crashed the scan
Unit: P1-U1
What happened: The first cloud run ended with "EACCES: permission denied, scandir '.../run/systemd/inaccessible/dir'" in the secret scan step, after every other check had run.
Cause: `/run` was added to the archive in this session; it holds directories with mode 000, and tar keeps that mode on extraction, so the local scanner could not read its own copy.
Fix: The driver runs `chmod -R u+rwX` on the extracted copy before scanning, and removes the copy in teardown (da1ab0b).
Lesson: When a scan extracts files from another system, normalize permissions on the copy first, and run a widened scan once before relying on it.

## L-19: Teardown does not survive a hard kill or a machine crash
Unit: P1-U1
What happened: A previous session crashed the machine (a suspected RAM fault) while a spike run could have been live. The driver's teardown runs on normal exit, an error, SIGINT, SIGTERM and its 30-minute deadline, but a SIGKILL, an out-of-memory kill, a WSL crash or a power loss skips it entirely.
Cause: All cleanup is in-process. On a hard stop nothing runs: the cloudflared child can be orphaned (its kill hook is on the parent's exit event), the sandbox lives until its own 20-minute timeout, E2B secrets (where the plan has them) and LiteLLM virtual keys persist with no expiry, and the scan copy stays in /tmp.
Fix: None in code this unit. The bounds that do hold: the sandbox timeout caps its lifetime at 20 minutes, every resource carries the run tag (sandbox metadata, `p1u1-` secret names, key aliases), and this session checked by hand before and after the runs that no sandbox, secret, cloudflared process or scan copy was left. The spike's virtual keys remain in the litellm schema (budget 0.5 USD and 1e-7 USD, reachable only through the local gateway).
Lesson: Every cloud resource gets a hard lifetime set at creation and a run tag, and the next run starts with a sweep that removes tagged leftovers, because in-process teardown cannot cover a crash.

## L-20: An address book entry had an invalid EIP-55 checksum
Unit: P2-U0
What happened: The first spike run stopped with `Address "0xf5F15f188AbCb0d165D1Edb7f37F7d6fA2fCebec" is invalid` from viem, reading the Chainlink USDC/USD proxy.
Cause: The address was copied into FINAL_PLAN, the Morpho note and the address book in mixed case with one wrong letter (`AbCb` for `AbCB`). Mixed case is a checksum, so viem and every EIP-55 client reject it, while our own code compared lowercase and never noticed.
Fix: All three copies use the correct case, and a domain test requires every address in the book to be valid EIP-55 or all lowercase; it failed on this entry before the fix (bd9b534).
Lesson: Validate every mixed-case address with a strict EIP-55 check when it enters the codebase, not when a library first rejects it.

## L-21: A rate limit was treated as a range that was too large
Unit: P2-U0
What happened: The full-history v4 pool scan failed with HTTP 429 from Monad's public RPC, after first splitting the failing ranges into ever smaller requests.
Cause: The log fetcher halved a block range on any error, so a rate limit produced more, smaller requests, at a concurrency of 8.
Fix: A 429 now waits with exponential backoff and retries the same range; only other errors split it; concurrency is 2, and block headers come from the keyed RPC (a54e678).
Lesson: Classify an RPC error before reacting: back off on rate limits, and change the request only for errors that are about the request.

## L-22: Stopping the spike with SIGTERM left anvil running
Unit: P2-U0
What happened: After the spike was stopped by PID, its anvil fork on port 8547 was still running and had to be killed separately.
Cause: The driver stopped anvil from a `process.on("exit")` handler, but Node does not fire the exit event when a signal ends the process. This is the L-19 gap again, at small scale.
Fix: The driver also stops anvil on SIGINT and SIGTERM before exiting (a54e678).
Lesson: A process that starts a child process must stop it on signals as well as on exit, and a test run checks that nothing is left (`pgrep`) afterwards.

## L-23: The v4 pool cache failed to serialize a BigInt
Unit: P2-U0
What happened: A run finished the full-history v4 scan, then died with "Do not know how to serialize a BigInt" while writing its cache, losing the scan.
Cause: The cache record spread every decoded event argument, including `sqrtPriceX96`, which viem decodes as a BigInt.
Fix: The record lists its fields explicitly and converts numbers (a54e678).
Lesson: Build any record that is written to JSON field by field from decoded chain data, never by spreading decoded arguments.

## L-24: Two v4 pools shared one venue id
Unit: P2-U0
What happened: Two different hooked v4 pools both got the id `uniswap-v4-mon-8388608-60-hooked`, and their quotes and maximum sizes were reported as identical.
Cause: The id held currency, fee and tick spacing, but not the hook address, and every later table was keyed by that id.
Fix: Hooked ids include the hook address prefix, the driver refuses to continue on a duplicate id, and the run was repeated from scratch (a54e678).
Lesson: When results are keyed by a derived id, assert the ids are unique before using them.

## L-25: Long notes pushed the address book table off screen on mobile
Unit: P2-U0
What happened: After adding the Kuru entries, the console's mobile address book screenshot came out shorter, not longer, and the image showed the Address and Status columns pushed out of view.
Cause: The notes held full 40-character implementation addresses, which cannot wrap, so the Entry column grew to the width of the screen.
Fix: The notes are short and the implementation addresses live in `evidence/p2-u0/` (ba07eb5); the screenshots were re-baselined only after looking at both images.
Lesson: Look at a failed screenshot before re-baselining it; a size change in the unexpected direction is a layout bug, not a new baseline.

## L-26: Quoting through the fork was too slow to finish
Unit: P2-U0
What happened: A run spent over 30 minutes in the quote stage with no output, and was stopped.
Cause: Each quote on the anvil fork made anvil fetch every crossed tick's storage slot from the free-tier RPC one request at a time, and the size search went up to $1,000,000.
Fix: Uniswap quotes are `eth_call` at the pinned block on the keyed RPC (one request each, same result), only Kuru's simulation stays on the fork, the search stops at $50,000, the stage prints progress, and its results are cached per block (a54e678).
Lesson: Run read-only calls against the pinned block directly, keep the fork for calls that need state changes, and print progress in any stage that can run for minutes.

## L-27: A generated evidence file was committed before the secrets scan
Unit: P2-U0
What happened: `pnpm run secrets:scan` failed after the evidence commit: gitleaks' generic-api-key rule matched four `"token0"` keys in `evidence/p2-u0/data.json`.
Cause: Every value was the public WMON address, so these were false positives, but the scan ran only after the commit, so the fingerprints are now in history.
Fix: The four fingerprints are in `.gitleaksignore` with the reason (a354f85).
Lesson: Run the secrets scan on staged changes before committing any generated data file.

## L-28: The fork integration tests timed out under load
Unit: P0-U7
What happened: With the dev fork running, `pnpm test` failed one test out of 614 on one run and passed on the next five. Running the suite next to two app builds reproduced it twice: "reports the stack's anvil as the monad fork" (13.2 s) and "resets to the pinned block" (5.4 s) hit "Test timed out in 5000ms".
Cause: These tests make real calls (Docker for stack health, anvil to the upstream RPC for `anvil_reset`) under vitest's 5-second default, which a loaded machine exceeds. They skip when the fork is down, so most runs never exercised them.
Fix: The suite and its snapshot hooks allow 60 seconds; three runs under concurrent builds pass (4930908).
Lesson: A test that does real network or process I/O gets an explicit timeout sized for a loaded machine, and a test that failed once is rerun under load before it is called flaky.

## L-29: The prototype's palette failed contrast where our components use it
Unit: P0-U7
What happened: After applying the token changes from `Planv2/notes/prototype-review.md` 2.3, axe reported serious color-contrast violations on /design: every reason code and subtle amount, the danger button, the negative pills and the drawdown column.
Cause: The review measured contrast only against `surface`. Red #d9534f is 3.84:1 on `surface-overlay` and 3.86:1 on `negative-surface`, and the interpolated ash-dim #6e727a is 3.75:1 even on `surface`, while our components use `foreground-subtle` for essential text. This is L-9 again.
Fix: Red is #de6764 and ash-dim is #888c93, the smallest changes that pass 4.5:1 on every surface they sit on; "stale data" and "awaiting approval" use the new amber warning tone (dc28ca9).
Lesson: Before adopting a proposed palette, compute every text token against every surface token it can appear on, not just the one the proposal measured.

## L-30: Long tab labels spilled out of their trigger on mobile
Unit: P0-U7
What happened: At 380px, the /design tab "Medium (hover)" and the console's "local (fork)" wrapped onto two lines inside a fixed 32px tab, so the text overflowed the trigger. The console case already existed with Geist; Inter's wider letters made it show on /design too.
Cause: The tab trigger had a fixed height but allowed wrapping, and the list had no way to overflow.
Fix: Labels never wrap and the tab list scrolls sideways on narrow screens; a component test checks both (ecb49b9).
Lesson: A component with a fixed height must also stop its text wrapping and say what happens on overflow.
