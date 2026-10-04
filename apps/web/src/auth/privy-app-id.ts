import { variableSpec } from "@alpha-agents/config";

/** Privy app IDs are 25 characters; PrivyProvider throws on anything else. */
const PRIVY_APP_ID_LENGTH = 25;

/**
 * The public Privy app ID, or undefined when it is unset, still the
 * .env.example placeholder, or malformed. Undefined renders the "login is not
 * configured" state instead of failing the build or the page.
 */
export function privyAppId(value: string | undefined): string | undefined {
  const id = value?.trim();
  if (!id || id === variableSpec("PRIVY_APP_ID")?.example) return undefined;
  return id.length === PRIVY_APP_ID_LENGTH ? id : undefined;
}
