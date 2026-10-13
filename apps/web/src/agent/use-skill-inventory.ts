"use client";

import type { LoadoutSkillView } from "@alpha-agents/ui";
import { useEffect, useState } from "react";
import { ApiError, skillsApi } from "@/api/client";
import { useWalletSession } from "@/auth/session";
import { useOwnerSession } from "./use-owner-session";

export type SkillInventory =
  | { readonly state: "off" }
  | { readonly state: "reading" }
  | { readonly state: "ready"; readonly skills: readonly LoadoutSkillView[] }
  | { readonly state: "error"; readonly message: string };

/**
 * UI-FAST: the configure page's skill inventory: the agent's skills as the
 * API lists them for its owner (SK-U1): the built-in skills and playbooks and
 * the owner's own uploads. Read once per agent; `agentId` null reads nothing.
 */
export function useSkillInventory(agentId: bigint | null): SkillInventory {
  const wallet = useWalletSession();
  const asOwner = useOwnerSession(agentId ?? 0n);
  const [inv, setInv] = useState<SkillInventory>({ state: "off" });
  const ready = wallet.ready && !!wallet.address;

  useEffect(() => {
    if (agentId === null || !ready) {
      setInv({ state: "off" });
      return;
    }
    let live = true;
    setInv((cur) => (cur.state === "ready" ? cur : { state: "reading" }));
    asOwner((t) => skillsApi.list(agentId, t)).then(
      (s) =>
        live &&
        setInv({
          state: "ready",
          skills: [...s.builtin, ...s.owner].map((k) => ({ id: k.id, name: k.name, kind: k.kind })),
        }),
      (err: unknown) =>
        live &&
        setInv({
          state: "error",
          message:
            err instanceof ApiError
              ? err.message
              : "Could not read this agent's skills; try again.",
        }),
    );
    return () => {
      live = false;
    };
  }, [agentId, ready, asOwner]);

  return inv;
}
