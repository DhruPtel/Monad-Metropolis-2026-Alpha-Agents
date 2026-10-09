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

- [ ] Never use `window.ethereum`; use the chosen wallet's own provider, found by its EIP-6963 announcement (D-224).
- [ ] Send, read receipts and check the network through that same provider, and read the app's own state through the app's RPC; compare them only on fixed data (chain ID, a fixed block, contract code), never on "latest".
- [ ] Never let a local or test chain share a real chain's ID.
- [ ] A login belongs to one address: when the wallet's account changes or it stops sharing one, end the session at once and say so; never read or sign for one address with another's session (L-95).
- [ ] Map wallet error codes to plain messages: 4001 declined, 4902 unknown chain (add it, then switch), -32002 a request is already open, -32603 with an inner 4902 as unknown chain; show any other error's text.
- [ ] Never fail silently: every wallet request shows that it is waiting, what happened, or why it failed, and every message says which check failed.
- [ ] Confirm a wallet action by reading the wallet's state afterwards (a switch by eth_chainId, a send by its receipt).
- [ ] Give the mock wallet the real wallet's failure modes, and test each one: a login that outlives a reload, a token that links only its own wallet, two wallets installed at once (L-95).
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

Before PB-U1, on Monad testnet, run the mint, the network switch and a transfer with: MetaMask with smart accounts off; MetaMask with smart accounts on and an EIP-7702 delegation; OKX alone; MetaMask and OKX installed together (each chosen in turn); and one mobile wallet through WalletConnect. For each, check: the connected wallet's name and address; the network check and every switch outcome (approve, decline, unknown chain, request already open, and for OKX adding the local network or showing the manual steps); switching accounts in the wallet while logged in (the session ends with a notice, and logging in again uses the new account, with no 403 in the console); that the mint lands on testnet and appears in the portal; that a gas-sponsored send is detected and either works or is explained; and that the console shows no errors. It is part of the widening pass W-1 in BUILD_PLAN.md.

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

## L-82: Escapes for invisible characters were written as the characters
Unit: P1-U7
What happened: Lint failed on the new data tools server with "Irregular whitespace not allowed" in web-content.ts and "Unexpected control character" in its test, although both had been written with `\u`-style escapes. The files held the literal zero-width, bidirectional and BEL characters, and the tests had passed with them.
Cause: The escapes became the characters themselves when the files were written, so the source carried characters a reader cannot see (the Trojan Source class of problem), which lint rightly rejects.
Fix: The lines were rewritten with escapes by a script that writes the backslash sequences literally, and a grep for non-ASCII bytes in the new sources finds none (efc4b35).
Lesson: Write invisible and control characters only as escapes, and grep new source files for non-ASCII bytes before committing them.

## L-83: A scripted edit changed the first match, in the wrong class
Unit: P1-U7
What happened: An edit meant to make the narrator derive its key with `narratorKeyFor` looked for `this.key = ` and replaced the first occurrence, which was in the LiteLLM model client's constructor. The grep printed after the edit showed it; every test still passed, because every narrator test used a fake model.
Cause: The script found the line by its first index instead of asserting a unique pattern (L-78 again), and nothing tested the real model client.
Fix: The client's line was put back and the narrator's changed, both with uniqueness assertions; a new test checks that the real client sends the narrator's own key and the `narrator` alias to a local server.
Lesson: A scripted edit names a pattern that occurs exactly once and asserts it, and a component that every test fakes needs one test of its real implementation.

## L-84: The startup sweep would have deleted the narrator's key
Unit: P1-U7 (found before it caused a failure)
What happened: The narrator's LiteLLM key is a platform key in the orchestrator's namespace (`aa-<namespace>-narrator`), and P1-U5's startup sweep deletes every key with the namespace prefix that no agent runtime owns.
Cause: The sweep's rule assumed every key in a namespace belongs to a runtime.
Fix: The sweep keeps the narrator's alias, and the sweep test plants one and checks it survives (aa29711).
Lesson: When a new kind of resource joins a namespace that a cleanup sweeps, add it to the sweep's keep list and its test in the same change.

## L-85: Stopping dev:all signalled pnpm's shell, not the supervisor
Unit: P1-U7
What happened: Before the Playwright suites, `kill -TERM` on the first PID that `pgrep -f 'node scripts/dev-all.js'` printed ended the background command, but the web app, console, API, indexer and orchestrator kept listening.
Cause: The first match was pnpm's `sh -c` wrapper, whose command line holds the same text; the supervisor was its child and never got the signal.
Fix: The supervisor itself (the parent of the services) was signalled; it stopped every service, and the ports were checked free before any suite ran.
Lesson: Choose the PID to stop by its role (the parent of the services, from `ps -o pid,ppid,cmd`), and confirm the ports are free afterwards instead of trusting the exit of the command that was started.

## L-86: A console capture flickered at its corners once it moved (L-65 again)
Unit: P1-U7
What happened: After the new activity section moved the console's no-op result card down the page, its capture failed by 3 to 26 corner pixels, one color level each, and after a re-baseline the next run failed the same way.
Cause: L-65's partial-repaint antialiasing. Its fix, a full repaint before the capture, was applied only to the web suite.
Fix: The console spec forces a full repaint (root opacity across two animation frames) before its element captures; after one re-baseline, two runs in a row passed (c158e3c).
Lesson: When a fix for a capture flake lands in one suite, apply it to every suite that captures elements.

## L-87: The upstream RPC sometimes answers the pinned block as missing
Unit: P1-U7 (found, not fixed)
What happened: The keeper's fork test in one commit gate and the first live check run both failed with "the test fork ... did not start"; the fork log said "Failed to get block for block number: 109670000 ... non-archive node". A probe of 12 requests for the pinned block got 10 blocks and 2 empty answers (HTTP 200, null result).
Cause: The upstream behind MONAD_RPC_URL is load balanced, and some of its nodes do not keep the pinned block, so a new fork's first fetch fails at random. startTestFork's three attempts usually, but not always, ride it out.
Fix: None in code; the gate and the live check were run again and passed. The LOGS entry suggests a retry with backoff, or the secondary RPC, for fork start.
Lesson: Classify a failure by the server's own log before rerunning (L-51), and record an environment flake once, with its measured rate, rather than rerunning past it silently.

## L-88: A finished Scan did not yet have its activity entry
Unit: P1-U7
What happened: The first full live run passed every Scan check except the narrator's: the check found no activity entry for a Scan whose task already read "succeeded". The orchestrator's log showed the narrator writing it 15 to 30 seconds later. The same run's check names also read "activity scanEntry", because a regex rename of a variable had also rewritten the word inside strings.
Cause: The Scan marked its task finished and only then called the narrator, so "finished" did not mean "narrated" (L-10 again: state read right after a write it does not wait for). The rename matched whole words without telling code from text.
Fix: The Scan narrates before it marks the task finished, on the failure path too, so a finished Scan always has its entry; the check names were corrected by hand.
Lesson: When a step's result is promised alongside a status, write the result before the status, and rename identifiers with the type checker's help rather than a word regex.

## L-89: The reveal watch's 404s failed the live bee test at random
Unit: P1-U9 (seen in P1-U7 and P1-U9)
What happened: The web live suite's bee test failed once in P1-U7 and once in P1-U9 on a single browser console error, "Failed to load resource: the server responded with a status of 404", and passed on the next run each time. The message named no URL.
Cause: After a mint, the page watched for the reveal by polling `GET /v1/agents/:id`, which answers 404 until the indexer has seen the mint, and the browser logs every failed load as a console error, which the test counts (L-59). Whether the first poll beat the indexer decided the run.
Fix: The reveal watch reads the minter's agent list, which answers 200 and is empty until the mint is indexed; the live test also records the status and URL of any failed response, so a recurrence names itself. Two runs in a row then passed (42828ff).
Lesson: Poll for something that does not exist yet through a route that answers "none" with 200, and make a test that counts console errors also record which request failed.

## L-90: The /design scan once found a scrollable tab list it could not focus
Unit: P1-U9 (found, not fixed)
What happened: In the `--update` run of the web suite, the mobile /design scan reported "serious scrollable-region-focusable: .max-w-full", the tab list. The run before it and the two runs after it passed, and the tab list has not changed since P0-U7.
Cause: Not established. The tab list scrolls sideways when its labels are wider than 380px, and axe flags a scrolling region whose focusable children it does not count; when that happens depends on layout timing.
Fix: None. The LOGS entry suggests making the scrolling tab list focusable itself (tabIndex 0 with a label), which satisfies the rule whatever the timing.
Lesson: Record an accessibility finding that does not reproduce with its exact selector, rather than rerunning past it, so its cause can be pinned when it returns.

## L-91: Retries around anvil could not fix a fork whose upstream lies, and a proxy in the caller's process stalled
Unit: P1 tuning
What happened: After D-220's retries, the keeper's fork test still failed to start its fork: six attempts, three passing the pinned-block check and then failing inside anvil with "Resource not found". A probe showed why: requests for the pinned block with its transactions, which anvil sends, came back null half the time (the hash-only form a sixth of the time). A retrying proxy fixed the start, but every AgentNFT deploy then timed out with "MPP HTTP request ... operation timed out".
Cause: Some nodes behind the load-balanced upstream lack the pinned block and answer null, and anvil takes one answer as final, so a whole-start retry needs every one of anvil's requests to land on a good node. The proxy then ran in the test's own process, and the deploy helper runs forge through spawnSync, which blocks that process's event loop, so the proxy could not answer anvil while forge waited on anvil. Two smaller slips in the proxy were found on the way: Node's default 5-second keep-alive closing sockets anvil reuses, and retrying null transaction receipts, which anvil asks about for its own local transactions.
Fix: Forks reach the upstream through a retrying JSON-RPC proxy (null block lookups, not-found errors, rate limits, 5xx and dropped connections, with backoff, alternating with the secondary), run as a child process for test forks and in-process in the playtest fork's runner, with a long keep-alive, retries limited to block lookups, and anvil's own timeout raised above the proxy's budget (562dc23). The deploy then took 8 seconds, and the keeper's fork test passed.
Lesson: Retry at the layer that sees the bad answer, not around the program that receives it; and never host a server in a process that may block in a synchronous child call.

## L-92: A shared package's import-time path broke the console's build
Unit: P1 tuning
What happened: The console's `next build` failed collecting /fork with "The path argument must be of type string or an instance of URL. Received an instance of URL", pointing at the upstream proxy's `fileURLToPath(new URL(..., import.meta.url))`.
Cause: `packages/devenv` is bundled into the console, where `import.meta.url` is not a file URL, and the call ran at import, so any page that imported the package failed. Node-only tests and typecheck could not see it.
Fix: The path is resolved inside the function that spawns the proxy (2d14053); the console builds again.
Lesson: Code in a package that a bundler also consumes does nothing environment-specific at import; and a change to a shared package is not done until every app that imports it has built.

## L-93: L-90 resolved: Radix owns the tab list's tabindex
Unit: P1 tuning
What happened: L-90's intermittent "scrollable-region-focusable" on the scrolling tab list. A probe showed Radix's roving-focus root sets the list's own tabindex, and sets it to -1 while no tab has registered or while focus tabs back out; with every tab at -1 too, a scan at that moment sees an unfocusable scroller. A first fix put the list in a focusable wrapper but left the list's border on the list, so the wrapper clipped the frame's right edge when the tabs overflowed, which the address book capture showed at 380px.
Cause: Two owners of one attribute: the scroll container's focusability and Radix's roving tabindex.
Fix: Tab lists scroll inside a focusable, labelled wrapper that also carries the frame; the list keeps Radix's tabindex (f809788). Every tab capture is pixel-identical to before, and the /design scans passed at both widths.
Lesson: Do not set an attribute a library manages; wrap the element, and keep visual framing on the element that clips.

## L-94: A live check compared a truncated amount within a tolerance truncation can exceed
Unit: P1 tuning
What happened: The My Agents live run failed its refund check: the page said 0.9299 USDC, the chain showed 0.92997, and `toBeCloseTo(..., 4)` allows only 0.00005.
Cause: The page truncates to four decimals, never rounding up, so the difference can approach 0.0001; the test assumed rounding.
Fix: The check compares the chain amount truncated to four decimals with the page's figure exactly (36d53d7); the next run passed.
Lesson: Check a displayed amount with the display's own rule (truncation here), not with a tolerance.

## L-95: An account switch kept the old wallet's session, and the mint page could not load
Unit: wallet reliability
What happened: The owner switched wallets and later sent funds to a different wallet, and /mint showed "Could not read". Reproduced: after an account switch in the wallet the button showed the new address, eligibility was asked for it with the old wallet's Privy token, the API answered 403 `wallet_not_linked` (logged in the console as a failed resource), and the panel became the read error; on /agents owner sessions failed with `not_owner`, and /configure showed the new address's agents under the old login.
Cause: The app took its address from wagmi, which follows the wallet's account, while the Privy session (and its token) belongs to the address that logged in; nothing compared the two. The mock wallet hid it: it accepted any account with one fixed token, the fake API never checked linking, and its login did not survive a reload.
Fix: One wallet core for Privy and the mock reads the account from the chosen wallet's provider and ends the session with a notice the moment it differs from the login's address or disappears; the address and token are exposed only while they match (633fa13). Mock tokens now name their wallet, and the mock identity and fake API link only that wallet; the mock logs in through two EIP-6963 wallets and persists its login; the specs that switched accounts now expect a fresh login (6453bf3, 52cee48).
Lesson: A login and a wallet account are two facts; check that they agree on every change, and give the mock the same split so a test can see them disagree.

## L-96: The Connecting spinner could not be left
Unit: wallet reliability
What happened: The connect button sometimes spun on "Connecting" with no action, and clicking around did nothing.
Cause: Privy was authenticated but no wallet account was available (after a reload with the wallet locked, the site disconnected in the wallet, or Privy dropping its active wallet after an account change); the state was "connecting" with no button, and Privy's `login()` does nothing while a session exists.
Fix: The core ends such a session (no account) with a notice, a connect while a session exists logs out first, and a waiting connect shows Cancel in the wallet button at once and a notice saying what it waits for (633fa13, 02d65ff).
Lesson: Every waiting state needs a way out and a reason on screen; check what the login library does when asked to log in while it believes it already is.

## L-97: The wallet's name overflowed the header from 1280px
Unit: wallet reliability
What happened: The header width test failed at 1280 and 1440, connected with OKX Wallet: 70px over.
Cause: From 1280 the header holds the nav inline, and the wallet's name was added beside the chain chip and the address.
Fix: From xl to 2xl the name takes the chain chip's place; the header's chain indicator and the wrong-chain prompt still cover the network (02d65ff).
Lesson: Test header additions with the longest value they can take; the width test caught it only because it connects with OKX, the longest name.

## L-98: A staged deletion rode along in an unrelated commit
Unit: wallet reliability
What happened: Commit 507e7db, meant for the design system only, also deleted `use-wallet-chain.ts`, which the Privy provider at that commit still imported, so that one commit does not build; 633fa13 removes the import.
Cause: The deletion was made with `git rm`, which stages it, and the next commit staged two files by path without reading the full staged list.
Fix: None possible without rewriting history; the next commit restored a building tree, and this lesson records it.
Lesson: Delete files with `rm` and stage them with the commit they belong to, and read `git status` for staged entries, not only the files just added, before every commit.

## L-99: A brief notice during connect moved later captures by a few pixels
Unit: wallet reliability
What happened: After the wallet changes, the shell and portal captures differed from their baselines by 1 to 35 antialiased pixels, and a re-baseline did not hold on the next run.
Cause: The waiting notice showed for the mock's 150 ms login and shifted the page, and these captures had no full repaint before them (L-65).
Fix: The notice waits 1.5 seconds before it shows (Cancel shows at once), and the shell and portal captures repaint first through a shared helper (02d65ff, 6453bf3); two consecutive runs matched.
Lesson: A transient element must not appear for quick, normal flows, and every capture taken after state changes repaints first.

## L-100: A script aimed at a test fork minted USDC on the playtest fork
Unit: P2-U1
What happened: `pnpm custody:local demo`, run with `LOCAL_FORK_PORT=8575` against a throwaway fork, failed its deposit with "transfer amount exceeds balance". The test USDC had been minted on the playtest fork on 8545 instead: anvil account 6 held 25 USDC there, USDC's supply was 25 higher, Circle's master minter and the fork-only test minter had each used a nonce, the test minter had been made a minter, and the head had moved from 109670005 to 109670007.
Cause: `scripts/lib/custody.js` called devenv's `mintTestUsdc(owner, amount)` without a URL. The scripts' own `ANVIL_URL` follows `LOCAL_FORK_PORT` (D-200), but every devenv function defaults to the playtest fork's URL whatever the environment says, so the one call that relied on the default went to 8545, and the local-fork guard accepted it because 8545 is the local fork.
Fix: The helper passes `ANVIL_URL` (74bd308). On the playtest fork the change was undone by hand: the 25 USDC went back to the test minter and were burned, the test minter was removed, and the three nonces and two MON balances were set to their values at block 109670005; every one now reads the same at that block and at the head. Three more blocks were mined doing it; blocks cannot be removed without a reset, so the head is 109670010.
Lesson: When code can target more than one fork, pass the URL to every call explicitly; a default that points at the shared fork turns a test run into a playtest change, and the local-fork guard cannot tell the two forks apart.

## L-101: A select menu ran off the bottom of a short screen
Unit: P2-U1 (step 0)
What happened: At 380px the console test could not pick "Praying mantis" from the 25-species list in the new Reveal next as card: Playwright reported "element is outside of the viewport" on every retry for two minutes.
Cause: The design system's SelectContent had `overflow-hidden` and no maximum height, so a long list opened in popper mode simply extended past the screen, and Radix locks page scrolling while a select is open, so the later options could not be reached at all. Every earlier select had a few options.
Fix: SelectContent stops at `--radix-select-content-available-height`, the space Radix measures, and its viewport scrolls (6e912a4); the mobile test now picks the option.
Lesson: Give every popover a maximum height from the space available, and test a long list at the narrowest width.

## L-102: Three slips in new tests, caught before commit
Unit: P2-U1
What happened: Ten custody swap tests failed with "next call did not revert as expected"; the keeper's fork test expected a reveal request one tick early; and an invariant meant to prove the runs reached deep states asserted only that a counter was at least zero.
Cause: The swap tests built their parameters with a helper that reads `nft.ownerEpoch()`, an external call, between `expectRevert` and the swap (L-39 again). The keeper opens its batch window on the tick that first sees a mint, and the test skipped that tick. The invariant could not fail.
Fix: Parameters are built before `expectRevert`; the test ticks once more; the vacuous invariant became a handler probe that requires deposits, withdrawals and credits to happen, and a mutation (withdraw without `onlyOwner`) made both fund invariants fail before the code was put back.
Lesson: Nothing, not even an argument, may call out between `expectRevert` and the call under test, and an invariant counts only after a deliberate break has made it fail.

## L-103: A fixture shared by both widths' runs leaked one run's state into the other's capture
Unit: P2-U1
What happened: The mobile run of the new steer test counted 6 steers where it made 3, and the mobile agents page capture showed the desktop run's three cancelled steers.
Cause: The console's fixture API is one process for the whole Playwright run, so steers created at 1440px were still there at 380px. This is L-15 again: state that persists across runs.
Fix: The fixture has a test-only reset route; the steer test clears the steers before and after itself and counts only its pending steers (1b474bc). Two runs in a row matched.
Lesson: A test that writes to a fixture shared across projects restores it, so no other test or capture depends on the order they run in.

## L-104: A dust withdrawal could lower the value per unit
Unit: P2-U3
What happened: `testFuzz_FlowsNeverTripTheBreaker` failed on its first run: after a WMON withdrawal the account's value per unit was 0.99999998999 where it had been 1.0, with no price move, so flows could nudge the breaker toward a trip.
Cause: The burn valued the withdrawn WMON on its own, `floor(out × price)`, while NAV floors the whole balance, `floor(balance × price)`. The fall in NAV can be one base unit more than the separately floored value, so a withdrawal worth "0" burned no units while NAV fell by one.
Fix: The value that left is the exact fall in NAV, `value(freeAfter + out) − value(freeAfter)`, each side floored as NAV floors it, and the burn rounds up (3332888); 3,000 fuzz runs then passed, and the policy mirror does the same.
Lesson: When one quantity is rounded per part and another over the whole, derive the part from the difference of wholes, and fuzz the invariant (here: flows never lower the value per unit) rather than the formula.

## L-105: A mint's claim deadline came from the wall clock, not the fork's
Unit: P2-U3
What happened: `pnpm oracle:local demo` stopped with "transaction ... reverted" when it minted after moving its fork's clock 9 days through the factory's timelock.
Cause: `mintLocal` set the claim deadline to the wall clock plus an hour; the fork's clock was now days ahead, so AgentNFT refused the claim as expired. Every earlier fork ran behind the wall clock, which hid it.
Fix: The deadline is an hour after the later of the wall clock and the fork's latest block, and the demo mints before the time jump (53ddeef).
Lesson: Anything that signs a deadline for a chain takes "now" from that chain, or from the later of the chain and the wall clock, never the wall clock alone.

## L-106: pnpm dev:down stopped the playtest fork, and its state was lost
Unit: P2-U3
What happened: Before the heavy suites I ran `pnpm dev:down` to stop dev:all. It also stopped anvil, Postgres and Redis. Anvil keeps the fork's state only in memory, so the playtest fork's local state went with it: the AgentNFT deployment and the owner's agent #1 (the bee) on 8545. Postgres and Redis kept their volumes.
Cause: `dev:down` stops the whole local environment, not only the services dev:all supervises; P2-U1 had stopped only the supervisor (L-85's method), and I did not read what `down` stops before running it.
Fix: The fork was restarted and rebuilt as described in the P2-U3 LOGS entry. No code change.
Lesson: Stop dev:all by signalling its supervisor (L-85), never with `dev:down`, while a playtest fork must be kept; read what a stop command stops before running it, because anvil's state does not survive a stop.

## L-107: Two slips in the parity fixture, caught by the forge side
Unit: P2-U3
What happened: The first forge parity run failed twice: forge refused to decode the fixture because a struct field was named `now_` while the JSON key was `now`, and one random breaker sequence ended with a poke while its MON/USD feed was down, which the contract rightly refused.
Cause: `vm.parseJsonTypeArray` matches struct fields to JSON keys by name, and the generator checked for a down feed before each random poke but not before the closing poke it appends.
Fix: The key is `time` on both sides, and the generator brings the feed back up before its closing poke (2db1e50).
Lesson: A generated fixture is only valid once the consumer has replayed all of it; keep every rule the generator enforces in one place, including for the steps it appends.

## L-108: The account's backstop answered before the Executor could name the limit
Unit: P2-U2
What happened: The rolling-window fuzz test failed on a refusal that was not `Rejected(reason)`: the custody core's `ConcentrationTooHigh` (WMON at 46%). A buy past the account's 45% backstop was refused by the account, inside the trade, before the Executor's post-trade check could say `CONCENTRATION_CAP`.
Cause: The Executor checked the 40% cap and the USDC floor only after the swap, on the actual fill, but the account checks its own looser backstop during the swap, so a large enough breach never reached the Executor's check.
Fix: The Executor projects a buy at the oracle price before the trade and refuses with `CONCENTRATION_CAP` or `USDC_FLOOR` there, and still checks the actual fill afterwards (78678ad); a regression test buys to 46%.
Lesson: When a stricter check sits behind a looser one in the same call path, run the stricter one first, or the caller gets the wrong reason.

## L-109: test:fork stalled anvil by blocking the process that drained its log
Unit: P2-U2
What happened: With two new fork suites, `pnpm test:fork` failed in bulk on every attempt with "failed to fetch active fork block" and later "failed to retrieve chain ID from fork endpoint", while the same suites passed in seconds on a fork I held open myself.
Cause: test-fork.js ran forge with `spawnSync`, which blocks the Node process that reads anvil's stdout into the fork log. Once anvil had written a pipe's worth of log (about 64 KB), it blocked on the write and stopped answering. More suites meant more requests and more log, so the stall came sooner. Running six suites in parallel through one cold fork added upstream timeouts on top. This is L-91's lesson one layer over, and probably the real cause of much of the "transient upstream" failure rate L-70 and L-75 recorded.
Fix: forge runs asynchronously, so the event loop keeps draining anvil's output, and the fork suites run one thread at a time; transient-error retries rose from one to two (f36526c). Three runs in a row then passed 32 of 32 with no retry, the warm ones in under a second.
Lesson: Never block, with a synchronous child call, a process that drains another process's pipe; before blaming an upstream, check whether the server is merely stuck writing its log.

## L-110: Test slips this unit, caught before commit
Unit: P2-U2
What happened: Three Executor tests reverted for the wrong reason because `executor.SET_POLICY()`, read inside the call's arguments, consumed the `vm.prank` and `vm.expectRevert` (L-39 again). The invariant handler's random venue was misbehaving 7 calls in 8 and its minimum output sat above the mock venue's fill, so nearly every trade reverted, and a mutation removing the concentration check went unnoticed. The executor demo checked reduce-only after taking WMON off the buy list, so the asset check answered first.
Cause: Arguments are evaluated before cheatcodes bind; random generators were not checked for how often they reach the state under test; a demo step depended on an earlier step's state.
Fix: Constants read into locals before the cheatcodes; the handler misbehaves about one call in eight, asks for the floor, and weights trades; a separate fuzz test covers the 20-trade window, and mutations of the 40% cap and the trade count each fail a test; the demo runs reduce-only first (9d8baae, 78678ad, ef549af).
Lesson: Prove every fuzz or invariant suite with a mutation before trusting it, and measure how often its generator reaches the rule it is meant to break.

## L-111: Printing the signer showed its RPC URLs
Unit: P2-U4
What happened: The signer test that checks no secret appears anywhere failed: `util.inspect` of a Signer printed its options, including the RPC URLs it is given to redact, which can carry an API key.
Cause: The options sat in a TypeScript `private` field, which is private only to the type checker; inspect and JSON see it.
Fix: The options moved to a JavaScript private field (`#o`), as the key providers already did, and the test checks inspect, JSON, logs, errors and rows for the seed, the key and the URL.
Lesson: Anything holding a secret or a secret-bearing URL keeps it in a `#` field and is tested by printing it.

## L-112: A crash check compared the database clock with the test clock
Unit: P2-U4
What happened: The test for a transaction left signed by a stopped process never saw it become unknown.
Cause: Its age was measured from `updated_at`, which Postgres sets with `now()`, against the signer's injected clock, hours apart in the test.
Fix: The age comes from the row's own history entry, written with the signer's clock.
Lesson: Compare times from one clock; a timestamp the database writes cannot be measured against an injected one.

## L-113: A piped commit gate let a secrets finding through
Unit: P2-U4
What happened: A commit went in although the gate printed "Secrets scan FAILED": gitleaks read `tokenOut: "<WMON's address>"` in a test as an API key.
Cause: The gate ran as `gate.sh | tail -1 && git commit`, so the commit saw tail's exit code, not the gate's. The gate also checks only formatting and secrets, so a later commit went in without a full lint and failed it afterwards.
Fix: The finding was checked (the public WMON address) and recorded in .gitleaksignore with its reason, the test names the address as a constant, and a public address in a fixture is no longer named like a key. Commits now run the gate with its exit code tested directly, and lint before the gate.
Lesson: Never pipe a check whose exit code decides a commit; test `$?` of the check itself.

## L-114: The unknown resolver raced the fork's mining
Unit: P2-U4
What happened: On the real fork, a swap whose answer was lost was failed as NONCE_CONSUMED although it had landed.
Cause: The resolver looked for the receipt, then read the nonce. Anvil answers a send before it mines, so the transaction mined between the two reads: no receipt, then a nonce past it. A provider that lags on receipts would do the same.
Fix: The nonce is read first and the receipt second, and "another transaction used the nonce" is believed only after a 30-second grace.
Lesson: When two reads decide an outcome, read the one that can only move forward first, and never conclude from a single sighting of an absence.

## L-115: Five cold forks at once timed out
Unit: P2-U4
What happened: The full vitest run failed three fork tests (devenv, indexer, signer) on timeouts; each passed alone.
Cause: Vitest runs files in parallel, so every file that starts a fork of its own fetched from the upstream at the same time. The signer's fork test made it five.
Fix: Those files form their own vitest project that runs one file at a time, after everything else; the full run passed with all 1,393 tests.
Lesson: A test that starts a fork is a heavy suite; group them so they run one at a time.

## L-116: An unreachable fork read as "agent not on the fork"
Unit: P2-U4
What happened: The Trades page's e2e test, with no fork running, showed "Agent 1 is not on the fork" instead of saying the fork could not be read.
Cause: The snapshot turned every error from `ownerOf` into "does not exist", including an unreachable endpoint.
Fix: Only a contract refusal means a missing agent; anything else is reported as it is, and a test covers both.
Lesson: Map only the error you mean; let every other failure say what it is.

## L-117: pnpm install rewrote unrelated lockfile entries
Unit: P2-U4
What happened: Adding the signer package with `pnpm install --offline` changed about 1,100 lockfile lines, including peer resolutions of unrelated packages.
Cause: A non-frozen install re-resolves the whole graph, and the local store's state differed from when the lockfile was written.
Fix: The lockfile was rebuilt from the committed one with only the new importer entries added, and `pnpm install --offline --frozen-lockfile` confirmed it.
Lesson: When adding a workspace package or dependency, check the lockfile diff touches only that, and verify with a frozen install.

## L-118: A missing price made a trade read as an invalid intent
Unit: P2-U5
What happened: The chain tools' fork test failed its stale-price case: `tradable_now` named `INTENT_INVALID` first, while the real Executor refused the same swap with `ORACLE_STALE`. The unit tests had passed, because their fake reader kept a non-zero price while marking it stale.
Cause: With an unusable feed the oracle adapter reports a price of zero, so the pre-check's stand-in minimum output, the oracle floor, was zero, and `executorBlockers` rightly calls a zero minimum an invalid intent. The trade flow always sends a positive minimum, so the Executor never sees that case.
Fix: With no usable price the stand-in minimum is 1, so only the oracle rule blocks the trade; a unit test with a zero, stale price checks it, and the fork test holds every case to the Executor's own answer (888be44).
Lesson: A pre-check that fills in what the caller will send must fill it in as the caller would, and is only proven against the real contract under each failure, not against a fake that keeps the failure's inputs friendly.

## L-119: Test slips this unit, caught before commit
Unit: P2-U5
What happened: Three new tests failed for test reasons: a signer test owner written as a mixed-case address with a wrong checksum (L-20 again), an assertion label that serialized a BigInt, and an expectation that missed a third blocker the code rightly gave (a 20 USDC buy also breaks the 40% cap). Separately, the last fix of 888be44 was committed after the secrets scan had run on the version before it; a scan of the whole history afterwards passed.
Cause: Addresses typed by hand in mixed case, labels built with JSON.stringify, an expectation written from the rule I meant to test rather than every rule the input breaks; and a re-edit after the gate without running it again.
Fix: Lowercase test addresses, plain labels, the expectation with all three codes; the scan run again on the committed tree.
Lesson: Write test addresses in lowercase, and rerun the commit gate after any edit made once it has passed.

## L-120: A refund waited forever for a session key only the console creates
Unit: P2-U5
What happened: The first orchestrator live check after refunds moved into the signer's outbox timed out on its refund step; the orchestrator logged "agent 1 has no session key in the signer; create it first; retried next pass" every two seconds.
Cause: The signer accepts a transaction only for a key it has recorded, and until then only the console's "create session key" route recorded one. Every unit test created the key in its setup, so none saw an agent whose key had never been recorded, which is every real agent that is refunded before it trades.
Fix: A credit transfer records the agent's key itself when none is recorded yet (its funding address, D-243, and `createKey` is idempotent); a test deletes the key first, and failed with the change removed (b77fe72).
Lesson: When a step moves into a component with preconditions, list each precondition and check that the production path, not only the test setup, establishes it; one live run before calling it done catches what setups hide.

## L-121: A commit went in while typecheck failed (L-113 again)
Unit: P2-U5
What happened: b77fe72 was committed although the same command printed `tc=1`: a test stub did not match the `Signer` type. 6cf9f1e fixed it, so b77fe72 alone does not typecheck.
Cause: The command printed typecheck's and lint's exit codes but gated the commit only on the secrets scan's.
Fix: Commits now run `typecheck`, `lint` and the scan, keep each exit code, and commit only when all three are zero.
Lesson: Gate a commit on every check it runs; a check whose result is only printed does not gate anything.

## L-122: A USDC refund ran out of gas under Monad's gas model
Unit: P2-U5
What happened: In the second live check, the refund was signed and mined and then reverted; the outbox recorded TRANSFER_REVERTED with "the replay passed", and the owner received nothing (the ledger was restored).
Cause: A-41 set a USDC transfer's gas limit at 100,000, from Ethereum's figures for a FiatToken transfer. Under Monad's gas model (cold storage and account access priced higher) the same transfer used 100,106 to 100,310 gas on the fork. The unit tests ran on a fake chain that does not meter gas, so nothing measured it.
Fix: The limit is 150,000 and A-41 records the measurement; the signer's fork test now refunds real USDC and checks the gas used is under the limit, and it failed with the old limit (this unit's fix commit).
Lesson: Set a gas limit from a measurement on the target EVM, never from Ethereum figures, and prove it with a transaction on a fork, not a fake chain; P2-EC measures it again on testnet and mainnet.

## L-123: The submission slot check let no queued trade take the last slots
Unit: P2-U6
What happened: In the trade flow's Postgres test, an armed agent with two free slots and three approved intents sent none of them: all three were refused with DAILY_TRADE_LIMIT.
Cause: At submission each intent counted every other slot-holding intent as reserved, including the younger ones still waiting behind it, so 18 trades plus 2 reserved filled the window for each intent in turn.
Fix: At submission an intent counts only intents already sent and those proposed before it, so the oldest goes first; a proposal still counts all of them (D-266, this unit's trade flow commit). The test now checks two submitted, the third refused, and its slot freed.
Lesson: A reservation check must say whose reservations come first; test it with more claimants than free slots, not one.

## L-124: The fork's upstream stopped serving the pinned block for a while, and I first called it permanent
Unit: P2-U6
What happened: The trade flow's fork test failed twice with "the test fork on port 8556 did not start"; every attempt for block 109670000 answered null. A probe got 0 of 8 answers for the block from the provider behind MONAD_RPC_URL, and Monad's public RPC refused state at it. I recorded it as a permanent prune and a blocker. About an hour later the P2-U5 fork test started a fork and passed, the trade flow's fork test then ran, and a second probe got 8 of 8.
Cause: An outage of the provider's older history, longer than L-87's per-node misses: for a while no node behind the load balancer served the block. One probe run is one moment, not a trend.
Fix: Nothing in code. The decisions file records the episode (C-80) and recommends an archive-capable secondary (Q-52).
Lesson: When a fork will not start, probe the pinned block, wait, and probe again before calling it a blocker; keep running the work that needs no fork in between. An archive secondary (D-220 already alternates to it) would have ridden this out.

## L-125: Test and type slips in P2-U6
Unit: P2-U6
What happened: (1) The console e2e test clicked `getByRole("button", { name: "Arm" })`, which also matched "Disarm", and failed in strict mode at both widths. (2) The Postgres intent row type declared `blockers` with chain-tools' Blocker type while Kysely returns plain records, so the orchestrator did not typecheck; the commit gate caught it before the commit. (3) Two `type` aliases broke the lint rule that wants interfaces; the gate caught them too. (4) The fork test simulated a sale with the owner's own `transferFrom`, which AgentNFT refuses (`TransfersRestricted`: only the escrow moves agents).
Cause: (1) Playwright's role names match substrings unless `exact` is set. (2, 3) Types written without running the package's own typecheck and the linter first. (4) I assumed a plain ERC-721 transfer without reading AgentNFT's `_update`.
Fix: (1) `exact: true` on the Arm button query. (2) The row keeps the database's type and the mapper casts once. (3) Interfaces. (4) Within the test's snapshot a deployed contract is set as the escrow, the owner approves it, and the impersonated escrow moves the agent (cf7f2c3).
Also: I formatted with `biome format`, which is not this repo's formatter and failed silently, so 16 files were committed unformatted until `pnpm format:check` caught them (be7ed3d formats them).
Lesson: Use `exact: true` for any button name that is part of another name on the same card; format with `pnpm format` (Prettier) and add `pnpm format:check` to the commit gate; the three-check commit gate (L-121) keeps working, so keep running it before every commit.

## L-126: The agent's first real trade was refused because its session key was never recorded
Unit: P2-U6
What happened: In the live check, the owner armed the agent and approved its first proposal, and the trade flow refused it at submission with SIMULATION_FAILED and no other reason; nothing was sent. The proposal had a quote and had passed every check.
Cause: The trade flow read the agent's session key with `keyAddress`, which only finds a key the signer has already recorded, and the signer records keys lazily (L-120: only the console's button or a refund created one). With no key, the code fell through to a catch-all that refused the trade with a made-up reason. The chain tools' key lookup had the same gap, so the grant check at proposal skipped the key comparison. The fork test created the key up front, so it never saw this.
Fix: The trade flow and the chain tools ensure the key with the signer's idempotent `createKey`; every gap at submission names its own reason (VENUE_NOT_ALLOWED, SIMULATION_FAILED) and there is no catch-all; a unit test checks the key is ensured at each submission (this unit's fix commit).
Lesson: L-120 again: any path that needs an agent's key must ensure it, not look it up. A fallback reason in a refusal hides the real cause; refuse only with a reason that is true. A fork test that prepares more than production does cannot catch this.

## L-127: The live check's chain check raced the scheduler, and a real agent proposed its whole account
Unit: P2-U6
What happened: The second live run timed out "waiting for the chain check": the task never started. In the third, the agent proposed selling 29.1 USDC from a 20 USDC account; the checks rejected it with every reason, correctly, so there was nothing to approve and the trade steps failed.
Cause: (1) The live run's scheduler starts a Scan every 15 seconds, and while one holds the agent's sandbox the console route answers 409 `lease_held`; the check posted once and never read the status (P2-U5's step had the same race and won it by timing). (2) The prompt let the model pick the size from several numbers ("at most half of maxTradeValueUsdc and at most the USDC you hold"), and it used another figure.
Fix: The live check retries the chain check until it is accepted (e48d6a5); the prompt names a concrete size, 1 USDC when the limits allow it, and says never to use the account's value or a price as the amount (f7d7c9a). The fourth run passed 34 of 34.
Lesson: Read the status of every request a live check makes. Give an LLM step a concrete number when the test needs a specific outcome; the hard limits are the safety, the prompt is only the plan.

## L-128: A new test file went into a commit unscanned for secrets
Unit: P2-U7
What happened: The commit gate passed before 3e6f103, and the next gate's full-history scan then found two "generic-api-key" findings in that commit's new `portfolio.test.tsx`. Both were the public USDC and WMON addresses under a `token` key, so nothing leaked; they are recorded in `.gitleaksignore` with their reason.
Cause: I ran the gate before `git add`. The scan of uncommitted changes reads the diff of tracked files, so a new, untracked file was not read until it was already committed (L-113 says to scan exactly what is staged).
Fix: Stage first, then run the gate (every later commit in this unit did).
Lesson: The order is stage, gate, commit; a gate that runs before staging cannot see new files.

## L-129: The owner's grant reverted on a fork: its expiry came from the wall clock
Unit: P2-U7 (bug from P2-U6)
What happened: In the portfolio live run, Arm sent the grant from the wallet and the page said "The trading permission transaction failed"; the agent stayed unarmed. Opening the account and depositing had worked.
Cause: The control API built `registerSession`'s `validUntil` as wall-clock now plus 30 days. The Executor checks it against its block time, and a fork's block time sits at its pinned block, weeks earlier, so the expiry was past its 30-day maximum (BadSession). P2-U6's test set the chain time equal to the wall clock, and its live run registered grants in the orchestrator, not through this route. This is L-105 again.
Fix: The route dates the grant, and the renewal check, from the chain's block time; a test with the chain 40 days behind the wall clock fails on the old code (aff51c2). The live run then passed.
Lesson: Every deadline sent to a chain comes from that chain's clock; a test of one must set the chain's clock apart from the wall clock.

## L-130: Slips in P2-U7, caught by its tests
Unit: P2-U7
What happened: (1) The page disabled every button while any trade was settling, so the owner could not reject or approve another proposal meanwhile; the arming e2e test found it. (2) Two mixed-case fixture addresses failed viem's checksum, and a decoded address was compared with a lowercase constant (L-119 again). (3) `--update-snapshots` took the spec file named after it as its value. (4) The first capture caught the approval toast; a later one put each form's hint under one field only, so labels did not line up, and the header named the environment twice.
Cause: (1) One "busy" flag meant both "re-read faster" and "an action is running". (2) Hand-typed addresses. (3) The flag's optional value. (4) Reviewing captures found them, as intended.
Fix: (1) A separate `acting` flag gates the buttons. (2) Fixture addresses come from `getAddress`, comparisons too. (3) Spec files go before the flag in `scripts/web-e2e.js`. (4) The hints moved under each row, the header names the network once.
Lesson: Keep "poll faster" and "block input" as two flags; derive fixture addresses with `getAddress`.

## L-131: The add-credits section read the wallet's USDC once
Unit: Phase 2 tuning
What happened: In the live run the card said "In your wallet: 0 USDC" after the test had minted 21 USDC to the wallet, so the amount was refused as more than the wallet holds.
Cause: The hook read the balance when the card mounted and after its own actions only; USDC that reached the wallet from elsewhere (the console's Test funds page, another wallet) never showed without a reload.
Fix: The balance is re-read every 10 seconds (039f3ce); the live run then passed.
Lesson: A balance the user can change outside the page is polled like the page's other live values, not read once.

## L-132: A credit transfer failed on a mixed-case address, and the message hid why
Unit: Phase 2 tuning
What happened: In the e2e suite every "Add credits" ended with "The wallet could not send this", including the declined request, which should have read as declined.
Cause: The fixture's funding address had an invalid checksum, and viem refuses such an address before anything reaches the wallet. The failure text dropped viem's own reason, so it took a code change to see it. The real API checksums addresses, so production was not affected.
Fix: The app checksums the funding address from lowercase before sending, and a failed send with no named revert now carries the wallet's short reason (6fc470f).
Lesson: Normalize addresses at the point of use, whatever the source; a failure message that drops the cause slows every later debug (L-55 again).

## L-133: Visual slips found in the capture review
Unit: Phase 2 tuning
What happened: The overview's total value overflowed its tile at 1440px; the gas notice wrapped each text run onto its own line; the positions panel repeated the overview's total.
Cause: A three-column tile grid inside half the page; a flex row on a sentence with inline amounts; a panel built before the overview existed.
Fix: Two tile columns with the total across both; the notice is plain inline text; the panel takes `showValue` and the portfolio hides its total.
Lesson: Look at every capture at both widths before accepting it (L-46); sentences with inline values are not flex rows.

## L-134: The indexer kept asking for a range the testnet provider had refused
Unit: P2-EC
What happened: Against Monad testnet the indexer settled at 6 blocks a step and, on every other step, asked for 12 blocks and was refused. The keyed provider answered "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range".
Cause: A refused range was halved, and every success doubled the range back towards the configured maximum, so the indexer walked back into the same refusal forever. The fork serves any range, so the halving had only ever been exercised once per run in a test.
Fix: A refused range lowers the maximum to one block under it, so the range settles at the provider's cap (10). A test with a 10-block source checks each refused size is asked once; it failed with the change removed (20cb18d).
Lesson: When a server refuses a request size, remember the refusal as a ceiling; backing off and growing back without one turns a limit into a steady stream of failures.

## L-135: The stack's fork-speed polling was rate-limited by the testnet provider
Unit: P2-EC
What happened: In the first end-to-end run on testnet, every orchestrator call to the chain failed with "HTTP request failed" for about ten minutes: the keeper, the trade flow, the feed refresher and the chain tools (UPSTREAM_UNAVAILABLE), so the agent's chain check proposed nothing. A counting proxy showed about 19 requests a second, answered 200 for about 40 seconds and then mostly 429.
Cause: The loops were tuned for a local fork, where reads are free: the indexer stepped back to back because Monad makes a block every 0.3 seconds, each step making three eth_getLogs calls, and the keeper, credits and trade flow each re-read the chain every 2 seconds. A free provider plan meters compute units a second. viem reports a 429 as "HTTP request failed", which hid the status.
Fix: Off the fork the indexer waits at least 2 seconds between indexing steps and the keeper, credits and trade flow poll every 5 seconds; through the same proxy the stack then made 7.5 requests a second with no 429 in two minutes (350f772, D-310). Q-59 asks whether to add a second testnet provider or a paid plan.
Lesson: Measure a service's request rate per method against the real provider before calling it ready for a real chain, and log an RPC failure's HTTP status, not only the client library's summary.

## L-136: A Monad receipt's gasUsed is the gas limit, and forge's broadcast record kept a stale limit
Unit: P2-EC
What happened: The first deployment record showed three calls with a "gas limit" lower than their gas used (26,668 against 83,348 for the pool's initialize). Read from the chain, every testnet transaction's receipt reported gasUsed equal to the transaction's gas limit.
Cause: Monad charges the gas limit, and its receipts say so, so a receipt cannot show what a call really used. Forge's run-latest.json keeps the pre-estimate gas for some calls, not what it sent.
Fix: The deployment record reads each transaction's limit, receipt and fees from the chain (ff2e6bf), and real use is measured with forge's gas report on a fork of testnet.
Lesson: On Monad, read gas from the transaction and measure real use in a simulation; never take gasUsed from a receipt, or a limit from a tool's local record, as the cost of a call.

## L-137: A fresh orchestrator secret on every start made each agent's stored key unreadable
Unit: P2-EC
What happened: After the testnet stack restarted, the orchestrator logged "agent 1: metering failed: Unsupported state or unable to authenticate data" every few seconds, and the agent's chain check ran out its deadline with no tool calls.
Cause: testnet:up generated ORCHESTRATOR_SECRET (and API_SESSION_SECRET) per start, but the orchestrator encrypts each agent's stored gateway key with its secret, so a key stored under one start could not be decrypted under the next. Locally the secret is a fixed default, so this never showed.
Fix: The secrets are TESTNET_ORCHESTRATOR_SECRET and TESTNET_API_SESSION_SECRET in .env, mapped on testnet, and testnet:up adds random ones once when missing; agent 1's testnet runtime was marked deprovisioned and provisioned again under the stable secret (0e615f2).
Lesson: Before making a secret ephemeral, find everything encrypted or signed with it that outlives the process.

## L-138: The swap's 1.1M gas limit left about 3,000 gas on an account's first swap
Unit: P2-EC
What happened: The testnet fork's gas report showed an account's first swap using 1,070,401 gas inside the call, about 1,097,000 with the base and calldata, against the signer's fixed 1.1M limit; the live first swap on testnet got through. A later sale used 975,571.
Cause: A-38 set the limit from one swap on the fork that was not an account's first; the first swap writes fresh storage (the Executor's trade ring buffer, the account's peak buckets), and Monad charges the limit, which pushed the limit close to one measurement.
Fix: The limit is 1.3M (ce0ed42, D-308).
Lesson: Size a fixed gas limit from the most expensive case of the call (first use, cold storage), measured on the target chain, not from one representative run.

## L-139: The 0.05 MON low-gas warning did not cover one deposit
Unit: P2-EC
What happened: On testnet, with the limit charged at 103 gwei, a deposit with its exact approval cost 0.048 MON and a first account, deposit and arming 0.084 MON, while the portfolio warned only below 0.05 MON (A-50).
Cause: A-50 was an estimate from Ethereum-style gas used, before any receipt on a real Monad chain.
Fix: The warning is at 0.1 MON (c2df44e, D-309).
Lesson: Set a user-facing gas threshold from real receipts of the actions it protects, summed for the user's first visit.

## L-140: Slips in this unit's own scripts, caught by running them
Unit: P2-EC
What happened: (1) The testnet dry-run test built a stale-feed intent after the warp, so the oracle refused to price it before the Executor could. (2) The end-to-end script's resume topped credits up whenever they were under 1 USDC, and the wallet held less. (3) A scripted fix for that did not match (prettier had reflowed the line) and the run was started anyway on the old code. (4) Lint failed twice on the gate: the new .next-testnet build folder was linted, and a fetch error was rethrown without a cause on purpose. (5) A test fixture logged with empty functions.
Cause: Writing the flow from memory of the APIs, and starting a run without checking that the edit had applied.
Fix: Each was fixed before its commit (the build folders joined the ignore lists in 57d1f55); the scripted edit was redone against the current text and asserted (L-78).
Lesson: After a scripted edit fails, stop: rerun nothing until the edit is applied and checked.

## L-141: A testnet provider saved under the mainnet fallback's name was never used, and two paths could not fail over
Unit: P2-EC (follow-up)
What happened: The owner added a second RPC provider, yet Q-52 and Q-59 stayed open. Probing every RPC entry in .env by name showed MONAD_RPC_URL_SECONDARY answered chain 10143: a testnet endpoint under the mainnet fallback's name. Testnet reads only MONAD_TESTNET_RPC_URL_SECONDARY, so nothing used it, and the fork's upstream list would have alternated with a testnet node. Checking failover then found two gaps: the indexer, chain tools, keeper, feeds and refunds had no second provider at all, and the signer refused to start when its primary was down. Separately, an indexer run with --once did not stop on SIGTERM and had to be stopped by PID.
Cause: Configuration matched variables by name without checking what each URL serves, and failover had been built only into the fork's upstream proxy and the signer's reads.
Fix: The entry was renamed (its value untouched); fork upstreams are chain-checked and a wrong-chain one is dropped by name; the indexer, chain tools, keeper, feeds and refunds fail over to the second provider; the signer starts when only its secondary answers (68dfb5a). With each primary blocked, all of them worked through the second provider.
Lesson: Check what chain an RPC entry serves before using it, and prove failover by blocking the primary in each service, not by reading the configuration.

## L-142: A lagging index made the app offer the mint to a wallet that had just minted
Unit: P2-EC (follow-up, owner's testnet playtest)
What happened: The owner minted agent 2 on testnet with 0x683e...5f76; the keeper revealed it six seconds after requesting (species 5). The mint page, which reads AgentNFT's hasMinted on chain, said the wallet already had an agent, while /configure and /agents showed "Mint an agent", and the reveal link /configure?agent=2 landed on the same button. The index was about 5,000 blocks behind the head, with no errors, and the API listed no agent for the wallet.
Cause: Two faults. (1) L-135's fix (D-310) paced a remote indexer to one step every 2 s, and the provider caps a step at 10 blocks: 5 blocks a second against testnet's 3.3, so after the stack had been down for an hour the index gained only 1.7 blocks a second and stayed hours behind. A rate limit was traded for a lag nobody measured. (2) /configure and /agents took the wallet's agents only from the index, and treated "the index has none" as "the wallet has none", and the reveal link's "not in this wallet" state needed the index to list some agent.
Fix: The indexer steps every 0.4 s while more than a range behind the head and is paced only at the head (cbc31b8); the restarted indexer closed the gap at about 14 blocks a second. The app completes the index from the chain: agents minted after the index's count that the wallet owns, and reveals the index has not seen, shown as pending ("Indexing your agent…", "Waiting for reveal…") until the index catches up; AgentNFT's hasMinted means a wallet that minted is never offered the mint; the mint flow watches the reveal on chain first (7826a8a, 5d4e8e5).
Lesson: A throttle needs a catch-up test as well as a rate test; and a page must not read "the index has nothing" as "the chain has nothing" for anything the user just did on chain.

## L-143: MON the owner sent to the agent's token-bound account was invisible in the app
Unit: P2-EC (testnet tuning, owner's playtest)
What happened: The owner sent testnet MON to one of agent 2's addresses and could not find it anywhere in the app. On chain, the token-bound account 0x487f...ccAA held 3 MON and 5 USDC, the funding address 0.5 MON and 10 USDC, and the PersonalAccount 5 USDC.
Cause: Each page showed only the balance it uses at the address it uses: credits (USDC at the funding address) and the PersonalAccount's USDC and WMON. The token-bound account is shown as an address but never read, because by design it holds no capital (D-039), so nothing read what an owner actually sent to it, nor MON at the funding address or any other token anywhere.
Fix: The API reads every native and address-book balance at all three addresses and classifies each one (3b431eb, 6d207b3); the All holdings panel on /agents and the portfolio names each address in plain words, marks what does nothing there, and lets the owner move what sits in the token-bound account to their wallet with a call they sign (80a3704, 3cd6972, D-315).
Lesson: Any address the app shows to a user will receive funds; read and show every balance at it, not only the ones the design expects there.

## L-144: Slips in the All holdings work, caught by its tests
Unit: P2-EC (testnet tuning)
What happened: (1) After a confirmed move, the e2e test waited for "Moved to your wallet." and failed showing "Waiting for your wallet": the move had gone through, but the re-read dropped the emptied line and its status with it, so the owner would never see the outcome. (2) The new panel showed "Could not read this agent's holdings" on every existing /agents and portfolio capture, where the fake API has no reader and answers 503 not_deployed. (3) The test compared the decoded recipient with the lowercase mock wallet address, while viem decodes to a checksummed one.
Cause: (1) The outcome was stored on the balance line, which a refetch removes when the balance reaches zero. (2) "Not available here" was handled as an error. (3) A literal address compared across encodings.
Fix: A finished move whose balance has left is kept on its address and shown there; a 503 not_deployed hides the panel; the test checksums the expected address (b8cdba2, 5ff031a). Logging the RPC traffic of one run showed the send and the receipt had succeeded, which pointed at the view, not the chain.
Lesson: Keep the outcome of an action somewhere that outlives the thing the action removes, and treat "not available in this environment" as a state of its own, not a failure.

## L-145: Mainnet's USDC/USD feed updates once an hour, leaving under five minutes of its staleness bound
Unit: P2-EC part 2 (mainnet canary)
What happened: Reading the last 12 rounds of Chainlink's USDC/USD feed on Monad mainnet showed an update every 3,605 to 3,607 s; during the canary its age ran from 1,506 to 3,076 s. The oracle adapter refuses a USDC/USD answer older than 3,900 s (A-34), so a round more than about five minutes late would make every deposit and trade refused as stale until the next one. MON/USD updates every 29 to 31 s against a 300 s bound. Two smaller differences were measured too: the launch pool sat 7.25 bps above Chainlink during the swaps (-4 to -6.5 bps minutes earlier), so a buy paid 12.24 bps against the oracle rather than the 5 bps fee; and each key swept back to the canary owner kept 0.00231 MON, because a send must hold its limit times its maximum fee while Monad charges the limit at the price paid.
Cause: On the fork and on testnet the feeds are our own and are refreshed on demand (LocalFeed, TestnetFeed, D-237, D-307), so a feed's real heartbeat never showed. The pool's offset and the sweep's remainder only exist with real prices and real fees.
Fix: No code change: the canary stayed inside every bound, and the numbers are in evidence/p2-ec/REAL_CHAIN.md. The USDC/USD margin is a suggestion for PB-U1 in the LOGS entry (alert on its age, or name the stale feed in the refusal so an owner knows to wait).
Lesson: Read a real feed's round history before choosing or trusting its staleness bound; a bound set from the documented heartbeat can leave minutes, not hours, of margin.

## L-146: Slips in this unit's own process, caught by the gate and the full suite
Unit: P2-EC part 2
What happened: (1) The first commit of the unit went through with lint failing: the gate's output was piped through `tail`, so its exit code was lost; the failure was a scratch preflight file in the ignored .dev folder, which lint still reads. (2) The secrets scan refused the run record twice for a field named `key`, then `sessionKeyAddress`, holding the session key's public address. (3) The full vitest suite found that the previous unit's HoldingsPanel was missing from the /design coverage check, because it was exported with `export function` instead of the components' trailing export block, and that unit ran only the vitest files it touched. (4) The canary runner reported "confirmed null ms" for both swaps: the signer moved from submitted to reconciled within one tick, so the runner never saw the confirmed state; the timings came from the outbox's own history instead.
Cause: Trusting a piped command's exit, naming a record field after what it describes rather than what it is, a convention the type system does not check, and timing a state from outside the process that owns it.
Fix: The gate now decides each commit on its own exit code; the scratch file was removed; the field is `grantedTo`; HoldingsPanel uses the export block (ab0d677); REAL_CHAIN.md reports the outbox's history.
Lesson: Let the gate's exit code decide a commit, never a filtered view of its output; and run the whole suite before closing a unit, not only the tests of the files it touched.

## L-147: Two forge suites raced on one process-wide environment variable
Unit: P3-U1 (Step 0)
What happened: After the custody set moved to salt version 2, a new assertion in `TestnetScripts.t.sol` failed whenever `CanaryScripts.t.sol` ran beside it ("the local fork uses the unscoped salts; unset DEPLOY_SALT_SCOPE"), and passed every time on its own; folding the assertions into the existing salt test made that test fail the same way.
Cause: Both suites set `DEPLOY_SALT_SCOPE` with `vm.setEnv`, which changes the forge process's environment, and forge runs suites in parallel threads. The existing test had the same race with a smaller window; the extra calls widened it.
Fix: `DeployScope.saltFor(scope, name, version)` computes a salt without reading the environment, and the new test checks the version 2 salts through it with no `setEnv` at all; three runs of both suites together passed.
Lesson: A test that sets a process-wide value (an environment variable, a working directory) races every suite that runs beside it; test the logic through a pure function and keep the environment-reading wrapper thin.

## L-148: A silent typecheck failure behind a quiet commit gate
Unit: P3-U1
What happened: The commit gate reported `pnpm -s typecheck => 1` with nothing in its log, and `pnpm -s typecheck` on its own printed nothing either, so the failure could not be read. Running the root `tsc` and `pnpm -r typecheck` separately showed it: `exactOptionalPropertyTypes` refused an optional `usdc` field given `undefined` in the web app.
Cause: `pnpm -s` (silent) also hides the recursive run's error output, so the gate's log kept only the exit code. The gate did its job (the commit was stopped), but cost a round of digging.
Fix: The gate runs `pnpm typecheck` without `-s`; the field is typed `Address | undefined`.
Lesson: A gate must keep the output that explains a failure, not only the exit code; never silence the checks it runs.

## L-149: The migration commit skipped the database package's own table check
Unit: P3-U1
What happened: The full vitest run at the end of the unit failed `creates every table in the indexer and platform schemas` in packages/db: migration 0014's three new tables were not in its list. The migration was committed in c6da42b after running only the goal store's tests, so that commit and the ones after it fail that one test until the fix commit.
Cause: L-146 again: I ran the test files of the code I wrote, not the tests of the package I changed, and packages/db keeps a list of every table.
Fix: The list names `platform.agent_goals`, `platform.agent_states` and `platform.agent_state_changes`; the full suite passes.
Lesson: After changing a package, run every test file in that package, not only the new ones; a migration always touches packages/db's own tests.

## L-150: Unicode escapes written through a tool call arrived as the invisible characters (L-82 again)
Unit: P3-U2
What happened: `packages/market/src/text.ts`, which strips zero-width and bidirectional characters, would not parse: prettier and tsc reported an unterminated regular expression, because the file held the literal U+2028 line separator, zero-width and bidi characters inside the regex where `​` and the like had been written.
Cause: The command that wrote the file travels as JSON, and JSON decodes `\uXXXX` sequences, so the shell received the characters themselves; U+2028 then broke the line. This is why L-82 recurred with a different writer.
Fix: The file was rewritten by a script that builds each backslash at run time (`"\\" + "u200b"`), a grep for non-ASCII bytes across the package finds none, and its test builds the sneaky characters with `String.fromCharCode` rather than literals.
Lesson: Never type `\u` escapes into a file through a tool call; generate them so the backslash is produced at run time, and grep every new source file for non-ASCII bytes before it is committed.

## L-151: The meter's paid-call cap refused a free call
Unit: P3-U2
What happened: The gate test for market data found that after a lease's 20 paid calls, a market_snapshot the cache could answer for free was refused with RATE_LIMITED.
Cause: The cap counted every non-refused data call, free ones included, and was checked before the call's price was considered.
Fix: The cap counts only calls with a charge above zero and applies only to a call that would be charged; a free call writes its row with `cache_hit` and no ledger entry. Also caught by the tests this unit: a mocked `Response` reused across calls (its body can be read once), fixed by building one per call.
Lesson: When a limit exists to protect spend, count and check only what spends; and test a free path right after a paid limit is reached.

## L-152: On testnet the mainnet market reader would have been handed the testnet's second RPC
Unit: P3-U9 (Step 0)
What happened: Wiring research's mainnet connection for testnet showed that the orchestrator built the market reader from `MONAD_RPC_URL` and `MONAD_RPC_URL_SECONDARY` read through the configuration, and on testnet the configuration fills `MONAD_RPC_URL_SECONDARY` from `MONAD_TESTNET_RPC_URL_SECONDARY` (D-254). The "mainnet" reader would have been given a testnet RPC; only its chain ID check (143) kept it from reading testnet as mainnet.
Cause: One variable name with a different meaning per environment, read for a purpose its environment-specific meaning does not have.
Fix: The configuration gives research its own `researchRpcUrls`, read from the mainnet variables by their own names in every environment and kept apart from `values` and the chain RPC, and every research client is built on a transport that refuses anything but reads (D-325).
Lesson: When a variable's meaning changes per environment, never read it by that name for another purpose; give the other purpose its own field, and keep the chain ID check as the last line, not the first.

## L-153: A Scan reported "ended without calling complete_stage" when the model provider was out of credit
Unit: P3-U9
What happened: In the live run every model-driven step after the first half failed the same way: one model call, no tool calls, "the Scan ended (failed) without calling complete_stage" (and the same for the chain check and the research check). Sending the tool list to LiteLLM by hand showed every request refused with "Your credit balance is too low to access the Anthropic API", for old tools and new alike; the platform's Anthropic account had run out during the run.
Cause: The gate recorded only the status (400) of a refused model call, and the tasks reported their own incomplete outcome, never the gateway's answer, so a platform-wide outage looked like an agent that would not finish.
Fix: The gate marks a refused call `PROVIDER_OUT_OF_CREDIT` when its body says so, and the Scan, the chain check and the research check name it (or the refused status) in their error (95eb0b9). The live model steps stay blocked until the account is topped up.
Lesson: A task that fails should say what its dependencies answered; when every agent fails the same way at once, test the shared dependency directly before suspecting the change under test.

## L-154: get_code called Circle's USDC proxy "no proxy"
Unit: P3-U9
What happened: The direct live check read USDC on Monad mainnet: 1,798 bytes of code, `pattern: none`. That size is Circle's FiatTokenProxy, whose implementation lives in the older `org.zeppelinos.proxy.implementation` slot, not the EIP-1967 slot the detector read.
Cause: The detector knew EIP-1967, its beacon, EIP-1167 and EIP-7702, and was tested only on synthetic code and slots.
Fix: `get_code` reads the ZeppelinOS slot too and reports `zeppelinos`; `read_contract`'s proxy reads return both slots; the fork test asserts USDC is a ZeppelinOS proxy (375124c).
Lesson: Check a detector against the real contracts the product cares about, not only the patterns its spec lists; the most important token on the chain used the pattern the spec did not name.

## L-155: Slips in P3-U9, caught by its tests and its captures
Unit: P3-U9
What happened: (1) An invalid MONAD_RPC_URL was reported twice, once by the loader and once by the new research reader. (2) A test's `JSON.stringify` of the meter's events threw on a BigInt price. (3) The console's vitest project cannot load TSX, so the research view's tests could not import it. (4) A no-send test checked the lookup inputs against `FORBIDDEN_INTENT_FIELDS`, which includes `target`, the field lookups must have. (5) The direct live check showed `dune_query` metered and then reversed when Dune had no key. (6) The 1440px capture showed "Run research check" cut off at the Agents table's edge.
Cause: New code reusing an existing reader, list or layout without checking what it already covered.
Fix: The research reader reports only an issue the loader has not; the test serializes BigInts; the view's helpers and types moved to `research.ts`; the test names the sending fields; an unconfigured X or Dune is refused before the meter; the task buttons wrap (d13eb2c).
Lesson: Look at every capture a unit changes, not only the new page, and run a new paid tool once with its key missing to see what it charges.

## L-156: The console's build failed on node:fs after a pure package gained a file reader
Unit: P3-U3
What happened: The console e2e run stopped with a Turbopack error on /policy: "the chunking context (unknown) does not support external modules (request: node:fs)". packages/policy's main entry had started exporting the evals loader, which reads the scenario files with `readFileSync`, and the console's policy page imports packages/policy in browser code.
Cause: A package whose main entry runs in the browser re-exported a module that only runs in Node; the typecheck and every vitest run (all in Node) passed.
Fix: The loader is imported as `@alpha-agents/policy/evals`, a subpath export apart from the main entry (269e7f9).
Lesson: Keep a shared package's main entry browser-safe; anything that reads files, sockets or the environment goes behind its own subpath export, and a Next.js build is the test that proves it.

## L-157: The console's "Set plan" said "The orchestrator is not configured"
Unit: P3-U3
What happened: The new e2e test clicked "Set plan" and saw "The plan was not set: The orchestrator is not configured." The fixture API answered correctly when called directly.
Cause: The console composes its agents source from the control API's and the orchestrator's, passing each orchestrator method through by name; the new optional `setPlan` and `runRunner` were added to the orchestrator source but not to that list, and optional methods typecheck either way.
Fix: Both are passed through (269e7f9); the e2e test covers setting, refusing and running.
Lesson: When a method is optional on an interface, the compiler cannot tell you a composition point forgot it; add the method at every place the source is assembled, and test the control end to end.

## L-158: Slips in P3-U3, caught by its tests
Unit: P3-U3
What happened: (1) The runner's first Postgres test saw its own intent "expired" at once: the test clock was the chain's fixed time, weeks before today, while the stores expire intents on the real clock. (2) A test expected `TURNOVER_CAP` from the agent's `turnoverUsed`, but the Executor computes turnover from the trades in its 24-hour window. (3) A test expected `DAILY_TRADE_LIMIT`, which the owner's limit of 20 trades a day (equal to the hard limit) always reaches first as `OWNER_TRADE_LIMIT`. (4) Two eval scenarios did not test what their descriptions said (an account large enough to clear the minimum trade, and a "USDC short" buy that cannot happen while underweight). (5) The first commit used the scope `contracts` for packages/policy, which should have been `agent`; history is not rewritten.
Cause: Tests written against assumptions about the code under them rather than its actual inputs, and a scope picked without checking the list.
Fix: The runner runs on the stores' clock; the turnover case uses two trades in the window; the eval scenarios were corrected and their expectations computed by an independent implementation of the rule.
Lesson: Drive a test through the same inputs the production check reads (the window, the clock), and when a scenario's description and its numbers disagree, recompute the numbers outside the code under test.

## L-159: The formatter changed the bytes of hashed skill packages
Unit: P3-U7
What happened: Right after `pnpm skills:lock` recorded each package's content hash, the commit's formatting step rewrote the skill.json, params.json, evals.yaml and several SKILL.md files, and the lock test failed: "version 1.0.0 is already published with another content hash". Prettier had also restyled the generated evals.yaml into YAML flow style that is no longer JSON, which broke the check comparing it with P3-U3's evals.
Cause: The content hash covers exact bytes, and the repository's formatter runs over every file it knows, including package files.
Fix: The built-in folder is formatted before locking (so the gate's format check keeps it stable and the lock test catches any later byte change), and the generated evals.yaml is listed in .prettierignore.
Lesson: Anything hashed as bytes must be in its final formatted form before the hash is recorded, and a generated file whose format matters must be kept away from the formatter.

## L-160: A skill named a tool it did not declare, and two declared tools they never named
Unit: P3-U7
What happened: The package test that reads every `mcp__<server>__<tool>` in a SKILL.md found `deep-dive-research` telling the model to use `defillama_tvl` without declaring it, the Scan and Zoom out playbooks declaring tools their text never mentions, the band rebalancer declaring `get_prices` it never uses, and the swap skill naming `propose_swap` through its intent only.
Cause: Manifests and text were written separately, and the manifest validator checks only that declared IDs exist.
Fix: The manifests list exactly the tools their text names (implicit tools and a declared intent's tool allowed), and the test holds that both ways.
Lesson: A permission list and the instructions it covers must be checked against each other, not only against the registry; an undeclared tool fails at run time, an unused one widens what the skill may do.

## L-161: Slips in P3-U7, caught by its own checks
Unit: P3-U7
What happened: (1) Seven descriptions failed F4: a first sentence shorter than 57 characters left a fragment of the next word ("U") inside what the index shows. (2) The selection check's case "CHALLENGE stage: try to break the thesis from the Dive" gave no thesis, and the Scan model rightly asked for one instead of loading a playbook; the case, not the description, was wrong. (3) The audit crashed on address book entries whose address is not set yet.
Cause: Assuming the index cuts at a sentence, writing a test prompt that a careful model cannot act on, and an unchecked null.
Fix: Each first sentence is 56 or 57 characters so the cut falls on a word boundary; the case includes a thesis and the record says why it changed; the audit skips unset addresses.
Lesson: Test a selection prompt the way a careful model would read it; when a model declines to act, read its reply before changing the thing under test.
