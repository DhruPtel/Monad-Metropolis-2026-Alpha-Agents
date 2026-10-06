# Alpha Agents: Lessons

## Wallets and networks: read first

Pinned above the numbered lessons by owner decision (D-196): the one exception to this file being newest at the bottom. Read it before any unit that touches wallets, networks or transactions. Marked "verified" means checked on chain, in code or in git; "reported" means the owner saw it in the browser.

### What happened (2026-10-05, Pacific time)

1. 11:50: P1-U11 was handed off. The local fork answered chain ID 143, the same as Monad mainnet.
2. 12:01: the owner minted on /configure with MetaMask. MetaMask showed the transaction confirmed; the app said "The mint transaction failed." Verified: the fork had no transaction from the wallet. On Monad mainnet, where the wallet held 0 MON, a type-4 transaction (0x8bcc3d10...) sent by a relayer carried the mint call to the AgentNFT address, which has no code on mainnet, so it "succeeded" doing nothing. It also set an EIP-7702 delegation on the owner's mainnet account to 0x63c0c19a...e32b, which is still there.
3. 12:19 to 12:32: the fork moved to its own chain ID, 143143 (56d4df0), the app gained a wallet network guard (789af6d) and a named "sent to a different network" failure (4c49dab), and the README gained the MetaMask network steps (1dd5cc0).
4. Reported: MetaMask would not change the existing chain 143 entry's chain ID, the renamed entry kept intercepting, and the network could not be added from the site; it had to be added by hand. The switch buttons then did nothing while the app said the wallet was on Monad Testnet.
5. 13:03: the switch flow was rebuilt to reach the wallet and show every outcome (e28f012, c07da24).
6. Reported: the owner moved to OKX, which had taken over `window.ethereum`. With OKX correctly on the fork, the guard blocked the mint with a message that contradicted itself.
7. 13:27: the guard was rebuilt on a fixed block (ead099e). A unit test run during the task had reset the fork and removed AgentNFT (L-58); the live suite's setup redeployed it.
8. The owner minted and revealed. Verified: agent 1 on the fork is the bee (species 14), owned by 0x683e...5f76.

### Root causes

**1. The fork shared chain ID 143 with Monad mainnet** (L-53, D-195).
- How it showed up: a confirmed transaction in MetaMask, nothing on the fork, and an EIP-7702 delegation on the owner's mainnet account.
- Why: wallets and their services pick the network by chain ID. With no MON on chain 143, MetaMask sent the transaction through its gasless relay, which runs on MetaMask's servers for Monad mainnet whatever custom RPC is set, and upgraded the account to a smart account to do it.
- Fix: the fork answers 143143 and keeps Monad's EVM (`--network monad`); the app checks the wallet's network before sending and names a transaction that landed elsewhere.

**2. MetaMask's network model kept the old entry in the way** (reported).
- How it showed up: the renamed chain 143 entry kept taking requests meant for the fork.
- Why: MetaMask cannot change a saved network's chain ID, keeps a network per site separately from the one in its main view, and does not let two networks share one RPC URL, so an entry for 143 pointed at 127.0.0.1:8545 blocks a new entry for 143143 on the same URL.
- Fix: keep chain 143 on Monad's official RPC, add the fork as its own network (README "Wallet on the local fork"), and the switch flow now tells the user when MetaMask still reports another network for the site.

**3. A site cannot add a network whose RPC is http** (reported).
- How it showed up: no add prompt for the fork; it had to be added by hand.
- Why: MetaMask accepted wallet_addEthereumChain from the site only with an https RPC URL (reported), and the fork is http://127.0.0.1:8545. Privy's own add path also sends an empty explorer URL, which is not a valid URL.
- Fix: the README gives the exact network to add by hand, and when the wallet refuses to add the local network the switch message now gives those settings too; the app's add request has no empty explorer URL.

**4. A second extension silently owned `window.ethereum`** (reported).
- How it showed up: console tests run in the browser talked to OKX instead of MetaMask, and the "MetaMask" session behaved like OKX.
- Why: every wallet extension competes for `window.ethereum`, and the last one to load wins; OKX can also present itself as MetaMask. Verified: our app code has never used `window.ethereum` (none in the tree or in git history); every wallet call goes through the connected connector's provider.
- Fix: no app change was needed; the rule below keeps it that way, and console checks must use the connected provider, not `window.ethereum`.

**5. The switch buttons ignored their results** (L-55).
- How it showed up: clicking did nothing and no prompt appeared.
- Why: the buttons fired wagmi's `switchChain` and dropped the promise; wagmi waits for a chainChanged event that may never come, and errors went to hook state nothing showed. The mock wallet switched instantly, so tests never saw it.
- Fix: `switchWalletChain` asks the wallet's provider, adds the chain on 4902, confirms with eth_chainId, and the prompt shows every outcome; the app reads the chain from the provider and keeps wagmi in step.

**6. The network guard compared "latest" blocks** (L-57).
- How it showed up: a correct OKX setup was blocked with "Your wallet is on a network that reports chain 143143, not Monad (local fork)".
- Why: wallets cache and poll "latest" on their own schedule, a block from an earlier fork run has another hash, a wallet that did not answer was counted as another network, and two different failures shared one message. Verified: the pinned block's hash is identical on the fork and on mainnet, because the fork copies mainnet's history, so a block check alone cannot tell them apart.
- Fix: the guard checks the chain ID, the hash of one fixed block (the pin) and AgentNFT's code, all through the wallet's provider, with one plain message per failure.

**7. Test runs reset the shared fork** (L-58).
- How it showed up: AgentNFT disappeared from the running fork during a task; a playtest would lose its deployment, balances and agents.
- Why: the fork integration test calls anvil_reset, and a reset clears every snapshot, so the suite's revert could not bring anything back.
- Fix: the suite dumps the fork's state first and the reset test loads it back, asserting the head, AgentNFT's code and a balance match; the `afterAll` restores again if needed. Verified on the owner's fork with agent 1 on it: two runs left it identical.

**8. The masked Privy secret failed only on a later server path** (reported; consistent with the code).
- How it showed up: login worked, and a later server step that used the secret failed.
- Why: the session check verifies tokens with the key Privy publishes for the app ID, which needs no secret; the claim route's linked-wallet lookup is the first call that uses the secret. A dashboard copy with asterisks passes the first and fails the second. Verified today: `.env` holds a 105-character secret with no asterisks.
- Fix: the claim route answers 503 `privy_unavailable` with "check PRIVY_APP_SECRET ... not the dashboard's masked copy" instead of a bare 500.

### Rules for every unit that touches wallets or transactions

- [ ] Never use `window.ethereum` once a wallet is connected; use the connected connector's provider.
- [ ] Send, read receipts and check the network through that same provider, and read the app's own state through the app's RPC; compare them only on fixed data (chain ID, a fixed block, contract code), never on "latest".
- [ ] Never let a local or test chain share a real chain's ID.
- [ ] Map wallet error codes to plain messages: 4001 declined, 4902 unknown chain (add it, then switch), -32002 a request is already open, -32603 with an inner 4902 as unknown chain; show any other error's text.
- [ ] Never fail silently: every wallet request shows that it is waiting, what happened, or why it failed, and every message says which check failed.
- [ ] Confirm a wallet action by reading the wallet's state afterwards (a switch by eth_chainId, a send by its receipt).
- [ ] Give the mock wallet the real wallet's failure modes, and test each one.
- [ ] Tests must leave shared dev state as they found it: snapshot and revert, or dump and load around a reset.

### Mainnet and testnet risks for real users

| Risk | What goes wrong | How the app must handle it |
| ---- | --------------- | -------------------------- |
| Several wallets installed | The wrong extension answers, or Privy's MetaMask option opens another wallet that imitates it | Use EIP-6963 discovery through Privy, show the connected wallet's name and address, and run every call through the connected provider |
| Smart accounts and EIP-7702 delegations | An address has code; contracts that call receiver hooks or check `code.length` treat it as a contract; signatures may be smart-account signatures | AgentNFT mints with `_mint` (no receiver hook) and its agent-account check falls back to "not an agent" for other code (verified in the source); verify signatures that may come from smart accounts with EIP-1271 as well as ECDSA; show when a wallet is delegated |
| Gas sponsorship relays | The wallet sends through its own relayer: the transaction hash, the sender and the timing differ from a direct send, and it may go to another network | Confirm the network before sending, follow the receipt on the app's network, and say plainly when it landed somewhere else |
| Users on the wrong network | Actions go to another chain or fail | Block actions until the chain ID matches, offer one switch with every outcome shown, and confirm the switch by reading the chain |
| Wallets behave differently | 4902 arrives wrapped (-32603), add prompts differ or are missing, some switch without an event, some refuse http RPCs | Handle every known code shape, confirm by reading state rather than waiting for events, and test each supported wallet |
| A real network's public RPC lags | The app's RPC is a block behind the wallet's | Compare only fixed data, and wait a grace period before calling a receipt missing |

### Wallet compatibility test before the beta

Before PB-U1, on Monad testnet, run the mint, the network switch and a transfer with: MetaMask with smart accounts off; MetaMask with smart accounts on and an EIP-7702 delegation; OKX alone; MetaMask and OKX installed together (each chosen in turn); and one mobile wallet through WalletConnect. For each, check: the connected wallet's name and address; the network check and every switch outcome (approve, decline, unknown chain, request already open); that the mint lands on testnet and appears in the portal; that a gas-sponsored send is detected and either works or is explained; and that the console shows no errors. It is part of the widening pass W-1 in BUILD_PLAN.md.

---

## Numbered lessons

One entry for every bug found and fixed, newest at the bottom (the pinned section above is the one exception, D-196). Every unit session reads this file first. Append only. Format:

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

## L-57: The network guard compared "latest" blocks and blocked a correct wallet
Unit: P1-U11 (fix after handoff)
What happened: With OKX on the local fork (chain ID 143143, RPC http://127.0.0.1:8545), the mint stopped with "Your wallet is on a network that reports chain 143143, not Monad (local fork), which this app reads", a message that contradicts itself.
Cause: checkWalletNetwork took the wallet's latest block and required the app's RPC to have the same hash at that number. A wallet caches and polls "latest" on its own schedule; after today's fork restart a cached block 109670001 from the earlier run also has another hash. It also counted a wallet that could not answer a request as a different network. Both failures produced the same text, so the OKX report cannot say which one fired.
Fix: The guard checks the chain ID through the wallet's provider, the hash of one fixed block (the pinned block) through both sides, and AgentNFT's code through the wallet; each failure has its own plain message, and a silent wallet is reported as silent (ead099e). The pinned block's hash is identical on the fork and on mainnet (checked through both RPCs), so the chain ID and the code check carry the mainnet case.
Lesson: Never compare "latest" block data between a wallet and the app; compare a fixed block, and give each failed comparison its own message so a report says which one failed.

## L-58: Running the unit suite undeploys AgentNFT from the dev fork
Unit: P1-U11 (found, not fixed)
What happened: AgentNFT had code on the running fork at the start of this task and none before the live suite ran; the fork was back at the pinned block. Nothing else was lost, because the fork held only the deployment.
Cause: `pnpm test` includes packages/devenv's fork integration test "resets to the pinned block", which calls anvil_reset on the shared dev fork whenever one is running, and a reset removes every block after the pin. The test then snapshots the reset state for its cleanup, so it does not restore what was there.
Fix: None in code: the owner's fork was redeployed by the live suite's setup, and the guard now says "Deploy it with pnpm deploy:agent-nft" when AgentNFT is missing on the app's side. The reset test should restore the fork it found (snapshot before resetting and revert after) in a later unit.
Lesson: A test that resets shared state must put back what it found, and running the unit suite during a playtest is a state change, not a read.

## L-59: drei Html roots in the 3D viewer raced React
Unit: P1-U11 (fix after handoff)
What happened: The Next.js dev overlay on /configure showed "3 Issues". Read from the dev server's own error report (its /_next/mcp get_errors tool), they were: "Attempted to synchronously unmount a root while React was already rendering" from the viewer's loading note; "Failed to execute 'removeChild' on 'Node'"; and a missing `key` warning inside Privy's PrivyProvider.
Cause: drei's Html mounts a separate React root for each element. The loading note was a Suspense fallback, so React unmounted it in the middle of a render, and Html's cleanup unmounted its root synchronously; the slot markers were Html too, and their cleanup removed nodes React had already removed with the canvas wrapper. The key warning comes from Privy's own minified component and is not in our code.
Fix: The viewer no longer uses drei Html: slot markers and the loading note are DOM in an overlay Viewer3D owns, moved each frame from the projected socket positions. The live bee test fails on any console or page error from load to unmount (a099230). The Privy warning is left to Privy.
Lesson: Do not mount drei Html (or any second React root) in a Suspense fallback or anything React may unmount mid-render; draw overlays as DOM the component owns, and assert a clean console in the test that renders them.

## L-60: The live suite only worked while the 1-of-1 bee was unminted
Unit: P1-U11 (fix after handoff)
What happened: After the owner revealed agent 1 as the bee, the live suite failed two tests with "species 14 has no slot left on this fork".
Cause: The deck holds exactly one bee, and the bee tests ask the reveal for it; per-test snapshots cannot give back a bee the playtest minted before the suite started. This is L-15 again: a test that depends on persistent shared state passes only on a fresh fork.
Fix: When no bee is left, the suite dumps the fork, resets it to the pin, runs on a fresh deployment, then resets again and loads the dump back; the run left the owner's fork identical, agent 1 included (a099230).
Lesson: A test that needs a scarce on-chain item must check it is available and set up its own when it is not, then restore the shared state it changed.

## L-61: The mint button lagged the panel's reveal
Unit: P1-U10
What happened: In the first screenshot run, the panel could show a revealed agent while its mint button still said "Waiting for reveal".
Cause: Two independent polls saw the reveal: the mint flow's (every 2 seconds) and the page's wallet read (every 3 seconds). The panel took whichever came first, and the button took only the mint flow's.
Fix: The button's state and its "Pro · Bee" text come from the panel's view, so both change together (f10aea3).
Lesson: When two reads can report the same event, derive every view of it from one combined value, never from each read separately.

## L-62: One more nav link overflowed the desktop header
Unit: P1-U10
What happened: After Mint was added to the nav, the header test (from L-50) failed: the connected header was 29px too wide at 1280px and 1440px.
Cause: The inline nav had no slack left at the xl breakpoint when connected, and each link added about 60px.
Fix: Nav links use 8px instead of 10px side padding, which saves 32px; the test passes at 1024, 1279, 1280 and 1440px (fb20706). The slack left is small, so the next link needs a layout change, not tighter padding.
Lesson: The L-50 measurement test earns its keep: run it whenever the nav changes, and plan for the header's next item before the slack runs out.

## L-63: A fork restored from a state dump has no history
Unit: P1-U10 (found, not fixed)
What happened: `pnpm test:fork` ran its 12 forge fork tests and then failed the address book step with "eth_getCode: JSON-RPC error -32602". Every state read below the head (code or balance at block 109670000 or 109670004) answered "BlockOutOfRangeError: block height is 109670005 but requested was 109670000". Block headers, the pinned block's hash included, still served, so the app and the wallet network guard were unaffected.
Cause: The L-58 and L-60 restores reset the fork and call `anvil_loadState` with a full dump. A throwaway, non-fork anvil showed that a loaded state serves the head and block headers but no historical state: after mining 3 blocks, a dump, a reset and a load, the balance at block 1 fails the same way while the head works. The owner's fork has been restored this way since P1-U11's runs, and this unit's suite runs restored it again.
Fix: None in code. `test:fork` passes on a fresh fork, run inside the same dump, reset and load, which left the owner's fork as found. The LOGS entry suggests restoring without losing history.
Lesson: Know what a restore does not bring back: a state dump restores state, not history, so any check that reads at a past block must run before the restore or on its own fork.

## L-64: Three slips in new e2e tests
Unit: P1-U10
What happened: Three new tests failed for test reasons, not app reasons. `filter({ hasText: "Bee" })` also matched "Hercules beetle". An owner check compared a checksummed address with the mixed-case mock address and failed on case alone. The live test followed the agent link and found /configure logged out. Separately, the revealed panel capture differed by a 4 by 3 pixel patch at its rounded corner.
Cause: `hasText` with a string is a case-insensitive substring match; addresses must be compared without case; the link is a full page load, and the mock wallet, unlike a Privy session, does not survive one. The capture differed because an earlier, taller state left the page scrolled, and an antialiased edge rasterizes differently at another offset (L-44).
Fix: An anchored regex, a lowercase comparison, a reconnect on /configure, and a scroll to the top before every capture; the mint spec then passed three runs in a row and the live suite four (3e03e4a, b5c5b9b).
Lesson: Match names with anchored patterns, compare addresses without case, remember which state survives a page load in the mock, and fix the scroll offset before an element capture.

## L-65: Panel captures differed by an antialiased corner between runs
Unit: P1-U4
What happened: Mint panel screenshots failed on some runs and passed on others, by 1 to 15 pixels at the panel's top-left corner, one color level each. The layout was identical in every run (same bounding box, scroll and page height).
Cause: After the panel changed state, the browser repainted only part of the page, and the rounded corner's antialiased pixels were composited differently depending on which partial repaints had happened. A first guess, the scrollbar changing the page width, was wrong: reserving the gutter made the mobile layout 15px narrower than a phone's, and it was removed.
Fix: Before each mint panel capture, the root's opacity is toggled across two animation frames, forcing a full repaint; four runs in a row then matched (95fc33f).
Lesson: When a capture differs by a few edge pixels with an unchanged layout, force a full repaint before capturing instead of loosening the comparison; and measure (bounding box, scroll, width) before acting on a theory.

## L-66: Staged deletions were swept into an unrelated commit
Unit: P1-U4
What happened: Commit af4de72 (the indexer's fork test) also deleted the web dev claim route and the web server code, because `git rm` had staged those deletions earlier while the replacement code was still unstaged. Between af4de72 and be04bf0 the web mint posts to a route that no longer exists.
Cause: `git rm` stages at once, and the commit gate checked the files added for that commit but not the whole staged set.
Fix: None to history (it is not rewritten); the gap is noted in the log, and later commits read the staged list before committing.
Lesson: Delete files with plain `rm` and stage them with the commit they belong to, and read `git diff --cached --stat` before every commit.

## L-67: A failed migration left a test database behind
Unit: P1-U4
What happened: Two `alpha_agents_db_*` databases stayed on the development Postgres after the first test runs failed.
Cause: createTestDatabase created the database and then migrated it; when the migration threw, the caller never received the handle that drops it.
Fix: A failed migration drops the database before rethrowing; the leftovers were dropped by hand (3072750).
Lesson: A helper that creates a shared resource must clean it up on its own failure paths, before it hands the caller a handle.

## L-68: A default parameter turned "no token" into a valid token
Unit: P1-U4
What happened: The API test "an invalid or missing session is refused" got 200 for the missing case.
Cause: The test helper's token parameter had a default, `"alice-token"`, and passing `undefined` to a parameter with a default uses the default.
Fix: The helper takes `null` for no token (b8b6168).
Lesson: Use `null`, never `undefined`, to mean "absent" for a parameter that has a default.

## L-69: Parameter properties would not run under Node's type stripping
Unit: P1-U4
What happened: Typecheck rejected two classes with `erasableSyntaxOnly`; the services run TypeScript directly with Node, which would also have refused them at runtime.
Cause: Constructor parameter properties (`constructor(private readonly id: number)`) emit code, which type stripping cannot do.
Fix: Plain fields assigned in the constructor (246d65f).
Lesson: In code Node runs as TypeScript, use only erasable syntax: no parameter properties, enums or namespaces.

## L-70: test:fork's first run after other fork tests times out
Unit: P1-U4 (found, not fixed)
What happened: On its own fork, `pnpm test:fork` passes 12 of 12 in under a second when run on its own, but its first run right after other fork tests (pnpm test's fork tests or the live suite) fails test_GasForMintAndReveal, or two tests, after about 95 seconds, with forge's "failed to get account ... operation timed out" from the test fork. The next run passes.
Cause: Not established. The fresh fork must fetch every account and slot those tests touch from the upstream, which the playtest fork had in memory; the warm runs read Foundry's shared fork cache. Ruled out: the upstream was answering in under 250 ms; a 300-second forge RPC timeout only made the failure slower; retrying forge on the same fork failed every test (the fork stopped answering); keeping the other forks off the shared cache (`--no-storage-caching`) did not help.
Fix: None; all experiments were edited back. test:fork is reported as passing on its own and failing on its first run after other fork tests.
Lesson: Moving a heavy fork test from a long-lived fork to a fresh one moves its upstream fetching into the test; measure a fresh fork's cold run before relying on it.

## L-71: An in-memory fixture invented an event the contract never emits
Unit: P1-U4
What happened: The indexer's in-memory fixtures had a mint emit OwnerEpochBumped with epoch 1; indexing the real fork showed agent 1 at epoch 0 and no such event in its mint.
Cause: The fixture was written from memory of the plan, not from a real transaction; AgentNFT bumps the epoch only on transfers, never on a mint.
Fix: Fixtures emit Transfer and AgentMinted for a mint, and the expected epochs and counts were corrected (246d65f).
Lesson: Build event fixtures from a real transaction's logs, and run the code against a real chain at least once before trusting its fixture tests.

## L-72: Blocking advisory locks deadlocked the connection pool
Unit: P1-U5
What happened: The provisioning test that calls provision five times at once hung until it was stopped, and the stopped run left a test database behind (dropped by hand).
Cause: withAgentLock took a pooled connection and blocked in `pg_advisory_lock` on it. With a pool of 4, four waiters held every connection, so the lock holder could not get one for its own queries and never released the lock.
Fix: The lock is a `pg_try_advisory_lock` loop that returns its connection between tries, with a deadline (12ee0d2); the concurrent test passes in under a second.
Lesson: Never block on a lock while holding a pooled connection that the lock holder may need; wait without holding one, and test the concurrent path with more callers than the pool has connections.

## L-73: LiteLLM's /key/info still returned a deleted key
Unit: P1-U5 (found before it caused a failure)
What happened: A probe deleted a throwaway virtual key by alias, then asked /key/info: it answered 200 with the key's details, also five seconds later, while /key/list by alias returned nothing and a call with the key got 401.
Cause: /key/info answers from LiteLLM's key cache, which a delete does not clear at once. It is L-17 again: a counter or record read through a cache right after a write is not the truth.
Fix: The orchestrator decides whether a key exists only through /key/list by alias (12ee0d2), and the live check confirms deletion the same way.
Lesson: Before relying on an admin read to confirm a delete, delete something and read it back through that exact call; use the listing, not the cached detail view.

## L-74: pnpm add rewrote peer resolutions across the whole lockfile
Unit: P1-U5
What happened: Adding two workspace links with `pnpm install --offline`, and later BullMQ, viem and Hono with `pnpm add`, changed 700 to 800 unrelated lockfile lines each time, adding or dropping `typescript@6.0.3` peer suffixes and moving the web app's viem onto zod 3.25 instead of 4.6.
Cause: pnpm 9 re-resolves optional peers for every importer when it writes the lockfile, and the result flips between two valid forms; earlier units committed this churn (be04bf0 changed 288 such lines).
Fix: The lockfile was merged at the text level: HEAD's entries kept exactly, the orchestrator's importer block added with HEAD's resolutions, and only package and snapshot entries for packages HEAD did not have; `pnpm install --frozen-lockfile` accepted each result (12ee0d2, f2cd946).
Lesson: Read the lockfile diff after every dependency change, and keep a commit's lockfile changes to the packages it adds.

## L-75: L-70 resolved: a cold test fork's upstream fetches timed out the gas test
Unit: P1-U5
What happened: test_GasForMintAndReveal failed after about 96 seconds on its first run after other fork tests, with forge's "failed to get account ... operation timed out" from the test fork (reproduced in this unit).
Cause: The test minted 50 agents to 50 new wallets, each creating a new account, so forge asked the cold fork for about a hundred unknown accounts, each of which the fork fetched from the upstream one at a time; the reads outran forge's timeout.
Fix: The test mints and reveals 10 agents, which still measures the reveal's fixed and per-agent gas (27,000 per agent), and `pnpm test:fork` reruns forge once on a fresh fork when a run fails with an error L-43's classifier calls a transient upstream fetch (8bad7c2, D-206). Six cold runs after the keeper's fork test took 10 to 14 seconds; five passed at once, and one hit L-43's "failed to fetch grandparent block" in setUp before the retry was added. Run right after the full unit suite (three forks of its own), the first forge run still timed out in two tests on the same fetch error after 47 seconds, and the retry on a fresh fork passed 12 of 12: the lighter test makes the timeout rarer and faster, and the retry is what makes the command reliable.
Lesson: Size a fork test by the number of new accounts it makes the fork fetch, not only by its gas, measure it cold, and keep a bounded, classified retry for the upstream fetches no test size removes.

## L-76: The sweep test killed its fake tunnel before it was a tunnel
Unit: P1-U6
What happened: The P1-U5 sweep test failed once in a commit gate: the sweep reported no tunnel stopped. It passed when run alone.
Cause: The test spawned `bash -c "exec -a cloudflared sleep 120"` and swept at once. Until bash has exec'd, /proc shows the parent's command line, and the sweep, correctly, will not stop a process that is not cloudflared. Under load the sweep ran first.
Fix: The test waits until /proc shows the process as cloudflared before sweeping (60296bc); three runs in a row passed.
Lesson: A test that prepares a process for code that inspects it must wait until the process is in the state it means to test, not just spawned.

## L-77: A commit went in while its gate had failed, again
Unit: P1-U6
What happened: e996526 was committed although its gate reported "GATE FAIL" (the L-76 test). This is L-42 and L-56 again.
Cause: To stop the shell expanding a `**/*.fork.test.ts` argument, the commit helper wrapped the gate in `set -f; gate; set +f`, and the next line read `rc=$?`, the exit code of `set +f`, which is always 0.
Fix: The helper reads the gate's code on the same line, `gate; rc=$?; set +f`, checked with a deliberate failure; the failing test was fixed in the next commit (60296bc). History is not rewritten.
Lesson: Capture an exit code immediately after the command it belongs to, and prove a commit gate stops a failing commit before trusting it.

## L-78: Scripted edits that matched nothing failed silently
Unit: P1-U6
What happened: Two scripted text replacements did nothing without an error. One left the live check's indexer with `usdc: null`, so deposits were never indexed and the check timed out waiting for credits; finding why took two live runs. Another, earlier, replicated a block of a new file thousands of times (94,922 lines) before it was rewritten whole.
Cause: Python's `str.replace` returns the text unchanged when the pattern is absent; prettier had reformatted the target object onto several lines since the pattern was written.
Fix: The live check sets USDC (1c55146); the corrupted file was rewritten whole before it was committed. Replacements in scripts now assert their pattern is present once.
Lesson: Every scripted edit asserts its pattern matched exactly once, and a new file is checked for size and content after a scripted change.

## L-79: A "use server" file exported a constant and broke the console build
Unit: P1-U6
What happened: The console's production build failed with "Only async functions are allowed to be exported in a 'use server' file", followed by every server action reported as missing.
Cause: The fund action's amount was an exported `const` in actions.ts, which Next.js forbids in a server actions module.
Fix: The constant is module-private (a6858ca).
Lesson: Export only async functions from a "use server" file, and build the app (not only typecheck it) before calling a server action change done.

## L-80: Small spend showed as zero, and a wide table hid its actions
Unit: P1-U6
What happened: In the first console captures, 24-hour spend of 0.0056 USDC read "0 USDC", and at 1440px the new Fund and Refund buttons were cut off at the table's right edge while agent names wrapped onto three lines.
Cause: AmountDisplay truncates to two decimals by default, and a model call costs fractions of a cent; ten columns were wider than the page.
Fix: Credits and spend show four decimals (still truncated, never overstated); related values share a column, names do not wrap, and the action groups stack (a6858ca). The captures were checked by eye at both widths before baselining.
Lesson: Pick display precision from the size of the values shown, and look at a table's capture at the widest and narrowest widths whenever it gains a column.

## L-81: The first drain check measured the wrong call
Unit: P1-U6
What happened: The live check's "run ends as billing" step passed its count of one 402 while the run had in fact completed: the refused request was a free `GET /v1/models`, and the model completion had been served. The next attempt "spent" the agent's balance with a 5-token call costing 0.00003 USD, far less than the 0.0016 USD the balance bought, so nothing was drained.
Cause: The no-op task's "model calls" counted every `/v1` request through the gate, and the drain call was sized by guess rather than by its cost.
Fix: The task result lists each gated call's method, path and status, the check requires the one chat completion to be the 402, and the drain call is sized to cost more than the balance; the check then passed with the completion refused and no retry (1c55146).
Lesson: Assert on the specific request a claim is about, and size a test's spending by its measured cost, not by assumption.
