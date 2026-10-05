# @alpha-agents/domain

Core types shared by every service:

- `amounts.ts`: bigint amounts with the scale in the type (`UsdcE6`, `AmountRaw`, `PriceE18`), integer basis points, and `valueUsdcE6`, the one conversion from a token amount to USDC.
- `ids.ts`, `tiers.ts`, `accounts.ts`, `assets.ts`: agent IDs, epochs, action IDs, tiers (base 3 slots, medium 5, pro 8), account kinds, and the USDC and WMON asset enum.
- `modes.ts`: the canonical mode model of FINAL_PLAN 4.12 and its mapping from every earlier vocabulary.
- `species.ts`: the 25 agent species in onchain order, with tier, exact count and image slug (D-178, D-179); AgentNFT's species table must match it.
- `tools.ts`: the canonical tool registry of FINAL_PLAN 4.4.5.
- `intents.ts`: strict swap and rebalance intents (never calldata) and the signable Executor form.
- `reasons.ts`: rejection reason codes with owner-facing messages.
- `records.ts`: record and event schemas, each carrying the environment label.
- `tokenbound.ts`: `tokenboundAccountAddress`, the ERC-6551 address of an agent's account, checked against @tokenbound/sdk and the canonical registry on the fork.
- `address-book.ts`: every external address per environment, with source, status and open question. Only `signingAddress` returns a `VerifiedAddress`, and it refuses unverified entries. `pnpm test:fork` re-checks every verified entry against the local fork.
