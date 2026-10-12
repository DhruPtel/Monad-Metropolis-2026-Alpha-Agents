"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  type SkillFindingJson,
  type SkillsJson,
  SkillRefusedError,
  skillsApi,
} from "@/api/client";
import { useWalletSession } from "@/auth/session";
import { type PickedFile, pickProblem, readPicked } from "./skill-upload";
import { useOwnerSession } from "./use-owner-session";

/**
 * The agent's skills for its owner (SK-U1): the built-in set and the owner's
 * own uploads, the pick and upload of a package with its findings, and the
 * removal of one. Every call runs on the owner session.
 */
export type SkillsStatus =
  | { readonly state: "idle" }
  | { readonly state: "reading" }
  | { readonly state: "uploading" }
  | {
      readonly state: "refused";
      readonly findings: readonly SkillFindingJson[];
    }
  | {
      readonly state: "mounted";
      readonly skillId: string;
      readonly already: boolean;
      readonly findings: readonly SkillFindingJson[];
    }
  | { readonly state: "removed"; readonly skillId: string }
  | { readonly state: "error"; readonly message: string };

const words = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong; try again.";

export function useSkills(agentId: bigint) {
  const wallet = useWalletSession();
  const asOwner = useOwnerSession(agentId);
  const [skills, setSkills] = useState<SkillsJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<readonly PickedFile[]>([]);
  const [status, setStatus] = useState<SkillsStatus>({ state: "idle" });
  const [tick, setTick] = useState(0);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Another wallet's data is never shown: a new account starts over.
  useEffect(() => {
    setSkills(null);
    setError(null);
    setPicked([]);
    setStatus({ state: "idle" });
  }, [wallet.address, agentId]);

  useEffect(() => {
    if (!wallet.ready || !wallet.address) return;
    let live = true;
    void (async () => {
      try {
        const s = await asOwner((t) => skillsApi.list(agentId, t));
        if (live && mounted.current) {
          setSkills(s);
          setError(null);
        }
      } catch (err) {
        if (live && mounted.current) setError(words(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [agentId, asOwner, wallet.ready, wallet.address, tick]);

  const pick = useCallback(async (list: FileList | null) => {
    setStatus({ state: "reading" });
    try {
      const files = await readPicked(list);
      if (!mounted.current) return;
      setPicked(files);
      setStatus({ state: "idle" });
    } catch {
      if (mounted.current)
        setStatus({
          state: "error",
          message: "The files could not be read; pick the folder again.",
        });
    }
  }, []);

  const clear = useCallback(() => {
    setPicked([]);
    setStatus({ state: "idle" });
  }, []);

  /** BC-U1: the editor's text through the same upload path as a folder. */
  const uploadFiles = useCallback(
    (files: readonly { path: string; content: string }[]) => {
      if (running.current) return;
      running.current = true;
      setStatus({ state: "uploading" });
      void (async () => {
        try {
          const r = await asOwner((t) => skillsApi.upload(agentId, [...files], t));
          if (!mounted.current) return;
          setStatus({
            state: "mounted",
            skillId: r.skill.id,
            already: r.already,
            findings: r.findings,
          });
          setTick((t) => t + 1);
        } catch (err) {
          if (!mounted.current) return;
          if (err instanceof SkillRefusedError)
            setStatus({ state: "refused", findings: err.findings });
          else setStatus({ state: "error", message: words(err) });
        } finally {
          running.current = false;
        }
      })();
    },
    [agentId, asOwner],
  );

  /** BC-U1: the editor's live check, on the owner session. */
  const check = useCallback(
    (files: readonly { path: string; content: string }[]) =>
      asOwner((t) => skillsApi.check(agentId, [...files], t)),
    [agentId, asOwner],
  );

  const upload = useCallback(() => {
    if (running.current) return;
    const problem = pickProblem(picked);
    if (problem) {
      setStatus({ state: "error", message: problem });
      return;
    }
    running.current = true;
    setStatus({ state: "uploading" });
    void (async () => {
      try {
        const r = await asOwner((t) =>
          skillsApi.upload(
            agentId,
            picked.map((f) => ({ path: f.path, content: f.content })),
            t,
          ),
        );
        if (!mounted.current) return;
        setStatus({
          state: "mounted",
          skillId: r.skill.id,
          already: r.already,
          findings: r.findings,
        });
        setPicked([]);
      } catch (err) {
        if (!mounted.current) return;
        if (err instanceof SkillRefusedError)
          setStatus({ state: "refused", findings: err.findings });
        else setStatus({ state: "error", message: words(err) });
      } finally {
        running.current = false;
        if (mounted.current) setTick((t) => t + 1);
      }
    })();
  }, [agentId, asOwner, picked]);

  const remove = useCallback(
    (skillId: string) => {
      if (running.current) return;
      running.current = true;
      void (async () => {
        try {
          await asOwner((t) => skillsApi.remove(agentId, skillId, t));
          if (mounted.current) setStatus({ state: "removed", skillId });
        } catch (err) {
          if (mounted.current) setStatus({ state: "error", message: words(err) });
        } finally {
          running.current = false;
          if (mounted.current) setTick((t) => t + 1);
        }
      })();
    },
    [agentId, asOwner],
  );

  return {
    skills,
    error,
    picked,
    status,
    busy: status.state === "reading" || status.state === "uploading",
    pick,
    clear,
    upload,
    remove,
    refresh: useCallback(() => setTick((t) => t + 1), []),
    uploadFiles,
    check,
  };
}
