import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    exclude: ["**/node_modules/**", "**/dist/**", "Planv1/**", "Planv2/**", "Reference/**"],
    passWithNoTests: true,
    coverage: {
      reportsDirectory: "coverage",
    },
  },
});
