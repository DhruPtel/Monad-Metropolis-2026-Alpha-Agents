import type { PageTab } from "@alpha-agents/ui";

/** UI-FAST: the agent pages' tabs, and which one a path is on. */

/** The tab a path belongs to; null for a page that is none of them (the goal form, the window). */
export function activeAgentTab(path: string, agentId: bigint): string | null {
  const base = `/agents/${agentId.toString()}`;
  if (path === base || path === `${base}/`) return "overview";
  const rest = (path.startsWith(`${base}/`) ? path.slice(base.length + 1).split("/")[0] : "") ?? "";
  return ["trading", "research", "vault", "skills", "settings"].includes(rest) ? rest : null;
}

export function agentTabs(agentId: bigint): PageTab[] {
  const base = `/agents/${agentId.toString()}`;
  return [
    { id: "overview", label: "Overview", href: base },
    { id: "trading", label: "Trading", href: `${base}/trading` },
    { id: "research", label: "Research", href: `${base}/research` },
    { id: "vault", label: "Vault", href: `${base}/vault` },
    { id: "skills", label: "Skills", href: `${base}/skills` },
    { id: "settings", label: "Keys", href: `${base}/settings` },
  ];
}
