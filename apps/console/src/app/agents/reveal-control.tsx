"use client";

import { SPECIES } from "@alpha-agents/domain";
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from "@alpha-agents/ui";
import { useState, useTransition } from "react";
import { cancelSteerAction, steerRevealAction } from "./actions";
import type { RevealSteerView, RevealSteeringView } from "./extension";

const nameOf = (slug: string | null) =>
  slug === null ? "random" : (SPECIES.find((s) => s.slug === slug)?.name ?? slug);

const targetText = (t: RevealSteerView["target"]) =>
  t.kind === "wallet" ? `wallet ${t.wallet}` : `agent #${t.agentId}`;

const STATUS_TONE: Readonly<Record<RevealSteerView["status"], BadgeTone>> = {
  pending: "warning",
  applied: "positive",
  failed: "negative",
  cancelled: "neutral",
};

/**
 * D-221: "Reveal next as", local fork only. The keeper steers its simulated
 * Entropy number so a chosen wallet's next reveal, or one pending agent, draws
 * the chosen species, once. Steers live in Postgres, so restarts keep them, and
 * each pending steer says exactly which agent it will apply to. The
 * orchestrator offers this only with APP_ENV=local, so the card never appears
 * for testnet or mainnet.
 */
export function RevealControl({ steering }: { steering: RevealSteeringView }) {
  const [current, setCurrent] = useState(steering);
  const [species, setSpecies] = useState("bee");
  const [kind, setKind] = useState<"wallet" | "agent">("wallet");
  const [target, setTarget] = useState("");
  const [pending, start] = useTransition();

  const steer = () =>
    start(async () => {
      const r = await steerRevealAction(
        species,
        kind === "wallet" ? { wallet: target } : { agentId: target },
      );
      if (!r.ok) {
        toast.error("The reveal was not steered", { description: r.error });
        return;
      }
      setCurrent(r.value);
      setTarget("");
      toast.success(
        `${kind === "wallet" ? "That wallet's next reveal" : `Agent #${target.trim()}`} will be a ${nameOf(species)}`,
      );
    });

  const cancel = (steerId: string) =>
    start(async () => {
      const r = await cancelSteerAction(steerId);
      if (!r.ok) {
        toast.error("The steer was not cancelled", { description: r.error });
        return;
      }
      setCurrent(r.value);
    });

  return (
    <Card data-testid="reveal-control">
      <CardHeader>
        <CardTitle>Reveal next as (local fork only)</CardTitle>
        <CardDescription>
          The keeper plays Entropy on the fork, so it can steer one reveal to a species: a
          wallet&apos;s next reveal, or a pending agent&apos;s. Choices are kept in Postgres, so
          restarts keep them. Agent #1 on a fresh fork reveals as {nameOf(current.firstReveal)}.
          Testnet and mainnet always reveal with Pyth Entropy&apos;s number.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Species">
            {(control) => (
              <Select value={species} onValueChange={setSpecies}>
                <SelectTrigger {...control} className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SPECIES.map((s) => (
                    <SelectItem key={s.slug} value={s.slug}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <Field label="For">
            {(control) => (
              <Select value={kind} onValueChange={(v) => setKind(v as "wallet" | "agent")}>
                <SelectTrigger {...control} className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="wallet">A wallet</SelectItem>
                  <SelectItem value="agent">A pending agent</SelectItem>
                </SelectContent>
              </Select>
            )}
          </Field>
          <Field
            label={kind === "wallet" ? "Wallet address" : "Agent ID"}
            className="min-w-0 flex-1 basis-56"
          >
            {(control) => (
              <Input
                {...control}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder={kind === "wallet" ? "0x..." : "3"}
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </Field>
          <Button size="sm" disabled={pending || target.trim() === ""} onClick={steer}>
            Reveal as {nameOf(species)}
          </Button>
        </div>
        <ul
          className="flex flex-col gap-2"
          data-testid="reveal-steers"
          aria-label="Steered reveals"
        >
          {current.pending.length === 0 ? (
            <li className="text-sm text-foreground-muted" data-testid="no-steers">
              No steered reveal is pending: the next reveals are random.
            </li>
          ) : null}
          {[...current.pending, ...current.recent].map((s) => (
            <li
              key={s.steerId}
              data-testid="reveal-steer"
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2 text-sm"
            >
              <Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge>
              <span className="font-medium text-foreground">{nameOf(s.species)}</span>
              <span className="min-w-0 break-all text-foreground-muted">
                for {targetText(s.target)}
              </span>
              <span
                className="min-w-0 basis-full break-all text-foreground"
                data-testid="applies-to"
              >
                {s.status === "pending"
                  ? `Applies to: ${s.appliesTo?.text ?? "unknown"}`
                  : (s.note ?? "")}
              </span>
              {s.status === "pending" ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => cancel(s.steerId)}
                >
                  Cancel
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
