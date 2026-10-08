/**
 * Upstream text the model may see (P3-U2 acceptance 6): names and symbols
 * from a provider are stripped of control, zero-width and bidirectional
 * characters, collapsed to single spaces and capped, so no upstream string
 * reaches the model unbounded.
 */
// Control characters are exactly what this pattern exists to remove.
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

export function cleanText(raw: unknown, max = 48): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  if (t === "") return null;
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}
