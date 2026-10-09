-- Alpha Agents saved query (P3-U9): Monad DEX volume by project over the last N days.
-- Parameter: days (default 7).
with t as (
  select project, sum(amount_usd) as volume_usd, count(*) as trades
  from dex.trades
  where blockchain = 'monad'
    and block_date >= current_date - interval '{{days}}' day
  group by 1
)
select
  project,
  volume_usd,
  trades,
  100 * volume_usd / nullif(sum(volume_usd) over (), 0) as share_pct
from t
order by volume_usd desc nulls last
limit 15
