import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CodeBlock,
  SectionLabel,
  StatBar,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@alpha-agents/ui";
import Link from "next/link";
import {
  type AgentCyclesJson,
  type CycleDetailJson,
  type CyclePlan,
  STAGE_LABELS,
  type StageDetail,
  cacheShare,
  callSubject,
  fillBps,
  paidCalls,
  statusTone,
  usdc,
} from "./cycles";

/**
 * The console's research cycle views (P3-U4): what each kind of cycle may cost
 * before it runs, the agent's recent cycles, and one cycle in full, each stage
 * with its model, its caps and cost against its ceiling, its cache reads, its
 * calls, its raw notes (platform-only) and its briefs, refused ones with
 * their reasons. Operators only: the console is local (D-205).
 */
const time = (iso: string | null) => (iso ? iso.replace("T", " ").slice(0, 19) : "None");
const label = (s: { stage: StageDetail["stage"]; themeCode: string | null }) =>
  `${STAGE_LABELS[s.stage]}${s.themeCode ? ` on ${s.themeCode}` : ""}`;

export function PlanCard({ plan }: { plan: CyclePlan }) {
  const title = plan.kind === "ROUTINE" ? "Routine cycle" : "Activation-shaped cycle";
  return (
    <Card data-testid={`plan-${plan.kind.toLowerCase()}`}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <p className="text-sm text-foreground-muted">
          At most <span className="numeric text-foreground">{usdc(plan.maxUsdcE6)}</span>, every
          stage at its ceiling. Each ceiling is reserved before its stage starts.
        </p>
      </CardHeader>
      <CardContent>
        <Table label={`${title}: stages before it runs`} stack>
          <TableHeader>
            <TableRow>
              <TableHead>Stage</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Caps</TableHead>
              <TableHead>Ceiling</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {plan.stages
              .filter((s) => s.count > 0)
              .map((s) => (
                <TableRow key={s.stage}>
                  <TableCell className="font-medium">
                    {STAGE_LABELS[s.stage as StageDetail["stage"]]}
                    {s.count > 1 ? ` (up to ${s.count})` : ""}
                  </TableCell>
                  <TableCell label="Model">{s.model ?? "None (deterministic)"}</TableCell>
                  <TableCell label="Caps" className="numeric">
                    {s.model
                      ? `${s.caps.turns} turns, ${s.caps.paidCalls} paid calls, ${Math.round(s.caps.seconds / 60)} min`
                      : "None"}
                  </TableCell>
                  <TableCell label="Ceiling" className="numeric">
                    {s.model ? usdc(s.ceilingUsdcE6) : "Free"}
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function CyclesTable({
  data,
  selected,
}: {
  data: AgentCyclesJson;
  selected: string | null;
}) {
  return (
    <Table label="Recent cycles" stack>
      <TableHeader>
        <TableRow>
          <TableHead>Started</TableHead>
          <TableHead>Kind</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Stages</TableHead>
          <TableHead>Charged</TableHead>
          <TableHead>Open</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.cycles.map((c) => (
          <TableRow key={c.cycleId} aria-selected={c.cycleId === selected}>
            <TableCell className="numeric">{time(c.startedAt ?? c.createdAt)}</TableCell>
            <TableCell label="Kind">{c.kind.toLowerCase()}</TableCell>
            <TableCell label="Status">
              <span className="flex flex-wrap items-center gap-2">
                <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                {c.stopReason ? (
                  <span className="text-xs text-foreground-muted">{c.stopReason}</span>
                ) : null}
              </span>
            </TableCell>
            <TableCell label="Stages">
              {c.stages.map((s) => STAGE_LABELS[s.stage]).join(", ") || "None yet"}
            </TableCell>
            <TableCell label="Charged" className="numeric">
              {usdc(c.chargedUsdcE6)}
            </TableCell>
            <TableCell label="Open">
              <Button asChild variant="secondary" size="sm">
                <Link href={`/cycles?agent=${data.agentId}&cycle=${c.cycleId}`}>Read</Link>
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function StageCard({ s }: { s: StageDetail }) {
  const model = s.model !== null;
  const test = (s.outcome ?? {}) as { envelope?: unknown; checked?: unknown[] };
  return (
    <Card data-testid={`stage-${s.seq}`}>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>
            {s.seq} · {label(s)}
          </CardTitle>
          <Badge tone={statusTone(s.status)}>{s.status}</Badge>
          {s.stopReason && s.stopReason !== "COMPLETED" ? (
            <Badge tone="detail">{s.stopReason}</Badge>
          ) : null}
        </div>
        <p className="text-sm text-foreground-muted">
          {model ? `Model ${s.model}` : "Deterministic, no model, free"} · started{" "}
          {time(s.startedAt)} · ended {time(s.finishedAt)}
        </p>
        {s.entry ? <p className="text-sm">{s.entry.text}</p> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {model ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatBar
              label="Cost against ceiling"
              value={`${usdc(s.chargedUsdcE6)} of ${usdc(s.ceilingUsdcE6)}`}
              fillBps={fillBps(BigInt(s.chargedUsdcE6), BigInt(s.ceilingUsdcE6))}
            />
            <StatBar
              label="Turns"
              value={`${s.modelCalls} of ${s.caps.turns}`}
              fillBps={fillBps(s.modelCalls, s.caps.turns)}
            />
            <StatBar
              label="Paid data calls"
              value={`${paidCalls(s)} of ${s.caps.paidCalls}`}
              fillBps={fillBps(paidCalls(s), s.caps.paidCalls)}
            />
            <StatBar
              label="Tokens"
              value={`${(s.inputTokens + s.outputTokens).toLocaleString("en-US")} of ${s.caps.tokens.toLocaleString("en-US")}`}
              fillBps={fillBps(s.inputTokens + s.outputTokens, s.caps.tokens)}
            />
          </div>
        ) : null}
        {model ? (
          <p className="text-sm text-foreground-muted">
            Prompt cache: <span className="numeric text-foreground">{cacheShare(s)}</span> of input
            read from cache ({s.cacheReadTokens.toLocaleString("en-US")} tokens). Absorbed by the
            platform above the ceiling:{" "}
            <span className="numeric text-foreground">{usdc(s.absorbedUsdcE6)}</span>.
          </p>
        ) : null}
        {s.record ? (
          <CodeBlock label="Stage record (complete_stage)">
            {JSON.stringify(s.record, null, 2)}
          </CodeBlock>
        ) : null}
        {test.envelope ? (
          <CodeBlock label="The Test's envelope and every proposal it checked">
            {JSON.stringify({ envelope: test.envelope, checked: test.checked ?? [] }, null, 2)}
          </CodeBlock>
        ) : null}
        {s.briefs.length > 0 ? (
          <div className="flex flex-col gap-3">
            <SectionLabel as="h4">Briefs</SectionLabel>
            {s.briefs.map((b) => (
              <div key={b.briefId} className="flex flex-col gap-2">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone={b.status === "accepted" ? "positive" : "negative"}>
                    {b.kind} {b.status}
                  </Badge>
                  <span className="numeric text-xs text-foreground-muted">{time(b.at)}</span>
                </span>
                {b.reasons.length > 0 ? (
                  <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-negative">
                    {b.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                ) : null}
                <CodeBlock label={`${b.kind} brief as written`}>
                  {JSON.stringify(b.body, null, 2)}
                </CodeBlock>
              </div>
            ))}
          </div>
        ) : null}
        {s.notes.map((n) => (
          <CodeBlock key={n.at} label={`Raw notes (platform-only): ${n.title}`}>
            {n.notes}
          </CodeBlock>
        ))}
        {s.toolCalls.length > 0 ? (
          <Table label={`${label(s)}: tool calls`} stack>
            <TableHeader>
              <TableRow>
                <TableHead>Tool</TableHead>
                <TableHead>Asked for</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Charge</TableHead>
                <TableHead>Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {s.toolCalls.map((c) => (
                <TableRow key={c.callId}>
                  <TableCell className="font-medium">{c.tool}</TableCell>
                  <TableCell label="Asked for" className="break-all">
                    {callSubject(c.input)}
                  </TableCell>
                  <TableCell label="Outcome">
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge
                        tone={statusTone(
                          c.status === "succeeded"
                            ? "completed"
                            : c.status === "refused"
                              ? "skipped"
                              : c.status,
                        )}
                      >
                        {c.status}
                      </Badge>
                      {c.errorCode ? (
                        <span className="text-xs text-foreground-muted">{c.errorCode}</span>
                      ) : null}
                      {c.cacheHit ? <Badge tone="detail">From cache</Badge> : null}
                    </span>
                  </TableCell>
                  <TableCell label="Charge" className="numeric">
                    {usdc(c.chargeUsdcE6)}
                  </TableCell>
                  <TableCell label="Result">
                    {c.resultStored ? (c.resultTruncated ? "Stored, cut" : "Stored") : "None"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
        {s.modelCallRecords.length > 0 ? (
          <Table label={`${label(s)}: model calls`} stack>
            <TableHeader>
              <TableRow>
                <TableHead>At</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Input</TableHead>
                <TableHead>Cache read</TableHead>
                <TableHead>Output</TableHead>
                <TableHead>Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {s.modelCallRecords.map((m) => (
                <TableRow key={m.requestId}>
                  <TableCell className="numeric">{time(m.at)}</TableCell>
                  <TableCell label="Model">{m.model}</TableCell>
                  <TableCell label="Input" className="numeric">
                    {m.inputTokens.toLocaleString("en-US")}
                  </TableCell>
                  <TableCell label="Cache read" className="numeric">
                    {m.cacheReadTokens.toLocaleString("en-US")}
                  </TableCell>
                  <TableCell label="Output" className="numeric">
                    {m.outputTokens.toLocaleString("en-US")}
                  </TableCell>
                  <TableCell label="Cost" className="numeric">
                    {m.costUsd.toFixed(6)} USD
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function CycleDetail({ data }: { data: CycleDetailJson }) {
  const c = data.cycle;
  return (
    <section aria-label="Cycle" className="flex flex-col gap-4" data-testid="cycle-detail">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold">
          {c.kind.toLowerCase()} cycle on {c.reasoning}
        </h2>
        <Badge tone={statusTone(c.status)}>{c.status}</Badge>
        {c.stopReason ? <Badge tone="detail">{c.stopReason}</Badge> : null}
      </div>
      <p className="text-sm text-foreground-muted">
        Charged <span className="numeric text-foreground">{usdc(c.chargedUsdcE6)}</span>, absorbed
        by the platform <span className="numeric text-foreground">{usdc(c.absorbedUsdcE6)}</span>.
        Started {time(c.startedAt)}, ended {time(c.finishedAt)}.
      </p>
      {data.stages.map((s) => (
        <StageCard key={s.stageRunId} s={s} />
      ))}
    </section>
  );
}
