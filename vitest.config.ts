import { defineConfig } from "vitest/config";

const ignored = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.next/**",
  "**/dependencies/**",
  "Planv1/**",
  "Planv2/**",
  "Reference/**",
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
          exclude: [...ignored, "packages/ui/**", "apps/web/**", "apps/console/**"],
        },
      },
      "packages/ui/vitest.config.ts",
      "apps/console/vitest.config.ts",
    ],
  },
});
