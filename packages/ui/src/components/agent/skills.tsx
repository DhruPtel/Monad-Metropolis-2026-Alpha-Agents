import { FileText, FolderUp, Puzzle, ShieldAlert, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

/**
 * The agent's skills (SK-U1): the built-in skills and playbooks every agent
 * mounts, and the owner's own uploads beside them, as tiles about three
 * across; the upload form with one input (a folder or its files); and the
 * findings of a refused upload, each saying in plain words what it means and
 * what to do next. Nothing here reads a file: the page hands the form what
 * the browser read.
 */
export interface SkillTileView {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /** What the model sees in its index. */
  readonly description: string;
  readonly kind: "skill" | "playbook" | "owner";
  readonly contentHash: string;
  readonly tools: readonly string[];
  /** For the owner's own skills: when it was uploaded, as "2026-10-12 07:40 UTC". */
  readonly uploadedAt?: string | null;
  /** For the owner's own skills: warnings the audit raised without blocking. */
  readonly warnings?: number;
}

const KIND_WORDS: Readonly<
  Record<SkillTileView["kind"], { label: string; tone: "neutral" | "detail" | "positive" }>
> = {
  skill: { label: "Built in", tone: "neutral" },
  playbook: { label: "Playbook", tone: "neutral" },
  owner: { label: "Yours", tone: "detail" },
};

const shortHash = (h: string) => h.slice(0, 12);

/** One skill as a tile: its name, kind, version, the model's description, its tools and hash. */
function SkillTile({
  skill,
  actions,
  className,
}: {
  skill: SkillTileView;
  /** For the owner's own skills: the remove button, as the page wires it. */
  actions?: ReactNode;
  className?: string;
}) {
  const kind = KIND_WORDS[skill.kind];
  return (
    <article
      className={cn(
        "flex min-h-40 flex-col gap-2 rounded-lg border border-border bg-surface p-4",
        skill.kind === "owner" && "border-detail/50",
        className,
      )}
      data-testid="skill-tile"
      data-kind={skill.kind}
      data-skill={skill.id}
      aria-label={`${skill.name}, ${kind.label.toLowerCase()}`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <Puzzle aria-hidden className="size-4 shrink-0 text-foreground-muted" />
          <span className="truncate text-sm font-semibold text-foreground">{skill.name}</span>
        </span>
        <Badge tone={kind.tone}>{kind.label}</Badge>
      </div>
      <p className="text-xs text-foreground-muted">{skill.description}</p>
      <dl className="mt-auto grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-2xs text-foreground-muted">
        <dt>Version</dt>
        <dd className="numeric text-foreground">{skill.version}</dd>
        <dt>Content hash</dt>
        <dd className="numeric text-foreground">{shortHash(skill.contentHash)}</dd>
        <dt>Tools</dt>
        <dd className="text-foreground">
          {skill.tools.length === 0 ? "none declared" : `${skill.tools.length} declared`}
        </dd>
        {skill.uploadedAt ? (
          <>
            <dt>Uploaded</dt>
            <dd className="numeric text-foreground">{skill.uploadedAt}</dd>
          </>
        ) : null}
      </dl>
      {skill.warnings ? (
        <p className="flex items-center gap-1 text-2xs text-warning" data-testid="skill-warnings">
          <ShieldAlert aria-hidden className="size-3" />
          {skill.warnings} warning{skill.warnings === 1 ? "" : "s"} from the audit, mounted all the
          same
        </p>
      ) : null}
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </article>
  );
}

/** The tiles, about three across on a desktop, one on a phone. */
function SkillGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn("grid gap-4 sm:grid-cols-2 lg:grid-cols-3", className)}
      data-testid="skill-grid"
    >
      {children}
    </div>
  );
}

export interface SkillFindingView {
  readonly rule: string;
  readonly severity: "block" | "warn";
  readonly path: string;
  readonly message: string;
  /** What the rule means, in plain words. */
  readonly means: string;
  /** What to do next. */
  readonly next: string;
}

/**
 * The findings of a checked upload: each names its rule and the file and
 * line, says what it means and what to do next. Blocking findings first;
 * a package with only warnings is mounted.
 */
function SkillFindings({
  findings,
  blocked,
  className,
}: {
  findings: readonly SkillFindingView[];
  blocked: boolean;
  className?: string;
}) {
  if (findings.length === 0) return null;
  return (
    <section
      className={cn("flex flex-col gap-3", className)}
      data-testid="skill-findings"
      data-blocked={blocked}
      aria-label="Audit findings"
    >
      <p className="flex items-center gap-2 text-sm">
        {blocked ? (
          <ShieldAlert aria-hidden className="size-4 text-negative" />
        ) : (
          <ShieldCheck aria-hidden className="size-4 text-warning" />
        )}
        <span className="font-medium text-foreground">
          {blocked
            ? "The package was refused. Fix each blocking finding and upload it again."
            : "The package passed with warnings, and is mounted. Worth a look:"}
        </span>
      </p>
      <ul className="flex flex-col gap-2">
        {findings.map((f, i) => (
          <li
            key={`${f.rule}-${f.path}-${i}`}
            className={cn(
              "flex flex-col gap-1 rounded-md border p-3 text-sm",
              f.severity === "block" ? "border-negative/50" : "border-warning/50",
            )}
            data-testid="skill-finding"
            data-rule={f.rule}
            data-severity={f.severity}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={f.severity === "block" ? "negative" : "warning"}>
                {f.severity === "block" ? "Blocks" : "Warning"}
              </Badge>
              <span className="numeric text-xs text-foreground-muted">{f.rule}</span>
              <span className="numeric text-xs text-foreground-muted">{f.path}</span>
            </div>
            <p className="text-foreground">{f.message}</p>
            <p className="text-xs text-foreground-muted">{f.means}</p>
            <p className="text-xs text-foreground">
              <span className="text-foreground-muted">Next: </span>
              {f.next}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface ChosenFileView {
  readonly path: string;
  readonly bytes: number;
}

/**
 * The upload form (SK-U1): one input, the skill's folder or its files, then
 * what was picked and the Upload button. The page reads the files and hands
 * them here; the status line shows the upload's outcome.
 */
function SkillUploadForm({
  files,
  onPick,
  onUpload,
  onClear,
  disabled = false,
  status,
  className,
}: {
  /** What the owner picked, as paths relative to the package root. */
  files: readonly ChosenFileView[];
  /** The browser's file list, folder or files; the page turns it into paths and text. */
  onPick: (list: FileList | null) => void;
  onUpload: () => void;
  onClear: () => void;
  disabled?: boolean;
  status?: ReactNode;
  className?: string;
}) {
  const total = files.reduce((s, f) => s + f.bytes, 0);
  const hasManifest = files.some((f) => f.path === "skill.json");
  const hasSkillMd = files.some((f) => f.path === "SKILL.md");
  return (
    <div className={cn("flex flex-col gap-3", className)} data-testid="skill-upload-form">
      <label
        className={cn(
          "flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong bg-surface-raised p-6 text-center",
          "is-hover:border-foreground-subtle",
          disabled && "cursor-not-allowed opacity-50",
        )}
      >
        <FolderUp aria-hidden className="size-6 text-foreground-muted" />
        <span className="text-sm font-medium text-foreground">Choose the skill's folder</span>
        <span className="text-xs text-foreground-muted">
          skill.json and SKILL.md at the top; references, data, examples and evals beside them. Up
          to 2 MB.
        </span>
        <input
          type="file"
          multiple
          // @ts-expect-error webkitdirectory is a browser attribute React does not type
          webkitdirectory=""
          directory=""
          className="sr-only"
          disabled={disabled}
          data-testid="skill-folder-input"
          aria-label="The skill's folder"
          onChange={(e) => onPick(e.currentTarget.files)}
        />
      </label>
      {files.length > 0 ? (
        <div
          className="flex flex-col gap-2 rounded-md border border-border p-3"
          data-testid="chosen-files"
        >
          <p className="flex items-center gap-2 text-sm">
            <FileText aria-hidden className="size-4 text-foreground-muted" />
            <span className="font-medium">
              {files.length} file{files.length === 1 ? "" : "s"}, {(total / 1024).toFixed(1)} KB
            </span>
          </p>
          <ul className="numeric max-h-32 overflow-y-auto text-xs text-foreground-muted">
            {files.map((f) => (
              <li key={f.path}>{f.path}</li>
            ))}
          </ul>
          {!hasManifest || !hasSkillMd ? (
            <p className="text-xs text-negative" data-testid="chosen-files-missing">
              {!hasManifest ? "skill.json is missing. " : ""}
              {!hasSkillMd ? "SKILL.md is missing. " : ""}
              Pick the folder that holds them.
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={disabled || files.length === 0 || !hasManifest || !hasSkillMd}
          onClick={onUpload}
          data-testid="skill-upload"
        >
          Upload and check
        </Button>
        {files.length > 0 ? (
          <Button variant="secondary" disabled={disabled} onClick={onClear}>
            Clear
          </Button>
        ) : null}
      </div>
      {status}
    </div>
  );
}

/** The empty state of the owner's own skills: what an upload is and the button that starts one. */
function OwnerSkillsEmpty({ onUpload, className }: { onUpload: () => void; className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-col items-start gap-2 rounded-lg border border-dashed border-border p-4",
        className,
      )}
      data-testid="owner-skills-empty"
    >
      <p className="text-sm text-foreground-muted">
        None yet. A skill is a folder of text the agent reads: skill.json with its description and
        tools, SKILL.md with the instructions, and notes beside them. It passes the same checks as
        the built-in skills, mounts read-only for this agent alone, and is never shown to anyone
        else.
      </p>
      <Button size="sm" onClick={onUpload} data-testid="upload-skill">
        Upload a skill
      </Button>
    </div>
  );
}

export { OwnerSkillsEmpty, SkillFindings, SkillGrid, SkillTile, SkillUploadForm };
