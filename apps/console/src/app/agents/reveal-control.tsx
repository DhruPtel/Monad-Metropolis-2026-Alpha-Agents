"use client";

import { SPECIES } from "@alpha-agents/domain";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from "@alpha-agents/ui";
import { useState, useTransition } from "react";
import { setNextRevealAction } from "./actions";
import type { RevealSteeringView } from "./extension";

const nameOf = (slug: string | null) =>
  slug === null ? "random" : (SPECIES.find((s) => s.slug === slug)?.name ?? slug);

/**
 * D-221: "Reveal next as", local fork only. The keeper steers its simulated
 * Entropy number so the next agent to be revealed draws this species, once.
 * The orchestrator offers it only with APP_ENV=local, so this card never
 * appears for testnet or mainnet.
 */
export function RevealControl({ steering }: { steering: RevealSteeringView }) {
  const [current, setCurrent] = useState(steering);
  const [choice, setChoice] = useState(steering.nextReveal ?? "bee");
  const [pending, start] = useTransition();

  const apply = (species: string | null) =>
    start(async () => {
      const r = await setNextRevealAction(species);
      if (!r.ok) {
        toast.error("The next reveal was not set", { description: r.error });
        return;
      }
      setCurrent(r.value);
      toast.success(
        species === null
          ? "The next reveal is random again"
          : `The next agent revealed on the fork will be a ${nameOf(species)}`,
      );
    });

  return (
    <Card data-testid="reveal-control">
      <CardHeader>
        <CardTitle>Reveal next as (local fork only)</CardTitle>
        <CardDescription>
          The keeper plays Entropy on the fork, so it can steer the next reveal to a species, once.
          Agent #1 on a fresh fork reveals as {nameOf(current.firstReveal)}. Testnet and mainnet
          always reveal with Pyth Entropy&apos;s number.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Species for the next reveal">
            {(control) => (
              <Select value={choice} onValueChange={setChoice}>
                <SelectTrigger {...control}>
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
          <Button size="sm" disabled={pending} onClick={() => apply(choice)}>
            Reveal next as {nameOf(choice)}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={pending || current.nextReveal === null}
            onClick={() => apply(null)}
          >
            Clear
          </Button>
        </div>
        <p role="status" className="text-sm text-foreground-muted" data-testid="next-reveal">
          Next reveal: {current.nextReveal === null ? "random" : nameOf(current.nextReveal)}.
        </p>
      </CardContent>
    </Card>
  );
}
