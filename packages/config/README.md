# @alpha-agents/config

Environment IDs and the configuration loader every service uses at startup. See "Environments and configuration" in the root README.

- `src/environments.ts`: `local`, `testnet` and `beta`, each with its label, chain ID and chain RPC.
- `src/variables.ts`: every environment variable, marked secret or public, with its environments, format, placeholder and first unit. `.env.example` is generated from it.
- `src/load.ts`: `loadConfig`, the mainnet signing guard, `assertChainId` and `ConfigError`.
- `src/secret.ts`: `Secret`, which never prints its value.
- `src/summary.ts`: `summarizeConfig`, a log-safe summary.

The package is TypeScript run directly by Node's type stripping, so it uses erasable syntax only and imports with `.ts` extensions.
