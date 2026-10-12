# NFT-U1: the playtest fork redeploy (2026-10-12)

The playtest fork on port 8545 (chain 143143, pinned at block 109670000) was not reset. Every transaction sent was mined; the counts below are `eth_sendTransaction` lines against `Transaction:` lines in `.dev/anvil.log`.

| Step | Sent | Mined | Result |
| --- | --- | --- | --- |
| `pnpm deploy:agent-nft` | 1 | 1 | AgentNFT 0xAabdac6bF7B25F0a2190241D735A7014fDf92F14 (35,802 bytes), block 109670612 |
| `pnpm deploy:executor-v3` | 6 | 6 | Executor v3 0x7e1f02615472e845F339Baf189EF6096737d3f35, RouteAdapter 0xbD8f9E8A3db35B9004d9F75927cD159247c04E74, ProtocolRegistryV3 0xe0482Ce574Bd72b5D0472e13068205540fE4BC42, OracleAdapterV3 0xFac9B8360eA2363afB7A6d34B11BBd78c07387BD, AccountFactoryV3 0x53aE163F6545e94B3c1afAbe47F3FEc44A4D65C9, PersonalAccountV3 0x8962AAe666B5840C7BFE0f2D3786242544BEa43d, StrategyVaultV3 0x2D6bbc6a5193d2D48018fe29791420f4a5F81Dad; the Executor rebound to the new factory (L-229); block 109670617 |
| Re-provisioning (two claim mints, two steered reveals) | 8 | 8 | Agent 1 to 0x683eE842A16f85e69883F433745263BFe8D55f76 (TBA 0x716f8D40C55420340BC612a71DEdD1Fb8bDCF610), revealed as the Bee (species 14, pro); agent 2 to 0x32838fe90541567BBf77Fa0570661F3c20e2B152 (TBA 0x04e867bF4249FB01937A425f4d7fdE89b176942E), revealed as the Tick (species 4, base); the same ids, owners, species and tiers as on the P1-U3 contract |
| `pnpm assert:state` | 0 | 0 | PASS, MV-S15: 71 values of the v3 set match the intended configuration |

What stayed as it was: the owner's wallets' USDC (770 and 360 USDC) and MON (gas for the mints came from each wallet: 0.0003 and 0.0003 MON); the platform database (agents 1 and 2 keep species 14 and 4 in `platform.agent_runtimes`, their funding addresses, credits and goals); the old contracts (AgentNFT 0x60cacA6dE327331b321E140Ae19AcbCc4188Be6E, the P7-U2 Executor set and the Step 0 factory) stay deployed and unused. Neither agent had an account on the Step 0 factory or a vault, so nothing was moved. The indexer re-projects agents 1 and 2 from the new contract's events (same ids, new token-bound accounts) when the dev stack next starts; the TokenRegistry, the fund set and the allowlists are unchanged.
