"use client";

import { Badge, cn } from "@alpha-agents/ui";
import {
  Activity,
  ArrowLeftRight,
  BookMarked,
  Bot,
  Coins,
  GitBranch,
  LineChart,
  RefreshCw,
  Scale,
  Telescope,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export const CONSOLE_PANELS = [
  { href: "/", label: "Environment", icon: Activity },
  { href: "/fork", label: "Fork controls", icon: GitBranch },
  { href: "/funds", label: "Test funds", icon: Coins },
  { href: "/addresses", label: "Address book", icon: BookMarked },
  { href: "/policy", label: "Policy sandbox", icon: Scale },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/trades", label: "Trades", icon: ArrowLeftRight },
  { href: "/market", label: "Market", icon: LineChart },
  { href: "/research", label: "Research", icon: Telescope },
  { href: "/cycles", label: "Cycles", icon: RefreshCw },
] as const;

const isActive = (pathname: string, href: string) =>
  href === "/" ? pathname === "/" : pathname.startsWith(href);

function ConsoleShell({ environment, children }: { environment: string; children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b bg-surface">
        <div className="mx-auto flex max-w-content flex-wrap items-center gap-3 px-4 py-3 md:px-6">
          <span aria-hidden className="size-3 rotate-45 rounded-sm border-2 border-detail" />
          <span className="text-base font-semibold">Dev console</span>
          <Badge tone="detail">Local only · 127.0.0.1</Badge>
          <span className="ml-auto text-xs text-foreground-muted">
            Environment <span className="numeric text-foreground">{environment}</span>
          </span>
        </div>
        <nav
          aria-label="Panels"
          className="mx-auto flex max-w-content gap-1 overflow-x-auto px-4 pb-2 md:px-6"
        >
          {CONSOLE_PANELS.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={isActive(pathname, href) ? "page" : undefined}
              className={cn(
                "inline-flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap text-foreground-muted outline-none",
                "transition-colors is-hover:bg-surface-raised is-hover:text-foreground is-focus:focus-ring",
                "aria-[current=page]:bg-surface-raised aria-[current=page]:text-primary",
              )}
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto w-full max-w-content flex-1 px-4 py-8 md:px-6">{children}</main>
    </div>
  );
}

export { ConsoleShell };
