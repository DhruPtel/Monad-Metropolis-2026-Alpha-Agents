"use client";

import { Bell, Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";
import {
  BetaBanner,
  Button,
  Tag,
  toast,
  WalletButton,
  WrongChainPrompt,
  cn,
} from "@alpha-agents/ui";
import { chainName, useWalletSession } from "@/auth/session";

export const NAV_ITEMS = [
  { href: "/", label: "Dashboard" },
  { href: "/gallery", label: "Gallery" },
  { href: "/marketplace", label: "Marketplace" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/agents", label: "My Agents" },
  { href: "/mint", label: "Mint" },
  { href: "/configure", label: "Configure" },
  { href: "/create", label: "Create" },
] as const;

const isActive = (pathname: string, href: string) =>
  href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

const navLink = cn(
  "rounded-md px-2.5 py-2 text-sm font-medium whitespace-nowrap text-foreground-muted transition-colors outline-none",
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
  const wallet = useWalletSession();
  const walletChain = chainName(wallet.chainId, wallet.target);
  const wrongChain = wallet.state === "wrong-chain";

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
            <span className="text-base font-semibold tracking-tight whitespace-nowrap">
              Alpha Agents
            </span>
          </Link>
          {/* Inline from xl: below 1280px the links and the wallet controls do not fit
              on one row, so the menu holds the links. */}
          <nav aria-label="Main" className="hidden items-center gap-1 xl:flex">
            {links()}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden sm:inline-flex">
              <ChainIndicator environment={environment} />
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="hidden sm:inline-flex"
              aria-label="Notifications"
              onClick={() =>
                toast.info("No notifications yet", {
                  description: "Agent events arrive in a later unit.",
                })
              }
            >
              <Bell aria-hidden />
            </Button>
            <WalletButton
              state={wallet.state}
              address={wallet.address}
              chainName={walletChain}
              errorMessage={wallet.errorMessage}
              errorLabel={wallet.configured ? undefined : "Login unavailable"}
              onConnect={wallet.configured ? wallet.connect : undefined}
              onDisconnect={wallet.disconnect}
              onSwitchChain={wallet.switchChain}
            />
            <Button
              variant="ghost"
              size="icon"
              className="xl:hidden"
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
            className="flex flex-col gap-1 border-t px-4 py-3 xl:hidden"
          >
            {links(() => setMenuOpen(false))}
            <span className="pt-2 sm:hidden">
              <ChainIndicator environment={environment} />
            </span>
          </nav>
        ) : null}
      </header>
      <main className="mx-auto flex w-full max-w-content flex-1 flex-col gap-6 px-4 py-8 md:px-6">
        {wallet.mock ? (
          <Tag tone="warning" size="md">
            Test build: mock wallet
          </Tag>
        ) : null}
        {wrongChain ? (
          <WrongChainPrompt
            targetChainName={wallet.target.name}
            currentChainName={walletChain}
            switching={wallet.switching}
            onSwitchChain={wallet.switchChain}
            status={wallet.switchStatus}
          />
        ) : null}
        {/* On the wrong chain the page stays visible but inert: nothing can be clicked or focused. */}
        <div
          inert={wrongChain}
          className={cn("flex flex-1 flex-col transition-opacity", wrongChain && "opacity-50")}
        >
          {children}
        </div>
      </main>
    </div>
  );
}

export { AppShell, ChainIndicator };
