"use client";

import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  toast,
} from "@alpha-agents/ui";
import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import {
  approveIntentAction,
  armAgentAction,
  disarmAgentAction,
  proposeOverLimitAction,
} from "./actions";

/**
 * The trade flow's console controls (P2-U6): arm the agent as its owner would
 * (on the local fork the owner's grant is impersonated), disarm it (which
 * revokes the grant), approve one waiting intent, and record a proposal over
 * the trade size limit to see a trade blocked. The page refreshes
 * itself while any intent is moving, so its states show as they change.
 */
export function ArmingControls({
  agentId,
  name,
  state,
  enabled,
}: {
  agentId: string;
  name: string;
  state: "unarmed" | "awaiting_first_trade" | "armed";
  enabled: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const arm = () =>
    start(async () => {
      const r = await armAgentAction(agentId);
      if (!r.ok) {
        toast.error(`${name} was not armed`, { description: r.error });
        return;
      }
      toast.success(`${name} has a trading permission`, {
        description: `Valid until ${r.value.validUntilDate ?? "unknown"}. Approve its first trade to arm it.`,
      });
      router.refresh();
    });

  const disarm = () =>
    start(async () => {
      const r = await disarmAgentAction(agentId);
      if (!r.ok) {
        toast.error(`${name} was not disarmed`, { description: r.error });
        return;
      }
      toast.success(`${name} is disarmed`, {
        description: "Its trading permission was revoked on chain; every proposal waits again.",
      });
      router.refresh();
    });

  const overLimit = () =>
    start(async () => {
      const r = await proposeOverLimitAction(agentId);
      if (!r.ok) {
        toast.error("No proposal recorded", { description: r.error });
        return;
      }
      toast.info("Proposed half the account's USDC", {
        description:
          state === "armed"
            ? "The trade flow approves it and the re-check at submission blocks it."
            : "It waits for approval; approve it to see the re-check block it.",
      });
      router.refresh();
    });

  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="ghost" disabled={!enabled || pending} onClick={overLimit}>
        Propose over-limit trade
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={!enabled || pending || state !== "unarmed"}
        loading={pending && state === "unarmed"}
        onClick={arm}
      >
        Arm
      </Button>
      <Dialog>
        <DialogTrigger asChild>
          <Button size="sm" variant="danger" disabled={!enabled || pending || state === "unarmed"}>
            Disarm
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disarm {name}?</DialogTitle>
            <DialogDescription>
              Arming ends now and the trading permission is revoked on chain. Trades already sent
              finish; every new proposal waits for approval.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <DialogClose asChild>
              <Button variant="danger" onClick={disarm}>
                Disarm
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function ApproveIntentButton({
  agentId,
  intentId,
  first,
}: {
  agentId: string;
  intentId: string;
  /** The agent has a grant and waits for its first approval: approving arms it. */
  first: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const approve = () =>
    start(async () => {
      const r = await approveIntentAction(agentId, intentId);
      if (!r.ok) {
        toast.error("Not approved", { description: r.error });
        return;
      }
      toast.success(r.value ? "Approved: the agent is armed" : "Approved", {
        description: "The trade flow re-checks it and sends it within seconds.",
      });
      router.refresh();
    });
  return (
    <Button size="sm" variant="primary" disabled={pending} loading={pending} onClick={approve}>
      {first ? "Approve and arm" : "Approve"}
    </Button>
  );
}

/** Refreshes the page every two seconds while `active`, so moving intents show each state. */
export function RefreshWhileMoving({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), 2_000);
    return () => clearInterval(timer);
  }, [active, router]);
  return null;
}
