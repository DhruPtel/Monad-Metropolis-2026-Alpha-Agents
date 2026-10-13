# NFT-U2 handoff: species correction

Unit: NFT-U2. Status: done. 2026-10-13. The testnet set followed the new AgentNFT the same night, once the owner funded the deployer, and the testnet stack ran end to end on it.

## Commits

- `b7e02a7` feat(contracts): the species correction (D-376): every NFT-U1 species kept, Butterfly to pro, the owner's counts in AgentNFT's deck and tier table and the domain list, the suites, the species, supply and design specimens, A-94 resolved, FINAL_PLAN and BUILD_PLAN [NFT-U2]
- `74c6615` feat(contracts): AgentNFT redeployed on the playtest fork without a reset (with Executor v3's set, AccountFactoryV3 and the v2 custody set, which take it at construction), the owner's bee and tick minted again, the address book moved, MV-S15 and the fresh-fork suite passing; the new AgentNFT on Monad testnet with the guard stopping the set behind it; the deploy script's `--evidence` and partial record, the verifier skipping what Sourcify holds; evidence/nft-u2/REDEPLOY.md [NFT-U2]
- `a8fe7bf` test(web): the baselines for the species correction and the console's Address book page, the console's Manage choice as the design system's Select (L-250) [NFT-U2]
- `5a2e392` docs(plans): the NFT-U2 LOGS entry and the first handoff [NFT-U2]
- The next commit: feat(contracts): the testnet set behind the NFT-U2 AgentNFT (5 transactions, 5.61 MON, 8 contracts verified on Sourcify), the address book's testnet environment moved to it, the testnet stack on a reset database with the mint allowlist filled again run end to end, with the completed records [NFT-U2]
- The last commit: docs(plans): the continuation's LOGS entry, the redeploy record and this handoff [NFT-U2]

## The counts

| Tier | Species and count |
| --- | --- |
| Base, 500 | Larva grub 84, Roly-poly 84, Ant 83, Tick 83, Weevil 83, Ladybug 83 |
| Medium, 300 | Silkworm, Ground beetle, Cricket, Moth, Firefly, Centipede, Water strider, Earwig, Grasshopper, Leaf insect: 30 each |
| Pro, 200 | Bee, Praying mantis, Hercules beetle, Horseshoe crab: 1 each; Jumping spider, Mantis shrimp, Dragonfly, Scorpion, Trilobite, Stag beetle, Atlas moth, Cicada, Snake, Hummingbird, Fish, Butterfly, Crab, Orchid mantis: 14 each |

The onchain indexes are unchanged (Butterfly stays 31); only its tier and the counts moved. AgentNFT's constants: `INITIAL_DECK` 0x70e3c38f531c3870e1c3870e1c38701020409e3c78f1e3c78f53a74ea54, `TIER_TABLE` 0xfb9fffffffeaaa955.

## The new addresses

| Where | Contract | Address |
| --- | --- | --- |
| Playtest fork (chain 143143, no reset) | AgentNFT | 0x3Dc0b5Aa055eB5B91baD59382bC593ab964370E7 |
| | Executor v3, its RouteAdapter, ProtocolRegistryV3, OracleAdapterV3 | 0x9B39732cCD833204A12f940e48bdc0f67a45D9B5, 0x2006F4b8b5D2b66648Fc5981432161c2a0aA19F3, 0xBc29a9D783faa2F90C13adA440F9A7fB3dAfdb88, 0x534cc6Fa4183bd4eB670D306711738b9677cAa47 |
| | AccountFactoryV3, PersonalAccountV3, StrategyVaultV3 | 0x3Ba5CB3d7ced2cA135Da5C2Ebe13463d3ab66E9e, 0xE1180b624EfFaC5A6ecaCbb709Ef3Bef3A40f426, 0xDE47493a0FF37683865f1fA76655640bb7B8e4c0 |
| | AccountFactory (v2), PersonalAccount, Executor v2, ProtocolRegistry v2, venues v4 and v3 | 0xD198e95a92Cc56a8Ef413Df3a46A6E42b2059e77, 0x3f0c0eC0604110EEC4133391342A870Ffdb08Ce1, 0x75017d46de8C03dC15E4A93075D220906BA4359A, 0xF40444bec74c0F4E051803d9b83A1d882790B2D6, 0x7Eae23589af7D8dD908A49A50369BF9320786EF4, 0xA29731cdd9419dA8Bf4eD33fc9c3e0f9ace5490E |
| | Agent 1 (bee) and agent 2 (tick), the same owners, new token-bound accounts | 0x31C7365A48cd9a2C1849cA59D5EE566eC315e953, 0x94DCFC702E306cb237F3470dadF56F15d9c4b575 |
| Monad testnet (chain 10143) | AgentNFT (verified on Sourcify) | 0x53704d94AF23CF04D2b6212cc071c6Bda6A4DFEF |
| | Executor v3, its RouteAdapter, ProtocolRegistryV3, OracleAdapterV3 | 0x8727b75ffF16483A462347cF829BF3ffBBcAbfA6, 0x6F729E50B7A2Ba738a6a86B595B692cBC2E1a18a, 0x5101D2f94B002e53658aB15Bba411a3Ee16b1650, 0xC8b178126a25A4dA9b2E7cc9faF7492051866707 |
| | AccountFactoryV3, PersonalAccountV3, StrategyVaultV3 | 0xD8422359414939b365E12caaE3C5f08A3360b7Aa, 0xDD92990D765d3553CfC35EbC19f487e7d1D9819C, 0xeF7890Ce15F50715CD5617D12f97deb7DEbD80D7 |
| | TokenRegistry, the fund set, the AttestationVerifier (unchanged) | 0xDe0997ABe3dd6c79f64FeAfd69CCF3FaE58ed5a0, 0x6fB101B197dFC3F0C694C457e1E1732982EEF0Ef |

The address book's local environment names the fork's new set (every verified entry matches, `pnpm test:fork`) and its testnet environment the new AgentNFT and set on testnet; F-U13's AgentNFT, Executor v3 and AccountFactoryV3 stay on testnet unused.

## Test results

| Check | Result |
| --- | --- |
| forge (chains/monad) | build and `forge fmt --check` clean; 667 passed, 0 failed, 14 skipped; the AgentNFT suites 71, with the full-supply fuzz yielding exactly the new counts under any randomness and every agent's tier its species' table entry |
| packages/domain | species.test.ts: the counts, Butterfly pro, the contract's deck and tier table equal to the list's packing |
| `pnpm deploy:agent-nft`, `deploy:executor-v3`, re-provisioning, `deploy:account-factory` on the playtest fork | 1, 6, 12 and 7 transactions mined of 1, 6, 12 and 7 sent; the fork's head 109670628 to 109670644, no reset |
| `pnpm assert:state` | PASS, MV-S15: 71 values |
| `pnpm test:fork` | the same set on a fresh fork; the address book matches every verified entry |
| reveal-tiers.fork.test.ts (forks project) | 3 passed: 34 species and the new deck, one species of every tier minted and steered with the right tier, slots and metadata, a wallet's third mint refused |
| `pnpm deploy:testnet:v3 --evidence evidence/nft-u2` (two runs) | AgentNFT at 0x53704d94 (9,026,204 gas, 0.9929 MON, block 70537008), the guard stopping step 5 until the owner funded the deployer; then Executor v3 and its set, AccountFactoryV3 and the binding (5 transactions, 5.61 MON, blocks 70548462 to 70548621); every transaction mined |
| `pnpm verify:testnet:v3 --evidence evidence/nft-u2` | 18 of 18 exact_match on Sourcify (the 8 new contracts, the 10 unchanged ones already there) |
| `pnpm testnet:up`, `pnpm testnet:e2e` on the new set | passed in one attempt (281 s): the mint on the new AgentNFT, the real Entropy reveal in 76 s (species 13 Earwig, medium), credits in 2 s, a Scan, the v3 account with the feeds re-dated, 0.5 USDC deposited, the grant on Executor v3, the chain check's 0.02 USDC trade settled through Executor v3 at the finalized tag 8.4 s after approval, the over-limit proposal rejected (TRADE_SIZE_EXCEEDED, CONCENTRATION_CAP), disarm, withdrawAll, the account empty (evidence/nft-u2/e2e-run-2026-10-13T01-29-09-065Z.json) |
| `pnpm test:testnet-fork`, `pnpm test:canary-fork` | 9 passed; 4 passed |
| vitest, whole | 222 files, 2665 passed |
| Playwright web suite (1440px and 380px, axe) | 308 passed, 2 skipped plainly after the mint and design re-baseline |
| Playwright console suite | 122 passed on the re-baseline run and on two plain runs (the Address book page with the new set; the Agents page with the Select) |
| pnpm typecheck, lint, format:check | clean |

Acceptance, as the prompt lists it: the three decisions recorded in D-376 with A-94 resolved, FINAL_PLAN and BUILD_PLAN updated; AgentNFT's deck and the species list, every test (the 1,000-mint fuzz included), the manifest and the mint page's odds; the local fork redeployed with no reset and the owner's agents re-provisioned; AgentNFT and the set behind it redeployed on Monad testnet and run end to end; the addresses recorded above and in evidence/nft-u2/REDEPLOY.md; every check run, one heavy suite at a time.

## Model spend

About 0.51 USD at LiteLLM's cost for the testnet end-to-end run's Scan and chain check; none for the rest of the unit. The day's window stands at 5.096 USD; the gateway's daily budget is 15 USD.

## What the owner should check or try

- Testnet, with one of your three playtest wallets on Monad Testnet: `pnpm testnet:up` (the dev stack must be stopped first), open http://localhost:3000, mint on the corrected species (your wallets are on the mint allowlist and the depositor allowlist), watch the reveal, set a goal, deposit about 0.5 USDC, arm, and let the agent trade on the P2-EC USDC/MON pool; `pnpm testnet:gas <agentId>` gives the session key 0.9 MON from the deployer, which holds about 5.2 MON. `pnpm testnet:down` stops it. Agent 1 on this database is the test wallet's (an Earwig).
- `pnpm dev:all`, then /mint: the medium card shows ten species at 30 and the pro card eighteen with Butterfly among them; /configure?agent=1 shows the bee and agent 2 the tick as before.
- The console's Agents page: Manage beside Arm is the design system's Select now.

## Open issues for the next unit

- The nine species without art keep the placeholder until their files arrive (NFT-U1).
- The class A round trip on testnet waits for the SET_VERIFIER timelock (2026-10-21 23:15 UTC), as in F-U13.

Push: `git push`
