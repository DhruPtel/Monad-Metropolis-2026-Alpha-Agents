"use client";

import { SKILL_TEMPLATES, type SkillTemplateFile } from "@alpha-agents/domain";
import type { SkillCheckState, SkillEditorFile } from "@alpha-agents/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { ApiError, type SkillCheckJson, type SkillFindingJson } from "@/api/client";

/** How long after the last keystroke the text is checked. */
export const CHECK_DEBOUNCE_MS = 600;

/**
 * The editor's text and its live check (BC-U1), apart from React where it
 * can be: the files start from a template with the owner as publisher, every
 * edit marks the check stale, and the page runs the check after a pause.
 */
export function templateFiles(templateId: string, owner: Address): readonly SkillTemplateFile[] {
  const t = SKILL_TEMPLATES.find((x) => x.id === templateId) ?? SKILL_TEMPLATES[0];
  if (!t) throw new Error("no skill template");
  return t.files(owner);
}

/** The check's state from the platform's answer. */
export function checkStateOf(r: SkillCheckJson): SkillCheckState {
  const blocking = r.findings.filter((f) => f.severity === "block").length;
  if (r.blocked || blocking > 0) return { state: "refused", blocking: Math.max(blocking, 1) };
  return {
    state: "passed",
    skillId: r.skillId,
    warnings: r.findings.filter((f) => f.severity === "warn").length,
  };
}

export interface SkillEditorState {
  readonly templateId: string;
  readonly files: readonly SkillEditorFile[];
  readonly check: SkillCheckState;
  readonly findings: readonly SkillFindingJson[];
  readonly setTemplate: (id: string) => void;
  readonly setFile: (path: string, content: string) => void;
  /** Starts over from the template, for the next skill. */
  readonly reset: () => void;
}

export function useSkillEditor(
  owner: Address | undefined,
  check: (files: readonly { path: string; content: string }[]) => Promise<SkillCheckJson>,
  /** Whether a check may run now (an owner session is available). */
  enabled: boolean,
): SkillEditorState {
  const [templateId, setTemplateId] = useState<string>(SKILL_TEMPLATES[0]?.id ?? "notes");
  const [files, setFiles] = useState<readonly SkillEditorFile[]>(() =>
    owner ? templateFiles(templateId, owner) : [],
  );
  const [checkState, setCheck] = useState<SkillCheckState>({ state: "idle" });
  const [findings, setFindings] = useState<readonly SkillFindingJson[]>([]);
  const [version, setVersion] = useState(0);
  const latest = useRef(0);

  // The owner's wallet is the publisher: a new wallet starts the text over,
  // from the template in hand (read through a ref, so only the wallet triggers it).
  const templateRef = useRef(templateId);
  templateRef.current = templateId;
  useEffect(() => {
    if (!owner) return;
    setFiles(templateFiles(templateRef.current, owner));
    setCheck({ state: "idle" });
    setFindings([]);
    setVersion((v) => v + 1);
  }, [owner]);

  const setTemplate = useCallback(
    (id: string) => {
      if (!owner) return;
      setTemplateId(id);
      setFiles(templateFiles(id, owner));
      setCheck({ state: "idle" });
      setFindings([]);
      setVersion((v) => v + 1);
    },
    [owner],
  );

  const setFile = useCallback((path: string, content: string) => {
    setFiles((fs) => fs.map((f) => (f.path === path ? { path, content } : f)));
    setVersion((v) => v + 1);
  }, []);

  const reset = useCallback(() => {
    if (!owner) return;
    setFiles(templateFiles(templateId, owner));
    setCheck({ state: "idle" });
    setFindings([]);
    setVersion((v) => v + 1);
  }, [owner, templateId]);

  // The live check: after a pause in typing, the current text goes to the
  // platform; an answer for older text is dropped.
  useEffect(() => {
    if (!enabled || files.length === 0) return;
    const mine = ++latest.current;
    setCheck({ state: "checking" });
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const r = await check(files.map((f) => ({ path: f.path, content: f.content })));
          if (latest.current !== mine) return;
          setFindings(r.findings);
          setCheck(checkStateOf(r));
        } catch (err) {
          if (latest.current !== mine) return;
          setCheck({
            state: "error",
            message:
              err instanceof ApiError ? err.message : "Could not check the package; try again.",
          });
        }
      })();
    }, CHECK_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [check, enabled, files, version]);

  return { templateId, files, check: checkState, findings, setTemplate, setFile, reset };
}
