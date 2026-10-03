// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/.next/**",
      "**/out/**",
      "**/cache/**",
      "Planv1/**",
      "Planv2/**",
      "Reference/**",
      "**/dependencies/**",
      "clones/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    files: ["scripts/**/*.js"],
    languageOptions: { globals: globals.node },
  },
);
