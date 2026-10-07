import { defineConfig } from "vitest/config";

const ignored = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.next/**",
  "**/.next-e2e/**",
  "**/dependencies/**",
  "Planv1/**",
  "Planv2/**",
  "Reference/**",
  "clones/**",
];

const FORK_TESTS = [
  "packages/**/*.fork.test.ts",
  "services/**/*.fork.test.ts",
  "packages/devenv/src/fork.integration.test.ts",
];

export default defineConfig({
  test: {
    passWithNoTests: true,
    coverage: { reportsDirectory: "coverage" },
    projects: [
      {
        test: {
          name: "node",
          include: ["**/*.{test,spec}.?(c|m)[jt]s?(x)"],
          // packages/ui runs in its own jsdom project; the apps' e2e specs run in Playwright.
          exclude: [...ignored, ...FORK_TESTS, "packages/ui/**", "apps/web/**", "apps/console/**"],
        },
      },
      {
        // Tests that start a fork of their own run one file at a time, after everything else:
        // several cold forks fetching from the upstream at once time out (P2-U4, L-115).
        test: {
          name: "forks",
          include: FORK_TESTS,
          exclude: ignored,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
      "packages/ui/vitest.config.ts",
      "apps/console/vitest.config.ts",
      "apps/web/vitest.config.ts",
    ],
  },
});
