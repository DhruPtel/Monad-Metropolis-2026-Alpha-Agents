// @ts-check
// Writes .env.example from the variable registry in packages/config.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderEnvExample } from "@alpha-agents/config";
import { ROOT } from "./lib/paths.js";

writeFileSync(join(ROOT, ".env.example"), renderEnvExample());
console.log("wrote .env.example");
