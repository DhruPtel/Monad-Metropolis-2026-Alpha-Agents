import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";
import { fieldControl } from "./input";

/**
 * A multi-line text control in the field style (BC-U1): the skill editor's
 * skill.json and SKILL.md. Monospace, so a manifest's braces line up.
 */
function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        fieldControl,
        "h-auto min-h-32 resize-y py-2 font-mono text-xs leading-relaxed",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
