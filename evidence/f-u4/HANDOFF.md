# F-U4 handoff

Unit: F-U4 Contracts III: Executor v3 and the policy mirror.
Status: partial. Every acceptance test passes and everything in scope is built, tested, deployed on `pnpm test:fork`'s fork and recorded; the deployment on the playtest fork (8545) is blocked because that fork's anvil stopped answering at 05:15 UTC during the unit (L-181), and reviving it is the owner's decision.

## Commits

- 3d2846d test(contracts): mirror Executor v3 in packages/policy and replay 236 cases on both sides, with a v3 policy hash in the domain and the new codes in the chain tools' guidance [F-U4]. This commit also holds the Executor itself (ExecutorV3.sol, IExecutorV3.sol, the nine reason codes, the six unit suites and the invariant run): the first slice's gate failed on a typecheck the new codes caused in the chain tools, and the second commit carried both once it was fixed.
- d7aedfb feat(contracts): deploy Executor v3 with its registered RouteAdapter, registry, oracle and factory from one deterministic set, trade real pools on a fork, and record gas, Slither and the addresses [F-U4].
- The docs commit (its hash is in the handoff message): docs(plans): log F-U4, record its lessons, the deployment decision, the Executor's values and the gas rule, and mark it done [F-U4].

## Test results

- forge: 554 passed, 0 failed, 11 skipped (the fork suites, run under test:fork). The Executor v3 suites: 75 unit tests, 4 invariants over 48 runs and 2,880 calls, and 236 parity cases in four slices.
- vitest: 2,099 passed in 157 files, 1 skipped, 0 failed. The run's exit code is 1 because of the same unhandled rejection from scan.test.ts as before this unit (an MCP client posting after its lease ended, 401).
- `pnpm test:fork`: 50 passed in 9 suites on a fresh fork of the pinned block; the Executor v3 set deployed there and the address book matched every verified entry. The Executor fork test trades through one, two and three real pools from the session key.
- Console e2e: 112 passed after re-baselining the address book page (desktop and mobile; pixel-identical above the entry count, the rest the six new rows and two updated notes), then 112 passed again against the new baselines.
- Slither: 311 results, 27 in the new code, every one justified (evidence/f-u4/SLITHER.md). Gas in evidence/f-u4/GAS.md.
- Format, lint, typecheck, forge fmt and the secrets scan passed on every commit.

## What the owner should check or try

1. The playtest fork. Its anvil (pid 165477, `pnpm dev:up` two days ago) is alive and listening on 8545 but answers nothing since 05:15 UTC; its log (.dev/anvil.log) ends mid-way through the fetches of a forge fork test I pointed at it (L-181). I did not stop or reset it, and `pnpm dev:all` cannot start while it is down (`pnpm dev:up` reports anvil DOWN), so the dev stack is stopped; postgres and redis are up. If you restart the fork, its in-memory state is lost unless the runner's dump restores it; then `pnpm deploy:agent-nft`, `pnpm deploy:account-factory`, `pnpm deploy:fund` and `pnpm deploy:custody-v3` as before, `pnpm deploy:executor-v3` for this unit, and `pnpm dev:all`. The addresses will be exactly the address book's (D-363).
2. `pnpm test:fork`: the Executor v3 set deploys, the address book matches, and `ExecutorV3ForkTest` logs each route's gas and every pool's spot against its feed.
3. `forge test --match-path "chains/monad/test/fund/ExecutorV3*.t.sol"` from chains/monad: every limit at its threshold, the token rules, class A, the misbehaving venue, reentrancy, sessions, the invariants and the parity replay.
4. `pnpm vitest run packages/policy/src/executor-v3.test.ts`: the fixture is what the mirror answers now; `pnpm policy:parity` rewrites every fixture.
5. Read evidence/f-u4/GAS.md: the two-hop buy of cbBTC through PancakeSwap is refused at the floor because both pools sit over their feeds in that direction, while the sale fills; this is how the floor and the 2% pool bound interact on real pools.

## Open issues for the next unit

- The playtest fork deployment of the Executor v3 set waits for a fork that answers (above).
- The live token check (F-U2 step 0) still waits for the Anthropic account to accept calls.
- An opted-out account cannot sell its screened tokens through their screened pools (the registry's rule, F-U2); the owner withdraws them in kind. For the registry's owner to decide.
- A trade's gas is mostly valuation (every held token's real feed read four times); a combined account view would cut it by about 300,000 gas per held token and is a later contracts change.
- For F-U5: `SwapIntentV3` with schema 2, `adapterId = keccak256("route-adapter")`, grants through Executor v3's `registerSession`, gas limits from `executorV3SwapGasLimit(hops, heldTokensAfter)`, blockers from `executorV3.blockers`; the account's `holdings()` and `capValues()` and the registries' records are the mirror's market.

## Push

    git push
