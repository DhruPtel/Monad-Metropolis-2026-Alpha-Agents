"use client";

import { Button, Field, Input, toast } from "@alpha-agents/ui";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { discoverTokensAction, lookupTokenAction, screenTokenAction } from "./actions";

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

/** Runs a discovery pass now: GeckoTerminal's pools, confirmed on mainnet. */
export function DiscoverNowButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
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
          toast.success(`Found ${r.value.tokens} tokens in ${r.value.pools} pools`, {
            description: `${r.value.newPools} new pool(s).`,
          });
          router.refresh();
        })
      }
      disabled={pending}
      loading={pending}
    >
      Run discovery now
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
