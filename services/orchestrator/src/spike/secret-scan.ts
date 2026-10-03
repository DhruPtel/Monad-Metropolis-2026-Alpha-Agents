import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SecretHit {
  readonly secret: string;
  readonly file: string;
}

/**
 * Scans every file under `dir` for each named secret value and reports which names were found
 * in which files. Values never appear in the result. Secrets shorter than 16 characters are
 * refused, because a short value matches by chance and makes the scan meaningless.
 */
export function scanForSecrets(
  dir: string,
  secrets: Readonly<Record<string, string>>,
): SecretHit[] {
  const needles = Object.entries(secrets).map(([name, value]) => {
    if (value.length < 16) throw new Error(`secret ${name} is too short to scan for`);
    return { name, bytes: Buffer.from(value) };
  });
  const hits: SecretHit[] = [];
  const walk = (path: string) => {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) walk(join(path, entry));
      return;
    }
    if (!stat.isFile()) return;
    const content = readFileSync(path);
    for (const { name, bytes } of needles) {
      if (content.includes(bytes)) hits.push({ secret: name, file: path.slice(dir.length + 1) });
    }
  };
  walk(dir);
  return hits;
}

/** Throws if any secret value appears in the text; used before writing any report to disk. */
export function assertNoSecrets(text: string, secrets: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(secrets)) {
    if (value.length > 0 && text.includes(value)) throw new Error(`report contains secret ${name}`);
  }
}
