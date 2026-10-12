/**
 * The owner's skill upload, as the browser prepares it (SK-U1): the files a
 * folder picker or a file picker gave, read as text, with the shared root
 * folder dropped so the package's paths start at skill.json. Pure where it
 * can be, so the shape is tested without a browser.
 */
export interface PickedFile {
  readonly path: string;
  readonly content: string;
  readonly bytes: number;
}

/** The most the page sends, before the platform's own 2 MB rule (F3). */
export const UPLOAD_MAX_BYTES = 3 * 1024 * 1024;
export const UPLOAD_MAX_FILES = 80;

/** The path the browser gives a picked file: its place in the folder, or its name. */
export function pickedPath(file: { readonly name: string; readonly webkitRelativePath?: string }) {
  const rel =
    file.webkitRelativePath && file.webkitRelativePath.length > 0
      ? file.webkitRelativePath
      : file.name;
  return rel.replaceAll("\\", "/");
}

/** Drops a shared root folder ("my-skill/skill.json" becomes "skill.json"); plain paths stay. */
export function stripSharedRoot<T extends { readonly path: string }>(files: readonly T[]): T[] {
  if (files.length === 0) return [];
  const roots = new Set(files.map((f) => f.path.split("/")[0] ?? ""));
  const topLevel = files.some((f) => !f.path.includes("/"));
  if (topLevel || roots.size !== 1) return [...files];
  return files.map((f) => ({ ...f, path: f.path.slice(f.path.indexOf("/") + 1) }));
}

/** Why a picked set cannot be sent, in the owner's words, or null when it can. */
export function pickProblem(files: readonly PickedFile[]): string | null {
  if (files.length === 0) return "Pick the skill's folder first.";
  if (files.length > UPLOAD_MAX_FILES)
    return `That is ${files.length} files; a skill holds at most ${UPLOAD_MAX_FILES}. Pick the skill's own folder, not a parent.`;
  const bytes = files.reduce((s, f) => s + f.bytes, 0);
  if (bytes > UPLOAD_MAX_BYTES)
    return "The folder is over 3 MB; a skill package is at most 2 MB of text.";
  if (!files.some((f) => f.path === "skill.json")) return "skill.json is missing from the folder.";
  if (!files.some((f) => f.path === "SKILL.md")) return "SKILL.md is missing from the folder.";
  return null;
}

/**
 * Reads a picked list into paths and text. Files the format can never hold
 * (not text) still travel, so the platform names them in its findings rather
 * than the page silently dropping them.
 */
export async function readPicked(list: FileList | null): Promise<PickedFile[]> {
  if (!list) return [];
  const picked: PickedFile[] = [];
  for (const file of Array.from(list).slice(0, UPLOAD_MAX_FILES + 1)) {
    const content = await file.text();
    picked.push({ path: pickedPath(file), content, bytes: file.size });
  }
  return stripSharedRoot(picked).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
