"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import {
  Button,
  DataKeyCard,
  DataKeyForm,
  DataKeyGrid,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  SectionLabel,
  Skeleton,
  WalletActionStatus,
} from "@alpha-agents/ui";
import { ArrowLeft, KeyRound, Wallet } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { DataKeyJson } from "@/api/client";
import { useKeys } from "@/agent/use-keys";
import { useWalletSession } from "@/auth/session";

/** "2026-10-12 09:00 UTC" from an ISO time. */
const whenUtc = (iso: string | null) => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : null);

/**
 * The agent's settings for its owner (BK-U1): one tile per paid data source
 * the owner may bring their own key for. Add or replace a key in a small
 * dialog with one input; remove it with one question. The key is never shown
 * again after saving. Owner only.
 */
export function SettingsPage({
  environment,
  agentId,
}: {
  environment: EnvironmentId;
  agentId: bigint;
}) {
  const wallet = useWalletSession();
  const ks = useKeys(agentId);
  const name = `Agent #${agentId.toString()}`;
  const [editing, setEditing] = useState<DataKeyJson | null>(null);
  const [removing, setRemoving] = useState<DataKeyJson | null>(null);
  void environment;

  const header = (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-foreground-muted">
        <Link href="/agents" className="flex items-center gap-1">
          <ArrowLeft aria-hidden className="size-4" /> My Agents
        </Link>
        <Link href={`/agents/${agentId.toString()}/portfolio`} data-testid="portfolio-link">
          Portfolio
        </Link>
        <Link href={`/agents/${agentId.toString()}/skills`} data-testid="skills-link">
          Skills
        </Link>
      </div>
      <h1 className="text-2xl font-semibold">Settings of {name}</h1>
      <p className="text-sm text-foreground-muted">
        Your own keys for paid data sources. A key is stored sealed, used only by the
        platform&apos;s tool servers for this agent, never placed in its sandbox, and never shown
        again.
      </p>
    </div>
  );

  if (!wallet.ready || !wallet.address)
    return (
      <div className="flex flex-col gap-6" data-testid="settings">
        {header}
        <EmptyState
          icon={KeyRound}
          title="Connect the owner's wallet"
          description="Settings are shown to the owner alone; connect the wallet that owns this agent."
          action={
            <Button onClick={wallet.connect}>
              <Wallet aria-hidden /> Connect wallet
            </Button>
          }
        />
      </div>
    );
  const k = ks.keys;
  if (!k)
    return (
      <div className="flex flex-col gap-6" data-testid="settings">
        {header}
        {ks.error ? (
          <EmptyState icon={KeyRound} title="Could not read the settings" description={ks.error} />
        ) : (
          <div aria-busy="true" aria-label="Loading the settings" className="flex flex-col gap-4">
            <Skeleton className="h-40 w-full" />
          </div>
        )}
      </div>
    );

  const statusLine = (() => {
    const st = ks.status;
    switch (st.state) {
      case "saving":
        return <WalletActionStatus state="checking" text="Sealing and storing the key…" />;
      case "saved":
        return (
          <WalletActionStatus
            state="confirmed"
            text={`Saved as ${st.hint}. The key is never shown again; the agent's next task uses it.`}
          />
        );
      case "removed":
        return (
          <WalletActionStatus
            state="confirmed"
            text="Removed. Nothing of the key stays; the source answers that it is not configured from the agent's next call."
          />
        );
      case "error":
        return <WalletActionStatus state="failed" text={st.message} />;
      default:
        return null;
    }
  })();
  const view = (d: DataKeyJson) => ({ ...d, addedAt: whenUtc(d.addedAt) });

  return (
    <div className="flex flex-col gap-6" data-testid="settings">
      {header}
      <section className="flex flex-col gap-3" aria-label="Data keys">
        <SectionLabel as="h2">Data keys</SectionLabel>
        {!k.available ? (
          <p className="text-sm text-foreground-muted" data-testid="keys-unavailable">
            The platform cannot take keys here right now.
          </p>
        ) : null}
        <DataKeyGrid>
          {k.keys.map((d) => (
            <DataKeyCard
              key={d.provider}
              source={view(d)}
              actions={
                <>
                  <Button
                    size="sm"
                    disabled={!k.available || ks.busy}
                    onClick={() => {
                      ks.reset();
                      setEditing(d);
                    }}
                    data-testid={d.present ? "replace-key" : "add-key"}
                  >
                    {d.present ? "Replace key" : "Add key"}
                  </Button>
                  {d.present ? (
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={ks.busy}
                      onClick={() => setRemoving(d)}
                      data-testid="remove-key"
                    >
                      Remove key
                    </Button>
                  ) : null}
                </>
              }
            />
          ))}
        </DataKeyGrid>
        {!editing ? statusLine : null}
      </section>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null);
            ks.reset();
          }
        }}
      >
        <DialogContent aria-describedby="data-key-description">
          <DialogHeader>
            <DialogTitle>
              {editing?.present ? "Replace" : "Add"} your {editing?.label ?? ""} key
            </DialogTitle>
            <DialogDescription id="data-key-description">{editing?.gives ?? ""}</DialogDescription>
          </DialogHeader>
          {editing ? (
            <DataKeyForm
              source={view(editing)}
              value={ks.draft}
              onChange={ks.setDraft}
              onSave={() => ks.save(editing.provider)}
              problem={ks.problem}
              disabled={ks.busy}
              status={statusLine}
            />
          ) : null}
          {ks.status.state === "saved" ? (
            <Button
              variant="secondary"
              onClick={() => {
                setEditing(null);
                ks.reset();
              }}
              data-testid="key-done"
            >
              Done
            </Button>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent aria-describedby="remove-key-description">
          <DialogHeader>
            <DialogTitle>Remove your {removing?.label ?? ""} key?</DialogTitle>
            <DialogDescription id="remove-key-description">
              Nothing of it stays on the platform. The agent&apos;s {removing?.tool ?? ""} tool
              answers that it is not configured from its next call.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              data-testid="confirm-remove-key"
              onClick={() => {
                if (removing) ks.remove(removing.provider);
                setRemoving(null);
              }}
            >
              Remove key
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
