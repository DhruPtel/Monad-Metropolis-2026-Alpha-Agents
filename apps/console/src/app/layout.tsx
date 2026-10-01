import { DEFAULT_ENVIRONMENT, ENVIRONMENTS } from "@alpha-agents/config";
import { Toaster, TooltipProvider, cn } from "@alpha-agents/ui";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ConsoleShell } from "@/components/console-shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dev console · Alpha Agents",
  description: "Local-only dev console for the Alpha Agents development environment.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // next.config.ts refuses to start unless APP_ENV is local, so this is always the fork.
  const environment = ENVIRONMENTS[DEFAULT_ENVIRONMENT].label;
  return (
    <html lang="en" data-theme="dark" className={cn(GeistSans.variable, GeistMono.variable)}>
      <body>
        <TooltipProvider delayDuration={200}>
          <ConsoleShell environment={environment}>{children}</ConsoleShell>
          <Toaster />
        </TooltipProvider>
      </body>
    </html>
  );
}
