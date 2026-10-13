"use client";

import { FilePlus2, LoaderCircle, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Field } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { SkillFindings, type SkillFindingView } from "./skills";

/**
 * The in-app skill editor (BC-U1): an owner starts from a template, edits
 * skill.json, SKILL.md and the template's notes file in plain text areas,
 * sees every format and audit finding as they type (the page checks the
 * text through the platform, debounced), and saves through the same upload
 * path as a folder. Presentational: the page owns the text and the checks.
 */
export interface SkillTemplateView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface SkillEditorFile {
  readonly path: string;
  readonly content: string;
}

export type SkillCheckState =
  /** Nothing typed since the last check, or no check yet. */
  | { readonly state: "idle" }
  | { readonly state: "checking" }
  | { readonly state: "passed"; readonly skillId: string | null; readonly warnings: number }
  | { readonly state: "refused"; readonly blocking: number }
  | { readonly state: "error"; readonly message: string };

function CheckLine({ check }: { check: SkillCheckState }) {
  switch (check.state) {
    case "idle":
      return null;
    case "checking":
      return (
        <p className="flex items-center gap-2 text-xs text-foreground-muted" role="status">
          <LoaderCircle aria-hidden className="size-3 animate-spin" /> Checking against every rule…
        </p>
      );
    case "passed":
      return (
        <p className="flex items-center gap-2 text-xs text-positive" role="status">
          <ShieldCheck aria-hidden className="size-3" />
          {check.skillId ?? "The package"} passes every check
          {check.warnings > 0
            ? `, with ${check.warnings} warning${check.warnings === 1 ? "" : "s"} worth a look`
            : ""}
          . Save mounts it for this agent at its next task.
        </p>
      );
    case "refused":
      return (
        <p className="text-xs text-negative" role="status">
          {check.blocking} finding{check.blocking === 1 ? "" : "s"} block
          {check.blocking === 1 ? "s" : ""} the package. Fix each below; the check runs again as you
          type.
        </p>
      );
    case "error":
      return (
        <p className="text-xs text-negative" role="status">
          {check.message}
        </p>
      );
  }
}

function SkillEditor({
  templates,
  templateId,
  onTemplate,
  files,
  onChange,
  check,
  findings,
  onSave,
  saving = false,
  disabled = false,
  status,
  className,
}: {
  templates: readonly SkillTemplateView[];
  /** The template the text started from; picking another replaces every file. */
  templateId: string;
  onTemplate: (id: string) => void;
  /** The package's files, in the order shown. */
  files: readonly SkillEditorFile[];
  onChange: (path: string, content: string) => void;
  check: SkillCheckState;
  /** The latest check's findings, blocking ones first. */
  findings: readonly SkillFindingView[];
  onSave: () => void;
  saving?: boolean;
  disabled?: boolean;
  /** The save's outcome, as the page's status line. */
  status?: ReactNode;
  className?: string;
}) {
  const canSave = check.state === "passed" && !saving && !disabled;
  return (
    <div className={cn("flex flex-col gap-4", className)} data-testid="skill-editor">
      <fieldset className="flex flex-col gap-2" disabled={disabled || saving}>
        <legend className="text-sm font-medium text-foreground">Start from</legend>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Templates">
          {templates.map((t) => (
            <Button
              key={t.id}
              size="sm"
              variant="secondary"
              aria-pressed={t.id === templateId}
              onClick={() => onTemplate(t.id)}
              data-testid={`skill-template-${t.id}`}
              title={t.description}
            >
              <FilePlus2 aria-hidden /> {t.name}
            </Button>
          ))}
        </div>
        <p className="text-xs text-foreground-muted">
          {templates.find((t) => t.id === templateId)?.description ??
            "Pick a template; the files below are yours to edit."}
        </p>
      </fieldset>
      {files.map((f) => (
        <Field
          key={f.path}
          label={f.path}
          hint={
            f.path === "skill.json"
              ? "The manifest: keep publisher.address as your wallet; the id is the skill's name in the mount."
              : f.path === "SKILL.md"
                ? "What the agent reads: plain instructions, never commands or code."
                : "A reference file SKILL.md points the agent to."
          }
        >
          {(control) => (
            <Textarea
              {...control}
              value={f.content}
              disabled={disabled || saving}
              rows={f.path === "skill.json" ? 14 : 8}
              spellCheck={f.path !== "skill.json"}
              data-testid={`skill-file-${f.path.replace(/[^a-z0-9]+/gi, "-")}`}
              onChange={(e) => onChange(f.path, e.currentTarget.value)}
            />
          )}
        </Field>
      ))}
      <CheckLine check={check} />
      {findings.length > 0 ? (
        <SkillFindings blocked={check.state === "refused"} findings={findings} />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!canSave} loading={saving} onClick={onSave} data-testid="skill-save">
          Save and mount
        </Button>
        {status}
      </div>
    </div>
  );
}

export { SkillEditor };
