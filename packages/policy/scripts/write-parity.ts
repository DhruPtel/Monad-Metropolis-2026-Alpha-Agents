// pnpm policy:parity: writes the oracle and breaker parity fixture that
// packages/policy and the forge tests both check (P2-U3), and the fund parity fixture (F-U2).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EXECUTOR_FIXTURE_PATH,
  PARITY_FIXTURE_PATH,
  executorParityJson,
  parityJson,
} from "../src/parity.ts";
import { FUND_FIXTURE_PATH, fundParityJson } from "../src/fund.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
writeFileSync(`${root}${PARITY_FIXTURE_PATH}`, parityJson());
console.log(`wrote ${PARITY_FIXTURE_PATH}`);
writeFileSync(`${root}${EXECUTOR_FIXTURE_PATH}`, executorParityJson());
console.log(`wrote ${EXECUTOR_FIXTURE_PATH}`);
writeFileSync(`${root}${FUND_FIXTURE_PATH}`, fundParityJson());
console.log(`wrote ${FUND_FIXTURE_PATH}`);
