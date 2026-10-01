# Unit prompt template

From `Planv2/BUILD_PLAN.md` section 1. Copy this file to `Planv2/units/<unit ID>-<short-name>.md` (for example `P1-U3-agentnft.md`) and fill in every heading. Every prompt ends with the same two lines under WHEN DONE.

```
UNIT: <unit ID> <name>

GOAL
<One or two sentences on what this unit delivers and why.>

READ FIRST
LESSONS.md, Planv2/DECISIONS_AND_OPEN_QUESTIONS.md, and the Planv2/FINAL_PLAN.md sections this unit touches: <sections>.

DEPENDS ON
<Unit IDs that must be done first, or "Nothing.">

IN SCOPE
1. <Item.>

OUT OF SCOPE
<What this unit must not build, and which unit builds it instead.>

DELIVERABLES
<Files, contracts, services or pages this unit produces.>

ACCEPTANCE TESTS
- <A check that passes or fails.>

HOW THE OWNER TESTS IT
1. <A step the owner runs by hand.>

WHEN DONE
Add a LOGS.md entry.
Add a LESSONS.md entry for every bug fixed.
```
