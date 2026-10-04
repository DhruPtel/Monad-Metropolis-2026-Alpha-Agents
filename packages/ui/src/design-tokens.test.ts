import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { COLOR_TOKENS, MOTION_TOKENS, SHADOW_SCALE } from "./tokens";

/**
 * Guards the design system: raw colors, sizes and fonts live only in
 * packages/ui/src/styles.css. Every component in packages/ui and every page in
 * the apps uses token utilities.
 */
const SRC = join(__dirname);
const ROOT = join(SRC, "../../..");
const css = readFileSync(join(SRC, "styles.css"), "utf8");
const SCANNED = [SRC, join(ROOT, "apps/web/src"), join(ROOT, "apps/console/src")].filter((d) =>
  existsSync(d),
);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const RAW_VALUE_RULES: readonly [string, RegExp][] = [
  ["hex color", /#[0-9a-fA-F]{3,8}\b/],
  ["color function", /\b(rgba?|hsla?|oklch|oklab|lab|lch)\(/],
  ["arbitrary size", /-\[[^\]]*\d(px|rem|em|vh|vw|%)[^\]]*\]/],
  ["arbitrary calc", /-\[[^\]]*calc\(/],
  ["arbitrary color", /-\[(#|rgb|hsl|oklch|var\()/],
  ["arbitrary font", /font-\[/],
  ["inline pixel size", /:\s*["'`]?\d+(\.\d+)?(px|rem|em)\b/],
  ["font family", /fontFamily/],
  [
    "default palette class",
    /\b(bg|text|border|ring|outline|fill|stroke|from|to|via)-(red|green|blue|gray|slate|zinc|neutral|stone|lime|yellow|amber|orange|emerald|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose|white|black)(-\d+)?\b/,
  ],
];

describe("no raw values outside the token file", () => {
  const files = SCANNED.flatMap(sourceFiles);

  it("finds the component and page sources", () => {
    expect(files.some((f) => f.endsWith("components/ui/button.tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith("apps/web/src/app/design/design-system.tsx"))).toBe(true);
  });

  it.each(files.map((f) => [relative(ROOT, f), f]))("%s uses only tokens", (_, file) => {
    const source = readFileSync(file, "utf8");
    const found = RAW_VALUE_RULES.flatMap(([rule, pattern]) => {
      const match = source.match(pattern);
      return match ? [`${rule}: ${match[0]}`] : [];
    });
    expect(found).toEqual([]);
  });

  it("the rules catch raw values", () => {
    const bad = [
      'className="bg-[#B6FF3B]"',
      'className="w-[13px]"',
      'style={{ color: "#fff" }}',
      'className="text-red-500"',
      'className="font-[Inter]"',
    ];
    for (const sample of bad) {
      expect(
        RAW_VALUE_RULES.some(([, pattern]) => pattern.test(sample)),
        sample,
      ).toBe(true);
    }
  });
});

describe("token file", () => {
  it.each(COLOR_TOKENS.map((t) => t.name))("defines --%s and maps it into Tailwind", (name) => {
    expect(css).toMatch(new RegExp(`^\\s*--${name}:`, "m"));
    expect(css).toContain(`--color-${name}: var(--${name});`);
  });

  it("uses the prototype's graphite and lime (D-154)", () => {
    expect(css).toContain("--palette-graphite-950: #0e1013;");
    expect(css).toContain("--palette-graphite-900: #14161a;");
    expect(css).toContain("--palette-lime: #b6ff2e;");
  });

  it("keeps cards flat and defines every shadow and motion token it lists", () => {
    expect(css).toContain("--shadow-raised: none;");
    for (const { name } of SHADOW_SCALE)
      expect(css).toContain(`--shadow-${name}: var(--shadow-${name});`);
    for (const { name } of MOTION_TOKENS) expect(css).toMatch(new RegExp(`^\\s*--${name}:`, "m"));
    expect(css).toContain("prefers-reduced-motion: reduce");
  });

  it("removes Tailwind's defaults so only tokens compile", () => {
    for (const reset of [
      "--color-*: initial;",
      "--font-*: initial;",
      "--radius-*: initial;",
      "--shadow-*: initial;",
      "--text-*: initial;",
    ]) {
      expect(css).toContain(reset);
    }
  });
});

describe("/design shows every component", () => {
  const design = readFileSync(join(ROOT, "apps/web/src/app/design/design-system.tsx"), "utf8");
  const componentFiles = sourceFiles(join(SRC, "components"));

  it.each(componentFiles.map((f) => [relative(SRC, f), f]))(
    "%s is on the design page",
    (_, file) => {
      const source = readFileSync(file, "utf8");
      const exported = [...source.matchAll(/^export \{([^}]+)\}/gm)]
        .flatMap((m) => (m[1] ?? "").split(","))
        .map((name) => name.trim())
        .filter((name) => /^[A-Z]/.test(name) && !name.endsWith("Variants"));
      expect(exported.length).toBeGreaterThan(0);
      const missing = exported.filter((name) => !new RegExp(`<${name}\\b`).test(design));
      // Pieces used only inside other components are listed here on purpose.
      const composedOnly = ["SelectGroup", "TooltipProvider", "Toaster"];
      expect(missing.filter((name) => !composedOnly.includes(name))).toEqual([]);
    },
  );
});
