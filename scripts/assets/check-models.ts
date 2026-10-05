// Checks every model in the species manifest (packages/domain species-assets.ts)
// against MODEL_LIMITS. Run: pnpm assets:check. Exits 1 if any model fails or
// a listed file or image is missing.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SPECIES_ASSETS } from "@alpha-agents/domain";
import { MODEL_LIMITS, checkModelBytes } from "./model-check.ts";

const PUBLIC = new URL("../../apps/web/public/", import.meta.url).pathname;

let failed = false;
console.log(
  `limits: ${MODEL_LIMITS.maxBytes / 1e6} MB, ${MODEL_LIMITS.maxTriangles} triangles, ` +
    `${MODEL_LIMITS.maxTextureSize}px textures, longest side ${MODEL_LIMITS.minLongestSide} to ${MODEL_LIMITS.maxLongestSide} units`,
);
for (const asset of SPECIES_ASSETS) {
  const { slug } = asset.species;
  if (asset.image && !existsSync(join(PUBLIC, asset.image))) {
    failed = true;
    console.log(`FAIL  ${slug.padEnd(16)} image ${asset.image} is missing`);
  }
  if (!asset.model) {
    console.log(`2D    ${slug.padEnd(16)} ${asset.image ? "image" : "placeholder"}, no model`);
    continue;
  }
  const file = join(PUBLIC, asset.model.path);
  if (!existsSync(file)) {
    failed = true;
    console.log(`FAIL  ${slug.padEnd(16)} model ${asset.model.path} is missing`);
    continue;
  }
  const report = await checkModelBytes(readFileSync(file), asset);
  const summary =
    `${(report.bytes / 1e6).toFixed(2)} MB, ${report.triangles} triangles, ` +
    `longest side ${report.longestSide.toFixed(2)}, textures ${report.maxTextureSize}px, ` +
    `${report.sockets.length} sockets${report.skinned ? ", rigged" : ""}`;
  if (report.problems.length > 0) failed = true;
  console.log(`${report.problems.length === 0 ? "PASS" : "FAIL"}  ${slug.padEnd(16)} ${summary}`);
  for (const p of report.problems) console.log(`        ${p}`);
}
console.log(failed ? "assets: FAILED" : "assets: every model passes");
process.exit(failed ? 1 : 0);
