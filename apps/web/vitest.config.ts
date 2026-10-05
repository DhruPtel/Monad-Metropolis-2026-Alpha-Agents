import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

// Unit tests for the web app's logic and build guards.
export default defineProject({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: { name: "web", environment: "node", include: ["src/**/*.test.ts", "*.test.ts"] },
});
