import { webEnvironment } from "@alpha-agents/config";
import { notFound } from "next/navigation";
import { ReportPage } from "@/components/report/report-page";

export const metadata = { title: "Research report · Vivarium" };

/** RP-U1: one research cycle's report, for the agent's owner. */
export default async function AgentReportPage({
  params,
}: {
  params: Promise<{ id: string; cycleId: string }>;
}) {
  const { id, cycleId } = await params;
  if (!/^[1-9]\d{0,4}$/.test(id) || !/^cycle-[0-9a-f-]{36}$/.test(cycleId)) notFound();
  return (
    <ReportPage
      environment={webEnvironment(process.env.APP_ENV)}
      agentId={BigInt(id)}
      cycleId={cycleId}
    />
  );
}
