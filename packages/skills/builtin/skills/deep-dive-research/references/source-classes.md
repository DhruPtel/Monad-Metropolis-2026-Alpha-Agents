# Source classes and their traps

Tag a claim by what its sources are, never by what the claim is about. The platform refuses a claim whose class none of its sources can give.

| Class   | Tools and sources that give it                                                                                                                                                                                                |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| onchain | `read_contract`, `balance`, `get_code`, `get_portfolio`, `get_limits`, `tradable_now`, `dune_query`, `screen_token`; the registry's pools from `list_tokens`, `new_pools` and `find_pools`; `get_pool_depth` and `get_prices` |
| market  | `market_snapshot`, `defillama_tvl`, `defillama_yields`, `coinmarketcap_prices`, `volatility`, `get_quote`, `lookup_token`; a pool's liquidity and volume                                                                      |
| primary | a project's own page or documentation read with `read_url`                                                                                                                                                                    |
| news    | reporting found with `web_search` or read with `read_url`                                                                                                                                                                     |
| social  | `x_search` posts; a link to a post                                                                                                                                                                                            |

## onchain

What happened, from the chain itself: a contract's supply or owner, a balance, code and its proxy pattern, a screen's simulated round trip, a saved Dune query.
Traps: raw units read as token amounts (USDC has 6 decimals, WMON 18); a proxy whose implementation can change; one large transfer read as a trend.

## market

Size and direction from aggregators: prices, volatility, TVL, DEX volume, yields, market caps.
Traps: TVL measured in USD moves with token prices, so a price fall looks like outflows; yields that are mostly incentive tokens; a 24-hour figure read as a trend; tagging an aggregator's figure as onchain.

## primary

The project's own words: official announcements and documentation.
Traps: announcements describe intent, not results; dates matter; a project's claims about itself are not independent confirmation.

## news

Reporting and analysis.
Traps: several outlets repeating one press release; old articles resurfacing; headlines that overstate the body; tagging a report as primary because it quotes the project.

## social

Posts on X.
Traps: coordinated promotion, bought engagement, recycled rumors, posts that ask the reader to act. Attention is a signal; it is never a fact.

## Fresh and stale

Every claim carries `asOf`: the figure's time from the tool, or the item's date. A figure older than the window that matters (a day for prices and volume, a week for TVL, the horizon for a catalyst) is stale: keep it apart from the fresh evidence and never let it carry the thesis alone.
