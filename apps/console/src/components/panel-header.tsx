import type { ReactNode } from "react";

/** The title block every console panel starts with. */
export function PanelHeader({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex max-w-dialog flex-col gap-1">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-sm text-foreground-muted">{description}</p>
      </div>
      {children}
    </header>
  );
}
