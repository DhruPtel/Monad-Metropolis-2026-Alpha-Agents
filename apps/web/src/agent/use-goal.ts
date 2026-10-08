"use client";

import { AGENT_STATE_RENDERING, type GoalSaveState } from "@alpha-agents/ui";
import { RESEARCH_INTENSITY_FACTS, formatAmount } from "@alpha-agents/domain";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  type GoalConfigJson,
  type GoalPageJson,
  GoalRefusedError,
  goalApi,
} from "@/api/client";
import { useWalletSession } from "@/auth/session";
import { type FieldErrors, type GoalForm, errorsByField, formFromGoal, goalFromForm } from "./goal";
import { useOwnerSession } from "./use-owner-session";

/** How long the form waits after the last change before it asks for a preview. */
const PREVIEW_DELAY_MS = 250;

export interface GoalSaveStatusView {
  readonly state: GoalSaveState;
  readonly text: string;
  readonly reasons: readonly string[];
}

export interface GoalPageState {
  readonly page: GoalPageJson | null;
  /** The wallet does not own the agent. */
  readonly notOwner: boolean;
  readonly error: string | null;
  readonly form: GoalForm | null;
  /** What the form's goal translates to, from the API's preview; null while it is not valid. */
  readonly preview: GoalConfigJson | null;
  /** Each field's reason: the form's own checks first, then the translator's. */
  readonly fieldErrors: FieldErrors;
  readonly status: GoalSaveStatusView | null;
  readonly saving: boolean;
  setForm(update: (f: GoalForm) => GoalForm): void;
  save(): void;
}

const words = (err: unknown) =>
  err instanceof Error ? err.message : "Something went wrong reading the goal.";

/**
 * The Goal page's data (P3-U1): the saved goal and the form's ranges through
 * the owner session, a preview of what the form's goal sets after each change,
 * and the save with its result.
 */
export function useGoal(agentId: bigint): GoalPageState {
  const wallet = useWalletSession();
  const asOwner = useOwnerSession(agentId);
  const [page, setPage] = useState<GoalPageJson | null>(null);
  const [notOwner, setNotOwner] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setFormState] = useState<GoalForm | null>(null);
  const [preview, setPreview] = useState<GoalConfigJson | null>(null);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<GoalSaveStatusView | null>(null);
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  const previewRun = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The saved goal, read again whenever the wallet changes.
  useEffect(() => {
    if (!wallet.ready) return;
    let live = true;
    setNotOwner(false);
    setError(null);
    void (async () => {
      try {
        const p = await asOwner((t) => goalApi.get(agentId, t));
        if (!live || !mounted.current) return;
        setPage(p);
        setFormState(formFromGoal(p.goal ?? p.form.defaults));
      } catch (err) {
        if (!live || !mounted.current) return;
        if (err instanceof ApiError && err.code === "not_owner") setNotOwner(true);
        else setError(words(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [agentId, asOwner, wallet.ready, wallet.address]);

  const parsed = form ? goalFromForm(form) : null;
  const localErrors: FieldErrors = parsed?.errors ?? {};

  // A preview after each change, so the limits that apply show as the owner types.
  const goalKey = parsed?.goal ? JSON.stringify(parsed.goal) : null;
  useEffect(() => {
    if (!goalKey) {
      setPreview(null);
      return;
    }
    const run = ++previewRun.current;
    const timer = setTimeout(() => {
      void goalApi
        .preview(JSON.parse(goalKey))
        .then((r) => {
          if (run !== previewRun.current || !mounted.current) return;
          setPreview(r.ok ? r.config : null);
          setServerErrors(r.ok ? {} : errorsByField(r.errors));
        })
        .catch(() => {
          if (run === previewRun.current && mounted.current) setPreview(null);
        });
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [goalKey]);

  const setForm = useCallback((update: (f: GoalForm) => GoalForm) => {
    setFormState((f) => {
      if (!f) return f;
      const next = update(f);
      // A new intensity starts at its own default budget (D-293).
      return next.intensity !== f.intensity
        ? {
            ...next,
            budgetText: formatAmount(
              RESEARCH_INTENSITY_FACTS[next.intensity].defaultDailyBudgetUsdcE6,
              6,
              { minFractionDigits: 2, maxFractionDigits: 6 },
            ),
          }
        : next;
    });
    setStatus((s) => (s?.state === "saving" ? s : null));
  }, []);

  const save = useCallback(() => {
    if (!form || saving) return;
    const p = goalFromForm(form);
    if (!p.goal) {
      setStatus({
        state: "refused",
        text: "The goal was not saved; fix the fields named below.",
        reasons: Object.values(p.errors),
      });
      return;
    }
    const goal = p.goal;
    setSaving(true);
    setStatus({ state: "saving", text: "Saving the goal.", reasons: [] });
    void (async () => {
      try {
        const saved = await asOwner((t) => goalApi.save(agentId, goal, t));
        if (!mounted.current) return;
        setPage((old) => (old ? { ...old, ...saved } : old));
        setServerErrors({});
        const state = AGENT_STATE_RENDERING[saved.state].label;
        setStatus({
          state: "saved",
          text: saved.stateChange
            ? `Goal saved. Agent #${agentId} moved from ${AGENT_STATE_RENDERING[saved.stateChange.from].label} to ${state}.`
            : `Goal saved. Agent #${agentId} stays ${state}; plans and proposals now follow this goal.`,
          reasons: [],
        });
      } catch (err) {
        if (!mounted.current) return;
        if (err instanceof GoalRefusedError) {
          setServerErrors(errorsByField(err.errors));
          setStatus({
            state: "refused",
            text: err.message,
            reasons: err.errors.map((e) => e.message),
          });
        } else setStatus({ state: "failed", text: words(err), reasons: [] });
      } finally {
        if (mounted.current) setSaving(false);
      }
    })();
  }, [agentId, asOwner, form, saving]);

  return {
    page,
    notOwner,
    error,
    form,
    preview,
    fieldErrors: { ...serverErrors, ...localErrors },
    status,
    saving,
    setForm,
    save,
  };
}
