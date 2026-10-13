"use client";

import { type EnvironmentId, ENVIRONMENTS } from "@alpha-agents/config";
import { Button, EmptyState, ResearchReportDocument, Skeleton } from "@alpha-agents/ui";
import { ArrowLeft, Download, PlugZap, Wallet } from "lucide-react";
import Link from "next/link";
import { useCallback } from "react";
import { printReport, reportView } from "@/agent/report-view";
import { useReport } from "@/agent/use-reports";

/**
 * RP-U1: one research cycle's report as a document, for the agent's owner,
 * with Download as PDF: the browser's print, which the print styling makes
 * read like the page (no app header or navigation, paper colours). The
 * document's title names the agent and the cycle, so the PDF is named after it.
 */
export function ReportPage({
  environment,
  agentId,
  cycleId,
}: {
  environment: EnvironmentId;
  agentId: bigint;
  cycleId: string;
}) {
  const { report, error, wallet } = useReport(agentId, cycleId);
  const name = `Agent #${agentId.toString()}`;
  const download = useCallback(() => {
    printReport(window, name, cycleId);
  }, [cycleId, name]);
  const back = (
    <Link
      href={`/agents/${agentId.toString()}/research`}
      className="flex w-fit items-center gap-1 text-sm text-foreground-muted"
      data-print="hide"
    >
      <ArrowLeft aria-hidden className="size-4" /> Research
    </Link>
  );

  if (!wallet.ready && wallet.state !== "wrong-chain")
    return (
      <div className="flex flex-col gap-6">
        {back}
        <EmptyState
          icon={Wallet}
          title="Connect your wallet"
          description="The report opens once you connect the wallet that owns this agent."
          action={
            <Button onClick={wallet.connect}>
              <Wallet aria-hidden /> Connect wallet
            </Button>
          }
        />
      </div>
    );
  if (wallet.state === "wrong-chain")
    return (
      <div className="flex flex-col gap-6">
        {back}
        <EmptyState
          icon={PlugZap}
          title={`Switch to ${ENVIRONMENTS[environment].label}`}
          description="Your wallet is on another network. Switch it to read this report."
          action={<Button onClick={wallet.switchChain}>Switch network</Button>}
        />
      </div>
    );
  if (error)
    return (
      <div className="flex flex-col gap-6">
        {back}
        <EmptyState icon={PlugZap} title="Report not available" description={error} />
      </div>
    );
  if (!report)
    return (
      <div className="flex flex-col gap-6">
        {back}
        <Skeleton className="h-96" />
      </div>
    );
  const view = reportView(report, name);
  if (!view)
    return (
      <div className="flex flex-col gap-6" data-testid="report-not-written">
        {back}
        <EmptyState
          icon={PlugZap}
          title="No report for this cycle"
          description={report.reason ?? "The report was not written."}
        />
      </div>
    );
  return (
    <div className="flex flex-col gap-6" data-testid="report-page">
      {back}
      <ResearchReportDocument
        view={view}
        actions={
          <Button size="sm" onClick={download} data-testid="report-download">
            <Download aria-hidden /> Download as PDF
          </Button>
        }
      />
    </div>
  );
}
