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

`pnpm deploy:testnet:v3 --evidence evidence/nft-u2` (the F-U13 deployment script, continuing on the F-U13 set): the market and the two tokens found, the new AgentNFT deployed, the fund set found (it does not take AgentNFT), then the balance guard stopped the fifth step before anything else was sent. Every transaction sent was mined.

| Step | Result |
| --- | --- |
| 3 AgentNFT | 0x53704d94AF23CF04D2b6212cc071c6Bda6A4DFEF, transaction 0x0d9275573774e4f3af971c0d086faef1ccb754939eff4e9742fc730dd7e0a14b, block 70537008, 9,026,204 gas, 0.9929 MON at 110 gwei; 35,802 bytes; verified on Sourcify as exact_match (`pnpm verify:testnet:v3 --evidence evidence/nft-u2`, testnet-verification.json) |
| 5 Executor v3 and its set | stopped: "needs about 2.8401 MON at the maximum fee and the deployer holds 1.1537 MON". Executor v3, AccountFactoryV3 and the binding take AgentNFT at construction, so the whole set must follow the new AgentNFT before the testnet stack can use it: about 2.84 MON (Executor v3, its RouteAdapter and ProtocolRegistryV3, the OracleAdapterV3), 3.76 MON (AccountFactoryV3 with both implementations) and 0.01 MON (the binding), about 6.6 MON in all at 110 gwei; the verifier and the SET_VERIFIER proposal stand (the TokenRegistry did not move) |

Until the set follows, the testnet stack and the address book's testnet environment stay on the F-U13 deployment (AgentNFT 0xb70a241EA3964099BF930e3617756FA510BA6992 with NFT-U1's counts), which still works end to end; the new AgentNFT is recorded here and in testnet-deployment.json (a partial record, `partial: true`). The owner sends about 5.5 MON more to the deployer (6 MON recommended) and runs `pnpm deploy:testnet:v3 --evidence evidence/nft-u2` again: it continues at step 5, writes the full record, and the address book's testnet block then moves to the new set (the nine v3 ids and `agent_nft`), after which the testnet database is reset and the mint allowlist filled as in F-U13 (A-96).
