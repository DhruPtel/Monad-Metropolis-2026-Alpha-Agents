-- Alpha Agents saved query (P3-U9): native MON moved to and from labeled exchange addresses per day.
-- Positive netflow_mon means more MON went to exchanges than left them. Parameter: days (default 30).
with cex as (
  select distinct address from cex.addresses where blockchain = 'monad'
),
moves as (
  select
    t.block_date as day,
    case when t."to" in (select address from cex) then t.amount else 0 end as inflow,
    case when t."from" in (select address from cex) then t.amount else 0 end as outflow
  from tokens.transfers t
  where t.blockchain = 'monad'
    and t.token_standard = 'native'
    and t.block_date >= current_date - interval '{{days}}' day
    and (t."to" in (select address from cex) or t."from" in (select address from cex))
)
select
  day,
  sum(inflow) as inflow_mon,
  sum(outflow) as outflow_mon,
  sum(inflow) - sum(outflow) as netflow_mon
from moves
group by 1
order by 1 desc
