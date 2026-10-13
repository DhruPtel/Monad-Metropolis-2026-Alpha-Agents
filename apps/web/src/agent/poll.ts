/**
 * Schedules a hook's next poll after `ms` (CQ-U1). While the tab is hidden the poll
 * waits and runs as soon as the tab is shown again, so a page left in a background
 * tab stops reading the API and the chain. Returns the cancel for the effect's cleanup.
 */
export function schedulePoll(next: () => void, ms: number): () => void {
  let onShow: (() => void) | null = null;
  const stopWaiting = () => {
    if (onShow) document.removeEventListener("visibilitychange", onShow);
    onShow = null;
  };
  const timer = window.setTimeout(() => {
    if (typeof document === "undefined" || document.visibilityState !== "hidden") {
      next();
      return;
    }
    onShow = () => {
      if (document.visibilityState === "hidden") return;
      stopWaiting();
      next();
    };
    document.addEventListener("visibilitychange", onShow);
  }, ms);
  return () => {
    window.clearTimeout(timer);
    if (typeof document !== "undefined") stopWaiting();
  };
}
