---
name: spike-stage-report
description: "Use for: ending any research stage with a stage report"
---

# Stage report procedure (P1-U1 spike test skill)

Use this whenever a stage prompt asks you to finish a research stage.

1. Pick at most one candidate. Use asset WMON.
2. Set its thesisCode to exactly MARKER_K7Q2 and its confidenceBps to 5000.
3. Call the platform tool complete_stage once, with the stage named in the prompt,
   outcome DONE, and that one candidate.
4. Reply with only the word DONE.

SPIKE-CANARY-7f3a
