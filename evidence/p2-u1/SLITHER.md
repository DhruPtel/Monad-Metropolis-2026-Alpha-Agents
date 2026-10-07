# P2-U1 Slither review

Run on 2026-10-07 with Slither 0.11.6 (installed with `uv tool install slither-analyzer`) over `chains/monad`, excluding dependencies, tests and scripts:

```sh
cd chains/monad
slither . --filter-paths 'dependencies|test|script' --exclude-dependencies
```

The first run reported 41 results across 50 contracts. Five were fixed; the 36 left are each justified below. Slither runs `forge clean` first, so run `forge build` afterwards.

## Fixed

| Detector | Where | Fix |
|---|---|---|
| unindexed-event-address (4) | `AccountFactory.ExecutorSet`, `OracleSet`, `GuardianSet`, `SentinelSet` | Both addresses are indexed, so the indexer can filter by the new Executor, oracle, guardian or sentinel |
| reentrancy-events (1) | `AccountFactory.createPersonalAccount` | `PersonalAccountCreated` is emitted before the clone's `initialize` call |

## Custody contracts: justified

| Detector | Impact | Where | Why it stays |
|---|---|---|---|
| incorrect-equality | Medium | `CustodyCore._after`: `received == 0` | Comparing the account's own measured output with zero is the point: a trade that pays nothing must revert. A donation can only raise `received`, which helps the account |
| incorrect-equality | Medium | `CustodyCore._withdrawAllOf`: `balance == 0`; `_clampCredit`: `credit == 0` | Skips work when there is nothing to pay or no credit. A donated balance is simply withdrawn too |
| incorrect-equality | Medium | `PersonalAccount._afterWithdraw`: both balances `== 0` | Resets the principal once the account is empty. It runs inside the withdrawal, after `withdrawAll` has paid the whole balance, so nobody can slip a donation in between; a credited (unpaid) balance correctly keeps the principal |
| missing-zero-check | Low | `AccountFactory` constructor: `guardian_`, `sentinel_` | Zero means "no guardian" or "no sentinel key yet", which only removes tighteners; appointing one later waits the timelock |
| missing-zero-check | Low | `PersonalAccount.initialize`: `owner_` | Only the factory calls it, with `msg.sender` of `createPersonalAccount`, which is the agent's owner and never zero |
| reentrancy-benign | Low | `CustodyCore.executeSwap`: `delete _swap` after `onSwap` | Intended: the swap context must stay open during the Executor's callback so `pullForSwap` works, and is cleared after. `executeSwap` is `nonReentrant`, and `pullForSwap` checks the context (one pull, exact token, exact amount, the Executor only) |
| timestamp | Low | `AccountFactory.propose`, `execute`; `CustodyCore._checkSwap` | Timelocks of 9 days with a 7-day window, and intent deadlines of up to 120 seconds; a leader's few seconds of skew do not matter at those scales |
| assembly | Informational | `PersonalAccount._noteWithdrawal` | A call with bounded gas whose result and return data are deliberately ignored, so a factory that reverts, burns gas or returns a huge payload cannot stop a withdrawal. Solidity's `call` would copy the return data |
| naming-convention (7) | Informational | `USDC`, `WMON`, `AGENT_NFT`, `PERSONAL_ACCOUNT_IMPLEMENTATION` | Immutables in upper case, the repository's convention since AgentNFT |

## AgentNFT and its interfaces (P1-U3): justified, not changed

AgentNFT is not changed in this unit: any edit to its source, a comment included, changes its metadata hash and so its deterministic CREATE2 address, which the address book, the apps and the owner's playtest fork all use. These findings are recorded for the record and for the external review.

| Detector | Impact | Where | Why it stays |
|---|---|---|---|
| reentrancy-eth | High | `AgentNFT.requestReveal`: `pendingReveal` written after `ENTROPY.requestV2` | A false positive, reviewed in P2-U3 Step 0: see the section below |
| unused-return | Medium | `mintWithClaim` ignores `tryRecover`'s error; `_isAgentAccount` ignores three of `token()`'s values | A failed recovery returns address zero, which fails the signer check; only the token contract is needed to recognise an agent account |
| reentrancy-events (2) | Low | `requestReveal`, `_mintAgent` | Events after calls to Entropy and the canonical ERC-6551 registry and account, both fixed contracts |
| timestamp (3) | Low | `mintWithClaim`, `reveal`, `requestReveal` | A claim deadline and a one-hour reveal timeout |
| low-level-calls | Informational | `requestReveal` refund | Sends the excess fee back and reverts if it fails |
| missing-inheritance | Informational | AgentNFT could inherit `IAgentNFTView` | It implements both functions; inheriting would change its bytecode for no behaviour |
| naming-convention (5) | Informational | AgentNFT immutables and `_entropyCallback` | The repository's convention; `_entropyCallback` is the name Pyth's interface calls |
| shadowing-local (2) | Low | `IERC6551Registry` return names | The registry's published ABI names its return value `account`; interface only |

## The High finding, reviewed again in P2-U3 Step 0

**What Slither says.** `requestReveal` sends the reveal fee to Pyth Entropy (`ENTROPY.requestV2{value: fee}()`) and only then writes `pendingReveal`. If the contract it calls could call back into AgentNFT during that call, it would see the old `pendingReveal`. Slither flags every "call that sends value, then a state write" as reentrancy-eth, whatever the callee is.

**Why it is a false positive.**

1. The callee is the one address AgentNFT trusts for randomness. It is fixed in the constructor and cannot be changed. Pyth's `requestV2` records the request and returns; the number arrives in a later transaction, from Pyth's provider, through `_entropyCallback`. Nobody else can be the callee, so no attacker gets control during the call. A correction to the P2-U1 row: Entropy's address is fixed, but it is an ERC-1967 proxy (177 bytes of code; its implementation slot reads `0x1235841f...e9c6` on the fork), so Pyth governance can upgrade it. That does not change the answer: an Entropy that turned hostile could choose the random numbers outright, which is worse than anything a reentry could do, and the plan already treats it as a trusted dependency (D-187).
2. Even a hostile Entropy that reenters gains nothing, and three new tests show it (`test/AgentNFTReentrancy.t.sol`, with an Entropy mock that calls back during `requestV2`):
   - If it calls `requestReveal` again, it must pay that inner fee itself. The outer call then overwrites `pendingReveal` with its own request, so the inner request is orphaned at Entropy's expense. The caller pays exactly one fee, AgentNFT keeps no balance, the orphaned request's number is ignored, and the outer request reveals the batch normally.
   - If it calls `_entropyCallback` during the request, the sequence does not match the pending one yet, so the number is ignored and no seed can be planted.
   - The refund to the caller is the last statement. A caller that reenters from the refund finds the batch pending and reverts with `RevealPending`.
3. AgentNFT never spends its own balance here: the fee comes out of `msg.value`, and the excess goes back to the caller.

**Decision.** Not changed. Changing AgentNFT would move its deterministic address on the owner's playtest fork, where agent #1 lives, for no gain in safety. If AgentNFT is edited for another reason before PB-U1, writing a "request in flight" marker before the call would silence the detector at the cost of one storage write.
