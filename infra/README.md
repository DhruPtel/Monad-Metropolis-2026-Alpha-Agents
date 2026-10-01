# infra

Local and hosted infrastructure.

- `compose.yaml`: local Postgres 16 and Redis 7 for development, with ports bound to 127.0.0.1 only and development-only credentials. Use `pnpm dev:up`, `pnpm dev:status`, `pnpm dev:down` and `pnpm dev:reset` from the repository root rather than calling Docker directly.

Environment templates arrive in P0-U3; deployment configuration arrives with the units that deploy.
