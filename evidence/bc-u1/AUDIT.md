# BC-U1: the beta completeness audit (2026-10-12)

Against FINAL_PLAN 0.10's definition of done and the owner's beta scope of the four-unit session (the marketplace, the creator portal, skills as NFTs, x402, the profile page, the Gallery and the community feed stay after the beta). "Working" means built, tested and exercised end to end on the local fork by its unit's live check or playtest; "partial" names what is missing inside the beta scope; "missing" means nothing is built. The unit column is where the evidence lives (LOGS.md).

## The definition of done, item by item

| # | A tester can | State | Where | Note |
| --- | --- | --- | --- | --- |
| 1 | Connect a wallet and mint an agent, free apart from gas | working | P1-U2, P1-U3, P1-U10, P1-U11, NFT-U1 | Two mints per wallet since NFT-U1; the real art on the mint page and the portal; the live spec mints through the API claim on a fork |
| 2 | Fund credits at the funding address and see the balance and per-call spend | working | P1-U6, P1-U7, P1-U9, UI-U1 | The credits tile, Add credits in a dialog, spend and activity on My Agents |
| 3 | Set an aggressiveness goal and deposit into the agent's account | working | F-U7, F-U3, F-U11, UI-U1 | The guided setup flow on the portfolio; deposits and withdrawals in dialogs on the v3 account |
| 4 | Turn on automatic trading, watch the sweep research, screen, build and approve a target portfolio, and watch the agent trade within the limits through Executor v3 | working | F-U5 to F-U10, F-U12, F-T2 | The activation sweep with the step panel, the plan card, the runner's capped legs; the live activation check and the live Aggressive sweep |
| 5 | Open the portfolio window: asset makeup, performance from the snapshots, scores, "$100 at the start" against USDC | working | F-U11 | The window page; UI-U2 re-shapes it as tiles |
| 6 | Watch the agent keep researching and trading, and the sentinel tighten on a stale feed or a drawdown | working | P3-U10, P4-U2 | The research loop, the watcher's triggers, the sentinel's conditions with their fork tests |
| 7 | Put money in a vault of class F tokens and withdraw both ways, redeemInKind included | working | P7-U1 to P7-U4 | The vault page with deposits, USDC and in-kind exits; the vault live run with 23 checks |
| 8 | Read the profile and the Gallery, and the community feed | after the beta | D-371 | Out of the beta scope by the owner's decision; the coming-later page stands in |
| 9 | Upload their own skill package, see it pass the checks and mount read-only, never shown to others | working | SK-U1 | BC-U1 adds creating a skill in the app from a template, with the same checks live while typing |
| 10 | Add their own Dune API key, sealed, used only by their agent through the tool servers, metered apart | working | BK-U1 | BC-U1 adds X and CoinMarketCap on the same mechanism |
| optional | Class A tokens through the price attestor | working | F-U12, F-T2 | Required since D-370 |
| optional | A reveal that feels like opening a rare pull | planned | UI-U2 | RV-U1's scope, built next in this session |

## Every unit of the beta's build order (BUILD_PLAN 4.0.1)

| Row | Unit | State | Open inside the beta scope |
| --- | --- | --- | --- |
| 1 to 5 | F-U5 to F-U9 | done | none |
| 6, 7 | F-U10, F-U11 | done | the window's long tiles (UI-U2) |
| 8, 9 | P3-U10, P4-U2 | done | none |
| 10 to 13 | P7-U1 to P7-U4 | done | the console's Trades setup text said 30 days for vaults (closed here); the console's Arm had no account choice (closed here) |
| 14 to 16 | P5-U1, P7-U7, CF-U1 | after the beta | by D-371 |
| 17 | SK-U1 | done | a running sandbox and a changed skill set: the page now says a change joins the next task (closed here); creating a skill in the app (closed here) |
| 18 | BK-U1 | done | X and CoinMarketCap on the owner's key (closed here); the sources page naming the owners' use (closed here) |
| 19, F-T2 | F-U12, F-T2 | done | none |
| 20a | NFT-U1 | done | none |
| 20 | RV-U1 | next | UI-U2 |
| 21 to 24 | F-U13, W-1, PB-U1, PB-U2 | not started | F-U13 is the fourth unit of this session; W-1, PB-U1 and PB-U2 need the owner's accounts and funds (listed at the end of the session) |

## The tool registry

Live and resolved to a tool on its server: 30 of 54 IDs (chain 11, data 14, platform 5), the registry check passing. The 24 deferred IDs, each with the unit that builds it, and whether it belongs to the beta scope:

| IDs | Deferred to | In the beta scope? |
| --- | --- | --- |
| chain.whoami, get_assets, simulate_rebalance, list_intents, cancel_intent, propose_rebalance | W-2, the Pass 2 tools (after the submission) | no: the beta's agent trades through propose_swap and the runner's target portfolio |
| data.wallet_portfolio, wallet_positions, wallet_pnl, holders | W-2, the provider of Q-24 | no |
| data.hypersync_events, data.ohlcv | after PB-U2 | no |
| data.unlocks | after the beta (D-302) | no |
| platform.update_thesis, list_theses, get_thesis | P3-U5, the Thesis Board, cut from the beta (D-160) | no |
| platform.propose_strategy_update, no_change, check_strategy_params | W-2: superseded for the beta by F-U9's proposal in complete_stage's decision and by the orchestrator's own Test stage (D-282, F-U6); the stale "P3-U6" reasons were corrected in BC-U1 | no: their purpose is served |
| platform.directory_search, list_offers, send_message, buy_signal_access, read_signal_feed | Phase 5, agent to agent | no: the community feed and x402 are after the beta |

Every live data tool has its source configured on this machine by variable name alone (X, CoinMarketCap and Tavily present; Dune on the owner's key only, as designed), apart from GoPlus, which the screen treats as a second opinion and goes without.

## Gaps found and what BC-U1 did with them

| Gap | Inside the beta scope? | Done in BC-U1 |
| --- | --- | --- |
| The console's Arm registered the personal account's grant only | yes | A "Manage" choice beside Arm: the personal account (30 days) or the vault (no fixed expiry), posted to the orchestrator's arm route; the toast names the account |
| The console's Trades setup text said the grant lasts 30 days, also for a vault | yes | Both setup cards say 30 days on a personal account and no fixed expiry on a vault |
| A running sandbox keeps the skill set it booted with, and the page did not say so | yes | The skills route reports a running task; the page shows a notice and says a change joins the next task |
| The sources page did not show when calls ran on an owner's key beside the platform's caps | yes | The orchestrator counts the day's owner-paid calls; the page says how many, beside the caps |
| X and CoinMarketCap stayed on the platform's keys | yes | Both on the owner's own key through the same store, route, tool-server path, metering and settings tiles as Dune |
| Creating a skill without a folder | yes (the owner's item 3) | The in-app editor from two templates, checked live through a new check route, saved through the upload route |
| Three registry deferrals named a unit that no longer exists (P3-U6) | yes | The reasons now say what supersedes them |
| The window page's long tiles, the console's Agents page layout, the reveal moment | yes, UI-U2's | left for UI-U2 |
| The vault UI's remaining pieces (the lockup setting, the fee proposal, the handover acceptance, W-6), the reduce-only handover exception, the parity fixture's vault case | no: W-6 and the sale flow are after the beta | recorded as suggestions |
| The frozen IPFS images, KMS, the Safe multisig, mainnet funds | PB-U1 and W-1 | listed for the owner at the end of the session |
