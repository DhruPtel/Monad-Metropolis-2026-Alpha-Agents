# apps/console

The local-only dev console (P0-U4). See "Dev console" in the root README.

- `next.config.ts`: reads the root `.env` and refuses to start or build unless `APP_ENV` is local.
- `src/proxy.ts`: answers only requests addressed to 127.0.0.1 or localhost.
- `src/app`: one route per panel (environment, fork controls, test funds, address book, policy sandbox, agents). State-changing work happens in server actions over `@alpha-agents/devenv`, whose calls run the local-fork guard first.
- `src/app/agents/extension.ts`: the extension points later units implement to list, reset and trigger agents.
- `e2e`: screenshot and accessibility tests of every page, plus `live.spec.ts` for the running stack.
