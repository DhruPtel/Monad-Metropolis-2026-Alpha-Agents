// pnpm policy:parity: writes the oracle and breaker parity fixture that
// packages/policy and the forge tests both check (P2-U3).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EXECUTOR_FIXTURE_PATH,
  PARITY_FIXTURE_PATH,
  executorParityJson,
  parityJson,
} from "../src/parity.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
writeFileSync(`${root}${PARITY_FIXTURE_PATH}`, parityJson());
console.log(`wrote ${PARITY_FIXTURE_PATH}`);
writeFileSync(`${root}${EXECUTOR_FIXTURE_PATH}`, executorParityJson());
console.log(`wrote ${EXECUTOR_FIXTURE_PATH}`);
