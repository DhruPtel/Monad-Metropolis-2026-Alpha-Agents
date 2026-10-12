// The incoming art mapping (NFT-U1): which file in the owner's gitignored
// assets-incoming/ folder is each species' 2D image and 3D model, pinned by
// sha256. Read by build-images.ts and build-models.ts; checked by
// incoming.test.ts.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface IncomingFile {
  readonly file: string;
  readonly sha256: string;
}
export interface IncomingModel extends IncomingFile {
  /** Degrees to turn the model about +Y so it faces the camera (+Z), from the visual check. */
  readonly yaw: number;
}
export interface IncomingMap {
  readonly note: string;
  readonly roots: { readonly images: string; readonly models: string };
  readonly images: Readonly<Record<string, IncomingFile>>;
  readonly models: Readonly<Record<string, IncomingModel>>;
  readonly unused: readonly (IncomingFile & { readonly why: string })[];
}

export const REPO_ROOT = new URL("../../", import.meta.url).pathname;
export const INCOMING_MAP_PATH = new URL("./incoming.json", import.meta.url).pathname;

export function readIncomingMap(): IncomingMap {
  return JSON.parse(readFileSync(INCOMING_MAP_PATH, "utf8")) as IncomingMap;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The folder's path, or null when the owner's originals are not on this machine. */
export function incomingRoot(map: IncomingMap, kind: "images" | "models"): string | null {
  const dir = join(REPO_ROOT, map.roots[kind]);
  return existsSync(dir) ? dir : null;
}

/** Reads one source file and refuses one whose hash is not the pinned one. */
export function readPinned(root: string, entry: IncomingFile): Uint8Array {
  const bytes = readFileSync(join(root, entry.file));
  const hash = sha256(bytes);
  if (hash !== entry.sha256) {
    throw new Error(`${entry.file} is not the pinned file (sha256 ${hash.slice(0, 16)}...)`);
  }
  return bytes;
}
