# NFT-U2: the redeploys (2026-10-12 to 2026-10-13)

## The playtest fork

The playtest fork on port 8545 (chain 143143, pinned at block 109670000) was not reset; its head moved from 109670628 to 109670644. Every transaction sent was mined: the counts are the fork's `eth_sendTransaction` lines against its `Transaction:` lines in `.dev/anvil.log` for each step (the re-provisioning's helpers also send signed transactions for the keeper and Entropy, which the log counts as mined but not as `eth_sendTransaction`).

| Step | Sent | Mined | Result |
| --- | --- | --- | --- |
| `pnpm deploy:agent-nft` | 1 | 1 | AgentNFT 0x3Dc0b5Aa055eB5B91baD59382bC593ab964370E7 (35,802 bytes), the deck and tier table of D-376; NFT-U1's 0xAabdac6bF7B25F0a2190241D735A7014fDf92F14 stays on the fork unused |
| `pnpm deploy:executor-v3` | 6 | 6 | Executor v3 0x9B39732cCD833204A12f940e48bdc0f67a45D9B5, RouteAdapter 0x2006F4b8b5D2b66648Fc5981432161c2a0aA19F3, ProtocolRegistryV3 0xBc29a9D783faa2F90C13adA440F9A7fB3dAfdb88, OracleAdapterV3 0x534cc6Fa4183bd4eB670D306711738b9677cAa47, AccountFactoryV3 0x3Ba5CB3d7ced2cA135Da5C2Ebe13463d3ab66E9e, PersonalAccountV3 0xE1180b624EfFaC5A6ecaCbb709Ef3Bef3A40f426, StrategyVaultV3 0xDE47493a0FF37683865f1fA76655640bb7B8e4c0; the TokenRegistry (0x171F36056B2449F0FBB9923676AffAb14A1cf55C) and the fund set unchanged |
| Re-provisioning (two claim mints, two steered reveals, through scripts/lib/agent-mint.js and agent-reveal.js) | 8 (plus 4 signed by the helpers) | 12 | Agent 1 to 0x683eE842A16f85e69883F433745263BFe8D55f76 (TBA 0x31C7365A48cd9a2C1849cA59D5EE566eC315e953), revealed as the Bee (species 14, pro, the one of one drawn); agent 2 to 0x32838fe90541567BBf77Fa0570661F3c20e2B152 (TBA 0x94DCFC702E306cb237F3470dadF56F15d9c4b575), revealed as the Tick (species 4, base): the same ids, owners, species and tiers as before, each mint paid by its wallet (334k gas) |
| `pnpm deploy:account-factory` (the v2 custody set, whose factory and Executor also take AgentNFT) | 7 | 7 | AccountFactory 0xD198e95a92Cc56a8Ef413Df3a46A6E42b2059e77, PersonalAccount 0x3f0c0eC0604110EEC4133391342A870Ffdb08Ce1, Executor v2 0x75017d46de8C03dC15E4A93075D220906BA4359A, ProtocolRegistry v2 0xF40444bec74c0F4E051803d9b83A1d882790B2D6, venues 0x7Eae23589af7D8dD908A49A50369BF9320786EF4 (v4, active) and 0xA29731cdd9419dA8Bf4eD33fc9c3e0f9ace5490E (v3, paused); the oracle adapter 0xa9D5E28dfeca6eAA252092ED8f3F9a36cEB30f34 unchanged; the owner's wallet allowlisted |
| `pnpm assert:state` | 0 | 0 | PASS, MV-S15: 71 values of the v3 set match the intended configuration |
| `pnpm test:fork` | fresh fork | | the same set deployed on a fresh fork; the address book matches every verified entry |
| reveal-tiers.fork.test.ts (the forks project) | fresh fork | | 34 species and the new deck; one species of every tier minted and steered with the right tier, slots and metadata; the third mint of a wallet refused |

What stayed as it was: the owner's wallets' USDC and MON (each mint cost its wallet about 0.0007 MON of gas), the platform database (agents 1 and 2 keep species 14 and 4, their funding addresses, credits and goals; the indexer re-projects both from the new contract's events, with their new token-bound accounts, when the dev stack next starts), the TokenRegistry, the fund set and the allowlists. Neither agent had an account on the NFT-U1 factory or a vault, so nothing was moved; the NFT-U1 set and the P1-U3 and NFT-U1 AgentNFTs stay on the fork unused.

## Monad testnet

`pnpm deploy:testnet:v3 --evidence evidence/nft-u2` (the F-U13 deployment script continuing on the F-U13 set), in two runs: the first (2026-10-13, 00:13 UTC) found the market and the two tokens, deployed the new AgentNFT, found the fund set (it does not take AgentNFT) and was stopped by the balance guard before the fifth step, with the deployer at 1.15 MON; the owner then sent 10 MON, and the second run (01:10 UTC) continued at the fifth step and deployed the set that takes AgentNFT at construction. Every transaction sent was mined (`testnet-deployment.json`, 6 transactions from the run's start block 70536885).

| Step | Result |
| --- | --- |
| 3 AgentNFT | 0x53704d94AF23CF04D2b6212cc071c6Bda6A4DFEF, transaction 0x0d9275573774e4f3af971c0d086faef1ccb754939eff4e9742fc730dd7e0a14b, block 70537008, 9,026,204 gas, 0.9929 MON at 110 gwei; 35,802 bytes |
| 5 Executor v3 and its set | ExecutorV3 0x8727b75ffF16483A462347cF829BF3ffBBcAbfA6 (block 70548462, 10,209,952 gas, 1.1231 MON); the ExecutorSetDeployer 0x172D7A40a2DeECB7F10beA4D4a3a32050964f277 with Executor v3's RouteAdapter 0x6F729E50B7A2Ba738a6a86B595B692cBC2E1a18a and ProtocolRegistryV3 0x5101D2f94B002e53658aB15Bba411a3Ee16b1650 inside (block 70548471, 9,075,673 gas, 0.9983 MON); OracleAdapterV3 0xC8b178126a25A4dA9b2E7cc9faF7492051866707 (block 70548474, 2,561,256 gas, 0.2817 MON) |
| 6 AccountFactoryV3 and the binding | AccountFactoryV3 0xD8422359414939b365E12caaE3C5f08A3360b7Aa with PersonalAccountV3 0xDD92990D765d3553CfC35EbC19f487e7d1D9819C and StrategyVaultV3 0xeF7890Ce15F50715CD5617D12f97deb7DEbD80D7 inside (block 70548552, 29,025,690 gas, 3.1928 MON); `executor.bind` at block 70548621 (99,200 gas, 0.0109 MON) |
| 7 The verifier and SET_VERIFIER | found: the AttestationVerifier 0x6fB101B197dFC3F0C694C457e1E1732982EEF0Ef and the TokenRegistry's proposal stand (the registry did not move), executable 2026-10-21 23:15 UTC |
| Sourcify (`pnpm verify:testnet:v3 --evidence evidence/nft-u2`) | 18 of 18 exact_match: the 8 new contracts verified, the 10 unchanged ones already there |

The deployer spent 6.60 MON across the two runs (0.99 and 5.61) and holds about 5.2 MON after the end-to-end run's top-ups. The address book's testnet environment names the new AgentNFT and the new v3 set; the fund set's ids are unchanged; F-U13's Executor v3 (0x50BF6cf5f27720f32aEeBdB11EC91821d933ecB6) and AccountFactoryV3 (0xE40652172925dbBc63755E1f55EFb8ae91623d5B) and its AgentNFT (0xb70a241EA3964099BF930e3617756FA510BA6992) stay on testnet unused, beside P2-EC's.

## The testnet stack end to end on the new set

The testnet database (alpha_agents_testnet) and Redis database 1 were reset for the new AgentNFT (the F-U13 index and its agent belonged to the old contract), the mint allowlist was filled again with the test wallet and the owner's three playtest wallets (A-96), the test wallet received 0.3 MON of gas from the deployer, and the indexer caught up from block 70537009 to the head (about 14,000 blocks in 9 minutes). Then `pnpm testnet:e2e` ran to the end in one attempt (`e2e-run-2026-10-13T01-29-09-065Z.json`, 281 s):

| Step | Measured |
| --- | --- |
| Mint on the new AgentNFT (`mintWithClaim`) | block 70551209, 338,165 gas; receipt 419 ms, finalized 1,173 ms; indexed 2.6 s later |
| Pyth Entropy reveal | `requestReveal` and `reveal` 6 s apart after the keeper's 60-second window; species 13 (Earwig, medium) 76 s after the mint; provisioning ready at once |
| Credits (1 USDC) | credited 2.0 s after the transfer |
| Scan | succeeded in 115 s (about 0.5 USD with the chain check) |
| Gas top-ups (`pnpm testnet:gas 1`) | the keeper back to 0.35 MON, the agent's funding address to 0.9 (A-96) |
| PersonalAccountV3 opened, the feeds re-dated (6,628 s old), 0.5 USDC deposited | 343,838; 42,601 each; 87,643 and 409,068 gas |
| Arm on Executor v3 | 110,697 gas; awaiting its first trade |
| The chain check's proposal (0.02 USDC of WMON) | proposed 42 s after the task was queued, approved, settled through the signer and Executor v3 on the P2-EC USDC/MON pool 8.4 s after the approval; 0.019980 WMON for 0.02 USDC; the outbox reconciled |
| The over-limit proposal | rejected at submission: TRADE_SIZE_EXCEEDED and CONCENTRATION_CAP (no GAS_UNFUNDED this time: the 0.9 MON target covers a second swap) |
| Disarm, `withdrawAll` | 55,799 and 321,562 gas; the account 0xEC64A70Fb7Cc88EF0260cBd3DBb77A7cd0b7418b empty, mode NORMAL |

The stack was stopped afterwards (`pnpm testnet:down`); `pnpm testnet:up` starts it again on the same database, where agent 1 is the test wallet's.
