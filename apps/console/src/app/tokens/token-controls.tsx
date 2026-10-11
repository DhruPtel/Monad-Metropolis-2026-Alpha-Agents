"use client";

import { Button, Field, Input, toast } from "@alpha-agents/ui";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import {
  discoverTokensAction,
  discoveryRunAction,
  lookupTokenAction,
  screenTokenAction,
} from "./actions";

/** Screens the token now on the screen fork, then shows the new result. */
export function ScreenNowButton({ address, symbol }: { address: string; symbol: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      onClick={() =>
        start(async () => {
          const r = await screenTokenAction(address);
          if (!r.ok) {
            toast.error(`${symbol} was not screened`, { description: r.error });
            return;
          }
          if (r.value.verdict === "passed") toast.success(`${symbol} passed every check`);
          else
            toast.info(`${symbol} was refused`, {
              description: `${r.value.failed} check(s) failed.`,
            });
          router.refresh();
        })
      }
      disabled={pending}
      loading={pending}
    >
      {pending ? "Screening on the fork" : "Screen now"}
    </Button>
  );
}

/** How often the button asks after the run it started. */
const DISCOVERY_POLL_MS = 3_000;

/**
 * Runs a discovery pass now: GeckoTerminal's pools, confirmed on mainnet. The
 * orchestrator answers at once with the run and the pass goes on in the
 * background (L-197); the button watches the run until it ends, then shows
 * what it found and refreshes the page.
 */
export function DiscoverNowButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [watching, setWatching] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!watching) return;
    const startedAt = Date.now();
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      setSeconds(Math.round((Date.now() - startedAt) / 1000));
      const r = await discoveryRunAction(watching);
      if (stopped) return;
      if (!r.ok) {
        toast.error("Discovery could not be watched", { description: r.error });
        setWatching(null);
        return;
      }
      if (r.value.status === "running") return;
      setWatching(null);
      if (r.value.status === "completed")
        toast.success(`Found ${r.value.tokensSeen} tokens in ${r.value.poolsSeen} pools`, {
          description: `${r.value.newPools} new pool(s).`,
        });
      else toast.error("Discovery failed", { description: r.value.error ?? "no reason" });
      router.refresh();
    };
    void tick();
    const timer = window.setInterval(() => void tick(), DISCOVERY_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [router, watching]);
  const busy = pending || watching !== null;
  return (
    <Button
      variant="secondary"
      onClick={() =>
        start(async () => {
          const r = await discoverTokensAction();
          if (!r.ok) {
            toast.error("Discovery did not run", { description: r.error });
            return;
          }
          toast.info(r.value.started ? "Discovery started" : "Discovery already under way", {
            description: "The page refreshes when it ends.",
          });
          setSeconds(0);
          setWatching(r.value.runId);
        })
      }
      disabled={busy}
      loading={busy}
      data-testid="discover-now"
    >
      {watching ? `Discovery running (${seconds} s)` : "Run discovery now"}
    </Button>
  );
}

/** Looks up any token by address, even one discovery never saw, and opens its page (D-360). */
export function LookupToken() {
  const router = useRouter();
  const [address, setAddress] = useState("");
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-col gap-2 sm:flex-row sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await lookupTokenAction(address);
          if (!r.ok) {
            toast.error("The token was not found", { description: r.error });
            return;
          }
          toast.success(`${r.value.symbol} is in the registry`);
          router.push(`/tokens?token=${r.value.address}`);
        });
      }}
    >
      <Field label="Token address" className="min-w-0 flex-1">
        {(control) => (
          <Input
            {...control}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="0x..."
            spellCheck={false}
            autoComplete="off"
            className="numeric"
          />
        )}
      </Field>
      <Button
        type="submit"
        variant="secondary"
        disabled={pending || address.trim().length === 0}
        loading={pending}
      >
        Look up
      </Button>
    </form>
  );
}
