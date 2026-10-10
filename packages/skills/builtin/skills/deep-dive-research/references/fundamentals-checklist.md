# The fundamentals checklist for a token

Eight items, each with the tool that reaches it and the trap behind it. An item no tool reaches is null in the brief, with the gap named; it is never guessed.

1. **What it does and who uses it.** `lookup_token` for identity, decimals, listings and pools; `read_url` on the official page; `web_search` for an independent description. Trap: a description that is only the project's pitch; a look-alike name.
2. **Fees, revenue and volume trends.** `find_pools` for 24-hour volume per pool; `coinmarketcap_prices` for volume and market cap; `dune_query` for the platform's saved volume queries. Trap: one day's volume read as a trend; wash volume in a single pool; revenue that is mostly incentive tokens.
3. **TVL and its direction.** `defillama_tvl` for the protocol behind the token over 7 and 30 days; `defillama_yields` for where the token earns. Trap: TVL in USD moving with the token's price rather than with deposits.
4. **Holder concentration and liquidity depth.** `get_pool_depth` at this account's leg size; `find_pools` for how many pools carry the liquidity and how old they are; `screen_token` for the look-alike and liquidity checks. Trap: liquidity that one provider can remove; depth quoted at a size the account never trades.
5. **Supply and emissions.** `read_contract` for total supply and the owner's functions; the documentation for the schedule and unlocks. Trap: a small float against a large fully diluted supply; mint powers the owner keeps.
6. **Team, treasury and contract control.** The screen's OWNER_POWERS, UPGRADEABLE and GOPLUS checks; `get_code` for the proxy pattern; `balance` for a public treasury. Trap: powers that passed because the token was reviewed, still worth naming as a risk.
7. **Catalysts and their dates.** `web_search` and `read_url` for announcements with dates; `x_search` for the attention around them. Trap: a catalyst with no date; one already priced in; attention mistaken for the event.
8. **Relative value against similar tokens.** Market cap, volume and TVL ratios against two or three comparable tokens from `list_tokens` or `coinmarketcap_prices`. Trap: peers that are not comparable; a ratio quoted without saying what it rests on.

The weight the evidence can carry: a thesis under a Conservative goal needs items 1, 3, 4 and 6 strong and a price feed; under Balanced a clear answer to items 1, 2 and 8; under Aggressive items 4 and 6 at least, a near horizon and an exit plan the kill criterion states.
