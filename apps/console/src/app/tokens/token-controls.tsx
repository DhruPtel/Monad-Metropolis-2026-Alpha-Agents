"use client";

import { Button, toast } from "@alpha-agents/ui";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { discoverTokensAction, screenTokenAction } from "./actions";

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
