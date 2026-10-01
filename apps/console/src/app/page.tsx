import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@alpha-agents/ui";
import { PanelHeader } from "@/components/panel-header";
import { environmentSnapshot } from "@/lib/environment";

export const dynamic = "force-dynamic";

export default async function EnvironmentPage() {
  const { config, health } = await environmentSnapshot();
  return (
    <div className="flex flex-col gap-8">
      <PanelHeader
        title="Environment"
        description="Health of the local stack and the configuration this console loaded. Secrets appear only as set or not set."
      >
        <Badge tone={health.healthy ? "positive" : "negative"} data-testid="stack-health">
          {health.healthy ? "All services up" : "Something is down"}
        </Badge>
      </PanelHeader>

      <Table label="Service health">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Service</TableHead>
            <TableHead scope="col">Status</TableHead>
            <TableHead scope="col">Detail</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {health.services.map((s) => (
            <TableRow key={s.name}>
              <TableCell className="font-medium capitalize">{s.name}</TableCell>
              <TableCell>
                <Badge tone={s.up ? "positive" : "negative"}>{s.up ? "Up" : "Down"}</Badge>
              </TableCell>
              <TableCell className="numeric text-foreground-muted" data-dynamic>
                {s.detail}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Anvil fork</CardTitle>
            <CardDescription>Monad mainnet forked at the pinned block.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-foreground-muted">Chain ID</dt>
              <dd className="numeric">{health.anvil?.chainId ?? "unavailable"}</dd>
              <dt className="text-foreground-muted">Network</dt>
              <dd className="numeric">{health.anvil?.network ?? "unavailable"}</dd>
              <dt className="text-foreground-muted">Current block</dt>
              <dd className="numeric" data-dynamic>
                {health.anvil?.blockNumber ?? "unavailable"}
              </dd>
              <dt className="text-foreground-muted">Pinned block</dt>
              <dd className="numeric">{health.pinnedBlock ?? "unknown"}</dd>
              <dt className="text-foreground-muted">Block time</dt>
              <dd className="numeric" data-dynamic>
                {health.anvil
                  ? new Date(health.anvil.timestamp * 1000).toISOString()
                  : "unavailable"}
              </dd>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
            <CardDescription>The redacted summary from packages/config.</CardDescription>
          </CardHeader>
          <CardContent>
            {config.ok ? (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm" data-testid="config-summary">
                <dt className="text-foreground-muted">APP_ENV</dt>
                <dd className="numeric">{config.summary.appEnv}</dd>
                <dt className="text-foreground-muted">Environment</dt>
                <dd className="numeric">{config.summary.environment}</dd>
                <dt className="text-foreground-muted">Chain ID</dt>
                <dd className="numeric">{config.summary.chainId}</dd>
                {Object.entries(config.summary.variables).map(([name, value]) => (
                  <div key={name} className="contents">
                    <dt className="numeric text-xs break-all text-foreground-muted">{name}</dt>
                    <dd className="numeric text-xs break-all">{value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-negative">The configuration is invalid:</p>
                <ul className="flex flex-col gap-1 text-sm">
                  {config.issues.map((i) => (
                    <li key={i.variable} className="numeric text-xs">
                      {i.variable} {i.problem}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
