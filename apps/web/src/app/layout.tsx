import { ENVIRONMENTS, webEnvironment } from "@alpha-agents/config";
import { WalletProvider } from "#wallet-provider";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { privyAppId } from "@/auth/privy-app-id";
import { AppShell } from "@/components/shell/app-shell";
import { Toaster, TooltipProvider, cn } from "@alpha-agents/ui";
import { inter, jetbrainsMono } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Alpha Agents",
  description: "Alpha Agents, unaudited beta",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // The environment the app was built for (D-149); an unknown APP_ENV fails the build.
  const environment = webEnvironment(process.env.APP_ENV);
  return (
    <html lang="en" data-theme="dark" className={cn(inter.variable, jetbrainsMono.variable)}>
      <body>
        <TooltipProvider delayDuration={200}>
          <WalletProvider appId={privyAppId(process.env.PRIVY_APP_ID)} environment={environment}>
            <AppShell environment={ENVIRONMENTS[environment].label}>{children}</AppShell>
          </WalletProvider>
          <Toaster />
        </TooltipProvider>
      </body>
    </html>
  );
}
