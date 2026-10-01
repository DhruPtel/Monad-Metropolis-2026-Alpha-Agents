import { ENVIRONMENT_IDS, type EnvironmentId } from "./environments.ts";
import { VARIABLES } from "./variables.ts";

function scope(environments: readonly EnvironmentId[]): string {
  return environments.length === ENVIRONMENT_IDS.length ? "all" : environments.join(", ");
}

/**
 * Renders .env.example from the variable registry, so the template and the
 * loader cannot drift. `pnpm run env:example` writes it; a test checks the
 * committed file matches.
 */
export function renderEnvExample(): string {
  const lines = [
    "# Alpha Agents environment template. Generated from packages/config/src/variables.ts",
    "# by `pnpm run env:example`; edit the registry, not this file.",
    "#",
    "# Copy to .env and fill in only what the units you run need. .env is gitignored;",
    "# never commit real values. A value left as its placeholder counts as not set.",
    "# Commented lines show real defaults. Each comment gives: what it is [secret or",
    "# public; environments that read it; unit that first uses it].",
  ];
  let group = "";
  for (const v of VARIABLES) {
    if (v.group !== group) {
      group = v.group;
      lines.push("", `# ---- ${group} ----`);
    }
    const kind = v.secret ? "secret" : "public";
    lines.push(`# ${v.description} [${kind}; ${scope(v.environments)}; ${v.firstUsedBy}]`);
    lines.push(`${"commented" in v && v.commented ? "# " : ""}${v.name}=${v.example}`);
  }
  return `${lines.join("\n")}\n`;
}
