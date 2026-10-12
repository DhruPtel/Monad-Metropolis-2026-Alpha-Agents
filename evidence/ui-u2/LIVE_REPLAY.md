# UI-U2: the replay tool on the dev stack

Date: 2026-10-12. The dev stack (`pnpm dev:all`) on the playtest fork, agent #1 (the owner's Bee, pro, goal Standard on research-medium, 28.89 USDC of credits), a real E2B sandbox and the real model through the gate.

## The review cycle replayed

A REVIEW cycle started from the console's route (`POST /v1/agents/1/cycles {"kind":"REVIEW"}`): cycle `cycle-1d2e37d5-20fd-40aa-8f5d-213efdbc382d`, task `6159eac0-0b8e-43c7-a59a-73f9dcff8e6b`.

| Stage | Result |
| --- | --- |
| 1 TEST | completed, deterministic, free |
| 2 ZOOM_OUT `stage-run-e2e022b1-d182-4efc-abfc-45cb3a1da07f` | completed on research-medium, 6 model calls, charged 0.215957 USDC of the 0.60 ceiling; calls get_research_context, get_goals_and_limits, get_portfolio (failed ACCOUNT_NOT_AVAILABLE: the agent has no v3 account on this fork), get_prices, write_research_brief twice (the first RATIONALE refused: it cited get_portfolio, which answered nothing), complete_stage with NO_CHANGE (EVIDENCE_THIN) |

The stage's prompt (3,267 characters, starting "ZOOM_OUT stage of a REVIEW research cycle. Load your Zoom out playbook with skill_view (name aa-playbook-zoom-out)...") and the cycle's SOUL.md (4,566 characters) were stored by the new columns.

## The replay

`GET /v1/stages/<stage>/replay` answered: replayable, the prompt, 7 inputs of which 4 have stored results (the two platform reads and get_prices; get_portfolio has none, having failed), one text to edit (the Zoom out playbook, version 2.3.0, 7,710 characters), no replay yet.

`POST /v1/stages/<stage>/replay` with the playbook's text plus a section "Added for the replay check: Name the single most important risk to the account first, in one sentence, before anything else." Cycle `cycle-30422663-99e4-438a-bb65-fe1566286814`, task `afd0a71a-06a6-4403-a95a-2bcd4e97bf38`, kind REPLAY, replay_of the stage, one override, the SOUL.md equal to the original's except for its own marker.

| Check | Result |
| --- | --- |
| The replay's prompt | equal to the stored prompt, word for word (`stage_runs.prompt` of both rows compared in Postgres) |
| Its one stage | ZOOM_OUT completed on research-medium, 5 model calls, charged 0.185820 USDC of 0.60; its RATIONALE accepted at the first try; NO_CHANGE (EVIDENCE_THIN) again |
| Its tool calls | get_research_context, get_goals_and_limits and get_prices answered from the store (status succeeded, provider `replay`, cache_hit, charge 0); get_portfolio refused `NOT_STORED` with the "Not among the stored inputs of the replayed stage" message (the original call failed, so nothing was stored for it); write_research_brief and complete_stage ran as the stage's own writes (charge 0) |
| Paid | the model calls alone: 5 calls, 0.1487 USD at LiteLLM's cost, 0.185820 USDC charged with the markup; no data tool charge, no upstream call |
| Not done | no activity entry, no proposal, no universe record for the replay |

Time: the review cycle ran about 1 minute 40 seconds after its sandbox booted; the replay about 2 minutes.

## Saving the edit

`POST /v1/stages/<stage>/replay/save` with the edited text: `{"ok":true,"saved":true,"kind":"playbook","version":"1"}`; the same text again: `saved:false, version 1` (never saved twice). The view then shows the playbook as version "2.3.0 +1" with 1 saved version for this agent, and the replay listed with its cost and its edited text's name. The next sandbox of agent #1 mounts the saved text in place of the built-in body (`platform.playbook_overrides`, mounted by `openAgentSandbox` through `playbookOverrides`); other agents keep the built-in text.

## The console's page

`http://127.0.0.1:3001/cycles/replay?stage=<stage>` rendered on the running stack: the stage's prompt, the stored inputs with "Answered from the store" and "Runs again", the Zoom out playbook as editable text with its saved version, Run replay, "Old and new output" with "replay completed" and "with aa-playbook-zoom-out edited", the comparison and the replays list, Save as new version.

## Model spend

The two cycles together: 11 model calls, about 0.25 USD at LiteLLM's cost (0.40 USDC charged to the agent's credits with the markup). The day's spend before this check was 4.468 USD; the gateway's daily budget is 15 USD.
