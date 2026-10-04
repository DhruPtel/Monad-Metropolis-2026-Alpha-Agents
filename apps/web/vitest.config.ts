import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

// Unit tests for the web app's server code and build guards. `server-only` throws
// outside a React Server build, so tests replace it with an empty module.
export default defineProject({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./src/server/test-server-only.ts", import.meta.url)),
    },
  },
  test: { name: "web", environment: "node", include: ["src/**/*.test.ts", "*.test.ts"] },
});
