const REPLACEMENT = "<redacted>";

/**
 * Returns every substring of an RPC URL that could carry a credential: the
 * whole URL, the host (some providers put the key in a subdomain), the path,
 * path segments and query values.
 */
export function secretFragments(rawUrl: string): string[] {
  const trimmed = rawUrl.trim();
  if (trimmed === "") return [];
  const fragments = new Set([trimmed]);
  try {
    const url = new URL(trimmed);
    fragments.add(url.host);
    fragments.add(url.hostname);
    if (url.pathname.length > 1) fragments.add(url.pathname);
    for (const segment of url.pathname.split("/")) {
      if (segment.length >= 4) fragments.add(segment);
    }
    for (const value of url.searchParams.values()) {
      if (value.length >= 4) fragments.add(value);
    }
    if (url.username) fragments.add(url.username);
    if (url.password) fragments.add(url.password);
  } catch {
    // Not a URL; the whole value is still redacted.
  }
  // Longest first, so a fragment never leaves part of a longer one behind.
  return [...fragments].filter((f) => f.length > 0).sort((a, b) => b.length - a.length);
}

/** Replaces every credential-bearing fragment of each secret in text. */
export function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    for (const fragment of secretFragments(secret)) {
      out = out.split(fragment).join(REPLACEMENT);
    }
  }
  return out;
}
