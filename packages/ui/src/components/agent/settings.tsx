import { KeyRound, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Field, Input } from "../ui/input";

/**
 * The owner's settings (BK-U1): one tile per paid data source the owner may
 * bring their own key for. A key is stored sealed, used only by the
 * platform's tool servers for this agent, never placed in the sandbox and
 * never shown again: the tile shows its last four characters and when it was
 * added. The form is one input in a small dialog; the page wires the save
 * and the removal.
 */
export interface DataKeyView {
  readonly provider: string;
  readonly label: string;
  /** What the agent gains with the key, in the owner's words. */
  readonly gives: string;
  /** Where the owner gets a key. */
  readonly keyHelp: string;
  /** The tool the key switches on. */
  readonly tool: string;
  /** BC-U1: the platform's own key serves the tool without the owner's (never for Dune). */
  readonly platformKey?: boolean;
  readonly present: boolean;
  /** "••••abcd", or null when none is stored. */
  readonly hint: string | null;
  /** "2026-10-12 09:00 UTC", or null. */
  readonly addedAt: string | null;
}

/** One paid source as a tile: what the key gives, whether one is stored, and the page's actions. */
function DataKeyCard({
  source,
  actions,
  className,
}: {
  source: DataKeyView;
  /** Add key, Replace key, Remove key, as the page wires them. */
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <article
      className={cn(
        "flex min-h-40 flex-col gap-2 rounded-lg border border-border bg-surface p-4",
        source.present && "border-detail/50",
        className,
      )}
      data-testid="data-key-card"
      data-provider={source.provider}
      data-present={source.present}
      aria-label={`${source.label} key`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <KeyRound aria-hidden className="size-4 shrink-0 text-foreground-muted" />
          <span className="truncate text-sm font-semibold text-foreground">{source.label}</span>
        </span>
        <Badge tone={source.present ? "detail" : "neutral"}>
          {source.present ? "Your key" : "No key"}
        </Badge>
      </div>
      <p className="text-xs text-foreground-muted">{source.gives}</p>
      {source.present ? (
        <dl className="mt-auto grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-2xs text-foreground-muted">
          <dt>Key</dt>
          <dd className="numeric text-foreground" data-testid="data-key-hint">
            {source.hint}
          </dd>
          <dt>Added</dt>
          <dd className="numeric text-foreground">{source.addedAt}</dd>
          <dt>Switches on</dt>
          <dd className="numeric text-foreground">{source.tool}</dd>
        </dl>
      ) : (
        <p className="mt-auto text-2xs text-foreground-muted">
          {source.platformKey
            ? `Without a key the agent's ${source.tool} tool runs on the platform's own key and shared daily budget; with yours it runs on your plan, for this agent alone, and charges it nothing.`
            : `Without a key the agent's ${source.tool} tool answers that it is not configured, and nothing else changes.`}
        </p>
      )}
      <p className="flex items-center gap-1 text-2xs text-foreground-muted">
        <ShieldCheck aria-hidden className="size-3" />
        Stored sealed, used only for this agent, never placed in its sandbox, never shown again.
      </p>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </article>
  );
}

/** The tiles, about three across on a desktop. */
function DataKeyGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn("grid gap-4 sm:grid-cols-2 lg:grid-cols-3", className)}
      data-testid="data-key-grid"
    >
      {children}
    </div>
  );
}

/**
 * The form for one key: a single password input, the source's help, and
 * Save. The page keeps the value and clears it the moment the key is saved,
 * so the key is in the browser only while the owner types it.
 */
function DataKeyForm({
  source,
  value,
  onChange,
  onSave,
  problem,
  disabled = false,
  status,
  className,
}: {
  source: DataKeyView;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  /** Why the key cannot be saved as typed, or null. */
  problem: string | null;
  disabled?: boolean;
  status?: ReactNode;
  className?: string;
}) {
  return (
    <form
      className={cn("flex flex-col gap-3", className)}
      data-testid="data-key-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled && !problem) onSave();
      }}
    >
      <Field
        label={`${source.label} API key`}
        hint={source.keyHelp}
        {...(problem ? { error: problem } : {})}
      >
        {(control) => (
          <Input
            {...control}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            data-testid="data-key-input"
          />
        )}
      </Field>
      <p className="text-xs text-foreground-muted">
        After saving you see its last four characters only. To change it, paste a new key; to stop
        using it, remove it.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={disabled || value.length === 0} data-testid="data-key-save">
          {source.present ? "Replace key" : "Save key"}
        </Button>
      </div>
      {status}
    </form>
  );
}

export { DataKeyCard, DataKeyForm, DataKeyGrid };
