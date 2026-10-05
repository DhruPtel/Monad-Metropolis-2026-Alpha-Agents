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

## L-31: A malformed Privy app ID failed the production build
Unit: P1-U2
What happened: The first real build for the build check failed prerendering "/" with "Cannot initialize the Privy provider with an invalid Privy app ID".
Cause: PrivyProvider throws during render unless the app ID is exactly 25 characters, and the layout passed any non-empty PRIVY_APP_ID through, so one bad value broke every page at build time.
Fix: `privyAppId` (apps/web/src/auth/privy-app-id.ts) passes only a 25-character ID that is not the .env.example placeholder; anything else renders the "wallet login is not configured" state, with tests (14111d4).
Lesson: Validate a third-party ID against the SDK's own rule before handing it over, and turn a bad value into a visible not-configured state instead of a failed render.

## L-32: loadConfig made a service that never touches the chain require an RPC URL
Unit: P1-U2
What happened: Built on `loadConfig`, the web session check would have refused to start on testnet or beta without MONAD_TESTNET_RPC_URL or MONAD_RPC_URL, although it only verifies Privy tokens.
Cause: `loadConfig` always added the environment's RPC variable to the required set, on the assumption that every service uses the chain.
Fix: ServiceSpec gains `usesChain: false`, which leaves the RPC optional and `rpcUrl` null when unset; the default is unchanged, and tests cover both (8717d31).
Lesson: A shared loader's built-in requirements must be things every caller needs; anything only most callers need is an option.

## L-33: The full-page /design screenshot timed out after the page grew
Unit: P1-U2
What happened: With the wallet section added, the two /design screenshot tests failed even with `--update`, reporting "Failed to re-generate expected. Timeout 5000ms exceeded."
Cause: The page content was stable, but capturing a full page this long takes over the 5-second default `expect` timeout on a loaded machine.
Fix: The two full-page captures pass `timeout: 30_000`; every run since passes, with and without `--update` (21182e2).
Lesson: When a screenshot fails to regenerate, read the call log before suspecting instability; give full-page captures of long pages an explicit timeout.

## L-34: The connected wallet pushed the brand onto two lines on mobile
Unit: P1-U2
What happened: The 380px screenshot of the connected shell showed "Alpha Agents" broken over two lines next to the address, copy and disconnect buttons.
Cause: The brand text could wrap, and the header held a placeholder notifications button on every width, so the real wallet controls ran out of room.
Fix: The brand never wraps and the notifications button hides below the small breakpoint (240b94b).
Lesson: Every new header control gets a screenshot at the narrowest width in its widest state before it is called done.

## L-35: pnpm dev:web never loaded the root .env
Unit: P1-U2 (fix after handoff)
What happened: With PRIVY_APP_ID and PRIVY_APP_SECRET set in the root .env, the wallet button still read "Login failed" and /api/session answered 503 not_configured. A Next.js env check from apps/web loaded no env files and saw PRIVY_APP_ID unset.
Cause: Next.js reads .env files only from the app's own folder, and `pnpm dev:web` ran `next dev` in apps/web directly. P1-U2 saw the 503 in dev and accepted it, because .env had no Privy values then, so the configured path was never tried.
Fix: `pnpm dev:web` runs scripts/web.js, which loads the root .env before starting Next, as scripts/console.js does for the console; with it, /api/session answers 401 and the Privy modal opens (9538cf9).
Lesson: Prove configuration reaches the process by setting a value and watching it take effect; a "not configured" result with nothing set proves nothing.

## L-36: The not-configured wallet state looked like a failed login with a dead button
Unit: P1-U2 (fix after handoff)
What happened: Without a usable PRIVY_APP_ID the wallet button read "Login failed" with "Try again", which did nothing; the reason was only in a hover tooltip, and on mobile only the dead button showed.
Cause: The not-configured session reused the ordinary error state, whose retry button ran a no-op.
Fix: WalletButton shows "Try again" only when there is an action to run; the not-configured state reads "Login unavailable" at every width, with the reason for screen readers and the fix in the tooltip (4dd673f).
Lesson: Never render a control whose action is a no-op; a state the user cannot fix from the page must say so and say where it is fixed.

## L-37: A hex string's length was recorded as a contract's code size
Unit: P1-U3
What happened: The randomness research and the address book recorded Pyth Entropy as 357 bytes of code. The address book check failed on it: the fork serves 177 bytes.
Cause: The size came from `cast code <address> | wc -c`, which counts the hex characters, the 0x prefix and the newline, not bytes.
Fix: Both records say 177 bytes, confirmed with `cast codesize` on mainnet and testnet (b7e4092, 6676ec2).
Lesson: Measure code size with `cast codesize` or `eth_getCode` divided into bytes, never by counting characters of printed hex.

## L-38: Printing anvil's node info exposed the RPC key in the session
Unit: P1-U3
What happened: A throwaway probe logged the result of `anvil_nodeInfo` to check the fork block. The output included the upstream MONAD_RPC_URL, API key included, in the session transcript. Nothing was written to a file or committed, and the probe was deleted at once.
Cause: anvil's node info carries its fork configuration, including the full upstream URL, and the probe printed the raw result without considering what it held.
Fix: No code change; the probe was never committed and the fork smoke test uses `vm.rollFork` instead. The owner was told so they can decide whether to rotate the key.
Lesson: Never print a raw RPC or node-info response from a process that was started with a secret; read the one field needed, and treat anything describing the fork's upstream as secret.

## L-39: Foundry expectations bound to the wrong call or event
Unit: P1-U3
What happened: Two new tests failed for the wrong reason. `vm.expectRevert` before `new AgentNFT(..., nft.ACCOUNT_REGISTRY(), ...)` reported "next call did not revert", and `vm.expectEmit` before a helper that approved and then transferred reported "Approval != expected OwnerEpochBumped".
Cause: Both cheatcodes bind to the next external call or the next event. Arguments are evaluated first, so the getter was the next call, and the helper's `approve` emitted its event before the transfer.
Fix: The constructor test reads the getters into locals before `expectRevert`, and the epoch test approves before `expectEmit` (d8645c8).
Lesson: Put nothing between `expectRevert` or `expectEmit` and the call under test, including external calls in its arguments and helpers that emit events first.

## L-40: Default fuzz and invariant settings made the suite run past ten minutes
Unit: P1-U3
What happened: The first `forge test` run with the AgentNFT suites did not finish in ten minutes and was stopped.
Cause: The default 256 fuzz runs were applied to tests that mint up to 1,100 agents per run, and the default invariant depth let each run mint hundreds of agents while every invariant read every agent.
Fix: The heavy fuzz tests set their run counts inline (8 and 12), and the invariant profile uses 48 runs at depth 60; the whole suite takes about 13 seconds, and a full-supply fuzz test still mints and reveals all 1,000 every run (35a03d8, d8645c8).
Lesson: Size a fuzz or invariant test's run count to the cost of one run, and confirm the deep states are reached with a probe instead of raising the count.

## L-41: The fork smoke test failed on any fork that had been used
Unit: P1-U3
What happened: After minting on the dev fork, `pnpm test:fork` failed `test_BlockNumberIsPinnedBlock`: 109670006 != 109670000.
Cause: The test required the anvil head to equal the pin, but any local transaction, deploy or mined block moves the head while the fork still starts at the pin.
Fix: The test checks the head is at or after the pin and that rolling back to the pin serves its state, and test:fork deploys AgentNFT inside a snapshot it reverts (879a941, 6676ec2).
Lesson: A test of a shared dev environment asserts the property that must hold after normal use, not the state of a fresh start.

## L-42: Process slips this unit repeated from earlier lessons
Unit: P1-U3
What happened: Four earlier lessons repeated. L-27: the fork test was committed before the secrets scan, and gitleaks flagged a public address constant (d8645c8). Worse, a later command piped the scan through `tail`, so its failure did not stop the commits that followed (b7e4092 and 879a941 went in while the history scan was failing). L-4: bc7e180's test reads an address book entry added in the next commit, so that commit alone fails one test file. L-11: a `pkill -f` pattern matched its own shell. None caused lasting damage.
Cause: Haste in the commit and cleanup steps, and a pipeline that hid the scanner's exit code.
Fix: The false positive is in `.gitleaksignore` with its reason (5c19f9f); every later commit ran the scan with its exit code checked (`secrets:scan > file && git commit`); bc7e180's gap closes in 6676ec2. History is not rewritten.
Lesson: Run the secrets scan and the tests on exactly what is staged, gate the commit on their exit codes rather than on piped output, and stop processes by PID.

## L-43: The first AgentNFT deploy on a fresh fork failed in forge's fee estimate
Unit: P1-U11
What happened: On a freshly started fork, `pnpm agent-nft:local mint` (which deploys first) and later the live test's `deployLocal` failed with "Failed to fetch fee history for EIP-1559 estimation ... could not get block data"; running it again worked. One fresh-fork deploy later failed differently, with "failed to fetch grandparent block ... does not exist".
Cause: forge estimates EIP-1559 fees with eth_feeHistory, which makes anvil fetch old blocks lazily from the upstream RPC, and the upstream sometimes fails those fetches. Passing both EIP-1559 fee flags still left one eth_feeHistory call (counted in anvil's log).
Fix: The local deploy sends legacy transactions at an explicit gas price read from anvil's latest block, so forge never calls eth_feeHistory, and a run that fails with a transient fork error is repeated up to three runs in all, which is safe because the deploy script skips a contract already at its CREATE2 address (832acc0). Seven fresh-fork deploys then made no eth_feeHistory call.
Lesson: When a tool fails intermittently against a fork, count the RPC methods it sends in anvil's log, remove the call that reaches the upstream, and retry only errors classified as transient, only around an idempotent step.

## L-44: Login specimen screenshots changed when /design grew above them
Unit: P1-U11
What happened: After the agent section and new viewer tokens were added to /design, five login screenshots (element captures of the wallet specimens, mostly loading spinners) differed by 7 to 1,139 pixels, although the specimens look identical. The failures were deterministic, and HEAD still passed them unchanged.
Cause: The new token rows moved the specimens 234px (desktop) and 546px (mobile) down the page, and antialiased, rotated content such as a spinner rasterizes differently at another page offset, which a threshold-0 comparison sees.
Fix: The five were re-baselined in the same commit as the change that moved them, after checking they were visually identical, that the change was deterministic, and that HEAD passed (98d753b).
Lesson: A content change above an element capture can change it; prove the new pixels come from the change (run HEAD, run twice) before re-baselining, and say so in the commit.

## L-45: Slot markers covered the species art's label and note
Unit: P1-U11
What happened: At 380px, the /design species art drew its slot hexagons over the placeholder's "BASE · ANT" label and its "Art coming soon" note; a new geometry test showed they also touched the note at 1440px.
Cause: The slots ride a ring at 40% of the art's size with a fixed 44px hexagon, while the words sat in the centre of the same square, so on a small square the ring crossed the words. The screenshot baseline had accepted it.
Fix: A placeholder with slots puts its words in a caption below the art; a /design test fails if any slot box overlaps any label or note at either width, and it failed before the fix (52fccd0).
Lesson: When markers are positioned in proportion to a box but have a fixed size, keep text out of the area they can reach, and check overlap with a geometry test rather than by eye.

## L-46: test.use with launchOptions inside a describe stopped the live suite
Unit: P1-U11
What happened: The live suite would not start: "Cannot use({ launchOptions }) in a describe group, because it forces a new worker."
Cause: The no-WebGL test turned WebGL off with browser launch flags inside a describe, which needs a second browser, and the suite runs one worker.
Fix: An init script makes every webgl and webgl2 context request return null for that test, which is also usable in the screenshot suite (a2fd0f3).
Lesson: Simulate a missing browser capability per page with an init script rather than per browser with launch flags.

## L-47: An untracked, untyped spec failed the web build
Unit: P1-U11
What happened: The first claim-key leak probe build failed in `next build` with TS7016 errors from `e2e/live.spec.ts`, a file that was not yet committed, importing `scripts/lib/*.js`.
Cause: `next build` typechecks every file the web tsconfig includes, untracked ones too, and the web tsconfig had no allowJs, so the JSDoc-typed scripts were untyped there.
Fix: The web tsconfig sets allowJs, so it reads the JSDoc types the root tsconfig already checks; a throwaway misuse proved the imports are typed (a2fd0f3).
Lesson: Typecheck work in progress before a build, since the build sees it, and prove an import is typed by misusing it once.

## L-48: The unrevealed placeholder showed through the portal's gates
Unit: P1-U11
What happened: With no wallet, no agent or an unrevealed agent, the viewer's dashed "UNREVEALED" placeholder showed through the gate's translucent panel, under its button.
Cause: The stage always drew the art, and the gate sits on top of it at 90% opacity.
Fix: The stage draws no art while a gate covers it (48daf11).
Lesson: Look at every state of a page in the visual check, including the empty ones, before baselining it.

## L-49: Portal captures were covered by the header and caught a hover state
Unit: P1-U11
What happened: Mobile captures of the portal hid "Alpha Agent #7" under the shell's sticky header, and one capture failed on the next run by 5 to 27 pixels: the Mint button in its hover colour in one run and not the other.
Cause: An element taller than the viewport is captured by scrolling, and the sticky header stays over it. The test clicked "Connect wallet", and the Mint button then appeared under the pointer.
Fix: Captures hide the sticky header with a stylePath file, the test moves the pointer off right after the click and waits for no hovered button; three runs in a row match (71297bc).
Lesson: Before an element capture, park the pointer, wait for no :hover, and hide fixed or sticky chrome that can overlap the element.

## L-50: The desktop nav never fitted below 1280px
Unit: P1-U11
What happened: Adding Configure made "My Agents" wrap onto two lines in the connected header at 1440px. Measuring showed the inline nav had overflowed from 1024px to 1279px all along (66px logged out at 1024, 242px connected), hidden because labels could wrap and no test used those widths.
Cause: The nav showed inline from lg (1024px) with wrapping labels, and the screenshots covered only 1440 and 380.
Fix: Labels never wrap, the inline nav starts at xl (1280px), link padding is 10px, and a test measures the header row at 1024, 1279, 1280 and 1440px, logged out and connected; it failed on the old header (cfc3f83).
Lesson: This is L-30 and L-34 again: a row of controls needs a measured no-overflow test at every breakpoint edge, not only screenshots at two widths.

## L-51: anvil_reset fails after the fork has been used
Unit: P1-U11 (found, not fixed)
What happened: `resets to the pinned block` in packages/devenv failed on several runs today with "anvil_reset: JSON-RPC error -32603", then passed on the next run. It looked like the upstream flakes of L-43.
Cause: anvil's log says "failed to invalidate fork cache at ~/.foundry/cache/rpc/monad/109670000/storage-<hash>.json: Not a directory": anvil 1.8.3 stores each block's cache as one zstd file but tries to invalidate a path inside it as if it were a directory. It hits the first reset after the fork was used.
Fix: None in code: it is a Foundry bug outside this unit. Commit gates that hit it were rerun and passed; the owner can watch it or try `--no-storage-caching` in a later unit.
Lesson: Read the server's own log for the message behind a bare JSON-RPC error code before classifying the failure.

## L-52: A Playwright run without --update still wrote baselines
Unit: P1-U11
What happened: A stray Playwright run against the main repo's older build left ten untracked configure-*.png baselines there, from before the gate fix.
Cause: Playwright writes a missing snapshot on any run and fails that test; only mismatches need --update.
Fix: The ten were overwritten with the verified worktree baselines and compared byte for byte before they were committed (71297bc).
Lesson: After any Playwright run, check git status for new snapshot files, and never commit one without knowing which build made it.

## L-53: MetaMask's gasless relay sent a local mint to Monad mainnet
Unit: P1-U11 (fix after handoff)
What happened: In the owner's playtest, MetaMask showed the mint as submitted and confirmed, but the app said "The mint transaction failed." The fork had no transaction from the wallet (nonce 0, no agent). On Monad mainnet the wallet, which held 0 MON there, had nonce 1: a type-4 transaction sent by another address at 19:01:42 UTC carried the mint calldata to the AgentNFT address, which has no code on mainnet, so it "succeeded" doing nothing. It also set an EIP-7702 delegation on the owner's mainnet account to 0x63c0c19a...e32b.
Cause: The local fork used chain ID 143, the same as Monad mainnet, so the app and MetaMask could not tell them apart. With no MON on chain 143, MetaMask sent the transaction through its gasless relay, which works on Monad mainnet whatever RPC the wallet has set, and the app then waited for the receipt on the fork, where it never appeared, and reported a generic failure.
Fix: The fork answers its own chain ID, 143143, with Monad's EVM kept by `--network monad` (56d4df0, D-195), so a wallet on mainnet is now the wrong chain. Before a mint, the app checks through the wallet's own provider that the wallet sees the app's latest block and AgentNFT's code, and stops with the wallet's network named (789af6d). A transaction the app's RPC never sees is checked on the wallet's network and reported as sent elsewhere (4c49dab). The README gives the MetaMask network for 143143.
Lesson: A local chain must never share a chain ID with a real network, because the wallet, not the app, decides where a transaction goes; and an app must confirm the wallet sees its chain before asking it to send anything.

## L-54: A fork test silently skipped because it detected the fork by chain ID
Unit: P1-U11 (fix after handoff)
What happened: After the fork moved to chain 143143, the unit suite reported one skipped test where it had none: the Tokenbound registry check in packages/domain, which compares our account address helper with the real registry on the fork.
Cause: The test decided whether a fork was running by comparing eth_chainId with "0x8f" (143), so on the new fork it skipped as if no fork were up, and its addresses still used chain 143 although agents on the fork are bound to block.chainid, 143143.
Fix: It detects the fork by LOCAL_FORK_CHAIN_ID and computes accounts with it; it runs and passes against the registry on the fork (56d4df0).
Lesson: Read the skipped count after any change to the environment, and detect a test environment from the same constant the code uses, never a literal.

## L-55: The network switch buttons failed silently
Unit: P1-U11 (fix after handoff)
What happened: In the owner's playtest, "Switch network" and "Switch to Monad (local fork)" did nothing and no MetaMask prompt appeared, while the app said the wallet was on Monad Testnet and MetaMask's main view showed the fork network selected with 100 MON.
Cause: The buttons called wagmi's `switchChain` and dropped its result. wagmi's injected connector sends the request and then waits for a chainChanged event, which a wallet that accepts the request without changing networks never sends, and any error went to hook state that nothing displayed. The app's chain was wagmi's cached connection chain, which can differ from the network MetaMask uses for this site (MetaMask can keep one per site, separate from the one in its main view). Privy's own switch path would also have failed for an unknown chain: it adds chains with an empty explorer URL. The mock wallet switched instantly, so no test ever exercised any of this. The owner's console lines were not available, so which of these MetaMask hit is not confirmed.
Fix: `switchWalletChain` asks the wallet's provider directly, adds the chain on 4902 with valid parameters, confirms with eth_chainId, and returns an outcome the wrong-chain prompt shows: waiting, declined, already pending, failed with the wallet's error, or still on the old network with how to fix the site's network. The app reads the chain from the provider (connect, chainChanged, window focus) and moves wagmi's connection to it. The mock wallet answers switches the way MetaMask can, and tests cover each outcome (e28f012, c07da24).
Lesson: Never fire a wallet request without showing its outcome, confirm a wallet action by reading the wallet's state afterwards, and give the mock wallet the failure modes of the real one.

## L-56: A commit went in while its staged tests had failed
Unit: P1-U11 (fix after handoff)
What happened: c07da24 was committed although the staged test run had one failure. The failure was the known anvil reset bug (L-51), and the committed tree then passed 851 of 851 twice, so no broken code went in. In the same task a heavy Playwright run started while the owner's `next dev` was running, against the Heavy work rule.
Cause: The gate was `check-staged.sh | grep ... && git commit`, so the commit depended on grep's exit code, not the checks'; this is L-42 again. The process list was printed before the heavy run but not acted on.
Fix: The committed tree was rechecked with the script's own exit code; later gates write the output to a file and test the exit code first.
Lesson: Gate a commit on the check's own exit code, never a pipeline's, and treat a dev server in the process list as a stop before any heavy suite.
