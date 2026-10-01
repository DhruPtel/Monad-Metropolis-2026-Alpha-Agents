"use client";

import { Bell, Menu, Wallet, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";
import { BetaBanner } from "@/components/beta-banner";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export const NAV_ITEMS = [
  { href: "/", label: "Dashboard" },
  { href: "/gallery", label: "Gallery" },
  { href: "/marketplace", label: "Marketplace" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/agents", label: "My Agents" },
  { href: "/create", label: "Create" },
] as const;

const isActive = (pathname: string, href: string) =>
  href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

const navLink = cn(
  "rounded-md px-3 py-2 text-sm font-medium text-foreground-muted transition-colors outline-none",
  "is-hover:text-foreground is-focus:focus-ring",
  "aria-[current=page]:text-primary",
);

/** Chain and environment, for example "Monad · fork". */
function ChainIndicator({ environment }: { environment: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border bg-surface px-3 py-1 text-xs text-foreground-muted">
      <span aria-hidden className="size-1.5 rounded-full bg-positive" />
      Monad
      <span className="numeric text-foreground-subtle">{environment}</span>
    </span>
  );
}

function AppShell({ environment, children }: { environment: string; children: ReactNode }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  const links = (onNavigate?: () => void) =>
    NAV_ITEMS.map((item) => (
      <Link
        key={item.href}
        href={item.href}
        {...(onNavigate ? { onClick: onNavigate } : {})}
        aria-current={isActive(pathname, item.href) ? "page" : undefined}
        className={navLink}
      >
        {item.label}
      </Link>
    ));

  return (
    <div className="flex min-h-screen flex-col">
      <BetaBanner environment={environment} />
      <header className="sticky top-0 z-40 border-b bg-background">
        <div className="mx-auto flex h-16 max-w-content items-center gap-4 px-4 md:px-6">
          <Link
            href="/"
            className="flex items-center gap-2 rounded-md outline-none is-focus:focus-ring"
          >
            <span aria-hidden className="size-3 rotate-45 rounded-sm border-2 border-primary" />
            <span className="text-base font-semibold tracking-tight">Alpha Agents</span>
          </Link>
          <nav aria-label="Main" className="hidden items-center gap-1 lg:flex">
            {links()}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden sm:inline-flex">
              <ChainIndicator environment={environment} />
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Notifications"
              onClick={() =>
                toast.info("No notifications yet", {
                  description: "Agent events arrive in a later unit.",
                })
              }
            >
              <Bell aria-hidden />
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    toast.info("Wallet login is not available yet", {
                      description: "It arrives in P1-U2.",
                    })
                  }
                >
                  <Wallet aria-hidden />
                  <span className="hidden sm:inline">Connect wallet</span>
                  <span className="sm:hidden">Connect</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Placeholder: wallet login arrives in P1-U2</TooltipContent>
            </Tooltip>
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              aria-expanded={menuOpen}
              aria-controls="mobile-nav"
              onClick={() => setMenuOpen((open) => !open)}
            >
              {menuOpen ? <X aria-hidden /> : <Menu aria-hidden />}
            </Button>
          </div>
        </div>
        {menuOpen ? (
          <nav
            id="mobile-nav"
            aria-label="Main"
            className="flex flex-col gap-1 border-t px-4 py-3 lg:hidden"
          >
            {links(() => setMenuOpen(false))}
            <span className="pt-2 sm:hidden">
              <ChainIndicator environment={environment} />
            </span>
          </nav>
        ) : null}
      </header>
      <main className="mx-auto w-full max-w-content flex-1 px-4 py-8 md:px-6">{children}</main>
    </div>
  );
}

export { AppShell, ChainIndicator };
