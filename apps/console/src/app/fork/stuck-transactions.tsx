"use client";

import type { AccountNonceReport } from "@alpha-agents/devenv";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@alpha-agents/ui";
import { useState, useTransition } from "react";
import type { ActionResult } from "@/lib/action-result";
import { alignNonceAction, dropQueuedAction, nonceReportAction } from "./actions";

/**
 * P2-U1 step 0: transactions a wallet sent with a nonce the fork does not
 * expect, as happens after a fork reset, sit in anvil's queue forever. This
 * card shows an account's fork nonce and queued transactions, and offers the
 * two fixes from the fork's side: drop them, or move the account's nonce to
 * the one its wallet sends next. The real fix is in the wallet (reset its
 * activity for the local fork network). Local fork only, like every action
 * on this page.
 */
export function StuckTransactions() {
  const [address, setAddress] = useState("");
  const [nonce, setNonce] = useState("");
  const [report, setReport] = useState<AccountNonceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = (action: () => Promise<ActionResult<AccountNonceReport>>, done?: string) =>
    start(async () => {
      const r = await action();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setError(null);
      setReport(r.value);
      if (r.value.suggestedNonce !== null) setNonce(String(r.value.suggestedNonce));
      if (done) toast.success(done);
    });

  return (
    <Card data-testid="stuck-transactions">
      <CardHeader>
        <CardTitle>Stuck transactions</CardTitle>
        <CardDescription>
          After a fork reset a wallet can send nonces ahead of the fork&apos;s, and anvil queues
          them forever. Reset the wallet&apos;s activity for the local fork network to fix it for
          good; from here you can drop the queued transactions, or move the account&apos;s nonce to
          the one its wallet sends next.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error ? (
          <p
            role="alert"
            data-testid="stuck-error"
            className="rounded-md border border-negative bg-negative-surface px-4 py-3 text-sm text-negative"
          >
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Account" className="min-w-0 flex-1 basis-72">
            {(control) => (
              <Input
                {...control}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="0x..."
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </Field>
          <Button
            size="sm"
            variant="secondary"
            disabled={pending || address.trim() === ""}
            onClick={() => run(() => nonceReportAction(address))}
          >
            Check
          </Button>
        </div>
        {report ? (
          <div className="flex flex-col gap-3" data-testid="nonce-report">
            <p role="status" className="text-sm text-foreground" data-testid="nonce-summary">
              The fork expects nonce {report.forkNonce}.{" "}
              {report.queued.length === 0
                ? "Nothing is queued for this account."
                : `${report.queued.length} queued: the wallet is ahead of the fork.`}
            </p>
            {report.queued.length > 0 ? (
              <Table label="Queued transactions">
                <TableHeader>
                  <TableRow>
                    <TableHead>Nonce</TableHead>
                    <TableHead>Hash</TableHead>
                    <TableHead>To</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.queued.map((q) => (
                    <TableRow key={q.hash || q.nonce}>
                      <TableCell className="numeric">{q.nonce}</TableCell>
                      <TableCell className="numeric break-all">{q.hash}</TableCell>
                      <TableCell className="numeric break-all">
                        {q.to ?? "contract creation"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : null}
            <div className="flex flex-wrap items-end gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={pending || report.queued.length === 0}
                onClick={() =>
                  run(() => dropQueuedAction(report.address), "Dropped the queued transactions")
                }
              >
                Drop queued transactions
              </Button>
              <Field label="Nonce to align to" className="w-40">
                {(control) => (
                  <Input
                    {...control}
                    inputMode="numeric"
                    value={nonce}
                    onChange={(e) => setNonce(e.target.value)}
                  />
                )}
              </Field>
              <Button
                size="sm"
                variant="secondary"
                disabled={pending || !/^\d{1,7}$/.test(nonce)}
                onClick={() =>
                  run(
                    () => alignNonceAction(report.address, Number(nonce)),
                    `The fork now expects nonce ${nonce}`,
                  )
                }
              >
                Align nonce
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
