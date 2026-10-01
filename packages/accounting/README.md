# @alpha-agents/accounting

Journal and valuation types for the ledger. Journal entries are double entry: lines sum to zero per asset, with signed raw amounts. A valuation is either `fresh`, with NAV equal to the sum of holdings, or `unavailable` with a reason and no NAV, never a stale number. `availableCredits` is balance minus unsettled usage minus reservations, floored at zero.
