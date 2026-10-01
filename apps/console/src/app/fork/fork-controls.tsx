"use client";

import type { ForkClock } from "@alpha-agents/devenv";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  EmptyState,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@alpha-agents/ui";
import { Camera } from "lucide-react";
import { useState, useTransition } from "react";
import type { ActionResult } from "@/lib/action-result";
import {
  advanceTimeAction,
  mineAction,
  readClock,
  resetAction,
  revertAction,
  snapshotAction,
} from "./actions";

interface Snapshot {
  readonly id: string;
  readonly clock: ForkClock;
}

export const TIME_STEPS = [
  { value: "3600", label: "1 hour" },
  { value: "86400", label: "1 day" },
  { value: "604800", label: "7 days" },
  { value: "2592000", label: "30 days" },
] as const;

const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace(".000Z", "Z");

/** A confirm dialog for a destructive action. */
function ConfirmButton({
  label,
  title,
  description,
  onConfirm,
  disabled,
  variant = "danger",
}: {
  label: string;
  title: string;
  description: string;
  onConfirm: () => void;
  disabled: boolean;
  variant?: "danger" | "secondary";
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant={variant} size="sm" disabled={disabled}>
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <DialogClose asChild>
            <Button variant="danger" onClick={onConfirm}>
              {label}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ForkControls({
  initialClock,
  pinnedBlock,
}: {
  initialClock: ForkClock | null;
  pinnedBlock: number;
}) {
  const [clock, setClock] = useState(initialClock);
  const [snapshots, setSnapshots] = useState<readonly Snapshot[]>([]);
  const [blocks, setBlocks] = useState("1");
  const [step, setStep] = useState<string>("86400");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run<T>(
    action: () => Promise<ActionResult<T>>,
    onValue: (value: T) => void,
    success: string,
  ) {
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      onValue(result.value);
      toast.success(success);
    });
  }

  const blockCount = Number(blocks);
  const blocksValid = Number.isSafeInteger(blockCount) && blockCount >= 1 && blockCount <= 10_000;

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <p
          role="alert"
          data-testid="action-error"
          className="rounded-md border border-negative bg-negative-surface px-4 py-3 text-sm text-negative"
        >
          {error}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Fork clock</CardTitle>
          <CardDescription>The latest block on the fork.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
            <dt className="text-foreground-muted">Block</dt>
            <dd className="numeric" data-testid="fork-block" data-dynamic>
              {clock?.blockNumber ?? "unavailable"}
            </dd>
            <dt className="text-foreground-muted">Block time</dt>
            <dd className="numeric" data-testid="fork-time" data-dynamic>
              {clock ? iso(clock.timestamp) : "unavailable"}
            </dd>
            <dt className="text-foreground-muted">Pinned block</dt>
            <dd className="numeric">{pinnedBlock}</dd>
          </dl>
          <div>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => run(readClock, setClock, "Clock refreshed")}
            >
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Snapshots</CardTitle>
            <CardDescription>Reverting drops that snapshot and every later one.</CardDescription>
          </CardHeader>
          <CardContent>
            <div>
              <Button
                size="sm"
                disabled={pending}
                onClick={() =>
                  run(
                    snapshotAction,
                    (s) => {
                      setSnapshots((list) => [...list, s]);
                      setClock(s.clock);
                    },
                    "Snapshot taken",
                  )
                }
              >
                <Camera aria-hidden />
                Take snapshot
              </Button>
            </div>
            {snapshots.length === 0 ? (
              <EmptyState
                icon={Camera}
                title="No snapshots yet"
                description="Take a snapshot before changing the fork, then revert to it."
              />
            ) : (
              <Table label="Snapshots">
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">ID</TableHead>
                    <TableHead scope="col">Block</TableHead>
                    <TableHead scope="col">Time</TableHead>
                    <TableHead scope="col">
                      <span className="sr-only">Action</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {snapshots.map((s, i) => (
                    <TableRow key={s.id}>
                      <TableCell className="numeric">{s.id}</TableCell>
                      <TableCell className="numeric">{s.clock.blockNumber}</TableCell>
                      <TableCell className="numeric text-xs">{iso(s.clock.timestamp)}</TableCell>
                      <TableCell>
                        <ConfirmButton
                          label="Revert"
                          variant="secondary"
                          title={`Revert to snapshot ${s.id}?`}
                          description={`The fork returns to block ${s.clock.blockNumber}. This snapshot and every later one are removed.`}
                          disabled={pending}
                          onConfirm={() =>
                            run(
                              () => revertAction(s.id),
                              (c) => {
                                setClock(c);
                                setSnapshots((list) => list.slice(0, i));
                              },
                              `Reverted to snapshot ${s.id}`,
                            )
                          }
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Mine blocks</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-end gap-3">
                <Field
                  label="Blocks"
                  className="w-32"
                  {...(blocksValid ? {} : { error: "1 to 10,000" })}
                >
                  {(control) => (
                    <Input
                      {...control}
                      inputMode="numeric"
                      value={blocks}
                      onChange={(e) => setBlocks(e.target.value)}
                    />
                  )}
                </Field>
                <Button
                  variant="secondary"
                  disabled={pending || !blocksValid}
                  onClick={() =>
                    run(() => mineAction(blockCount), setClock, `Mined ${blockCount} blocks`)
                  }
                >
                  Mine
                </Button>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Advance time</CardTitle>
              <CardDescription>Moves the clock forward and mines one block.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-end gap-3">
                <Field label="By" className="w-40">
                  {(control) => (
                    <Select value={step} onValueChange={setStep}>
                      <SelectTrigger {...control}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TIME_STEPS.map((t) => (
                          <SelectItem key={t.value} value={t.value}>
                            {t.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </Field>
                <Button
                  variant="secondary"
                  disabled={pending}
                  onClick={() =>
                    run(
                      () => advanceTimeAction(Number(step)),
                      setClock,
                      `Advanced ${TIME_STEPS.find((t) => t.value === step)?.label ?? "time"}`,
                    )
                  }
                >
                  Advance
                </Button>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Reset</CardTitle>
              <CardDescription>
                Back to the pinned block, dropping every change and snapshot.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div>
                <ConfirmButton
                  label="Reset fork"
                  title="Reset the fork to the pinned block?"
                  description={`Every change since block ${pinnedBlock}, including balances and snapshots, is lost.`}
                  disabled={pending}
                  onConfirm={() =>
                    run(
                      resetAction,
                      (c) => {
                        setClock(c);
                        setSnapshots([]);
                      },
                      `Reset to block ${pinnedBlock}`,
                    )
                  }
                />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
