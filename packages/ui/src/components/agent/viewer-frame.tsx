import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * The frame around the agent viewer (P1-U11): the prototype's radial
 * background, brass corner marks and mono readouts in the bottom corners, with
 * places for a badge (top left), tools (top right) and an overlay (centre).
 * The 3D canvas or the 2D art goes in `children`.
 */
interface ViewerFrameProps {
  readonly children?: ReactNode;
  readonly badge?: ReactNode;
  readonly tools?: ReactNode;
  /** Centred over the content, for example a mint prompt or a loading note. */
  readonly overlay?: ReactNode;
  readonly readoutLeft?: ReactNode;
  readonly readoutRight?: ReactNode;
  readonly label: string;
  readonly className?: string;
}

function CornerMarks() {
  const corner = "absolute size-2.5 border-detail/60";
  return (
    <>
      <span aria-hidden className={cn(corner, "top-3 left-3 border-t border-l")} />
      <span aria-hidden className={cn(corner, "top-3 right-3 border-t border-r")} />
      <span aria-hidden className={cn(corner, "bottom-3 left-3 border-b border-l")} />
      <span aria-hidden className={cn(corner, "right-3 bottom-3 border-r border-b")} />
    </>
  );
}

function ViewerFrame({
  children,
  badge,
  tools,
  overlay,
  readoutLeft,
  readoutRight,
  label,
  className,
}: ViewerFrameProps) {
  return (
    <section
      aria-label={label}
      data-slot="viewer-frame"
      className={cn(
        "viewer-surface relative isolate h-full min-h-80 w-full overflow-hidden",
        className,
      )}
    >
      <div className="absolute inset-0">{children}</div>
      <div className="pointer-events-none absolute inset-0">
        <CornerMarks />
        {overlay ? (
          <div className="pointer-events-auto absolute inset-0 flex items-center justify-center p-6">
            {overlay}
          </div>
        ) : null}
        {badge ? <div className="pointer-events-auto absolute top-3 left-7">{badge}</div> : null}
        {tools ? <div className="pointer-events-auto absolute top-3 right-7">{tools}</div> : null}
        {readoutLeft ? (
          <span className="absolute bottom-3 left-7 font-mono text-2xs leading-none text-foreground-muted">
            {readoutLeft}
          </span>
        ) : null}
        {readoutRight ? (
          <span className="absolute right-7 bottom-3 font-mono text-2xs leading-none text-foreground-muted">
            {readoutRight}
          </span>
        ) : null}
      </div>
    </section>
  );
}

export { ViewerFrame };
