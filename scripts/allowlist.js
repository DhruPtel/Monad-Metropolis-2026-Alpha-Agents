// @ts-check
// The mint allowlist (P1-U4, D-198): the wallets the control API will sign a
// mint claim for. Stored in platform.mint_allowlist.
//
//   pnpm allowlist add <address> [note]
//   pnpm allowlist remove <address>
//   pnpm allowlist list
//
// Uses DATABASE_URL for the environment in APP_ENV (local by default).
import { ConfigError, loadConfig } from "@alpha-agents/config";
import { createDb, dbAddress } from "@alpha-agents/db";
import { getAddress, isAddress } from "viem";
import { loadRootEnv } from "./lib/config.js";

loadRootEnv();
const [command, rawAddress, ...noteWords] = process.argv.slice(2);
const usage = "usage: pnpm allowlist add <address> [note] | remove <address> | list";

if (command !== "add" && command !== "remove" && command !== "list") {
  console.error(usage);
  process.exit(2);
}
if (command !== "list" && (!rawAddress || !isAddress(rawAddress, { strict: false }))) {
  console.error(`error: "${rawAddress ?? ""}" is not an address\n${usage}`);
  process.exit(2);
}

let config;
try {
  config = loadConfig({ name: "allowlist script", usesChain: false, requires: ["DATABASE_URL"] });
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`error: ${err.message}`);
  process.exit(1);
}
const url = /** @type {import("@alpha-agents/config").Secret} */ (config.values.DATABASE_URL);
const db = createDb(url.reveal(), { max: 1 });
const env = config.environment.label;

try {
  if (command === "list") {
    const rows = await db
      .selectFrom("platform.mint_allowlist")
      .selectAll()
      .orderBy("added_at")
      .execute();
    if (rows.length === 0) console.log(`the ${env} mint allowlist is empty`);
    for (const row of rows) {
      console.log(`${getAddress(row.wallet)}  ${row.note ?? ""}`.trimEnd());
    }
  } else {
    const wallet = dbAddress(/** @type {string} */ (rawAddress));
    if (command === "add") {
      const note = noteWords.join(" ").trim() || null;
      const result = await db
        .insertInto("platform.mint_allowlist")
        .values({ wallet, note })
        .onConflict((oc) => oc.column("wallet").doUpdateSet({ note }))
        .executeTakeFirst();
      console.log(
        `${getAddress(wallet)} is on the ${env} mint allowlist${result.numInsertedOrUpdatedRows ? "" : " (unchanged)"}`,
      );
    } else {
      const result = await db
        .deleteFrom("platform.mint_allowlist")
        .where("wallet", "=", wallet)
        .executeTakeFirst();
      console.log(
        result.numDeletedRows > 0n
          ? `${getAddress(wallet)} is off the ${env} mint allowlist`
          : `${getAddress(wallet)} was not on the ${env} mint allowlist`,
      );
    }
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    /relation .* does not exist/.test(message)
      ? "error: the database has no allowlist table yet; run pnpm db:migrate"
      : `error: ${message}`,
  );
  process.exitCode = 1;
} finally {
  await db.destroy();
}
