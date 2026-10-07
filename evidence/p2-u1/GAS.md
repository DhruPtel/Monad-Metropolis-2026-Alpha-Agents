# P2-U1 custody gas report

Measured on 2026-10-07 with forge 1.8.3 using the Monad EVM (`network = "monad"`). Gas inside the call, without the 21,000 transaction base or calldata.

Sources:
- Real tokens: `forge test --match-path test/fork/CustodyFork.t.sol --gas-report` on a fork of Monad mainnet at the pinned block 109670000, with Circle's USDC (FiatToken proxy) and WMON.
- Everything else: `forge test --match-path 'test/custody/{PersonalAccount,AccountFactory,CustodyReentrancy}.t.sol' --gas-report`, with mock tokens, AgentNFT, oracle and Executor.

| Action | Gas | Notes |
|---|---|---|
| `createPersonalAccount` | 235,194 | Clone deployment (EIP-1167), registry entry and initialize |
| `deposit`, real USDC or WMON | 194,096 to 244,224 | AgentNFT owner check, cap and allowlist bookkeeping in the factory, exact-receipt check; the higher figure is the first deposit of a token |
| `withdraw`, real USDC | 158,792 | Includes lowering the principal and the bounded note to the factory |
| `withdrawAll`, real USDC and WMON | 171,852 to 309,206 | The low end credits a blacklisted or paused USDC and pays WMON |
| `claim`, real USDC | 85,424 to 180,547 | |
| `executeSwap` (mock tokens, oracle and Executor) | 204,479 median, 430,812 max | Includes the Executor's callback, two NAV readings and the post-trade checks; the real figure depends on the oracle adapter (P2-U3) and the venue (P2-U2) |
| `setReduceOnly`, `pause`, `closeDeposits` | 29,824 to 34,764 | Two factory reads for the guardian and the sentinel |
| `unpause`, `openDeposits` | 8,663 to 14,154 | |
| `propose`, `execute` (factory) | 63,953 and 67,101 median | |
| Deployment size | AccountFactory 12,469 bytes of runtime code; PersonalAccount implementation 18,692 bytes; each clone 45 bytes | Measured on the fork after `pnpm deploy:account-factory` |

Monad bills the gas limit of a transaction, not the gas used, so the deposit and withdraw UI (P2-U7) and the signer (P2-U4) should set limits close to these numbers rather than a large fixed margin.
