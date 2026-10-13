# NFT-U2 handoff: species correction

Unit: NFT-U2. Status: done, with the testnet set waiting on funds. 2026-10-13.

## Commits

- `b7e02a7` feat(contracts): the species correction (D-376): every NFT-U1 species kept, Butterfly to pro, the owner's counts in AgentNFT's deck and tier table and the domain list, the suites, the species, supply and design specimens, A-94 resolved, FINAL_PLAN and BUILD_PLAN [NFT-U2]
- `74c6615` feat(contracts): AgentNFT redeployed on the playtest fork without a reset (with Executor v3's set, AccountFactoryV3 and the v2 custody set, which take it at construction), the owner's bee and tick minted again, the address book moved, MV-S15 and the fresh-fork suite passing; the new AgentNFT on Monad testnet with the guard stopping the set behind it; the deploy script's `--evidence` and partial record, the verifier skipping what Sourcify holds; evidence/nft-u2/REDEPLOY.md [NFT-U2]
- `a8fe7bf` test(web): the baselines for the species correction and the console's Address book page, the console's Manage choice as the design system's Select (L-250) [NFT-U2]
- The last commit: docs(plans): the NFT-U2 LOGS entry and this handoff [NFT-U2]

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
| | Executor v3's set, AccountFactoryV3, the binding | not yet: about 6.6 MON, the deployer holds 1.15 |

The address book's local environment names the fork's new set (every verified entry matches, `pnpm test:fork`); its testnet environment stays on the F-U13 set until the set follows the new AgentNFT there.

## Test results

| Check | Result |
| --- | --- |
| forge (chains/monad) | build and `forge fmt --check` clean; 667 passed, 0 failed, 14 skipped; the AgentNFT suites 71, with the full-supply fuzz yielding exactly the new counts under any randomness and every agent's tier its species' table entry |
| packages/domain | species.test.ts: the counts, Butterfly pro, the contract's deck and tier table equal to the list's packing |
| `pnpm deploy:agent-nft`, `deploy:executor-v3`, re-provisioning, `deploy:account-factory` on the playtest fork | 1, 6, 12 and 7 transactions mined of 1, 6, 12 and 7 sent; the fork's head 109670628 to 109670644, no reset |
| `pnpm assert:state` | PASS, MV-S15: 71 values |
| `pnpm test:fork` | the same set on a fresh fork; the address book matches every verified entry |
| reveal-tiers.fork.test.ts (forks project) | 3 passed: 34 species and the new deck, one species of every tier minted and steered with the right tier, slots and metadata, a wallet's third mint refused |
| `pnpm deploy:testnet:v3 --evidence evidence/nft-u2` | AgentNFT at 0x53704d94 (9,026,204 gas, 0.9929 MON, block 70537008); the guard stopped step 5 and said what is needed |
| `pnpm verify:testnet:v3 --evidence evidence/nft-u2` | AgentNFT exact_match on Sourcify (the tokens and feeds already there) |
| `pnpm test:testnet-fork`, `pnpm test:canary-fork` | 9 passed; 4 passed |
| vitest, whole | 222 files, 2665 passed |
| Playwright web suite (1440px and 380px, axe) | 308 passed, 2 skipped plainly after the mint and design re-baseline |
| Playwright console suite | 122 passed on the re-baseline run and on two plain runs (the Address book page with the new set; the Agents page with the Select) |
| pnpm typecheck, lint, format:check | clean |

Acceptance, as the prompt lists it: the three decisions recorded in D-376 with A-94 resolved, FINAL_PLAN and BUILD_PLAN updated; AgentNFT's deck and the species list, every test (the 1,000-mint fuzz included), the manifest and the mint page's odds; the local fork redeployed with no reset and the owner's agents re-provisioned; the testnet AgentNFT redeployed within the deployer's balance, the set behind it stopped by the guard with the figure below; the addresses recorded above and in evidence/nft-u2/REDEPLOY.md; every check run, one heavy suite at a time.

## Model spend

None: no model was called in this unit. The day stands at 5.391 USD.

## What the owner should check or try

- Send about 5.5 MON (6 recommended) to the testnet deployer `0x5C0Fb609931651357dcfd2b985910E3fC5904A4a` on Monad testnet (chain 10143), then run `pnpm deploy:testnet:v3 --evidence evidence/nft-u2`: it continues at step 5 (Executor v3's set, about 2.84 MON; AccountFactoryV3, about 3.76; the binding), writes the full record, and `pnpm verify:testnet:v3 --evidence evidence/nft-u2` verifies the set. After that the address book's testnet block moves to the new set, the testnet database is reset and the mint allowlist filled again (A-96), and `pnpm testnet:up` runs on the corrected species. Until then testnet runs on the F-U13 set with NFT-U1's counts.
- `pnpm dev:all`, then /mint: the medium card shows ten species at 30 and the pro card eighteen with Butterfly among them; /configure?agent=1 shows the bee and agent 2 the tick as before.
- The console's Agents page: Manage beside Arm is the design system's Select now.

## Open issues for the next unit

- The testnet set behind the new AgentNFT, as above.
- The nine species without art keep the placeholder until their files arrive (NFT-U1).

Push: `git push`
