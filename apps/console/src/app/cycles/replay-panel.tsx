"use client";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CodeBlock,
  Field,
  SectionLabel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
  Textarea,
  toast,
} from "@alpha-agents/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { STAGE_LABELS, type StageDetail, callSubject, isLive, statusTone, usdc } from "./cycles";
import {
  type ReplayText,
  type ReplayViewJson,
  changedTexts,
  compareStages,
  storedInputSummary,
} from "./replay";
import { saveReplayTextAction, startReplayAction } from "./replay-actions";

/**
 * The replay tool (UI-U2): a stored stage, the texts it ran with (its
 * playbook and the owner's skills) editable in place, "Run replay" to run
 * the stage again on the exact stored inputs with the edited texts mounted,
 * the old and new output side by side with the cost, and "Save as new
 * version" for an edit the owner wants to keep. Only the model call is paid;
 * every tool answers from the store.
 */
const time = (iso: string | null) => (iso ? iso.replace("T", " ").slice(0, 19) : "None");

export function ReplayPanel({
  view,
  original,
  replay,
  selectedReplay,
}: {
  view: ReplayViewJson;
  /** The stored stage in full, from its cycle's detail. */
  original: StageDetail;
  /** The selected replay's stage in full, when one ran. */
  replay: StageDetail | null;
  selectedReplay: Omit<ReplayViewJson["replays"][number], "stage"> | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [edits, setEdits] = useState<Record<string, string>>(
    Object.fromEntries(view.texts.map((t) => [t.name, t.skillMd])),
  );
  const changed = changedTexts(view.texts, edits);
  const live = view.replays.some((r) => isLive(r.cycle.status));
  const stageName = `${STAGE_LABELS[view.stage.stage]}${view.stage.themeCode ? ` on ${view.stage.themeCode}` : ""}`;
  const inputs = storedInputSummary(view.inputs);
  const canRun = view.canStart && view.replayable === null && !live && !pending;

  const run = () =>
    start(async () => {
      const r = await startReplayAction(view.stage.stageRunId, changed);
      if (!r.ok) {
        toast.error("The replay did not start", { description: r.error });
        return;
      }
      toast.success("Replay started", {
        description: "Only the model call is paid; every tool answers from the stored results.",
      });
      router.push(`/cycles/replay?stage=${view.stage.stageRunId}&replay=${r.value.cycleId}`);
    });

  const save = (t: ReplayText) =>
    start(async () => {
      const skillMd = edits[t.name] ?? t.skillMd;
      const r = await saveReplayTextAction(
        view.stage.stageRunId,
        { kind: t.kind, name: t.name, skillMd },
        selectedReplay?.cycle.cycleId ?? null,
      );
      if (!r.ok) {
        toast.error("The text was not saved", { description: r.error });
        return;
      }
      toast.success(
        r.value.saved
          ? `${t.title} saved as version ${r.value.version}`
          : `${t.title} is already at version ${r.value.version}`,
        {
          description:
            t.kind === "playbook"
              ? "This agent mounts it at its next task; other agents keep the built-in text."
              : "The skill's next version mounts at the agent's next task.",
        },
      );
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-6" data-testid="replay-panel">
      <Card data-testid="replay-stage">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>
              {stageName} of agent #{view.agentId}
            </CardTitle>
            <Badge tone={statusTone(view.stage.status)}>{view.stage.status}</Badge>
            <Tag tone="neutral">{view.cycle.kind.toLowerCase()} cycle</Tag>
          </div>
          <CardDescription>
            Ran {time(view.stage.startedAt)} on {view.stage.model ?? "no model"} for{" "}
            {usdc(view.stage.chargedUsdcE6)}. A replay sends the same prompt to the same model under
            the same caps, with your edited text mounted, and answers every tool call from the{" "}
            {inputs.stored} stored result{inputs.stored === 1 ? "" : "s"} below. Nothing is fetched
            or charged but the model call.{" "}
            <Link
              className="underline"
              href={`/cycles?agent=${view.agentId}&cycle=${view.cycle.cycleId}`}
            >
              Back to the cycle
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {view.replayable ? (
            <p className="text-sm text-warning" role="status" data-testid="replay-refused">
              {view.replayable}
            </p>
          ) : null}
          {view.stage.prompt ? (
            <CodeBlock label="The prompt the stage was sent, word for word">
              {view.stage.prompt}
            </CodeBlock>
          ) : null}
          <div className="flex flex-col gap-2">
            <SectionLabel as="h3">Stored inputs the replay answers from</SectionLabel>
            <p className="text-sm text-foreground-muted">
              {inputs.byTool.length === 0
                ? "This stage made no calls with stored results; a replay would have nothing to answer with."
                : `${inputs.byTool.map((b) => `${b.tool} ×${b.count}`).join(", ")}. The stage's own writes (${inputs.writes}) run again as its new output.`}
            </p>
            <Table label="Stored inputs" stack>
              <TableHeader>
                <TableRow>
                  <TableHead>Tool</TableHead>
                  <TableHead>Asked for</TableHead>
                  <TableHead>In a replay</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.inputs.map((i) => (
                  <TableRow key={i.callId}>
                    <TableCell className="font-medium">{i.tool}</TableCell>
                    <TableCell label="Asked for" className="break-all">
                      {callSubject(i.input)}
                    </TableCell>
                    <TableCell label="In a replay">
                      {i.stored ? (
                        <Badge tone="positive">Answered from the store</Badge>
                      ) : i.truncated ? (
                        <Badge tone="warning">Result cut; not answerable</Badge>
                      ) : (
                        <Badge tone="detail">Runs again</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="replay-texts">
        <CardHeader>
          <CardTitle>Edit the text, then run the replay</CardTitle>
          <CardDescription>
            The stage's playbook and each of the owner's skills, as mounted. An edit runs in this
            replay only; it is saved as a new version only when you choose. The frontmatter stays
            the package's own.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {view.texts.map((t) => {
            const edited = (edits[t.name] ?? t.skillMd) !== t.skillMd;
            return (
              <div
                key={t.name}
                className="flex flex-col gap-2"
                data-testid={`replay-text-${t.name}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Tag tone={t.kind === "playbook" ? "accent" : "neutral"}>
                    {t.kind === "playbook" ? "Playbook" : "Owner skill"}
                  </Tag>
                  <span className="text-sm text-foreground-muted">
                    {t.name} · version {t.version}
                    {t.savedVersions > 0 ? ` (${t.savedVersions} saved for this agent)` : ""}
                  </span>
                  {edited ? <Badge tone="warning">Edited</Badge> : null}
                </div>
                <Field label={`${t.title} (SKILL.md)`}>
                  {(control) => (
                    <Textarea
                      {...control}
                      value={edits[t.name] ?? t.skillMd}
                      onChange={(e) => setEdits((s) => ({ ...s, [t.name]: e.target.value }))}
                      rows={12}
                      spellCheck={false}
                    />
                  )}
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!edited || pending}
                    onClick={() => setEdits((s) => ({ ...s, [t.name]: t.skillMd }))}
                  >
                    Reset
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!edited || pending || !view.canStart}
                    onClick={() => save(t)}
                  >
                    Save as new version
                  </Button>
                </div>
              </div>
            );
          })}
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={run} disabled={!canRun} loading={pending} data-testid="run-replay">
              Run replay
            </Button>
            <span className="text-sm text-foreground-muted">
              {live
                ? "A replay is running; this page refreshes itself."
                : changed.length === 0
                  ? "No text changed: the replay reruns the stage as it was, which shows how much the model itself varies."
                  : `${changed.length} text${changed.length === 1 ? "" : "s"} changed. The model call costs at most ${usdc(view.stage.ceilingUsdcE6)}.`}
            </span>
          </div>
        </CardContent>
      </Card>

      <section
        aria-label="Old and new output"
        className="flex flex-col gap-4"
        data-testid="replay-compare"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold">Old and new output</h2>
          {selectedReplay ? (
            <>
              <Badge tone={statusTone(selectedReplay.cycle.status)}>
                replay {selectedReplay.cycle.status}
              </Badge>
              {selectedReplay.overrides.length > 0 ? (
                <Tag tone="accent">
                  with {selectedReplay.overrides.map((o) => o.name).join(", ")} edited
                </Tag>
              ) : (
                <Tag tone="neutral">no text changed</Tag>
              )}
            </>
          ) : (
            <Tag tone="neutral">no replay yet</Tag>
          )}
        </div>
        <Table label="What changed" stack>
          <TableHeader>
            <TableRow>
              <TableHead>What</TableHead>
              <TableHead>Original</TableHead>
              <TableHead>Replay</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {compareStages(original, replay).map((r) => (
              <TableRow key={r.label}>
                <TableCell className="font-medium">{r.label}</TableCell>
                <TableCell label="Original">{r.before}</TableCell>
                <TableCell label="Replay">
                  <span className="flex flex-wrap items-center gap-2">
                    {r.after}
                    {r.changed ? <Badge tone="warning">changed</Badge> : null}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="grid gap-4 lg:grid-cols-2">
          <OutputCard title="Original" s={original} />
          {replay ? (
            <OutputCard title="Replay" s={replay} />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Replay</CardTitle>
                <CardDescription>
                  Nothing to compare yet. Edit a text above, or keep it, and run the replay.
                </CardDescription>
              </CardHeader>
            </Card>
          )}
        </div>
        {view.replays.length > 0 ? (
          <Table label="Replays of this stage" stack>
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Ended</TableHead>
                <TableHead>Edited</TableHead>
                <TableHead>Cost</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.replays.map((r) => (
                <TableRow key={r.cycle.cycleId}>
                  <TableCell className="numeric">{time(r.cycle.createdAt)}</TableCell>
                  <TableCell label="Ended">
                    <Badge tone={statusTone(r.cycle.status)}>{r.cycle.status}</Badge>
                  </TableCell>
                  <TableCell label="Edited">
                    {r.overrides.length === 0
                      ? "nothing"
                      : r.overrides.map((o) => o.name).join(", ")}
                  </TableCell>
                  <TableCell label="Cost" className="numeric">
                    {usdc(r.cycle.chargedUsdcE6)}
                  </TableCell>
                  <TableCell>
                    <Button asChild size="sm" variant="secondary">
                      <Link
                        href={`/cycles/replay?stage=${view.stage.stageRunId}&replay=${r.cycle.cycleId}`}
                        aria-current={
                          selectedReplay?.cycle.cycleId === r.cycle.cycleId ? "page" : undefined
                        }
                      >
                        Compare
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </section>
    </div>
  );
}

/** One run's output: how it ended, its cost, its record, its briefs and its calls. */
function OutputCard({ title, s }: { title: string; s: StageDetail }) {
  return (
    <Card data-testid={`output-${title.toLowerCase()}`}>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>{title}</CardTitle>
          <Badge tone={statusTone(s.status)}>{s.status}</Badge>
          {s.stopReason && s.stopReason !== "COMPLETED" ? (
            <Badge tone="detail">{s.stopReason}</Badge>
          ) : null}
        </div>
        <CardDescription>
          Cost <span className="numeric text-foreground">{usdc(s.chargedUsdcE6)}</span> of at most{" "}
          {usdc(s.ceilingUsdcE6)}; {s.modelCalls} model call{s.modelCalls === 1 ? "" : "s"},{" "}
          {s.toolCalls.length} tool call{s.toolCalls.length === 1 ? "" : "s"}
          {s.toolCalls.some((c) => c.status === "refused")
            ? ` (${s.toolCalls.filter((c) => c.status === "refused").length} refused)`
            : ""}
          . Started {time(s.startedAt)}, ended {time(s.finishedAt)}.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {s.record ? (
          <CodeBlock label={`${title}: stage record`}>
            {JSON.stringify(s.record, null, 2)}
          </CodeBlock>
        ) : (
          <p className="text-sm text-foreground-muted">No stage record.</p>
        )}
        {s.briefs
          .slice()
          .reverse()
          .map((b) => (
            <div key={b.briefId} className="flex flex-col gap-2">
              <Badge tone={b.status === "accepted" ? "positive" : "negative"}>
                {b.kind} {b.status}
              </Badge>
              {b.reasons.length > 0 ? (
                <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-negative">
                  {b.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              ) : null}
              <CodeBlock label={`${title}: ${b.kind} brief`}>
                {JSON.stringify(b.body, null, 2)}
              </CodeBlock>
            </div>
          ))}
        {s.notes.map((n) => (
          <CodeBlock key={n.at} label={`${title}: raw notes, ${n.title}`}>
            {n.notes}
          </CodeBlock>
        ))}
      </CardContent>
    </Card>
  );
}
