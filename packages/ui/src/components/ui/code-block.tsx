import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

interface CodeBlockProps {
  /** What the block holds, shown above it and read out as its name. */
  label: string;
  /** Preformatted text: raw notes, a JSON record. Long lines wrap; tall blocks scroll. */
  children: ReactNode;
  className?: string;
}

/**
 * A labelled block of preformatted text for operators (P3-U4: a stage's raw
 * notes and its briefs as stored). Lines wrap rather than run off the screen,
 * and a tall block scrolls inside a focusable region, so it can be read with
 * the keyboard.
 */
function CodeBlock({ label, children, className }: CodeBlockProps) {
  return (
    <figure data-slot="code-block" className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <figcaption className="text-xs text-foreground-muted">{label}</figcaption>
      <pre
        tabIndex={0}
        aria-label={label}
        className="max-h-80 overflow-auto rounded-md border bg-surface-overlay p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground outline-none is-focus:focus-ring"
      >
        {children}
      </pre>
    </figure>
  );
}

export { CodeBlock };
