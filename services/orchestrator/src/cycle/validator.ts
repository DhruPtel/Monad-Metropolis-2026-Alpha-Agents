import type { ResearchBrief } from "@alpha-agents/platform-tools";
import { numbersIn } from "../narrator.ts";

/**
 * The brief validator (D-284, P3-U4): a brief is stored and shown only when
 * - every number in its text appears in a tool result this cycle recorded
 *   (written as the result gives it, or rounded from it to the written
 *   precision, also at a written scale such as "1.009B" or "52.7 million"),
 *   apart from time windows such as "24-hour" or "7d";
 * - every URL it names, and every source it cites, is a URL this cycle
 *   retrieved or the name of a tool this cycle called;
 * - it repeats no run of eight words from a mounted skill or playbook;
 * - it contains no canary string.
 * Each reason names the field and says what to change, so the agent can
 * write a corrected brief. Pure: the cycle's records come in as arguments.
 */
export const SKILL_RUN_WORDS = 8;
/** Every cycle's canary starts with this; no brief may contain it. */
export const CANARY_PREFIX = "AACANARY-";

export interface BriefContext {
  /** Every tool result the cycle recorded, as stored. */
  readonly results: readonly { readonly tool: string; readonly result: unknown }[];
  /** URLs the cycle retrieved: pages read and links searches returned. */
  readonly urls: readonly string[];
  /** Eight-word runs of the mounted skills' text (skillRuns). */
  readonly skillRuns: ReadonlySet<string>;
  /** This cycle's canary. */
  readonly canary: string;
}

/** The text fields of a brief, by path, that the checks read. */
export function briefTexts(b: ResearchBrief): [string, string][] {
  const out: [string, string][] = [];
  const claims = (path: string, list: readonly { text: string }[]) =>
    list.forEach((c, i) => out.push([`${path}[${i}].text`, c.text]));
  switch (b.kind) {
    case "SCAN":
      out.push(["summary", b.summary]);
      claims("changes", b.changes);
      b.themes.forEach((t, i) => out.push([`themes[${i}].whyNow`, t.whyNow]));
      b.dataGaps.forEach((g, i) => out.push([`dataGaps[${i}]`, g]));
      break;
    case "THEME":
      out.push(["question", b.question]);
      claims("evidenceFor", b.evidenceFor);
      claims("evidenceAgainst", b.evidenceAgainst);
      out.push(["freshness", b.freshness]);
      if (b.thesis) {
        out.push(["thesis.statement", b.thesis.statement]);
        out.push(["thesis.killCriterion", b.thesis.killCriterion]);
      }
      if (b.noThesisReason) out.push(["noThesisReason", b.noThesisReason]);
      out.push(["weakestLink", b.weakestLink]);
      out.push(["forThePlan", b.forThePlan]);
      break;
    case "CHALLENGE":
      b.objections.forEach((o, i) => out.push([`objections[${i}].text`, o.text]));
      out.push(["summary", b.summary]);
      break;
    case "OVERVIEW":
      out.push(["summary", b.summary]);
      claims("points", b.points);
      break;
    case "RATIONALE":
      claims("points", b.points);
      out.push(["whatWouldChangeIt", b.whatWouldChangeIt]);
      break;
  }
  return out;
}

/** Every source a brief cites, by path. */
export function briefSources(b: ResearchBrief): [string, string][] {
  const out: [string, string][] = [];
  const add = (path: string, list: readonly string[]) =>
    list.forEach((s, i) => out.push([`${path}[${i}]`, s]));
  const claims = (path: string, list: readonly { sources: readonly string[] }[]) =>
    list.forEach((c, i) => add(`${path}[${i}].sources`, c.sources));
  switch (b.kind) {
    case "SCAN":
      claims("changes", b.changes);
      b.themes.forEach((t, i) => add(`themes[${i}].sources`, t.sources));
      break;
    case "THEME":
      claims("evidenceFor", b.evidenceFor);
      claims("evidenceAgainst", b.evidenceAgainst);
      break;
    case "CHALLENGE":
      b.objections.forEach((o, i) => add(`objections[${i}].sources`, o.sources));
      break;
    case "OVERVIEW":
    case "RATIONALE":
      claims("points", b.points);
      break;
  }
  return out;
}

const words = (text: string) => text.toLowerCase().match(/[a-z0-9']+/g) ?? [];

/** Every run of eight consecutive words in the given texts, for the skill check. */
export function skillRuns(texts: readonly string[]): Set<string> {
  const runs = new Set<string>();
  for (const t of texts) {
    const w = words(t);
    for (let i = 0; i + SKILL_RUN_WORDS <= w.length; i += 1)
      runs.add(w.slice(i, i + SKILL_RUN_WORDS).join(" "));
  }
  return runs;
}

/** Time windows are not facts: "24-hour", "7d", "48 hours", "30-day" are left out of the number check. */
// Case matters: "M" after a number is millions, never months; months are written "mo" or "month".
const WINDOW =
  /\b\d+(?:\.\d+)?(?:\s|-)?(?:h|H|hr|hrs|[Hh]ours?|d|D|[Dd]ays?|w|W|wk|[Ww]eeks?|mo|[Mm]onths?)\b/g;

/** A number's decimal places as written. */
const places = (n: string) => (n.includes(".") ? (n.split(".")[1] ?? "").length : 0);

/**
 * Whether a written number traces to a result: equal to a number some result
 * holds, or that number rounded to the written number's decimal places
 * or truncated to them (a result's 3.2145 supports "3.21", "3.2" and "3";
 * 81.56 supports "81" and "82", never "3.3" or "80").
 */
export function numberTraces(
  written: string,
  known: ReadonlySet<string>,
  values: readonly number[],
) {
  if (known.has(written)) return true;
  const w = Number(written);
  if (!Number.isFinite(w)) return false;
  const p = places(written);
  const scale = 10 ** p;
  return values.some(
    (v) => v !== w && (Math.round(v * scale) / scale === w || Math.trunc(v * scale) / scale === w),
  );
}

/** A written scale after a number: thousands, millions, billions, trillions. */
const SCALES: readonly [RegExp, number][] = [
  [/^(k|K|thousand)$/, 1e3],
  [/^(M|mn|million)$/, 1e6],
  [/^(B|bn|billion)$/, 1e9],
  [/^(T|tn|trillion)$/, 1e12],
];
const SCALED =
  /(\d[\d,]*(?:\.\d+)?)(?:\s?(?:-|to)\s?\$?(\d[\d,]*(?:\.\d+)?))?\s?(k|K|thousand|M|mn|million|B|bn|billion|T|tn|trillion)\b/g;

/**
 * Numbers written with a scale ("1.009B", "52.7 million"), each with the
 * value it stands for and its precision: it traces when a result's value
 * rounds to it at that scale (1,008,834,781 supports "1.009B").
 */
export function scaledTraces(
  text: string,
  values: readonly number[],
  /** Numbers as results write them: a source that says "412 million" supports "412 million". */
  known: ReadonlySet<string> = new Set(),
): { written: string; ok: boolean }[] {
  const out: { written: string; ok: boolean }[] = [];
  for (const m of text.matchAll(SCALED)) {
    // A scale after a range ("995-1042M") applies to both of its ends.
    const scale = SCALES.find(([re]) => re.test(m[3] ?? ""))?.[1] ?? 1;
    for (const part of [m[1], m[2]]) {
      if (!part) continue;
      const raw = part.replace(/,/g, "");
      const f = 10 ** places(raw);
      const w = Number(raw);
      out.push({
        written: m[2] ? `${raw} (in ${m[0]})` : m[0],
        ok:
          known.has(numbersIn(raw)[0] ?? "") ||
          values.some(
            (v) => Math.round((v / scale) * f) / f === w || Math.trunc((v / scale) * f) / f === w,
          ),
      });
    }
  }
  return out;
}

const URL_RE = /\bhttps?:\/\/[^\s)<>"']+/gi;
const normalizeUrl = (u: string) =>
  u
    .replace(/[.,;:]+$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();

export interface BriefCheck {
  readonly ok: boolean;
  readonly reasons: string[];
}

export function validateBrief(brief: ResearchBrief, ctx: BriefContext): BriefCheck {
  const reasons: string[] = [];
  const known = new Set<string>();
  for (const r of ctx.results) for (const n of numbersIn(JSON.stringify(r.result))) known.add(n);
  const values = [...known].map(Number).filter(Number.isFinite);
  const urls = new Set(ctx.urls.map(normalizeUrl));
  const tools = new Set(ctx.results.map((r) => r.tool));
  const raw = JSON.stringify(brief);

  if (raw.includes(ctx.canary) || raw.includes(CANARY_PREFIX))
    reasons.push(
      "the brief contains the platform's internal marker; remove it, it is never research",
    );

  for (const [path, text] of briefTexts(brief)) {
    const plain = text.replace(WINDOW, " ").replace(URL_RE, " ");
    const scaled = scaledTraces(plain, values, known);
    const invented = [
      ...scaled.filter((x) => !x.ok).map((x) => x.written),
      ...numbersIn(plain.replace(SCALED, " ")).filter((n) => !numberTraces(n, known, values)),
    ];
    if (invented.length > 0)
      reasons.push(
        `${path}: ${[...new Set(invented)].join(", ")} does not appear in any tool result this cycle recorded; quote each figure as a tool returned it, or remove it`,
      );
    for (const m of text.matchAll(URL_RE))
      if (!urls.has(normalizeUrl(m[0])))
        reasons.push(
          `${path}: ${m[0].slice(0, 120)} is not a URL this cycle retrieved; cite only pages you read or links a search returned`,
        );
    const w = words(text);
    for (let i = 0; i + SKILL_RUN_WORDS <= w.length; i += 1) {
      const run = w.slice(i, i + SKILL_RUN_WORDS).join(" ");
      if (ctx.skillRuns.has(run)) {
        reasons.push(
          `${path}: "${run}" repeats a skill's wording; write the point in your own words`,
        );
        break;
      }
    }
  }

  for (const [path, source] of briefSources(brief)) {
    const isUrl = /^https?:\/\//i.test(source);
    if (isUrl ? !urls.has(normalizeUrl(source)) : !tools.has(source))
      reasons.push(
        `${path}: "${source.slice(0, 120)}" is neither a URL this cycle retrieved nor a tool this cycle called (${[...tools].sort().join(", ") || "none yet"})`,
      );
  }
  return { ok: reasons.length === 0, reasons: reasons.slice(0, 12) };
}
