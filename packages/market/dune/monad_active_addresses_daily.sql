-- Alpha Agents saved query (P3-U9): Monad active sending addresses and transactions per day.
-- Parameter: days (default 30).
select
  block_date as day,
  count(distinct "from") as active_addresses,
  count(*) as transactions
from monad.transactions
where block_date >= current_date - interval '{{days}}' day
group by 1
order by 1 desc
