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
          // apps/web runs in its own jsdom project; its e2e specs run in Playwright.
          exclude: [...ignored, "apps/web/**"],
        },
      },
      "apps/web/vitest.config.ts",
    ],
  },
});
