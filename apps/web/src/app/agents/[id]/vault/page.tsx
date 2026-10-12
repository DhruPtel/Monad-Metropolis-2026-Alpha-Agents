import { webEnvironment } from "@alpha-agents/config";
import { notFound } from "next/navigation";
import { VaultPage } from "@/components/vault/vault-page";

export const metadata = { title: "Vault · Alpha Agents" };

/** One agent's vault (P7-U4): public, with the connected wallet's own position; reached from the portfolio. */
export default async function AgentVaultPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[1-9]\d{0,4}$/.test(id)) notFound();
  return <VaultPage environment={webEnvironment(process.env.APP_ENV)} agentId={BigInt(id)} />;
}
