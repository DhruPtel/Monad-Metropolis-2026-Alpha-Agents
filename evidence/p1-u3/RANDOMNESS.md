# P1-U3 randomness research for the AgentNFT reveal

Date: 2026-10-04. Question: which source of randomness assigns each agent's tier and species at reveal (D-180), so that no one can predict the result or reroll it?

## 1. What is available on Monad

| Option | Mainnet (143) | Testnet (10143) | Source |
|---|---|---|---|
| Pyth Entropy (v2) | Deployed at `0xD458261E832415CFd3BAE5E416FdF3230ce6F134`. Verified on the local fork at block 109670000: 357 bytes of code (an ERC-1967 proxy, implementation `0x1235841f8df7b47b2b35c9654a13bb3be57ee9c6`), `getDefaultProvider()` returns `0x52DeaA1c84233F7bb8C8A45baeDE41091c616506`, `getFeeV2()` returns 1.4 MON | Deployed at `0x825c0390f379C631f3Cf11A82a37D20BddF93c07`. A read-only call to the public testnet RPC found 357 bytes of code and default provider `0x6CC14824Ea2918f5De5C2f75A9Da968ad4BD6344`, Pyth's documented testnet provider. Not checked by this project's fork process, so it stays unverified in the address book | Pyth's deployment registry, `contract_manager/src/store/contracts/EvmEntropyContracts.json` in https://github.com/pyth-network/pyth-crosschain (entries `monad` and `monad_testnet`; chain IDs 143 and 10143 from `contract_manager/src/store/chains/EvmChains.json`, last changed 2026-08-28). Pyth's chain list page https://docs.pyth.network/entropy/chainlist loads its table from that registry. Monad's oracle page https://docs.monad.xyz/tooling-and-infra/oracles lists Pyth Entropy as Monad's VRF |
| Chainlink VRF | Not listed | Not listed | https://docs.chain.link/vrf/v2-5/supported-networks has no Monad entry. Monad's oracle page lists Chainlink for data feeds and Data Streams only |
| Supra dVRF | Listed by Monad (no address given for mainnet) | Listed with addresses | https://docs.monad.xyz/tooling-and-infra/oracles. Not pursued, because Pyth is deployed on both networks and already verified on the fork |
| Gelato VRF | Not listed | Listed (no addresses) | https://docs.monad.xyz/tooling-and-infra/oracles |

Note on the testnet address: Monad's oracle page names `0x36825bf3Fbdf5a29E2d5148bfe7Dcf7B5639e320` as Pyth Entropy on testnet. That address has code on testnet, but `getDefaultProvider()` reverts there, so it is not the Entropy v2 contract. Pyth's own registry is the source used.

## 2. Monad's `blockhash` and `prevrandao`

- `blockhash`: Monad enabled EIP-2935 with a block hash buffer (Monad docs changelog, https://docs.monad.xyz/llms-full.txt, "Enable EIP-2935 + blockhash buffer", monad PR #1520), so recent block hashes are readable. Monad's blocks are produced by a leader known in advance from the stake-weighted schedule, and the leader builds the block, so the leader can know or steer a block hash before anyone else.
- `prevrandao`: Monad's "differences from Ethereum" page (https://docs.monad.xyz/developer-essentials/differences) says nothing about it, and no Monad page documents how it is produced. Measured: the header `mixHash` that `PREVRANDAO` returns is non-zero and changes every block on mainnet (blocks 110000000, 110000001 and 110612028 all differ), while Monad's JSON-RPC reference examples show it as zero. With no documented source and no RANDAO-style commitment, it must be treated as chosen by the block's leader.
- Monad's own NFT guide says: "For provably fair mint order and trait reveals, use a verifiable random function (VRF)" (https://docs.monad.xyz/llms-full.txt, section "Randomness (fair mints and reveals)").

Conclusion: neither opcode is fit for the reveal. A leader, or anyone who can choose when their transaction lands, could see or influence the outcome.

## 3. Recommendation: Pyth Entropy v2 with batch reveals

Pyth Entropy is a commit-reveal protocol: the provider commits to a hash chain in advance, the request fixes the user's contribution, and the provider then reveals its value in a callback. The requester cannot know the provider's value, and the provider cannot change it after committing. It is the only verifiable randomness service that is both deployed on Monad mainnet and verified on our fork.

How AgentNFT uses it, so that no minter can predict or reroll:

1. Mint creates an unrevealed agent. The deck (the remaining count of every species) does not change at mint.
2. `requestReveal()` can be called by anyone, normally the platform, once there are unrevealed agents and no request is pending. It pays the Entropy fee and covers every agent minted so far that is not yet revealed: the batch is fixed at request time. Agents minted later go into the next batch.
3. Entropy's callback only stores the random number for the pending request. It cannot revert on our side, so the callback cannot be made to fail.
4. `reveal(maxCount)` can be called by anyone. It applies the stored number to the batch in mint order: each agent draws uniformly from the slots left in the deck, using `keccak256(seed, agentId)`. The outcome is fixed the moment the number is stored, and the order is fixed, so calling it early, late or in chunks changes nothing.
5. Only one request can be pending, and only reveals change the deck, so the deck a batch draws from is fixed when the request is made.
6. If no callback arrives within one hour, anyone can request again for the same batch. The new request ignores the old one, and a late callback for the old request is ignored. A minter gains nothing here, because the provider's value is never published until the callback, and a stored value can never be replaced.

Why the attacks fail:

- **Predict before minting:** the batch's random number is requested after the agent exists and is not known to anyone but the provider until the callback.
- **Delay:** anyone can request and anyone can apply, the minter has no say in either, and timing does not change the result.
- **Cancel:** there is no cancel, no burn, and transfers are disabled until the escrow is set.
- **Let it expire:** expiry only replaces a request whose number was never delivered. Once a number is stored, it is final.

Residual trust: Pyth's default provider (Fortuna) learns a batch's outcome when it sees the request and could withhold the callback, forcing a re-request after an hour. That is a provider collusion risk we accept for the beta, like the price feed trust in D-055. It is not a minter path.

Cost: 1.4 MON per request at the pinned block, whatever the batch size, paid by the caller of `requestReveal`. Mint stays free (D-173).
