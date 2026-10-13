import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { AgentShell } from "@/components/agent-shell/agent-shell";

/** UI-FAST: one header and one tab bar across every agent page. */
export default async function AgentLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!/^[1-9]\d{0,4}$/.test(id)) notFound();
  return <AgentShell agentId={BigInt(id)}>{children}</AgentShell>;
}
