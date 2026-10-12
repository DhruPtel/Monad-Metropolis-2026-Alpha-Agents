"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  OwnerSkillsEmpty,
  SectionLabel,
  SkillFindings,
  SkillGrid,
  SkillTile,
  SkillUploadForm,
  Skeleton,
  WalletActionStatus,
} from "@alpha-agents/ui";
import { ArrowLeft, Puzzle, Wallet } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { OwnerSkillJson } from "@/api/client";
import { useSkills } from "@/agent/use-skills";
import { useWalletSession } from "@/auth/session";

/**
 * The agent's skills for its owner (SK-U1): the owner's own uploads first,
 * as tiles, then the built-in skills and playbooks; "Upload a skill" opens a
 * small dialog with one input, the skill's folder, and shows the findings
 * when the package is refused; Remove asks once. Owner only: another wallet
 * sees nothing of the owner's uploads.
 */
export function SkillsPage({
  environment,
  agentId,
}: {
  environment: EnvironmentId;
  agentId: bigint;
}) {
  const wallet = useWalletSession();
  const sk = useSkills(agentId);
  const name = `Agent #${agentId.toString()}`;
  const [uploadOpen, setUploadOpen] = useState(false);
  const [removing, setRemoving] = useState<OwnerSkillJson | null>(null);
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
        <Link href={`/agents/${agentId.toString()}/settings`} data-testid="settings-link">
          Settings
        </Link>
      </div>
      <h1 className="text-2xl font-semibold">Skills of {name}</h1>
      <p className="text-sm text-foreground-muted">
        What the agent knows and may do: the built-in skills every agent mounts, and your own, for
        this agent alone. Each is a folder of text, mounted read-only in its sandbox.
      </p>
    </div>
  );

  if (!wallet.ready || !wallet.address)
    return (
      <div className="flex flex-col gap-6" data-testid="skills">
        {header}
        <EmptyState
          icon={Puzzle}
          title="Connect the owner's wallet"
          description="Your own skills are shown to you alone; connect the wallet that owns this agent."
          action={
            <Button onClick={wallet.connect}>
              <Wallet aria-hidden /> Connect wallet
            </Button>
          }
        />
      </div>
    );
  const s = sk.skills;
  if (!s)
    return (
      <div className="flex flex-col gap-6" data-testid="skills">
        {header}
        {sk.error ? (
          <EmptyState icon={Puzzle} title="Could not read the skills" description={sk.error} />
        ) : (
          <div aria-busy="true" aria-label="Loading the skills" className="flex flex-col gap-4">
            <Skeleton className="h-40 w-full" />
          </div>
        )}
      </div>
    );

  const statusLine = (() => {
    const st = sk.status;
    switch (st.state) {
      case "reading":
        return <WalletActionStatus state="checking" text="Reading the folder…" />;
      case "uploading":
        return (
          <WalletActionStatus state="checking" text="Checking the package against every rule…" />
        );
      case "mounted":
        return (
          <WalletActionStatus
            state="confirmed"
            text={
              st.already
                ? `${st.skillId} was already uploaded with this content; it stays mounted.`
                : `${st.skillId} passed every check. It mounts read-only at the agent's next task.`
            }
          />
        );
      case "removed":
        return (
          <WalletActionStatus
            state="confirmed"
            text={`${st.skillId} is removed; it leaves the mount at the agent's next task.`}
          />
        );
      case "error":
        return <WalletActionStatus state="failed" text={st.message} />;
      default:
        return null;
    }
  })();
  const findings =
    sk.status.state === "refused" || sk.status.state === "mounted" ? sk.status.findings : [];

  return (
    <div className="flex flex-col gap-6" data-testid="skills">
      {header}
      <section className="flex flex-col gap-3" aria-label="Your own skills">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionLabel as="h2">Your own skills</SectionLabel>
          {s.owner.length > 0 ? (
            <Button size="sm" onClick={() => setUploadOpen(true)} data-testid="upload-skill">
              Upload a skill
            </Button>
          ) : null}
        </div>
        {s.owner.length === 0 ? (
          <OwnerSkillsEmpty onUpload={() => setUploadOpen(true)} />
        ) : (
          <SkillGrid>
            {s.owner.map((o) => (
              <SkillTile
                key={o.id}
                skill={{ ...o, uploadedAt: o.uploadedAtUtc, warnings: o.warnings.length }}
                actions={
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={sk.busy}
                    onClick={() => setRemoving(o)}
                    data-testid="remove-skill"
                  >
                    Remove
                  </Button>
                }
              />
            ))}
          </SkillGrid>
        )}
        {!uploadOpen && sk.status.state !== "refused" ? statusLine : null}
        {!uploadOpen && sk.status.state === "mounted" && findings.length > 0 ? (
          <SkillFindings blocked={false} findings={findings} />
        ) : null}
      </section>
      <section className="flex flex-col gap-3" aria-label="Built-in skills and playbooks">
        <SectionLabel as="h2">Built in, for every agent</SectionLabel>
        <SkillGrid>
          {s.builtin.map((b) => (
            <SkillTile key={b.id} skill={b} />
          ))}
        </SkillGrid>
      </section>

      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent
          aria-describedby="skill-upload-description"
          className="max-h-svh overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle>Upload a skill</DialogTitle>
            <DialogDescription id="skill-upload-description">
              The skill&apos;s folder, in the skill format: it passes the same checks as the
              built-in skills before it mounts, for this agent alone.
            </DialogDescription>
          </DialogHeader>
          <SkillUploadForm
            files={sk.picked.map((f) => ({ path: f.path, bytes: f.bytes }))}
            onPick={(list) => void sk.pick(list)}
            onUpload={sk.upload}
            onClear={sk.clear}
            disabled={sk.busy}
            status={statusLine}
          />
          {sk.status.state === "refused" ? (
            <SkillFindings blocked findings={sk.status.findings} />
          ) : null}
          {sk.status.state === "mounted" ? (
            <div className="flex flex-col gap-3">
              {findings.length > 0 ? <SkillFindings blocked={false} findings={findings} /> : null}
              <Button
                variant="secondary"
                onClick={() => setUploadOpen(false)}
                data-testid="upload-done"
              >
                Done
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent aria-describedby="skill-remove-description">
          <DialogHeader>
            <DialogTitle>Remove {removing?.name ?? "this skill"}?</DialogTitle>
            <DialogDescription id="skill-remove-description">
              It leaves the agent&apos;s mount at its next task. Its record stays, so uploading the
              same package again brings it back.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              data-testid="confirm-remove-skill"
              onClick={() => {
                if (removing) sk.remove(removing.id);
                setRemoving(null);
              }}
            >
              Remove
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
