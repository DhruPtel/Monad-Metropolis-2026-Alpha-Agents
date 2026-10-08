# P2-EC part 1: testnet deployment

Monad testnet (chain 10143). Throwaway (D-247, D-249): nothing here carries into the Rehearsal or the beta. Every CREATE2 salt is `keccak256("alpha-agents.p2ec.testnet.<name>.v1")`; no contract sits at a `v1` salt address (`pnpm test:testnet-fork` checks it). Deployed by `pnpm deploy:testnet` on 2026-10-08 starting at block 69,281,563, verified by `pnpm verify:testnet` on Sourcify, which MonadVision reads. The full records are `deployment.json` (every transaction, read from the chain) and `verification.json` (constructor arguments in full, Sourcify's answers).

## Contracts

Code size and code hash were read on testnet after deployment; each code size equals the fork's for the same contract.

| Contract | Address | Block | Creation transaction | Code size (bytes) | Code hash | Constructor arguments | Sourcify |
|---|---|---|---|---|---|---|---|
| TestnetFeed MON/USD | [`0x4F257aD5E3AE49E0934813c23F5940448d20965E`](https://testnet.monadvision.com/address/0x4F257aD5E3AE49E0934813c23F5940448d20965E) | 69281610 | [`0xf73c11c9…`](https://testnet.monadvision.com/tx/0xf73c11c9166637269475dea9ee810d58a305ac802b21a4406e8ad102cd0b2da5) | 2125 | `0xa7086b366328ed77…` | 224 bytes | [exact_match](https://repo.sourcify.dev/10143/0x4F257aD5E3AE49E0934813c23F5940448d20965E) |
| TestnetFeed USDC/USD | [`0x94f797988a94c86dF85bC457027eDF7b4673fD9D`](https://testnet.monadvision.com/address/0x94f797988a94c86dF85bC457027eDF7b4673fD9D) | 69281612 | [`0xff249dc0…`](https://testnet.monadvision.com/tx/0xff249dc0d85f701e130c1f6237a3b55f9525ae04f9ffc71638eb6ace52aae5a1) | 2125 | `0xa7086b366328ed77…` | 224 bytes | [exact_match (runtime only)](https://repo.sourcify.dev/10143/0x94f797988a94c86dF85bC457027eDF7b4673fD9D) |
| PoolSeeder | [`0xA4adD8Adbb6C04De71dC313322913b7084a9424A`](https://testnet.monadvision.com/address/0xA4adD8Adbb6C04De71dC313322913b7084a9424A) | 69281621 | [`0x79fb9e21…`](https://testnet.monadvision.com/tx/0x79fb9e2185045237171dfcc223681233bffc261b130f8eadd159b10c66e1c19b) |  | `…` | 64 bytes | [exact_match](https://repo.sourcify.dev/10143/0xA4adD8Adbb6C04De71dC313322913b7084a9424A) |
| AgentNFT | [`0x0c2472Ed555836F22FB3eAB7aBC2Cc3AebeaC9ea`](https://testnet.monadvision.com/address/0x0c2472Ed555836F22FB3eAB7aBC2Cc3AebeaC9ea) | 69281679 | [`0x994f5ffd…`](https://testnet.monadvision.com/tx/0x994f5ffd5626083b2d74cc440d113449b6ca71cef7c29fc8a8db3aa958dc0333) | 34459 | `0xb357594863407c9f…` | 352 bytes | [exact_match](https://repo.sourcify.dev/10143/0x0c2472Ed555836F22FB3eAB7aBC2Cc3AebeaC9ea) |
| OracleAdapter | [`0xa040cAa0529e5dfa48B5d61b78d75967BdBbb647`](https://testnet.monadvision.com/address/0xa040cAa0529e5dfa48B5d61b78d75967BdBbb647) | 69281723 | [`0x37631075…`](https://testnet.monadvision.com/tx/0x37631075976e28b236984a881f7b4422d633268f1296b9903ee406477a6b3b12) | 7076 | `0x82f754adfe5bf9f5…` | 384 bytes | [exact_match](https://repo.sourcify.dev/10143/0xa040cAa0529e5dfa48B5d61b78d75967BdBbb647) |
| Executor | [`0xc127997711a3D26a0967724897BCc365934DeC7c`](https://testnet.monadvision.com/address/0xc127997711a3D26a0967724897BCc365934DeC7c) | 69281727 | [`0xfb5f89c1…`](https://testnet.monadvision.com/tx/0xfb5f89c1526c361147b35f7694f7e1be3a5670a61a9d6c78de54171634e9bba4) | 28590 | `0x95fbbfed08947644…` | 416 bytes | [exact_match](https://repo.sourcify.dev/10143/0xc127997711a3D26a0967724897BCc365934DeC7c) |
| UniswapV4MonUsdcAdapter | [`0xe99aF4DC0E5dF691065D7CC8eb11070BD5B281b1`](https://testnet.monadvision.com/address/0xe99aF4DC0E5dF691065D7CC8eb11070BD5B281b1) | 69281734 | [`0x118b754e…`](https://testnet.monadvision.com/tx/0x118b754e2d91b735928ab3e1898fa10e64a4cce278ac44bcd5b728cbf0d5f57d) | 7589 | `0xbc1c90c8f8691441…` | 160 bytes | [exact_match](https://repo.sourcify.dev/10143/0xe99aF4DC0E5dF691065D7CC8eb11070BD5B281b1) |
| ProtocolRegistry | [`0xddE58ce63f029503804c68B84FF4a1cB81d3081c`](https://testnet.monadvision.com/address/0xddE58ce63f029503804c68B84FF4a1cB81d3081c) | 69281741 | [`0x594e341a…`](https://testnet.monadvision.com/tx/0x594e341abe4c506be29c350cf753dca07ed72e3e4b6f46c2960554d1448d4b9c) | 9211 | `0x303165fb752fe494…` | 384 bytes | [exact_match](https://repo.sourcify.dev/10143/0xddE58ce63f029503804c68B84FF4a1cB81d3081c) |
| AccountFactory | [`0x960c0421c5FEac805187F25D7abc04D971D334B6`](https://testnet.monadvision.com/address/0x960c0421c5FEac805187F25D7abc04D971D334B6) | 69281745 | [`0xea6e63ed…`](https://testnet.monadvision.com/tx/0xea6e63ed0baadbf0db367af9ccd2eef93a87d52251d5a955e15ee826b026affe) | 12557 | `0x8257abfa5c623074…` | 512 bytes | [exact_match](https://repo.sourcify.dev/10143/0x960c0421c5FEac805187F25D7abc04D971D334B6) |
| PersonalAccount implementation | [`0x740D148C9419977f5F7d7965B706b05Ce7Af4376`](https://testnet.monadvision.com/address/0x740D148C9419977f5F7d7965B706b05Ce7Af4376) | 69281745 | [`0xea6e63ed…`](https://testnet.monadvision.com/tx/0xea6e63ed0baadbf0db367af9ccd2eef93a87d52251d5a955e15ee826b026affe) | 23514 | `0xb868a8ed7eaa63fe…` | 96 bytes | [exact_match](https://repo.sourcify.dev/10143/0x740D148C9419977f5F7d7965B706b05Ce7Af4376) |

The PersonalAccount implementation is created by AccountFactory's constructor, so its creation transaction is AccountFactory's. The USDC/USD TestnetFeed has the same runtime code as the MON/USD one, and Sourcify reports its runtime match only.

## Roles

| Role | Address | Key |
|---|---|---|
| Deployer, admin of AgentNFT, AccountFactory, Executor and ProtocolRegistry, AgentNFT treasury, pool seeder owner | `0x5C0Fb609931651357dcfd2b985910E3fC5904A4a` | `TESTNET_DEPLOYER_PRIVATE_KEY` (no Safe on testnet: `TESTNET_ADMIN_SAFE_ADDRESS` unset) |
| Guardian (AccountFactory, Executor, ProtocolRegistry) | `0x5f8D9Bcb4479eED4934d51087DEEe157bac1322e` | `TESTNET_GUARDIAN_PRIVATE_KEY` |
| Sentinel (AccountFactory) | `0x6a1DDe374e166C01CC3d85964Fc7496F9B16D96e` | `TESTNET_SENTINEL_PRIVATE_KEY` |
| AgentNFT claim signer | `0xc82a7CDf5494B9E56E6604263BeBF41Eb5b4C490` | `TESTNET_CLAIM_SIGNER_PRIVATE_KEY` |
| TestnetFeed writer | `0xB501c40e5dDAa3dF9f32B3e04Db9b04fC1f6292a` | `TESTNET_FEED_PRIVATE_KEY` |
| Test owner wallet for the end-to-end run | `0xc7fcA8F663b8a20f8aFcCdd92E031678423AC2c8` | `TESTNET_TEST_WALLET_PRIVATE_KEY` |

AccountFactory's deposit allowlist at deployment: the test wallet and the owner's three playtest wallets (`0x683ee842a16f85e69883f433745263bfe8d55f76`, `0x32838fe90541567bbf77fa0570661f3c20e2b152`, `0xc8821706961bcac0e95441308083644eff444871`).

## Market

| Item | Value |
|---|---|
| Pool | Hookless native MON / Circle testnet USDC, fee 500, tick spacing 10, on the unofficial testnet PoolManager `0x451D64ab3b650040d2aE1886602b97ed6eDc643d` (D-257) |
| Pool ID | `0x40ab892dad820a1b57392a8a6e7c783e108a2285e83d3a6dbf1dd44902a19972` |
| Start price | 1 MON = 1.00 USDC (D-304), sqrtPriceX96 79,228,162,514,264,337,593,543, tick -276,325 |
| Seed | Liquidity 95,902,508,421,861 in ticks -276,420 to -276,220 (about ±1%), about 0.4975 MON and 0.459 USDC, about 96 USDC of virtual depth; trades up to about 0.05 USDC (D-307) |
| Feeds | Both TestnetFeeds answer 1.00 USD with 8 decimals, refreshed on demand (D-307) |
| Quotes | The unofficial deployment's V4Quoter `0x869834d127b230283fe63E0d0A9bEB67216a94C7` (Monad's protocols repository, `testnet/uniswap_v4.jsonc`) |
