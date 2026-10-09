-- Alpha Agents saved query (P3-U9): Monad DEX volume per day.
-- Parameter: days (number of days back, default 30). The platform reads it by name; the agent never writes SQL.
select
  block_date as day,
  sum(amount_usd) as volume_usd,
  count(*) as trades,
  count(distinct tx_from) as traders
from dex.trades
where blockchain = 'monad'
  and block_date >= current_date - interval '{{days}}' day
group by 1
order by 1 desc
