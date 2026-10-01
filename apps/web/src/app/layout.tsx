import { DEFAULT_ENVIRONMENT, ENVIRONMENTS, isEnvironmentId } from "@alpha-agents/config";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import "./globals.css";

export const metadata: Metadata = {
  title: "Alpha Agents",
  description: "Alpha Agents, unaudited beta",
};

/** The record label of the environment the app was built for (D-149). */
function environmentLabel(): string {
  const id = process.env.APP_ENV?.trim();
  return ENVIRONMENTS[id && isEnvironmentId(id) ? id : DEFAULT_ENVIRONMENT].label;
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" className={cn(GeistSans.variable, GeistMono.variable)}>
      <body>
        <TooltipProvider delayDuration={200}>
          <AppShell environment={environmentLabel()}>{children}</AppShell>
          <Toaster />
        </TooltipProvider>
      </body>
    </html>
  );
}
