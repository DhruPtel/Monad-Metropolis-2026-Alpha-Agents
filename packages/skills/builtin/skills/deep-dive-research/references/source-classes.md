# Source classes and their traps

## onchain

What happened, from the chain itself: a contract's supply or owner read with `mcp__chain__read_contract`, a balance, code and its proxy pattern with `mcp__chain__get_code`, or a saved Dune query.
Traps: raw units read as token amounts (USDC has 6 decimals, WMON 18); a proxy whose implementation can change; one large transfer read as a trend.

## market

Size and direction from aggregators: prices, volatility, TVL, DEX volume, yields.
Traps: TVL measured in USD moves with token prices, so a price fall looks like outflows; yields that are mostly incentive tokens; a 24-hour figure read as a trend.

## primary

The project's own words: official announcements and documentation.
Traps: announcements describe intent, not results; dates matter; a project's claims about itself are not independent confirmation.

## news

Reporting and analysis.
Traps: several outlets repeating one press release; old articles resurfacing; headlines that overstate the body.

## social

Posts on X.
Traps: coordinated promotion, bought engagement, recycled rumors, posts that ask the reader to act. Attention is a signal; it is never a fact.
