# Alpha Agents: Lessons

One entry for every bug found and fixed, newest at the bottom. Every unit session reads this file first. Append only. Format:

## L-[number]: [short title]
Unit: [unit ID]
What happened: what went wrong and how it showed up.
Cause: the root cause.
Fix: what was changed.
Lesson: one sentence rule to avoid it next time.

## L-1: TypeScript 7 is outside the typescript-eslint peer range
Unit: P0-U1
What happened: `pnpm add -D typescript` installed TypeScript 7.0.2, and pnpm reported unmet peer dependencies across every typescript-eslint package, which accepts only `>=4.8.4 <6.1.0`.
Cause: An unpinned add takes the newest major, and TypeScript 7 (the native port) shipped before typescript-eslint supported it.
Fix: Pinned `typescript` to `~6.0.0` (6.0.3); the install then reported no peer warnings and lint and typecheck passed.
Lesson: After adding any dev tool, read the peer dependency warnings and pin to the newest version every consumer supports, never just the newest version.
